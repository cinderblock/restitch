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

## FIX (two parts, both implemented in restitch)
1. **`-fps_mode passthrough` on every output** (`buildCommand` in ffmpeg.ts).
   Live restreamer semantics: never drop/dup frames to hit a CFR target. This
   neutralizes BOTH the gap-fill (no duplication possible) AND the 25fps frame
   drop (no rate conforming). Lowest latency mode. Upstream `fps=N` already made
   inputs CFR, so output stays smooth 30fps.
2. **Fresh baseline per (re)spawn** (`index.ts`): build the ffmpeg command INSIDE
   the launch factory so each restart recomputes `ptsBaselineMicros()`. Keeps PTS
   bounded (~0 at spawn), avoids PTS jumps on restart, lowers display latency.
   Applies to main compositor AND each extra composite.

## Progress log
- [x] Diagnosed: sub-streams = main-process H.264 outputs; full=HEVC works; entry=separate works.
- [x] Confirmed root cause via publish timestamps (stale baseline → CFR gap-fill).
- [ ] Implement fix #1 (fps_mode passthrough).
- [ ] Implement fix #2 (fresh baseline per spawn).
- [ ] Deploy (push → CI → sentinel build/up), monitor CI to completion.
- [ ] Verify: all 4 main outputs publish within seconds of a restart; no choppiness;
      bay internal sync intact (the user could never verify this before — blocked).

## Things not to do
- Don't chase the "reader is too slow" discards — they're caused by my own slow
  capture connections, not a real defect.
- Don't lower writeQueueSize (512 caused real corruption earlier; 16384 is correct).
- Don't disable hardware decode (user explicitly rejected that).
- Don't add per-chain `fps=` filters as the fix — passthrough makes output framerate
  conforming unnecessary and avoids reintroducing filter-level frame drops.
