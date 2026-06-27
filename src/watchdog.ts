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

  const handle = setInterval(() => {
    void tick();
  }, pollMs);
  // Fire once after a short delay so we don't restart everything on a
  // cold start before any process has had a chance to publish.
  setTimeout(() => void tick(), Math.min(pollMs, 5_000));

  return {
    stop() {
      clearInterval(handle);
    },
  };
}
