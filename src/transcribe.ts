/**
 * Transcription pipeline (combined-fusion).
 *
 *   1 ffmpeg with N RTSP audio inputs (one per camera). amerge gives us an
 *   N-channel interleaved s16le stream at 16 kHz.
 *   ↓
 *   Bun reads N-channel groups, picks max(|sample|) per timestep to produce a
 *   mono "loudest mic wins" mix (no comb-filtering from unsynchronized mics).
 *   Simultaneously accumulates per-channel RMS for attribution.
 *   ↓
 *   Bun runs its own silence detection on the mono RMS — speech segments
 *   trigger a single whisper transcription with the per-segment mean RMS
 *   per camera attached.
 *   ↓
 *   Ring buffer entry: { ts, text, primary_camera, contributors[] }.
 *   Exposed via startTranscription() to the host (index.ts), which serves
 *   the ring/stats from the dashboard HTTP server in-process.
 */

import type {
  Config,
  Camera,
  Transcription,
} from "./config.ts";
import { rawStreamName } from "./mediamtx.ts";
import { launchManaged, type ManagedProcess } from "./process.ts";

export interface Contributor {
  camera: string;
  rms_db: number;
}

export interface Entry {
  ts: number;
  text: string;
  primary_camera: string;
  contributors: Contributor[];
}

export class RingBuffer {
  private entries: Entry[] = [];

  constructor(private maxEntries: number) {}

  push(entry: Entry): void {
    const text = entry.text.trim();
    if (!text) return;
    if (isFiller(text)) return;
    this.entries.push({ ...entry, text });
    while (this.entries.length > this.maxEntries) this.entries.shift();
  }

  recent(limit = 100): Entry[] {
    return this.entries.slice(-limit).reverse();
  }

  countByCamera(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries) {
      out[e.primary_camera] = (out[e.primary_camera] ?? 0) + 1;
    }
    return out;
  }

  contributorCountByCamera(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.entries) {
      for (const c of e.contributors) {
        out[c.camera] = (out[c.camera] ?? 0) + 1;
      }
    }
    return out;
  }
}

function isFiller(text: string): boolean {
  if (text.length < 2) return true;
  if (/^[\[\(\<].*[\]\)\>]$/.test(text)) return true;
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
  dv.setUint16(20, 1, true);
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
        "--vad-threshold",
        "0.4",
      ],
      onStderr: (line) => {
        if (/error|fail|warning/i.test(line)) {
          console.error(`[whisper-server] ${line}`);
        }
      },
    }),
    { restartDelayMs: 5000 }
  );
}

/**
 * Single fused-audio pump: one ffmpeg pulls all camera audio, Bun does the
 * mixing and silence detection, then triggers a transcription per segment.
 */
export interface LiveStats {
  state: "silent" | "speaking" | "pending";
  threshold_db: number;
  mono_rms_db: number;
  per_cam_rms_db: Record<string, number>;
  transitions_total: number;
  last_segment_at: number | null;
}

function startCombinedPump(
  cameras: Camera[],
  config: Config,
  whisperUrl: string,
  ring: RingBuffer,
  stats: LiveStats
): ManagedProcess {
  const t = config.transcription;
  const N = cameras.length;
  const SAMPLE_RATE = 16000;
  const BYTES_PER_SAMPLE = 2;
  const GROUP_SIZE = N * BYTES_PER_SAMPLE; // bytes per output sample (one timestep across all channels)
  const MONO_BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;

  const PAD_BYTES = Math.floor((t.pad_ms / 1000) * MONO_BYTES_PER_SEC);
  const MIN_SEG_BYTES = Math.floor(t.min_segment_seconds * MONO_BYTES_PER_SEC);
  const MAX_SEG_BYTES = Math.floor(t.max_segment_seconds * MONO_BYTES_PER_SEC);
  const KEEP_BYTES = Math.floor(
    (t.silence_min_seconds + t.max_segment_seconds + 2) * MONO_BYTES_PER_SEC
  );
  const RMS_WINDOW_SAMPLES = Math.max(
    1,
    Math.floor((SAMPLE_RATE * t.rms_window_ms) / 1000)
  );
  const SILENCE_MIN_SAMPLES = Math.floor(
    SAMPLE_RATE * t.silence_min_seconds
  );
  // RMS threshold compared as integer amplitude (16-bit range).
  const THRESHOLD_AMP = Math.pow(10, t.silence_threshold_db / 20) * 32768;

  // --- Rolling mono PCM buffer ---
  let monoBuffer = new Uint8Array(0);
  let firstMonoByte = 0;
  let nextMonoByte = 0;
  let leftoverBytes = new Uint8Array(0); // unparsed bytes from prev chunk

  // --- Per-camera RMS history (one bin per completed RMS window) ---
  type RmsBin = { sampleOffset: number; perCam: number[] };
  let rmsHistory: RmsBin[] = [];

  // --- Current window accumulators ---
  let windowSamples = 0;
  let windowMonoSumSq = 0;
  const windowChanSumSq = new Float64Array(N);

  // --- Silence-detection state machine ---
  let state: "silent" | "speaking" | "pending" = "silent";
  let speechStartByte = 0;
  let silencePotentialStartByte = 0;
  let silencePendingSamples = 0;

  let inflight = 0;

  function appendMono(samples: Int16Array): void {
    if (samples.length === 0) return;
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const merged = new Uint8Array(monoBuffer.length + bytes.length);
    merged.set(monoBuffer, 0);
    merged.set(bytes, monoBuffer.length);
    monoBuffer = merged;
    nextMonoByte += bytes.length;

    if (monoBuffer.length > KEEP_BYTES + SAMPLE_RATE) {
      const trim = monoBuffer.length - KEEP_BYTES;
      monoBuffer = monoBuffer.slice(trim);
      firstMonoByte += trim;
      const sampleCutoff = firstMonoByte / BYTES_PER_SAMPLE;
      while (rmsHistory.length > 0 && rmsHistory[0]!.sampleOffset < sampleCutoff) {
        rmsHistory.shift();
      }
    }
  }

  async function flushSegment(startByte: number, endByte: number): Promise<void> {
    inflight++;
    try {
      const padStart = Math.max(firstMonoByte, startByte - PAD_BYTES);
      const padEnd = Math.min(nextMonoByte, endByte + PAD_BYTES);
      if (padEnd - padStart < MIN_SEG_BYTES) return;
      const bufStart = padStart - firstMonoByte;
      const bufEnd = padEnd - firstMonoByte;
      if (bufStart < 0 || bufEnd > monoBuffer.length) {
        console.warn("[combined] segment out of buffer range — dropped");
        return;
      }
      const pcm = monoBuffer.slice(bufStart, bufEnd);

      // Compute per-camera mean RMS across all bins that fall inside the
      // unpadded segment [startByte, endByte).
      const startSample = startByte / BYTES_PER_SAMPLE;
      const endSample = endByte / BYTES_PER_SAMPLE;
      const sumSq = new Float64Array(N);
      let bins = 0;
      for (const bin of rmsHistory) {
        if (bin.sampleOffset >= startSample && bin.sampleOffset < endSample) {
          for (let c = 0; c < N; c++) {
            const r = bin.perCam[c]!;
            sumSq[c]! += r * r;
          }
          bins++;
        }
      }

      const text = await transcribe(
        whisperUrl,
        pcm,
        t.language,
        t.initial_prompt
      );
      if (!text) return;

      // Attribution
      let primaryIdx = 0;
      let primaryRms = 0;
      const camRms: number[] = new Array(N);
      for (let c = 0; c < N; c++) {
        const rms = bins > 0 ? Math.sqrt(sumSq[c]! / bins) : 0;
        camRms[c] = rms;
        if (rms > primaryRms) {
          primaryRms = rms;
          primaryIdx = c;
        }
      }
      const cutoffRms =
        primaryRms * Math.pow(10, -t.contribution_threshold_db / 20);
      const contributors: Contributor[] = [];
      for (let c = 0; c < N; c++) {
        if (camRms[c]! >= cutoffRms && camRms[c]! > 0) {
          contributors.push({
            camera: cameras[c]!.name,
            rms_db: 20 * Math.log10(camRms[c]! / 32768),
          });
        }
      }
      contributors.sort((a, b) => b.rms_db - a.rms_db);

      const primary = cameras[primaryIdx]!.name;
      console.log(
        `[combined] [${primary}${contributors.length > 1 ? ` +${contributors.length - 1}` : ""}] ${text}`
      );
      const now = Date.now();
      ring.push({
        ts: now,
        text,
        primary_camera: primary,
        contributors,
      });
      stats.last_segment_at = now;
    } catch (e) {
      console.error("[combined] transcribe failed:", e);
    } finally {
      inflight--;
    }
  }

  function finishWindow(): void {
    const samples = windowSamples;
    if (samples === 0) return;
    const monoRms = Math.sqrt(windowMonoSumSq / samples);
    const perCam = new Array<number>(N);
    for (let c = 0; c < N; c++) perCam[c] = Math.sqrt(windowChanSumSq[c]! / samples);

    rmsHistory.push({
      sampleOffset: nextMonoByte / BYTES_PER_SAMPLE - samples,
      perCam,
    });

    // Live stats for the dashboard
    stats.mono_rms_db = monoRms > 0 ? 20 * Math.log10(monoRms / 32768) : -100;
    for (let c = 0; c < N; c++) {
      stats.per_cam_rms_db[cameras[c]!.name] =
        perCam[c]! > 0 ? 20 * Math.log10(perCam[c]! / 32768) : -100;
    }

    const above = monoRms > THRESHOLD_AMP;
    const prevState = state;
    if (state === "silent" && above) {
      state = "speaking";
      speechStartByte = nextMonoByte - samples * BYTES_PER_SAMPLE;
    } else if (state === "speaking" && !above) {
      state = "pending";
      silencePotentialStartByte = nextMonoByte - samples * BYTES_PER_SAMPLE;
      silencePendingSamples = samples;
    } else if (state === "pending") {
      if (above) {
        state = "speaking";
        silencePendingSamples = 0;
      } else {
        silencePendingSamples += samples;
        if (silencePendingSamples >= SILENCE_MIN_SAMPLES) {
          if (silencePotentialStartByte > speechStartByte) {
            void flushSegment(speechStartByte, silencePotentialStartByte);
          }
          state = "silent";
          silencePendingSamples = 0;
        }
      }
    }
    if (state !== prevState) {
      stats.transitions_total++;
      stats.state = state;
    }

    // Reset window accumulators
    windowSamples = 0;
    windowMonoSumSq = 0;
    for (let c = 0; c < N; c++) windowChanSumSq[c] = 0;

    // Emergency flush for absurdly long speech
    if (
      state === "speaking" &&
      nextMonoByte - speechStartByte > MAX_SEG_BYTES
    ) {
      void flushSegment(speechStartByte, nextMonoByte);
      speechStartByte = nextMonoByte;
    }
  }

  const onStdout = (chunk: Uint8Array): void => {
    let data: Uint8Array;
    if (leftoverBytes.length > 0) {
      data = new Uint8Array(leftoverBytes.length + chunk.length);
      data.set(leftoverBytes, 0);
      data.set(chunk, leftoverBytes.length);
    } else {
      data = chunk;
    }

    const groupCount = Math.floor(data.length / GROUP_SIZE);
    const usedBytes = groupCount * GROUP_SIZE;
    leftoverBytes = data.slice(usedBytes);
    if (groupCount === 0) return;

    const dv = new DataView(data.buffer, data.byteOffset, usedBytes);
    const mono = new Int16Array(groupCount);
    let committed = 0; // index in `mono` of first uncommitted sample

    for (let g = 0; g < groupCount; g++) {
      let maxAbs = 0;
      let maxSigned = 0;
      const base = g * GROUP_SIZE;
      for (let c = 0; c < N; c++) {
        const s = dv.getInt16(base + c * BYTES_PER_SAMPLE, true);
        const a = s < 0 ? -s : s;
        windowChanSumSq[c]! += s * s;
        if (a > maxAbs) {
          maxAbs = a;
          maxSigned = s;
        }
      }
      mono[g] = maxSigned;
      windowMonoSumSq += maxSigned * maxSigned;
      windowSamples++;

      if (windowSamples >= RMS_WINDOW_SAMPLES) {
        if (g + 1 > committed) {
          appendMono(mono.slice(committed, g + 1));
          committed = g + 1;
        }
        finishWindow();
      }
    }
    if (committed < groupCount) {
      appendMono(mono.slice(committed, groupCount));
    }
  };

  // Build the ffmpeg invocation.
  const cmd: string[] = [
    config.ffmpeg_path,
    "-loglevel",
    "warning",
  ];
  for (const cam of cameras) {
    cmd.push(
      "-use_wallclock_as_timestamps",
      "1",
      "-rtsp_transport",
      "tcp",
      "-allowed_media_types",
      "audio",
      "-i",
      `${config.output.base_url}/${rawStreamName(cam)}`
    );
  }
  // Per-input: resample to 16k mono, then amerge into N channels.
  const filterParts: string[] = [];
  for (let i = 0; i < cameras.length; i++) {
    filterParts.push(
      `[${i}:a]aresample=async=1,aformat=sample_rates=16000:channel_layouts=mono[a${i}]`
    );
  }
  const inputs = Array.from({ length: cameras.length }, (_, i) => `[a${i}]`).join("");
  filterParts.push(`${inputs}amerge=inputs=${cameras.length}[merged]`);
  cmd.push(
    "-filter_complex",
    filterParts.join("; "),
    "-map",
    "[merged]",
    "-ac",
    String(cameras.length),
    "-ar",
    "16000",
    "-f",
    "s16le",
    "-"
  );

  return launchManaged(
    "audio-combined",
    () => ({
      cmd,
      onStdout,
      onStderr: (line) => {
        if (/error|fail/i.test(line)) {
          console.error(`[combined] ${line}`);
        }
      },
    }),
    { restartDelayMs: 5000 }
  );
}

/**
 * Set up the transcription stack as part of the main restitch process.
 *
 * - Allocates the in-process ring buffer and live stats objects.
 * - Spawns whisper-server (CUDA) as a supervised subprocess.
 * - Waits for whisper-server in the background and, once ready, spawns
 *   the audio fusion ffmpeg pump. Returns immediately so it doesn't
 *   block the rest of index.ts startup (the dashboard panel will show
 *   "waiting" until segments start landing).
 * - Caller passes a shared `processes` array; the supervisor entries
 *   land in it so a single shutdown handler stops everything cleanly.
 *
 * Returns the ring + stats so the dashboard server can read them
 * in-process (no HTTP proxy across services).
 */
export function startTranscription(
  config: Config,
  processes: ManagedProcess[]
): { ring: RingBuffer; stats: LiveStats } {
  const t = config.transcription;
  const ring = new RingBuffer(t.max_entries_per_camera);
  const stats: LiveStats = {
    state: "silent",
    threshold_db: t.silence_threshold_db,
    mono_rms_db: -100,
    per_cam_rms_db: Object.fromEntries(
      config.cameras.map((c) => [c.name, -100])
    ),
    transitions_total: 0,
    last_segment_at: null,
  };

  if (!t.enabled) {
    console.log("[transcribe] disabled in config");
    return { ring, stats };
  }
  if (config.cameras.length === 0) {
    console.error("[transcribe] no cameras configured");
    return { ring, stats };
  }

  const whisperUrl = `http://${t.whisper_server.address.replace(/^:/, "127.0.0.1:")}`;

  console.log("[transcribe] starting whisper-server...");
  processes.push(startWhisperServer(t));

  // Don't block restitch startup on whisper warm-up — the audio pump
  // attaches as soon as whisper is ready, in the background.
  void (async () => {
    try {
      await waitForServer(whisperUrl);
      console.log(`[transcribe] whisper-server ready at ${whisperUrl}`);
      console.log(
        `[transcribe] starting combined pump for ${config.cameras.length} camera(s)`
      );
      processes.push(
        startCombinedPump(config.cameras, config, whisperUrl, ring, stats)
      );
    } catch (err) {
      console.error("[transcribe] whisper-server never came up:", err);
    }
  })();

  return { ring, stats };
}
