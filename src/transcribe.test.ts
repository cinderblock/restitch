import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ConfigSchema } from "./config.ts";
import {
  MonoRing,
  RingBuffer,
  startCombinedPump,
  superviseConsumer,
  type LiveStats,
  type PcmSink,
} from "./transcribe.ts";

const SR = 16000;
// Defaults from config.ts, in samples.
const PAD = 3200; // pad_ms 200
const MAX_SEG = 320000; // max_segment_seconds 20
const WINDOW = 1600; // rms_window_ms 100

function sequence(from: number, n: number): Int16Array {
  return Int16Array.from({ length: n }, (_, i) => (from + i) % 32768);
}

describe("MonoRing", () => {
  test("holds only the newest `capacity` samples, across wraps", () => {
    const ring = new MonoRing(1000);
    let fed = 0;
    for (const n of [300, 700, 1, 999, 450, 1000, 2]) {
      ring.append(sequence(fed, n));
      fed += n;
      expect(ring.end).toBe(fed);
      expect(ring.start).toBe(Math.max(0, fed - 1000));
      expect(ring.read(ring.start, ring.end)).toEqual(sequence(ring.start, ring.end - ring.start));
    }
  });

  test("an append bigger than the ring keeps its tail", () => {
    const ring = new MonoRing(1000);
    ring.append(sequence(0, 123));
    ring.append(sequence(123, 2500));
    expect(ring.end).toBe(2623);
    expect(ring.start).toBe(1623);
    expect(ring.read(1623, 2623)).toEqual(sequence(1623, 1000));
  });

  test("refuses ranges it no longer (or does not yet) hold", () => {
    const ring = new MonoRing(1000);
    ring.append(sequence(0, 1500));
    expect(ring.read(499, 600)).toBeNull();
    expect(ring.read(500, 1501)).toBeNull();
    expect(ring.read(600, 500)).toBeNull();
    expect(ring.read(500, 500)).toEqual(new Int16Array(0));
  });

  test("rejects a capacity that is not a positive integer", () => {
    expect(() => new MonoRing(0)).toThrow(RangeError);
    expect(() => new MonoRing(NaN)).toThrow(RangeError);
    expect(() => new MonoRing(10.5)).toThrow(RangeError);
  });
});

// --- Pump ------------------------------------------------------------------

const CAMS = ["a", "b", "c"];

function makePump() {
  const config = ConfigSchema.parse({
    cameras: CAMS.map((name, order) => ({ name, url: `rtsp://127.0.0.1/${name}`, order })),
  });
  const stats: LiveStats = {
    state: "silent",
    threshold_db: config.transcription.silence_threshold_db,
    mono_rms_db: -100,
    per_cam_rms_db: {},
    transitions_total: 0,
    last_segment_at: null,
    pump_uptime_s: 0,
    pump_lag_s: 0,
    pump_recent_ratio: 1,
  };
  const ring = new RingBuffer(1000);
  const segments: Int16Array[] = [];
  const pump = startCombinedPump(
    config.cameras,
    config,
    async (pcm) => {
      segments.push(new Int16Array(pcm.slice().buffer));
      return `segment ${segments.length}`;
    },
    ring,
    stats
  );
  return { pump, ring, segments };
}

/** Deterministic loud noise (speech) or near-silence, unique enough per index
 *  that a misplaced segment cannot match by accident. */
function mono(i: number, loud: boolean): number {
  const h = Math.imul(i, 2654435761) >>> 0;
  const mag = loud ? 8000 + (h % 8000) : h % 11;
  return h & 1 ? mag : -mag;
}

/**
 * Interleaved 3-channel s16le for samples [from, to). Channel `loudest` carries
 * the signal; the others carry half of it, so the max-abs mix is exactly
 * `mono(i)`.
 */
function interleave(from: number, to: number, isLoud: (i: number) => boolean, loudest: (i: number) => number) {
  const out = new Int16Array((to - from) * CAMS.length);
  const expected = new Int16Array(to - from);
  for (let i = from; i < to; i++) {
    const v = mono(i, isLoud(i));
    expected[i - from] = v;
    for (let c = 0; c < CAMS.length; c++) {
      out[(i - from) * CAMS.length + c] = c === loudest(i) ? v : Math.trunc(v / 2);
    }
  }
  return { bytes: new Uint8Array(out.buffer), expected };
}

// One cycle: 1 s silence, 20 x (3 s speech, 2 s silence), a 70 s monologue
// (past max_segment_seconds three times over), 2 s silence.
const BURSTS = 20;
const BURST = 3 * SR;
const BURST_PERIOD = 5 * SR;
const LEAD = SR;
const MONO_START = LEAD + BURSTS * BURST_PERIOD;
const MONOLOGUE = 70 * SR;
const CYCLE = MONO_START + MONOLOGUE + 2 * SR;

function loudAt(i: number): boolean {
  const p = i % CYCLE;
  if (p < LEAD) return false;
  if (p < MONO_START) return (p - LEAD) % BURST_PERIOD < BURST;
  return p < MONO_START + MONOLOGUE;
}

/** The padded [start, end) of every segment one cycle starting at `b` yields. */
function expectedSegments(b: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let k = 0; k < BURSTS; k++) {
    const s = b + LEAD + k * BURST_PERIOD;
    out.push([s - PAD, s + BURST + PAD]);
  }
  // Forced flushes: the first window that takes the run past MAX_SEG ends a
  // segment there (no right pad: that is the newest audio), and the next run
  // starts at it (left pad overlaps the previous segment).
  const m = b + MONO_START;
  const forced = MAX_SEG + WINDOW;
  let s = m;
  while (m + MONOLOGUE - s > forced) {
    out.push([s - PAD, s + forced]);
    s += forced;
  }
  out.push([s - PAD, m + MONOLOGUE + PAD]);
  return out;
}

describe("combined pump", () => {
  const spies: Array<ReturnType<typeof spyOn>> = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });
  function quiet() {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    spies.push(warn, error, log);
    return { warn, error };
  }

  test("runs many times past the ring's capacity with constant memory and every segment intact", async () => {
    const { warn, error } = quiet();
    const { pump, ring, segments } = makePump();
    const cycles = 3; // ~8.7 min of audio, ~23x the ring
    const total = cycles * CYCLE;
    const expected = new Int16Array(total);
    // A chunk size that is not a multiple of the 6-byte timestep, so groups
    // straddle chunks the way pipe reads do.
    const CHUNK_SAMPLES = 4093;
    for (let from = 0; from < total; from += CHUNK_SAMPLES) {
      const to = Math.min(total, from + CHUNK_SAMPLES);
      const { bytes, expected: e } = interleave(from, to, loudAt, (i) => Math.floor(i / CYCLE) % 3);
      expected.set(e, from);
      // Split each chunk at an odd byte offset too.
      const cut = 7;
      pump.onPcm(bytes.subarray(0, cut));
      pump.onPcm(bytes.subarray(cut));
      expect(pump.mono.end - pump.mono.start).toBeLessThanOrEqual(pump.mono.capacity);
      // Let the fake transcriber's promises settle, as the event loop would
      // between real pipe reads.
      await new Promise((r) => setImmediate(r));
    }

    expect(pump.mono.end).toBe(total);
    expect(pump.mono.start).toBe(total - pump.mono.capacity);
    // The whole point: a fixed ~22 s, not a buffer that tracks uptime.
    expect(pump.mono.capacity).toBeLessThan(25 * SR);

    const want = Array.from({ length: cycles }, (_, k) => expectedSegments(k * CYCLE)).flat();
    expect(segments.map((s) => s.length)).toEqual(want.map(([s, e]) => e - s));
    for (let k = 0; k < want.length; k++) {
      const [s, e] = want[k]!;
      expect(segments[k]!).toEqual(expected.subarray(s, e));
    }

    const entries = ring.recent(1000).reverse();
    expect(entries.length).toBe(want.length);
    const perCycle = want.length / cycles;
    entries.forEach((entry, k) => expect(entry.primary_camera).toBe(CAMS[Math.floor(k / perCycle) % 3]!));

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("one chunk bigger than the whole ring still yields every segment", async () => {
    const { warn, error } = quiet();
    const { pump, segments } = makePump();
    const speech = 40 * SR;
    const total = speech + 2 * SR;
    const { bytes, expected } = interleave(0, total, (i) => i < speech, () => 1);
    expect(total).toBeGreaterThan(pump.mono.capacity);

    pump.onPcm(bytes);
    await new Promise((r) => setImmediate(r));

    expect(pump.mono.end).toBe(total);
    const forced = MAX_SEG + WINDOW;
    const want: Array<[number, number]> = [
      [0, forced], // nothing before sample 0 to pad with
      [forced - PAD, speech + PAD],
    ];
    expect(segments.map((s) => s.length)).toEqual(want.map(([s, e]) => e - s));
    want.forEach(([s, e], k) => expect(segments[k]!).toEqual(expected.subarray(s, e)));
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

// --- Supervision -------------------------------------------------------------

describe("superviseConsumer", () => {
  test("a throwing consumer is logged once, detached, and rebuilt; repeated failure escalates", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const sink: PcmSink = { write: null };
      let built = 0;
      let delivered = 0;
      const fatal: unknown[] = [];
      superviseConsumer(
        sink,
        () => {
          built++;
          return () => {
            delivered++;
            throw new RangeError("Out of memory");
          };
        },
        { retryMs: 5, maxRestarts: 2, windowMs: 60_000, onFatal: (e) => fatal.push(e) }
      );
      const chunk = new Uint8Array(6);
      const feed = (n: number) => {
        for (let i = 0; i < n; i++) sink.write?.(chunk);
      };

      // First failure: one log line, consumer detached, so the next 99 chunks
      // never reach it (and log nothing).
      feed(100);
      expect(delivered).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(sink.write).toBeNull();

      // Rebuilt after retryMs; it fails again.
      await Bun.sleep(30);
      expect(built).toBe(2);
      feed(100);
      expect(delivered).toBe(2);
      expect(error).toHaveBeenCalledTimes(2);
      expect(fatal).toHaveLength(0);

      // Third failure inside the window exceeds maxRestarts: escalate, and do
      // not rebuild again.
      await Bun.sleep(30);
      expect(built).toBe(3);
      feed(100);
      expect(error).toHaveBeenCalledTimes(3);
      expect(fatal).toHaveLength(1);
      expect(fatal[0]).toBeInstanceOf(RangeError);
      await Bun.sleep(30);
      expect(built).toBe(3);
      expect(sink.write).toBeNull();
    } finally {
      error.mockRestore();
    }
  });

  test("a consumer that does not throw is left alone", () => {
    const sink: PcmSink = { write: null };
    let delivered = 0;
    superviseConsumer(sink, () => () => void delivered++, {
      retryMs: 5,
      maxRestarts: 1,
      windowMs: 60_000,
      onFatal: () => {
        throw new Error("unexpected");
      },
    });
    for (let i = 0; i < 1000; i++) sink.write?.(new Uint8Array(6));
    expect(delivered).toBe(1000);
  });
});
