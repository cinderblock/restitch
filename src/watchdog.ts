/**
 * Watchdog: periodically polls mediamtx and restarts ffmpeg processes that are
 * alive but stuck (the supervisor only restarts on process exit). Two triggers:
 *
 *  1. Output byte-stall — a watched output path's bytesReceived hasn't grown in
 *     stallMs (the publisher wedged).
 *  2. Input source reconnect — a watched INPUT path's readyTime changed, meaning
 *     its source dropped and reconnected. ffmpeg's read of it can stay wedged on
 *     the dead connection while the fps filter duplicates the last frame, so one
 *     composite half freezes but bytes keep flowing (byte-stall can't see it).
 *     Restart to re-establish a clean read.
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
  /** mediamtx path names this process READS as inputs (e.g. raw/foyer). When
   *  one of these paths' source reconnects, ffmpeg's read of it can wedge on the
   *  dead connection while the fps filter keeps duplicating the last frame —
   *  that half of the composite freezes but bytes keep flowing, so the byte-rate
   *  check is blind. mediamtx reports each path's readyTime; when it changes, the
   *  source reconnected, so we restart this process to re-establish a clean read.
   *  This is the actual trigger for the entry/foyer freeze (the freeze timestamp
   *  matched raw/foyer's readyTime exactly). */
  inputPaths?: string[];
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
  // Last-seen readyTime per `${watchedIndex}:${inputPath}` — a change means the
  // input's source reconnected (see inputPaths on WatchedProcess).
  const inputReadyTime = new Map<string, string>();

  type PathsList = {
    items?: {
      name: string;
      bytesReceived?: number;
      ready?: boolean;
      readyTime?: string | null;
    }[];
  };
  const tick = async () => {
    let paths: PathsList;
    try {
      const r = await fetch(`${apiBase}/v3/paths/list`);
      if (!r.ok) {
        console.warn(`[watchdog] paths/list ${r.status}`);
        return;
      }
      paths = (await r.json()) as PathsList;
    } catch (e) {
      console.warn(`[watchdog] paths/list fetch failed:`, e);
      return;
    }

    const byName = new Map<
      string,
      { bytesReceived: number; ready: boolean; readyTime: string | null }
    >();
    for (const p of paths.items ?? []) {
      byName.set(p.name, {
        bytesReceived: p.bytesReceived ?? 0,
        ready: !!p.ready,
        readyTime: p.readyTime ?? null,
      });
    }

    const now = Date.now();
    for (let i = 0; i < watched.length; i++) {
      const w = watched[i]!;
      const since = restartedAt.get(i);
      if (since !== undefined && now - since < graceMs) continue;

      // Input source-reconnect check. If any input path's readyTime changed, its
      // source reconnected and our read of it may be wedged on the old
      // connection — restart to re-establish a clean read. This is the real
      // trigger for the entry/foyer freeze.
      if (w.inputPaths && w.inputPaths.length > 0) {
        let reconnected: string | null = null;
        for (const path of w.inputPaths) {
          const rt = byName.get(path)?.readyTime;
          if (!rt) continue; // source not ready yet — nothing to compare
          const key = `${i}:${path}`;
          const prev = inputReadyTime.get(key);
          inputReadyTime.set(key, rt);
          if (prev !== undefined && prev !== rt) reconnected = path;
        }
        if (reconnected) {
          console.warn(
            `[watchdog] ${w.name}: input ${reconnected} source reconnected — ` +
              `restarting to avoid a wedged read`
          );
          restartedAt.set(i, now);
          for (const path of w.paths) state.delete(`${i}:${path}`);
          try {
            await w.process.restart();
          } catch (e) {
            console.error(`[watchdog] ${w.name}: reconnect restart failed:`, e);
          }
          continue;
        }
      }

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

  return {
    stop() {
      clearInterval(handle);
    },
  };
}
