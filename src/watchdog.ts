/**
 * Watchdog: periodically polls mediamtx and restarts ffmpeg processes
 * whose output paths have stopped receiving bytes. Catches the failure
 * mode where ffmpeg is alive but stuck — supervisor only restarts on
 * process exit, which doesn't fire on a stall.
 *
 * Tracks bytesReceived per path (publisher → mediamtx). If a watched
 * path's counter hasn't grown in STALL_THRESHOLD_MS, the ffmpeg
 * publishing to it is killed and the supervisor brings it back.
 */

import type { ManagedProcess } from "./process.ts";

export interface WatchedProcess {
  /** Display name for log messages. */
  name: string;
  /** mediamtx path names this process publishes to. */
  paths: string[];
  /** The supervisor entry for the ffmpeg. */
  process: ManagedProcess;
  /** If set, restart this process every N ms regardless of byte flow.
   *  Workaround for the doorbell+vstack slow-leak where the encoded
   *  output keeps publishing but one input branch silently freezes,
   *  which the byte-rate check can't detect (output bytes keep growing). */
  periodicRestartMs?: number;
  /** Content-freshness check: split the output frame (paths[0]) into this many
   *  equal bands — one per stacked input — and restart the process if any band
   *  stops changing (a silently-frozen input branch: the RTSP read wedges, the
   *  fps filter keeps duplicating the last frame, so bytes still flow and the
   *  byte-rate check above is blind). A live camera's burned-in clock overlay
   *  changes every second, so a truly frozen band goes pixel-static while a
   *  merely-quiet-but-live band does not — that's what makes this false-positive
   *  resistant. Omit to skip (e.g. the main compositor, whose rotated multi-bay
   *  geometry doesn't map to simple bands). */
  freshnessBands?: number;
  /** Band orientation: "rows" for a vertical stack (bands stacked top→bottom),
   *  "cols" for a horizontal stack. Default "rows". */
  freshnessAxis?: "rows" | "cols";
}

interface PathState {
  lastBytes: number;
  lastChangeAt: number;
}

export interface WatchdogOptions {
  /** mediamtx control API base URL. Default: http://localhost:9997 */
  mediamtxApi?: string;
  /** Poll interval in ms. Default: 15_000 */
  pollMs?: number;
  /** Considered stalled if bytesReceived hasn't grown in this many ms.
   *  Default: 60_000 */
  stallMs?: number;
  /** Grace period after a restart before we start watching the process
   *  again (lets ffmpeg reconnect to its inputs). Default: 45_000 */
  postRestartGraceMs?: number;
  /** ffmpeg binary path — required for the content-freshness check. */
  ffmpegPath?: string;
  /** mediamtx RTSP base URL (e.g. rtsp://localhost:8554) — required for the
   *  content-freshness check. */
  baseUrl?: string;
  /** How often to sample each freshness-watched output. Default: 30_000 */
  freshnessMs?: number;
  /** A band pixel-static for at least this long is treated as frozen.
   *  Default: 150_000 (5 samples at the 30s cadence). */
  freezeMs?: number;
}

// --- Content-freshness fingerprinting -------------------------------------
// We sample each watched composite as a tiny 64x64 gray frame (nearest-neighbor
// downscale so per-pixel content — including the ticking clock overlay — is
// preserved, not averaged away), hash it as an 8x8 grid of cells, and track how
// long each cell has been pixel-identical. A band is "frozen" when EVERY one of
// its cells has been identical past freezeMs.
const FP_SIZE = 64; // sampled frame is FP_SIZE x FP_SIZE gray
const GRID = 8; // 8x8 = 64 cells
const CELL = FP_SIZE / GRID;

/** Hash each of the 64 grid cells of a 64x64 gray raw frame (FNV-1a). */
export function hashCells(buf: Uint8Array): number[] {
  const cells: number[] = [];
  for (let cr = 0; cr < GRID; cr++) {
    for (let cc = 0; cc < GRID; cc++) {
      let h = 2166136261;
      for (let dr = 0; dr < CELL; dr++) {
        const base = (cr * CELL + dr) * FP_SIZE + cc * CELL;
        for (let dc = 0; dc < CELL; dc++) {
          h ^= buf[base + dc]!;
          h = Math.imul(h, 16777619);
        }
      }
      cells.push(h >>> 0);
    }
  }
  return cells;
}

/** Cell indices (0..63, row-major) belonging to band b of `bands`. */
export function cellsInBand(
  b: number,
  bands: number,
  axis: "rows" | "cols"
): number[] {
  const start = Math.floor((b * GRID) / bands);
  const end = Math.floor(((b + 1) * GRID) / bands);
  const out: number[] = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const k = axis === "cols" ? c : r;
      if (k >= start && k < end) out.push(r * GRID + c);
    }
  }
  return out;
}

export interface FreshnessState {
  hashes: number[]; // last seen per-cell hash (64)
  since: number[]; // ms timestamp each cell last changed (64)
}

/**
 * Fold a new fingerprint into the per-cell freshness state and decide whether
 * any band is frozen. Pure (no I/O) so it can be unit-tested. Returns the
 * updated state and the first frozen band index (or -1). On the first sample
 * (no prior state) it just seeds and returns nothing frozen.
 */
export function evaluateFreshness(
  prev: FreshnessState | undefined,
  hashes: number[],
  now: number,
  bands: number,
  axis: "rows" | "cols",
  freezeMs: number
): { state: FreshnessState; frozenBand: number } {
  if (!prev) {
    return { state: { hashes, since: hashes.map(() => now) }, frozenBand: -1 };
  }
  const since = prev.since.slice();
  for (let c = 0; c < hashes.length; c++) {
    if (hashes[c] !== prev.hashes[c]) since[c] = now;
  }
  let frozenBand = -1;
  for (let b = 0; b < bands; b++) {
    const cells = cellsInBand(b, bands, axis);
    if (cells.every((idx) => now - since[idx]! >= freezeMs)) {
      frozenBand = b;
      break;
    }
  }
  return { state: { hashes, since }, frozenBand };
}

/** Grab a 64x64 gray fingerprint of an RTSP stream. null on any failure. */
async function fingerprint(
  ffmpegPath: string,
  url: string
): Promise<Uint8Array | null> {
  try {
    const proc = Bun.spawn(
      [
        ffmpegPath,
        "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-timeout", "10000000",
        "-i", url,
        "-frames:v", "1",
        "-vf", `scale=${FP_SIZE}x${FP_SIZE}:flags=neighbor,format=gray`,
        "-f", "rawvideo",
        "-",
      ],
      { stdout: "pipe", stderr: "ignore" }
    );
    const buf = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;
    return buf.length >= FP_SIZE * FP_SIZE ? buf.subarray(0, FP_SIZE * FP_SIZE) : null;
  } catch {
    return null;
  }
}

export function startWatchdog(
  watched: WatchedProcess[],
  opts: WatchdogOptions = {}
): { stop: () => void } {
  const apiBase = (opts.mediamtxApi ?? "http://localhost:9997").replace(/\/$/, "");
  const pollMs = opts.pollMs ?? 15_000;
  const stallMs = opts.stallMs ?? 60_000;
  const graceMs = opts.postRestartGraceMs ?? 45_000;

  // Per-process per-path state, indexed by `${watchedIndex}:${pathName}`.
  const state = new Map<string, PathState>();
  // Wall-clock of last manual restart per process index (debounces).
  const restartedAt = new Map<number, number>();
  // First-seen timestamp per process for the periodic-restart cadence.
  const watchStartedAt = new Map<number, number>();

  const tick = async () => {
    let paths: { items?: { name: string; bytesReceived?: number; ready?: boolean }[] };
    try {
      const r = await fetch(`${apiBase}/v3/paths/list`);
      if (!r.ok) {
        console.warn(`[watchdog] paths/list ${r.status}`);
        return;
      }
      paths = await r.json();
    } catch (e) {
      console.warn(`[watchdog] paths/list fetch failed:`, e);
      return;
    }

    const byName = new Map<string, { bytesReceived: number; ready: boolean }>();
    for (const p of paths.items ?? []) {
      byName.set(p.name, {
        bytesReceived: p.bytesReceived ?? 0,
        ready: !!p.ready,
      });
    }

    const now = Date.now();
    for (let i = 0; i < watched.length; i++) {
      const w = watched[i]!;
      const since = restartedAt.get(i);
      if (since !== undefined && now - since < graceMs) continue;

      // Periodic restart workaround (per-process opt-in)
      if (w.periodicRestartMs) {
        const baseline = restartedAt.get(i) ?? watchStartedAt.get(i);
        if (baseline === undefined) {
          watchStartedAt.set(i, now);
        } else if (now - baseline >= w.periodicRestartMs) {
          console.warn(
            `[watchdog] ${w.name}: periodic restart (every ${Math.round(
              w.periodicRestartMs / 60000
            )} min)`
          );
          restartedAt.set(i, now);
          for (const path of w.paths) state.delete(`${i}:${path}`);
          try {
            await w.process.restart();
          } catch (e) {
            console.error(`[watchdog] ${w.name}: periodic restart failed:`, e);
          }
          continue;
        }
      }

      let allStale = w.paths.length > 0;
      let anyKnown = false;
      const stalledPaths: string[] = [];
      for (const path of w.paths) {
        const cur = byName.get(path);
        if (!cur) continue;
        anyKnown = true;
        const key = `${i}:${path}`;
        let s = state.get(key);
        if (!s) {
          s = { lastBytes: cur.bytesReceived, lastChangeAt: now };
          state.set(key, s);
          allStale = false;
          continue;
        }
        if (cur.bytesReceived !== s.lastBytes) {
          s.lastBytes = cur.bytesReceived;
          s.lastChangeAt = now;
          allStale = false;
        } else if (now - s.lastChangeAt < stallMs) {
          allStale = false;
        } else {
          stalledPaths.push(path);
        }
      }

      if (anyKnown && allStale) {
        console.warn(
          `[watchdog] ${w.name}: no bytes on ${stalledPaths.join(", ")} for ${Math.round(
            stallMs / 1000
          )}s — restarting`
        );
        restartedAt.set(i, now);
        // Reset baselines so the next tick treats the new bytes as fresh
        for (const path of w.paths) state.delete(`${i}:${path}`);
        try {
          await w.process.restart();
        } catch (e) {
          console.error(`[watchdog] ${w.name}: restart failed:`, e);
        }
      }
    }
  };

  // Non-reentrant: a tick that restarts one or more wedged processes can take
  // several seconds (SIGTERM → force-kill → respawn each). If the interval
  // fired again meanwhile, two ticks could each decide the same path is stale
  // and stack restarts. Skip a tick while the previous one is still running.
  let ticking = false;
  const runTick = () => {
    if (ticking) return;
    ticking = true;
    void tick().finally(() => {
      ticking = false;
    });
  };

  const handle = setInterval(runTick, pollMs);
  // Fire once after a short delay so we don't restart everything on a
  // cold start before any process has had a chance to publish.
  setTimeout(runTick, Math.min(pollMs, 5_000));

  // --- Content-freshness loop (detects silently-frozen input branches) ------
  const freshnessMs = opts.freshnessMs ?? 30_000;
  const freezeMs = opts.freezeMs ?? 150_000;
  const fpState = new Map<number, FreshnessState>();
  const freshWatched = watched.some((w) => w.freshnessBands && w.freshnessBands > 0);

  const checkFreshness = async () => {
    if (!opts.ffmpegPath || !opts.baseUrl) return;
    const now = Date.now();
    await Promise.all(
      watched.map(async (w, i) => {
        if (!w.freshnessBands || w.freshnessBands <= 0) return;
        // Respect the post-restart grace so we don't sample a stream that's
        // still reconnecting, and don't stack on top of a byte-stall restart.
        const since = restartedAt.get(i);
        if (since !== undefined && now - since < graceMs) return;

        const fp = await fingerprint(opts.ffmpegPath!, `${opts.baseUrl}/${w.paths[0]}`);
        if (!fp) return; // grab failed — skip (byte watchdog handles down streams)

        const sampleNow = Date.now();
        const { state: nextState, frozenBand } = evaluateFreshness(
          fpState.get(i),
          hashCells(fp),
          sampleNow,
          w.freshnessBands,
          w.freshnessAxis ?? "rows",
          freezeMs
        );
        fpState.set(i, nextState);
        if (frozenBand < 0) return;

        console.warn(
          `[watchdog] ${w.name}: band ${frozenBand + 1}/${w.freshnessBands} ` +
            `pixel-static for ${Math.round(freezeMs / 1000)}s (frozen input) — restarting`
        );
        restartedAt.set(i, sampleNow);
        fpState.delete(i); // reset so the fresh process starts clean
        for (const p of w.paths) state.delete(`${i}:${p}`);
        try {
          await w.process.restart();
        } catch (e) {
          console.error(`[watchdog] ${w.name}: freshness restart failed:`, e);
        }
      })
    );
  };

  let freshTicking = false;
  const runFreshness = () => {
    if (freshTicking) return;
    freshTicking = true;
    void checkFreshness().finally(() => {
      freshTicking = false;
    });
  };
  const freshHandle =
    freshWatched && opts.ffmpegPath && opts.baseUrl
      ? setInterval(runFreshness, freshnessMs)
      : null;

  return {
    stop() {
      clearInterval(handle);
      if (freshHandle) clearInterval(freshHandle);
    },
  };
}
