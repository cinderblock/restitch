/**
 * Standalone transcription service.
 *
 * Spawns a single whisper-server on the GPU plus one ffmpeg per camera
 * pulling 16 kHz mono PCM audio from mediamtx's raw/<slug> paths. Audio is
 * buffered into ~chunk_seconds windows, POSTed to whisper-server, and the
 * resulting text appended to an in-memory ring buffer per camera.
 *
 * Exposes /api/transcriptions on its own HTTP port; the main dashboard
 * proxies through to it.
 *
 * Run as a separate systemd unit (restitch-transcribe.service) so a
 * transcription crash doesn't take down the compositor.
 */

import { parseArgs } from "util";
import { resolve } from "path";
import YAML from "yaml";
import {
  ConfigSchema,
  type Config,
  type Camera,
  type Transcription,
} from "./config.ts";
import { rawStreamName } from "./mediamtx.ts";
import { launchManaged, type ManagedProcess } from "./process.ts";

interface Entry {
  ts: number;
  camera: string;
  text: string;
}

class RingBuffer {
  private buffers = new Map<string, Entry[]>();

  constructor(private maxPerCamera: number) {}

  push(camera: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (isFiller(trimmed)) return;
    let arr = this.buffers.get(camera);
    if (!arr) {
      arr = [];
      this.buffers.set(camera, arr);
    }
    arr.push({ ts: Date.now(), camera, text: trimmed });
    while (arr.length > this.maxPerCamera) arr.shift();
  }

  recent(limit = 100): Entry[] {
    const all: Entry[] = [];
    for (const arr of this.buffers.values()) all.push(...arr);
    all.sort((a, b) => b.ts - a.ts);
    return all.slice(0, limit);
  }

  countByCamera(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [cam, arr] of this.buffers) out[cam] = arr.length;
    return out;
  }
}

/**
 * Whisper often emits noise transcriptions like "[Music]", "(silence)",
 * "thank you for watching" on dead air. Drop them so they don't clutter
 * the ring buffer.
 */
function isFiller(text: string): boolean {
  if (text.length < 2) return true;
  // Drop transcripts that are entirely bracketed annotations.
  if (/^[\[\(\<].*[\]\)\>]$/.test(text)) return true;
  // Common Whisper hallucinations on silence (case-insensitive).
  const fillers = [
    "thanks for watching",
    "thank you for watching",
    "thank you.",
    "you",
    ".",
    "...",
  ];
  if (fillers.includes(text.toLowerCase())) return true;
  return false;
}

function makeWavHeader(
  dataSize: number,
  sampleRate = 16000,
  channels = 1,
  bitsPerSample = 16
): Uint8Array {
  const buf = new ArrayBuffer(44);
  const dv = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, (sampleRate * channels * bitsPerSample) / 8, true);
  dv.setUint16(32, (channels * bitsPerSample) / 8, true);
  dv.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  dv.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

async function transcribe(
  serverUrl: string,
  pcm: Uint8Array,
  language: string,
  initialPrompt: string
): Promise<string> {
  const header = makeWavHeader(pcm.length);
  const wav = new Uint8Array(header.length + pcm.length);
  wav.set(header, 0);
  wav.set(pcm, header.length);

  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  if (language) form.append("language", language);
  if (initialPrompt) form.append("prompt", initialPrompt);

  const r = await fetch(`${serverUrl}/inference`, {
    method: "POST",
    body: form,
  });
  if (!r.ok) {
    throw new Error(
      `whisper-server ${r.status}: ${(await r.text()).slice(0, 200)}`
    );
  }
  const json = (await r.json()) as { text?: string };
  return (json.text ?? "").trim();
}

async function waitForServer(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { method: "GET" });
      // Any HTTP response (even 404 on /) means it's listening
      if (r.status > 0) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`whisper-server didn't come up within ${timeoutMs}ms`);
}

function parseAddress(addr: string): { hostname?: string; port: number } {
  const colon = addr.lastIndexOf(":");
  if (colon === -1) return { port: parseInt(addr, 10) || 9001 };
  const host = addr.slice(0, colon);
  const port = parseInt(addr.slice(colon + 1), 10) || 9001;
  return host ? { hostname: host, port } : { port };
}

function startWhisperServer(t: Transcription): ManagedProcess {
  const { hostname, port } = parseAddress(t.whisper_server.address);
  return launchManaged(
    "whisper-server",
    () => ({
      cmd: [
        t.whisper_server.bin,
        "--model",
        t.whisper_server.model,
        "--vad",
        "--vad-model",
        t.whisper_server.vad_model,
        "--host",
        hostname ?? "127.0.0.1",
        "--port",
        String(port),
        // Lower threshold helps with quieter shop audio
        "--vad-threshold",
        "0.4",
      ],
      onStderr: (line) => {
        // whisper-server is chatty; only log warnings/errors at INFO+
        if (/error|fail|warning/i.test(line)) {
          console.error(`[whisper-server] ${line}`);
        }
      },
    }),
    { restartDelayMs: 5000 }
  );
}

function startCameraPump(
  cam: Camera,
  config: Config,
  whisperUrl: string,
  ring: RingBuffer
): ManagedProcess {
  const sourceUrl = `${config.output.base_url}/${rawStreamName(cam)}`;
  const t = config.transcription;
  const BYTES_PER_SEC = 16_000 * 2; // 16 kHz mono s16le
  const PAD_BYTES = Math.floor((t.pad_ms / 1000) * BYTES_PER_SEC);
  const MIN_BYTES = Math.floor(t.min_segment_seconds * BYTES_PER_SEC);
  const MAX_BYTES = Math.floor(t.max_segment_seconds * BYTES_PER_SEC);
  // Keep enough recent audio so silencedetect (which reports times AT WHICH
  // events happened, but FIRES after silence_min_seconds elapsed) can still
  // scrub back into the past.
  const KEEP_BYTES = Math.floor(
    (t.silence_min_seconds + t.max_segment_seconds + 2) * BYTES_PER_SEC
  );

  // Rolling byte buffer. `firstByte` is the absolute offset (from ffmpeg
  // input t=0) of buffer[0]; `nextByte` is the offset of the next sample
  // that will be written.
  let buffer: Uint8Array = new Uint8Array(0);
  let firstByte = 0;
  let nextByte = 0;

  // Speech state — set by silence_end events, cleared after flush.
  let speechStartByte: number | null = null;
  // Latest silenceStart event byte (set on silence_start). Used together
  // with speechStartByte to bracket a complete segment.
  let inflight = 0;

  const flushSegment = async (startByte: number, endByte: number) => {
    inflight++;
    try {
      const padStart = Math.max(firstByte, startByte - PAD_BYTES);
      const padEnd = Math.min(nextByte, endByte + PAD_BYTES);
      if (padEnd - padStart < MIN_BYTES) return;
      const bufStart = padStart - firstByte;
      const bufEnd = padEnd - firstByte;
      if (bufStart < 0 || bufEnd > buffer.length) {
        console.warn(
          `[${cam.name}] segment out of buffer range — dropped`
        );
        return;
      }
      const pcm = buffer.slice(bufStart, bufEnd);
      const text = await transcribe(
        whisperUrl,
        pcm,
        t.language,
        t.initial_prompt
      );
      if (text) {
        console.log(`[${cam.name}] ${text}`);
        ring.push(cam.name, text);
      }
    } catch (e) {
      console.error(`[${cam.name}] transcribe failed:`, e);
    } finally {
      inflight--;
    }
  };

  const onStdout = (chunk: Uint8Array) => {
    // Append to rolling buffer
    const merged = new Uint8Array(buffer.length + chunk.length);
    merged.set(buffer, 0);
    merged.set(chunk, buffer.length);
    buffer = merged;
    nextByte += chunk.length;

    // Trim from the front to keep only KEEP_BYTES of audio
    if (buffer.length > KEEP_BYTES) {
      const trim = buffer.length - KEEP_BYTES;
      buffer = buffer.slice(trim);
      firstByte += trim;
    }

    // Force-flush very long monologues
    if (
      speechStartByte !== null &&
      nextByte - speechStartByte > MAX_BYTES
    ) {
      const start = speechStartByte;
      speechStartByte = nextByte; // continue with a new segment from here
      void flushSegment(start, nextByte);
    }
  };

  const onStderr = (line: string) => {
    // ffmpeg silencedetect at -loglevel info emits:
    //   [silencedetect @ 0x...] silence_start: 12.345
    //   [silencedetect @ 0x...] silence_end: 14.567 | silence_duration: 2.222
    const endMatch = line.match(/silence_end:\s*([\d.]+)/);
    const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (endMatch) {
      const tSec = parseFloat(endMatch[1]!);
      speechStartByte = Math.max(0, Math.floor(tSec * BYTES_PER_SEC));
      return;
    }
    if (startMatch) {
      const tSec = parseFloat(startMatch[1]!);
      const endByte = Math.max(0, Math.floor(tSec * BYTES_PER_SEC));
      if (speechStartByte !== null && endByte > speechStartByte) {
        void flushSegment(speechStartByte, endByte);
      }
      speechStartByte = null;
      return;
    }
    // Suppress silencedetect noise; surface real warnings/errors.
    if (
      /error|fail/i.test(line) &&
      !/silencedetect/i.test(line)
    ) {
      console.error(`[${cam.name}] ${line}`);
    }
  };

  return launchManaged(
    `audio-${cam.name.toLowerCase().replace(/\s+/g, "-")}`,
    () => ({
      cmd: [
        config.ffmpeg_path,
        // 'info' level so silencedetect lines reach stderr — they're filtered
        // server-side in onStderr.
        "-loglevel",
        "info",
        "-rtsp_transport",
        "tcp",
        "-allowed_media_types",
        "audio",
        "-i",
        sourceUrl,
        "-vn",
        "-af",
        `silencedetect=noise=${t.silence_threshold_db}dB:d=${t.silence_min_seconds}`,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "-",
      ],
      onStdout,
      onStderr,
    }),
    { restartDelayMs: 5000 }
  );
}

async function loadConfig(path: string): Promise<Config> {
  const raw = await Bun.file(path).text();
  return ConfigSchema.parse(YAML.parse(raw));
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      config: { type: "string", short: "c", default: "config.yaml" },
    },
  });
  const configPath = resolve(values.config!);
  console.log(`[transcribe] Loading config from ${configPath}`);
  const config = await loadConfig(configPath);

  if (!config.transcription.enabled) {
    console.log("[transcribe] disabled in config — exiting");
    return;
  }

  const t = config.transcription;
  const whisperUrl = `http://${t.whisper_server.address.replace(/^:/, "127.0.0.1:")}`;
  const ring = new RingBuffer(t.max_entries_per_camera);

  const processes: ManagedProcess[] = [];

  // 1. whisper-server first; cameras can't transcribe until it's up.
  console.log("[transcribe] starting whisper-server...");
  processes.push(startWhisperServer(t));

  await waitForServer(whisperUrl);
  console.log(`[transcribe] whisper-server ready at ${whisperUrl}`);

  // 2. One ffmpeg-to-whisper pump per camera (every camera, including
  //    restream-only ones).
  for (const cam of config.cameras) {
    console.log(`[transcribe] starting pump for ${cam.name}`);
    processes.push(startCameraPump(cam, config, whisperUrl, ring));
  }

  // 3. HTTP API for the dashboard to poll.
  const { hostname, port } = parseAddress(t.api_address);
  const server = Bun.serve({
    hostname,
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/transcriptions") {
        const limit = Math.max(
          1,
          Math.min(500, parseInt(url.searchParams.get("limit") ?? "100", 10))
        );
        return Response.json({
          items: ring.recent(limit),
          counts: ring.countByCamera(),
        });
      }
      if (url.pathname === "/health") {
        return new Response("ok");
      }
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(
    `[transcribe] HTTP API listening on http://${server.hostname}:${server.port}`
  );

  const shutdown = () => {
    console.log("\n[transcribe] shutting down...");
    server.stop();
    for (const p of processes) p.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {}); // keep alive
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[transcribe] fatal:", err);
    process.exit(1);
  });
}
