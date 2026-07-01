# Composite sub-stream startup stall / corruption

Plan path: `plans/composite-substream-startup-stall.md`

## Goal
Fix the live restitch composites where every output of the **main** ffmpeg process
except the first (`full`, HEVC) — i.e. `full-low`, `the-field`, `john` (the H.264
sub-streams) — either fails to load for many minutes or plays choppy/out-of-sync.
`/entry` (a separate ffmpeg process) always worked, which was the misleading clue.

## Environment
- Box: sentinel (RTX 4090, Ubuntu 24.04), restitch in Docker container `restitch`.
- Live config: jackson `servers/sentinel/restitch/config.yaml` → delivered to
  `/opt/restitch/config.yaml`, dir-mounted read-only at `/etc/restitch`.
- Main compositor: one ffmpeg, 5 NVDEC inputs → vstack → transpose → `split=4` →
  `[split_0]`=full(HEVC), `[split_1..3]`=full-low/the-field/john (H.264, crop+scale).
- `/entry`: separate ffmpeg (doorbell over foyer).
- Restitch code: `src/ffmpeg.ts` (pipeline/command build), `src/index.ts`
  (supervisor launch), `src/process.ts` (`launchManaged` factory).

## ROOT CAUSE (confirmed by mediamtx publish timestamps)
The wall-clock PTS **baseline** (`ptsBaselineMicros()` = `Date.now()*1000`) is
computed ONCE at app startup inside `buildPipeline()` and **baked into the ffmpeg
command string**. The supervisor's launch factory reuses that same command (stale
baseline) on every restart.

Evidence — same process, two start events:
- First start 20:06:46 → all outputs published within ~25s (baseline fresh).
- Restart 20:24:50 → `full` published immediately, but:
  - `full-low` +9m31s, `the-field` +11m42s, `john` +14m (baseline ~18min/1080s stale).

Mechanism: after a restart the first real frame's PTS ≈ (now − stale_baseline) ≈
1080s. The sub-stream branches lose their framerate metadata through `crop/scale`
(ffmpeg logs *"No information about the input framerate ... falling back to 25fps"*),
so ffmpeg runs them as **CFR** and duplicate-fills the gap from PTS 0 → 1080s
(~27k frames) before emitting the first real frame — 9–14 min at ~2× realtime,
scaling with GPU contention per sub-stream. `full` keeps 30fps metadata (split_0,
no crop/scale) so it skips the fill.

Second consequence of the 25fps fallback: when CFR conforms 30fps frames to a 25fps
grid it DROPS ~5 frames/sec → the "slow/laggy / out of sync" the user saw once a
sub-stream finally came up.

Note: the earlier "reader is too slow, discarding frames" corruption was a RED
HERRING — it only occurred while *I* (ffprobe/snapshot captures) connected as slow
readers; 0 discards with no external readers. maxrate caps ARE applied (keyframes
~745KB), writeQueueSize 16384 is fine.

## FIX (two parts)
1. **Fresh baseline per (re)spawn** (`index.ts`): build the ffmpeg command INSIDE
   the launch factory so each restart recomputes `ptsBaselineMicros()`. Keeps PTS
   ~0 at spawn → no gap for CFR to fill → outputs publish in seconds after a
   restart. Applies to main compositor AND each extra composite. THE root-cause fix.
2. **Clean CFR output**: `-fps_mode cfr -r <fps>` on every output (`buildCommand`),
   with the composite/camera fps carried on each `PipelineOutput.fps`. The upstream
   wall-clock setpts (needed for cross-camera sync) leaves slightly non-monotonic
   per-frame PTS; CFR re-quantizes to an even grid. This both restores the correct
   rate on the crop/scale sub-streams (no more 25fps fallback / 5-of-30 frame drop)
   and eliminates the muxer's non-monotonic-DTS warnings. Safe from gap-fill because
   of fix #1 (fresh baseline → no gap).

### Pivot note (why not passthrough)
First deploy used `-fps_mode passthrough` (never drop/dup). It WORKED — verified
clean the-field frame, no decode errors, bays internally synced — but flooded logs
with ~115 non-monotonic-DTS warnings/sec because it forwarded the jittery wall-clock
PTS raw. Switched to CFR, which is what the old default silently did for `full`
(re-quantize the jitter). CFR is the "best" choice: clean logs + clean grid, and
fresh baseline removes the only reason CFR ever misbehaved.

## Progress log
- [x] Diagnosed: sub-streams = main-process H.264 outputs; full=HEVC works; entry=separate works.
- [x] Confirmed root cause via publish timestamps (stale baseline → CFR gap-fill).
- [x] Fix #1 (fresh baseline per spawn) — implemented, deployed, VERIFIED: post-restart
      all 4 outputs recover in seconds; clean decode; bays synced (frame ts matched).
- [x] Fix #2 first attempt: `-fps_mode passthrough` — deployed, works but DTS log spam.
- [x] Fix #2 final: `-fps_mode cfr -r <fps>` — implemented + build-verified locally.
- [ ] Commit + deploy CFR version, monitor CI to completion.
- [ ] Verify on box: DTS warnings gone (~0/sec); clean decode; fast publish after a
      supervisor restart; bay sync still intact.

## FOLLOW-UP BUG (found ~20h after deploy): orphan compositor pile-up
Symptom: "composite streams are all down." Container up ~20h had **4** main-
compositor ffmpeg processes alive at once (ages 17h/17h/14.6h/20s, all `Sl`).
Four compositors × 4 NVENC sessions each exhausted NVENC → none could hold the
publish → all composites `source=none`.

Root cause (process.ts + watchdog.ts interaction):
- `restart()` used `proc.kill()` = **SIGTERM only**. A compositor wedged on a
  half-dead RTSP input ignores SIGTERM until its 30s input timeout, so
  `await proc.exited` hangs.
- watchdog `setInterval(() => void tick())` was **not awaited / not re-entrant**;
  after the 45s grace, a still-stalled path fired `restart()` **again** on the
  same hung `proc`.
- When the wedged ffmpeg finally died, EVERY hung `restart()` resumed and each
  ran `proc = spawn()`; only the last assignment was tracked → the rest became
  **orphans nothing ever kills**. Repeat over hours → pile-up.

Fix:
- process.ts: `restart()`/`stop()` now SIGTERM then **SIGKILL after 5s** if not
  exited (never wedge on `await exited`); `restart()` guarded against re-entry
  (`restarting` flag).
- watchdog.ts: tick made **non-reentrant** (skip if a prior tick still running).

Immediate recovery on the box: `docker restart restitch` (cleared the pile-up →
single clean compositor, all composites back up). Fix deployed so it can't recur.

## Things not to do
- Don't chase the "reader is too slow" discards — they're caused by my own slow
  capture connections, not a real defect.
- Don't lower writeQueueSize (512 caused real corruption earlier; 16384 is correct).
- Don't disable hardware decode (user explicitly rejected that).
- Don't add per-chain `fps=` filters as the fix — passthrough makes output framerate
  conforming unnecessary and avoids reintroducing filter-level frame drops.
