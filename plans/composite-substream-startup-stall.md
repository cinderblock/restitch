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
- [x] Commit + deploy CFR version — DTS warnings 0/sec, clean decode, bays synced.
- [x] Follow-up: diagnosed + fixed orphan compositor pile-up (see section below);
      recovered box via `docker restart restitch`; deployed force-kill + non-reentrant
      watchdog fix; verified fresh container = 1 compositor + 1 entry, all composites up.
- [ ] Monitor over hours: confirm no compositor pile-up recurs (steady 1 process).
- [ ] Optional: wedge-simulation test (SIGSTOP compositor → watchdog SIGKILLs it →
      exactly 1 respawn) to prove the fix — deferred (disrupts live streams ~75s).

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

## FOLLOW-UP BUG #2: entry composite "broken bottom half" (frozen input branch)
Symptom: entry composite's bottom half (foyer) stuck ~7h in the past — showed
03:26 AM night-vision IR while `raw/foyer` was live at 10:45 AM daylight color.
Top half (doorbell) was live. Not corruption — a **frozen input branch**.

Diagnosis:
- entry ffmpeg proc age was 17.4h. No decode errors. `raw/foyer` source was
  live/clean (verified direct capture). Two entry captures minutes apart showed
  the foyer half's burned-in timestamp identically stuck at `03:26:57`.
- Mechanism: the entry ffmpeg's foyer RTSP input silently wedged ~03:26 AM
  (no error, `-timeout 30000000` didn't fire). `fps=30` then **duplicated the
  last foyer frame** indefinitely to hold 30fps, so vstack + output kept
  publishing at a healthy byte rate → the byte-rate watchdog is blind to it.
- This is exactly the failure the removed `periodicRestartMs` workaround covered;
  it was dropped assuming the setpts fix addressed it — it didn't (different bug).
- Exact 03:26 trigger unknown (docker logs rotated; only ~17 min retained). No
  foyer readiness flap in the retained window.

Immediate recovery: `pkill -f xc_stacked` (the entry filtergraph label) → supervisor
respawned entry → foyer half live again (verified: bottom half now 10:52 AM color,
synced with top). One entry process.

Proper fix (NOT yet done — needs user decision on tradeoff):
- (A) re-add periodic restart for extra composites — simple/reliable, but a ~45s
  blip every N min on a watched stream.
- (B) content-freshness watchdog: sample each composite, detect a static input
  region → restart. No blips, more code, false-positive risk on genuinely static
  night scenes.
- (C) harden input: add `-rw_timeout` so a stalled *read* (not just connect)
  errors ffmpeg → supervisor restarts. Cheap; may not catch this case if mediamtx
  keeps the reader session alive during the source's silent stall.
  Recommend C (cheap, targeted) + B-lite, or A as a stopgap.

DECISION history:
- (C) `-rw_timeout` — TRIED, FAILED. Not a valid option for the RTSP demuxer in this
  BtbN ffmpeg build ("Option rw_timeout not found" → exit 8 → crash loop → all
  composites down). Reverted (commit 42d7956). Also confirmed the existing `-timeout`
  (30s socket timeout) can't catch it: mediamtx keeps bytes flowing at the socket
  level even when frames stop, so NO input-level timeout works. C is a dead end.
- Freeze recurred (entry ran ~4 days, foyer froze again) → confirmed we need content
  detection.
- (B) content-freshness — IMPLEMENTED + validated (this is the fix):
  * watchdog samples each extra composite's output as a 64x64 gray frame
    (scale=...:flags=neighbor so per-pixel content, incl. the ticking clock, is
    preserved), hashes an 8x8 cell grid, tracks per-cell pixel-static duration.
  * One band per stacked input (entry = 2 vertical bands). A band all-static for
    ≥150s → that input frozen → restart. The clock overlay guarantees a live band
    always has ≥1 changing cell, so a merely-quiet camera is NOT flagged.
  * Pure `evaluateFreshness`/`hashCells`/`cellsInBand` unit-tested: foyer freeze →
    band1@150s; doorbell freeze → band0@150s; all-live → none; static-scene-with-
    ticking-clock → none (false-positive case passes).
  * Fingerprint ffmpeg cmd verified against live streams (4096 bytes) BEFORE deploy
    — the lesson from the -rw_timeout crash.
  * Scoped to extra composites only (entry). Main compositor keeps the byte-watchdog
    (its rotated 5-bay geometry doesn't map to simple bands; not the reported bug).
  * DEPLOYED (commit 0929f3c) + VERIFIED: healthy startup, and a ~4-min production
    soak showed NO false-positive restarts of entry (age grew 97→327s uninterrupted).
    Real-world freeze auto-recovery will prove out the next time a foyer wedge occurs
    (should now self-heal in ~150-200s instead of hours/days). STATUS: fix complete.

## FOLLOW-UP #3: the freeze is triggered by SOURCE RECONNECT (real fix)
The content-freshness check (#2 above) NEVER fired in 46h despite a frozen foyer.
Diagnosis on the live frozen stream revealed two things:

1. TIMEZONE ERROR (mine): I briefly told the user raw/foyer was "7h stale". It was
   NOT — the box runs on UTC, the cameras burn Pacific (PDT = UTC-7). raw/foyer
   showing "12:08 PM" Pacific = current. raw/foyer is live and fine.
2. The entry foyer was FROZEN at 07:56:35 AM Pacific = 14:56 UTC, which EXACTLY
   matched raw/foyer's mediamtx `readyTime` (14:56:41 UTC). i.e. the foyer camera's
   source dropped + reconnected at 07:56, and the entry ffmpeg's read of raw/foyer
   wedged on that event (fps kept duplicating the last pre-reconnect frame).

Why content-freshness missed it: the vstack seam (doorbell above, live) bleeds into
the top cell-row of the foyer band, so the band never read as 100% pixel-static.
The clock overlay sits at that same seam, so it can't be cleanly separated — the
grid approach is fundamentally confounded here. Abandoned.

REAL FIX (implemented, replaces the freshness check): watch each composite's INPUT
mediamtx paths' `readyTime` (exposed by /v3/paths/list). When it changes, the source
reconnected → restart that composite to re-establish a clean read. Reliable signal,
no content analysis, no false positives, targets the actual trigger. Applied to the
main compositor (raw/bay-1..5) and each extra composite (entry: raw/doorbell,
raw/foyer). Reconnect logic + inputPaths derivation unit-verified before deploy.

## FOLLOW-UP #4 (2026-07-16/17): main compositor wedges — NOT all-field, NOT code
Symptom: full-low/the-field/john stall to 0 bytes while `full` + `entry` flow;
~1/s "reader too slow" discards per bay session; main ffmpeg CPU ~20% (waiting);
NVDEC usage of main = 0% (pmon) while entry decodes fine; encoder churns CFR
duplicates on `full` ("More than 10000 frames duplicated"). Wedge engages within
~60-90s of every main start. Restarting main does NOT clear it.

EXONERATED (each with hard evidence):
- all-field (disabled it; wedge persists) — its connect timing was coincidental.
- My code: bisect-deployed known-good 40a83bc on the box → still wedges. Old-vs-new
  buildCommand diff at real probe dims (2688x1512) → byte-identical.
- ffmpeg binary (same BtbN 20260628 build, cached docker layer).
- GPU driver state: no NVRM/Xid errors, no leaked contexts, no throttle;
  kernel module == userspace libs == 595.71.05, no nvidia pkg changes since Jul 8.
- balls-counter (python running since Jun 30; its 2 host cuvid ffmpegs SIGSTOPed
  → wedge persists).
- NVR source flapping (raw/* readyTimes all == container start; reconnect-watchdog
  fired 0 times).
- Reconnect/any-stale watchdog changes (wedge reproduces under 40a83bc without them).

KEY INSIGHT on history: July 14-16 "healthy" verifications only ever checked
`ready=true` (publisher connected), never sustained byte flow. Last PROVEN
sub-stream flow: July 8 (clean the-field frame captures). The wedge may predate
today's deploys by days. A morning-of-July-16 the-field grab needed 2 attempts
(first returned no frames) — sickness likely already present at 10:55 PT.

PIPELINE BISECTION (completed):
- 5-bay NVDEC decode + fps + vstack → -f null: 1.04x realtime → input side healthy.
- Exact production command with -f null outputs: WEDGES identically (frame counter
  frozen, dup≈frames, speed decayed 0.3x) → mediamtx/RTSP publishing exonerated.
- 2×h264-only variant (no hevc full, no john): sustains 1.05x.
→ ROOT CAUSE (twofold, environmental + design):
  1. The bay cameras began streaming 2688x1512 on 2026-07-16 (were 2560x1440
     since setup — verified via probe logs). full grew to 7560x2688; hevc_nvenc
     with -tune hq -multipass fullres + B-frames no longer fits the NVENC
     realtime budget.
  2. CFR output (-fps_mode cfr) amplifies any deficit: hiccup → wallclock-PTS
     gap → CFR manufactures thousands of duplicate frames → encoders drown →
     bigger gap → permanent wedge (inputs unread, mediamtx discards ~1/s/bay,
     sub-streams 0 bytes, "More than 10000 frames duplicated").

FIXES SHIPPED (2026-07-16/17):
- 90430b2: hevc full → single-pass, no B-frames (-tune hq -bf 0, no multipass).
- c608266: all outputs -fps_mode vfr (was cfr) — VFR drops same/backward-PTS
  frames instead of duplicate-filling gaps; monotonic DTS, no amplification.
- Result: all 6 streams (incl. re-enabled all-field) flow sustained, 0 discard
  storms, main CPU at healthy ~700-880%. all-field verified visually correct
  (flip + right-trim + stack). Reconnect-watchdog observed working live
  (all-field auto-restarted when the-field republished).

KNOWN REMAINING ISSUE — latency creep + bay skew (NOT an outage):
- At 2688x1512×5 the pipeline runs slightly under 1.0x, so with VFR the deficit
  accumulates as LATENCY (~15s after a warm restart, drifting toward ~40-60s)
  plus a few seconds of cross-bay skew after restarts. Streams stay up/smooth.
- Options (user decision):
  (a) Revert bay camera streams to 2560x1440 in UniFi (restores the proven
      working point; USER must do — UniFi is off-limits to Claude).
  (b) Cut encode further: drop -tune hq (lookahead) from hevc, or preset p4→p2,
      or scale full down. One-line restitch changes.
  (c) Longer term: GPU-side filtering (scale_cuda etc.) to buy real headroom.
  (d) Add a latency bound (drop-oldest) so backlog can't accumulate regardless.

## Things not to do
- Don't try to content-detect a frozen vstack half via a coarse grid — the seam
  bleed + clock-at-seam confound it (proven). Use the source-reconnect signal.
- Don't compare camera burned-in timestamps to the box clock without accounting for
  the box being UTC and cameras being Pacific (7h offset looks like a 7h "lag").
- Don't chase the "reader is too slow" discards — they're caused by my own slow
  capture connections, not a real defect.
- Don't lower writeQueueSize (512 caused real corruption earlier; 16384 is correct).
- Don't disable hardware decode (user explicitly rejected that).
- Don't add per-chain `fps=` filters as the fix — passthrough makes output framerate
  conforming unnecessary and avoids reintroducing filter-level frame drops.
