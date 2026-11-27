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
import { rawStreamName } from "./stitchd.ts";
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

// Bounds on work queued against whisper-server. It transcribes one request at a
// time, so anything past a few in flight is audio that will be stale by the
// time it is heard — and every one of them pins up to max_segment_seconds of
// PCM in memory for as long as it waits.
const WHISPER_TIMEOUT_MS = 120_000;
const MAX_INFLIGHT = 8;

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
    // Each pending request holds its segment's audio. A whisper-server that
    // stops answering must fail these, not collect them.
    signal: AbortSignal.timeout(WHISPER_TIMEOUT_MS),
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
  /** Seconds since the audio pump started delivering. */
  pump_uptime_s: number;
  /** How many seconds of audio the pump is BEHIND real time, cumulatively.
   *  The pump is a live capture, so in the steady state it must deliver
   *  SAMPLE_RATE * channels * 2 bytes per wall-clock second. Any shortfall
   *  means ffmpeg is not draining its RTSP inputs fast enough — which is
   *  exactly when the server starts dropping a slow reader and discarding
   *  frames for those inputs. A lag that grows with uptime is the signature of
   *  progressive drift (amerge waiting ever longer on a laggard input); a lag
   *  that jumps once and stays flat is a one-off stall. */
  pump_lag_s: number;
  /** Delivered bytes as a fraction of what real time demands, over the most
   *  recent window. 1.0 = keeping up; < 1.0 = falling behind right now.
   *  Distinguishes "currently degrading" from "took one hit hours ago". */
  pump_recent_ratio: number;
}

/**
 * The most recent `capacity` mono samples, in one buffer allocated up front.
 *
 * Samples are addressed by absolute index since the pump started (`start` is
 * the oldest still held, `end` one past the newest). Appending past capacity
 * overwrites the oldest audio — that is the policy, not an accident: the pump
 * sizes the ring to the longest stretch a segment can ever need, so anything
 * older is audio nobody will ask for again, and a request that reaches past
 * `start` anyway is refused by `read` for the caller to report.
 *
 * This replaces a grow-and-copy buffer that reallocated and copied its whole
 * ~730 KB contents on every append (>= 10 per second, roughly 13 MB/s of
 * large-ArrayBuffer churn, forever). After days of that, Bun began failing those
 * allocations with "RangeError: Out of memory" on every PCM chunk.
 */
export class MonoRing {
  private readonly buf: Int16Array;
  private written = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`MonoRing capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Int16Array(capacity);
  }

  /** Absolute index of the oldest sample still held. */
  get start(): number {
    return Math.max(0, this.written - this.capacity);
  }

  /** Absolute index one past the newest sample. */
  get end(): number {
    return this.written;
  }

  append(samples: Int16Array): void {
    let src = samples;
    if (src.length > this.capacity) {
      // Only the newest `capacity` of these can be held; the rest would be
      // overwritten by this same call.
      this.written += src.length - this.capacity;
      src = src.subarray(src.length - this.capacity);
    }
    const at = this.written % this.capacity;
    const first = Math.min(src.length, this.capacity - at);
    this.buf.set(src.subarray(0, first), at);
    if (first < src.length) this.buf.set(src.subarray(first), 0);
    this.written += src.length;
  }

  /** A copy of samples [from, to), or null if any of it is no longer (or not
   *  yet) held. */
  read(from: number, to: number): Int16Array | null {
    if (from < this.start || to > this.end || from > to) return null;
    const out = new Int16Array(to - from);
    const at = from % this.capacity;
    const first = Math.min(out.length, this.capacity - at);
    out.set(this.buf.subarray(at, at + first), 0);
    if (first < out.length) out.set(this.buf.subarray(0, out.length - first), first);
    return out;
  }
}

/** Sends one segment of 16 kHz mono s16le to whisper and returns its text. */
export type SegmentTranscriber = (pcm: Uint8Array) => Promise<string>;

/**
 * Build the PCM consumer: max-abs mono mix, per-channel RMS, silence
 * detection, whisper dispatch. stitchd produces the merged N-channel stream it
 * reads.
 */
export function startCombinedPump(
  cameras: Camera[],
  config: Config,
  transcribeSegment: SegmentTranscriber,
  ring: RingBuffer,
  stats: LiveStats
): { onPcm: (chunk: Uint8Array) => void; mono: MonoRing } {
  const t = config.transcription;
  const N = cameras.length;
  const SAMPLE_RATE = 16000;
  const BYTES_PER_SAMPLE = 2;
  const GROUP_SIZE = N * BYTES_PER_SAMPLE; // bytes per output sample (one timestep across all channels)

  // Everything below is in mono samples, absolute since the pump started.
  const PAD = Math.floor((t.pad_ms / 1000) * SAMPLE_RATE);
  const MIN_SEG = Math.floor(t.min_segment_seconds * SAMPLE_RATE);
  const MAX_SEG = Math.floor(t.max_segment_seconds * SAMPLE_RATE);
  const RMS_WINDOW_SAMPLES = Math.max(
    1,
    Math.floor((SAMPLE_RATE * t.rms_window_ms) / 1000)
  );
  const SILENCE_MIN_SAMPLES = Math.floor(
    SAMPLE_RATE * t.silence_min_seconds
  );
  // RMS threshold compared as integer amplitude (16-bit range).
  const THRESHOLD_AMP = Math.pow(10, t.silence_threshold_db / 20) * 32768;

  // --- Rolling mono PCM, fixed size ---
  // The longest history a segment can need: a speech run is force-flushed once
  // it passes MAX_SEG (checked each window, and a pending/speaking flicker can
  // carry it one window further), a segment ended by silence is flushed
  // SILENCE_MIN after it ends, and each side gets PAD. One second of slack on
  // top. A segment that still reaches past this is dropped loudly in
  // flushSegment.
  const mono = new MonoRing(
    MAX_SEG + SILENCE_MIN_SAMPLES + 2 * PAD + 2 * RMS_WINDOW_SAMPLES + SAMPLE_RATE
  );
  // A chunk can end mid-timestep; the bytes of that partial group wait here.
  const partial = new Uint8Array(GROUP_SIZE);
  let partialLen = 0;
  // Mixed samples of the chunk being processed. Reused; grows to the largest
  // chunk seen, which the pipe bounds.
  let scratch = new Int16Array(0);

  // --- Per-camera RMS history (one bin per completed RMS window) ---
  // Trimmed with the ring, so it holds at most mono.capacity / window bins.
  type RmsBin = { sampleOffset: number; perCam: number[] };
  const rmsHistory: RmsBin[] = [];

  // --- Current window accumulators ---
  let windowSamples = 0;
  let windowMonoSumSq = 0;
  const windowChanSumSq = new Float64Array(N);

  // --- Silence-detection state machine ---
  let state: "silent" | "speaking" | "pending" = "silent";
  let speechStart = 0;
  let silencePotentialStart = 0;
  let silencePendingSamples = 0;

  let inflight = 0;

  // --- Pump lag instrumentation -------------------------------------------
  // Measures whether ffmpeg is keeping up with real time. Byte-triggered
  // rather than timer-driven on purpose: startCombinedPump() is re-invoked on
  // every pump restart, and a setInterval here would outlive the pump it
  // belongs to and leak one timer per restart.
  const BYTES_PER_SEC_TOTAL = SAMPLE_RATE * GROUP_SIZE; // all channels
  let pumpStartMs = 0; // set on first chunk, not launch (ffmpeg needs to connect)
  let bytesIn = 0;
  let lastLogBytes = 0;
  let windowStartMs = 0;
  let windowStartBytes = 0;
  const LOG_EVERY_BYTES = BYTES_PER_SEC_TOTAL * 300; // ~5 min of audio

  function recordBytes(n: number): void {
    const now = Date.now();
    if (pumpStartMs === 0) {
      pumpStartMs = now;
      windowStartMs = now;
      return; // no elapsed time yet — a ratio here would divide by ~0
    }
    bytesIn += n;

    const elapsedS = (now - pumpStartMs) / 1000;
    const expected = elapsedS * BYTES_PER_SEC_TOTAL;
    stats.pump_uptime_s = Math.round(elapsedS);
    stats.pump_lag_s = Math.max(0, (expected - bytesIn) / BYTES_PER_SEC_TOTAL);

    const winMs = now - windowStartMs;
    if (winMs >= 60_000) {
      const winExpected = (winMs / 1000) * BYTES_PER_SEC_TOTAL;
      stats.pump_recent_ratio = winExpected > 0 ? (bytesIn - windowStartBytes) / winExpected : 1;
      windowStartMs = now;
      windowStartBytes = bytesIn;
    }

    // Periodic line so hours of history land in the container log next to
    // the server's discard warnings — correlating the two is the whole point.
    if (bytesIn - lastLogBytes >= LOG_EVERY_BYTES) {
      lastLogBytes = bytesIn;
      console.log(
        `[combined] pump: uptime ${(elapsedS / 60).toFixed(1)}min ` +
          `lag ${stats.pump_lag_s.toFixed(2)}s ` +
          `recent ${(stats.pump_recent_ratio * 100).toFixed(1)}% ` +
          `inflight ${inflight}`
      );
    }
  }

  function appendMono(samples: Int16Array): void {
    if (samples.length === 0) return;
    mono.append(samples);
    const cutoff = mono.start;
    let drop = 0;
    while (drop < rmsHistory.length && rmsHistory[drop]!.sampleOffset < cutoff) drop++;
    if (drop > 0) rmsHistory.splice(0, drop);
  }

  /** Cut [start, end) (plus padding) out of the ring now, then transcribe it
   *  in the background. */
  function flushSegment(start: number, end: number): void {
    if (inflight >= MAX_INFLIGHT) {
      console.warn(
        `[combined] ${inflight} segments already waiting on whisper-server — dropped one`
      );
      return;
    }
    if (start < mono.start) {
      // The ring is sized so this cannot happen; if it does, the sizing is
      // wrong and every long segment is being lost — say so, with numbers.
      console.error(
        `[combined] segment of ${((end - start) / SAMPLE_RATE).toFixed(1)}s starts ` +
          `${((mono.start - start) / SAMPLE_RATE).toFixed(1)}s before the oldest audio held ` +
          `(ring holds ${(mono.capacity / SAMPLE_RATE).toFixed(1)}s) — dropped`
      );
      return;
    }
    const padStart = Math.max(mono.start, start - PAD);
    const padEnd = Math.min(mono.end, end + PAD);
    if (padEnd - padStart < MIN_SEG) return;
    // In range by construction: mono.start <= padStart < padEnd <= mono.end.
    const audio = mono.read(padStart, padEnd)!;
    const pcm = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);

    // Compute per-camera mean RMS across all bins that fall inside the
    // unpadded segment [start, end).
    const sumSq = new Float64Array(N);
    let bins = 0;
    for (const bin of rmsHistory) {
      if (bin.sampleOffset >= start && bin.sampleOffset < end) {
        for (let c = 0; c < N; c++) {
          const r = bin.perCam[c]!;
          sumSq[c]! += r * r;
        }
        bins++;
      }
    }

    inflight++;
    void attribute(pcm, sumSq, bins).finally(() => inflight--);
  }

  async function attribute(pcm: Uint8Array, sumSq: Float64Array, bins: number): Promise<void> {
    try {
      const text = await transcribeSegment(pcm);
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
    }
  }

  function finishWindow(): void {
    const samples = windowSamples;
    if (samples === 0) return;
    const monoRms = Math.sqrt(windowMonoSumSq / samples);
    const perCam = new Array<number>(N);
    for (let c = 0; c < N; c++) perCam[c] = Math.sqrt(windowChanSumSq[c]! / samples);

    rmsHistory.push({ sampleOffset: mono.end - samples, perCam });

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
      speechStart = mono.end - samples;
    } else if (state === "speaking" && !above) {
      state = "pending";
      silencePotentialStart = mono.end - samples;
      silencePendingSamples = samples;
    } else if (state === "pending") {
      if (above) {
        state = "speaking";
        silencePendingSamples = 0;
      } else {
        silencePendingSamples += samples;
        if (silencePendingSamples >= SILENCE_MIN_SAMPLES) {
          if (silencePotentialStart > speechStart) {
            flushSegment(speechStart, silencePotentialStart);
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
    if (state === "speaking" && mono.end - speechStart > MAX_SEG) {
      flushSegment(speechStart, mono.end);
      speechStart = mono.end;
    }
  }

  /** Mix `groupCount` whole timesteps of `data`, starting at `byteOffset`. */
  function mixGroups(data: Uint8Array, byteOffset: number, groupCount: number): void {
    if (scratch.length < groupCount) scratch = new Int16Array(groupCount);
    const dv = new DataView(data.buffer, data.byteOffset + byteOffset, groupCount * GROUP_SIZE);
    let committed = 0; // index in `scratch` of first sample not yet in the ring

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
      scratch[g] = maxSigned;
      windowMonoSumSq += maxSigned * maxSigned;
      windowSamples++;

      if (windowSamples >= RMS_WINDOW_SAMPLES) {
        // finishWindow reads mono.end, so the window's samples go in first.
        appendMono(scratch.subarray(committed, g + 1));
        committed = g + 1;
        finishWindow();
      }
    }
    appendMono(scratch.subarray(committed, groupCount));
  }

  const onPcm = (chunk: Uint8Array): void => {
    recordBytes(chunk.length);
    let offset = 0;
    if (partialLen > 0) {
      const take = Math.min(GROUP_SIZE - partialLen, chunk.length);
      partial.set(chunk.subarray(0, take), partialLen);
      partialLen += take;
      offset = take;
      if (partialLen < GROUP_SIZE) return;
      mixGroups(partial, 0, 1);
      partialLen = 0;
    }
    const groupCount = Math.floor((chunk.length - offset) / GROUP_SIZE);
    if (groupCount > 0) mixGroups(chunk, offset, groupCount);
    const rest = chunk.length - offset - groupCount * GROUP_SIZE;
    if (rest > 0) {
      partial.set(chunk.subarray(chunk.length - rest), 0);
      partialLen = rest;
    }
  };

  // stitchd produces the merged PCM on its stdout; this function only owns
  // the consumer side.
  return { onPcm, mono };
}

/**
 * Feed PCM to a consumer built by `make`, and rebuild it when it throws.
 *
 * A consumer that has thrown has state nobody can vouch for, and feeding it
 * the next chunk just throws again — that is how one OOM became eight days of
 * a stack trace per chunk (79 GB of log). So the first throw detaches it
 * (`sink.write = null`, later chunks are dropped by the caller), logs the
 * error once, and builds a fresh consumer after `retryMs`. More than
 * `maxRestarts` failures inside `windowMs` means a fresh consumer does not
 * help — the process itself is unwell — so it escalates to `onFatal`, which
 * exits and lets the container's restart policy start everything clean.
 */
export function superviseConsumer(
  sink: PcmSink,
  make: () => (chunk: Uint8Array) => void,
  opts: {
    retryMs: number;
    maxRestarts: number;
    windowMs: number;
    onFatal: (err: unknown) => void;
  }
): void {
  const failures: number[] = [];
  const attach = (): void => {
    const consume = make();
    const write = (chunk: Uint8Array): void => {
      try {
        consume(chunk);
      } catch (err) {
        if (sink.write === write) sink.write = null;
        const now = Date.now();
        while (failures.length > 0 && now - failures[0]! >= opts.windowMs) failures.shift();
        failures.push(now);
        const window = `${Math.round(opts.windowMs / 60_000)} min`;
        if (failures.length > opts.maxRestarts) {
          console.error(
            `[transcribe] PCM consumer failed ${failures.length} times in ${window} — giving up:`,
            err
          );
          opts.onFatal(err);
          return;
        }
        console.error(
          `[transcribe] PCM consumer failed (${failures.length}/${opts.maxRestarts} restarts ` +
            `in ${window}) — transcription stopped, rebuilding it in ${opts.retryMs / 1000}s:`,
          err
        );
        setTimeout(attach, opts.retryMs);
      }
    };
    sink.write = write;
  };
  attach();
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
/** Somewhere for stitchd's merged PCM to land once whisper is ready. */
export interface PcmSink {
  write: ((chunk: Uint8Array) => void) | null;
}

export function startTranscription(
  config: Config,
  processes: ManagedProcess[],
  /** stitchd supplies the merged PCM here. The sink stays null until whisper
   *  is up, so early bytes are
   *  dropped rather than queued against a server that cannot answer. */
  pcmSink: PcmSink,
  /** Called when the PCM consumer keeps failing however often it is rebuilt.
   *  Expected to stop everything and exit non-zero. */
  onFatal: (err: unknown) => void
): { ring: RingBuffer; stats: LiveStats } {
  const t = config.transcription;
  const ring = new RingBuffer(t.max_entries_per_camera);
  // Only cameras opted in to transcription. Each one is another RTSP input on
  // the single amerge'd ffmpeg and another channel the consumer walks per
  // sample, so this set — not config.cameras — defines the pump's whole cost.
  const cameras = config.cameras.filter((c) => c.transcribe);
  const stats: LiveStats = {
    state: "silent",
    threshold_db: t.silence_threshold_db,
    mono_rms_db: -100,
    // Only transcribed cameras get an RMS row; listing the others would show a
    // permanent -100 dB that reads as "mic is dead" rather than "not listening".
    per_cam_rms_db: Object.fromEntries(cameras.map((c) => [c.name, -100])),
    transitions_total: 0,
    last_segment_at: null,
    pump_uptime_s: 0,
    pump_lag_s: 0,
    pump_recent_ratio: 1,
  };

  if (!t.enabled) {
    console.log("[transcribe] disabled in config");
    return { ring, stats };
  }
  if (config.cameras.length === 0) {
    console.error("[transcribe] no cameras configured");
    return { ring, stats };
  }
  if (cameras.length === 0) {
    console.log("[transcribe] no cameras have transcribe enabled — pump not started");
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
      const skipped = config.cameras.length - cameras.length;
      console.log(
        `[transcribe] attaching to stitchd audio` +
          ` for ${cameras.length} camera(s)` +
          (skipped > 0 ? ` (${skipped} excluded via transcribe: false)` : "")
      );
      superviseConsumer(
        pcmSink,
        () =>
          startCombinedPump(
            cameras,
            config,
            (pcm) => transcribe(whisperUrl, pcm, t.language, t.initial_prompt),
            ring,
            stats
          ).onPcm,
        { retryMs: 10_000, maxRestarts: 3, windowMs: 60 * 60_000, onFatal }
      );
    } catch (err) {
      console.error("[transcribe] whisper-server never came up:", err);
    }
  })();

  return { ring, stats };
}
