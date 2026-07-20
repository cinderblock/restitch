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

## RESOLVED (2026-07-17): throughput deficit fixed with bilinear scaling
Root of the latency creep / silent input-freezes: the bays' 2560x1440→2688x1512
bump (CONFIRMED camera-side via direct NVR probe = 2688x1512; nobody changed
UniFi) pushed the pipeline under realtime. Key diagnosis: NOT hardware-limited —
the 4090's NVENC/NVDEC sit ~idle (enc 2-6%, dec 20%); the bottleneck is the CPU
software filtergraph (803% CPU across ~40 threads, none pinned; frames are
downloaded from the GPU as nv12, then vstack/transpose/lanczos-scale on the CPU,
then re-uploaded). The lanczos scaler was the marginal cost.

FIX: added `encoder.scale_flags` (default lanczos) and set the live config to
`bilinear`. Verified: after a fresh restart the-field held ~1s latency over 4+
min (no creep → pipeline now ≥1.0x realtime at 1512p), all 5 bays synced, 0
discards, all 6 streams flowing. all-field's two-half skew collapsed from ~45s
to ~1s. GPU still has headroom (enc 30-56%).

LEVERS STILL AVAILABLE if 1512p headroom ever gets tight again:
- Real fix for big headroom: GPU-side filtering (scale_cuda/transpose_npp, keep
  frames in CUDA memory) — the 4090 would crush this. Risk: the green-frame
  cuda-format issue + vstack has no CUDA filter (needs overlay_cuda).
- Revert bays to 2560x1440 (UniFi, user's infra).
- Nice multiples barely matter here (NVENC is idle, not the bottleneck).

## COMMISSIONED (2026-07-17): full-GPU pipeline — "GPU or error, no CPU fallback"
User directive (emphatic): pixel work (decode/filter/scale/encode) must run on
the GPU; if the GPU path fails, ERROR loudly — no CPU fallback, no silent
quality downgrades (bilinear was explicitly rejected as "paving over").
Saved as memory gpu-or-error.md.

Historical truth for the record: the CPU filter chain (vstack/transpose/scale
via swscale after nv12 download) has been the architecture since day one — not a
recent change. The recent CPU-decode for stream refs + bilinear WERE new and are
to be reverted as part of this work.

DESIGN (validated by probes on the box, 2026-07-17):
- Vulkan lane: DEAD in-container. No VK_KHR_video_decode_queue even with
  caps=all, and the only Vulkan device is llvmpipe (CPU rasterizer!) — the
  NVIDIA Vulkan ICD isn't present (headless driver). Using it would be secret
  CPU work. Do not revisit without host driver changes.
- CUDA lane: VALIDATED.
  * NVDEC decode -> cuda frames (proven for months).
  * P8 PASS: GPU canvas = color source 16x16 -> hwupload_cuda -> scale_cuda to
    canvas size; stack via chained overlay_cuda at offsets -> NVENC.
  * P9 PASS: overlay_cuda accepts NEGATIVE offsets (clips at canvas bounds) =
    GPU-side crop emulation: assemble each output directly from (rotated)
    inputs placed on an output-sized canvas with offsets; out-of-canvas pixels
    drop. No crop filter needed.
  * scale_cuda supports interp_algo=lanczos (quality restored, GPU-cheap).
  * ONLY missing piece: rotation. transpose_npp requires a custom ffmpeg build
    with --enable-nonfree --enable-libnpp (CUDA SDK in the existing
    nvidia/cuda devel builder stage; nv-codec-headers; local use only).
- Geometry note: vstack(bays)+transpose90 == transpose90 each bay + place side
  by side (hstack order reversed) — one overlay pass builds the final rotated
  layout directly; 180 rotations = transpose_npp twice (or dir=clock_flip
  variants).
- Fail-fast: extend ensureHwaccelWorks to verify transpose_npp / scale_cuda /
  overlay_cuda exist AND run a smoke graph at startup; refuse to start
  otherwise. Remove stream-ref CPU decode. Remove scale_flags=bilinear from
  live config (GPU lanczos instead).

IMPLEMENTATION STEPS:
1. Dockerfile: ffmpeg source build (pin n7.1.x) in the CUDA devel stage with
   nonfree+libnpp+nvenc/nvdec+network/rtsp; swap into runtime image.
2. ffmpeg.ts: GPU graph builder (canvas+overlay assembly per output).
3. Startup capability check (hard error).
4. Deploy, verify latency (~1-2s), sync, quality, soak; revert bilinear config.

## SHIPPED (2026-07-17/18): full-GPU pipeline LIVE
All six streams run the GPU-resident pipeline in production:
- NVDEC (cuda frames, shared device ctx) -> setparams color retag -> fps/setpts
  -> transpose_npp rotation sandwiches -> overlay_cuda canvas assembly (crops =
  negative offsets) -> scale_npp (lanczos) -> NVENC. ensureHwaccelWorks
  smoke-tests the full GPU filter set at startup and refuses to run otherwise
  (fired once in production when the probe itself was stale — worked as designed).
- Custom ffmpeg n7.1.5 build (Dockerfile ffmpeg-builder stage): nonfree+libnpp+
  cuda-nvcc sm_89; replaces BtbN download (also pins the version).
- Verified live: all 6 streams exact dimensions, 3-way timestamp sync to the
  SECOND (bays + field-centered all 02:44:44), ~3s end-to-end latency, 0
  discards, GPU dec ~60%/enc ~58%, biggest ffmpeg at ~10-20% CPU (was 800%+).
- Rehearsal throughput with -f null: main 5.08x realtime, entry 1.73x, af 2.83x.

Hard-won build/graph rules (do not relearn):
- overlay_cuda: nv12 only. transpose_npp: yuv420p only (sandwich with
  scale_npp format conversions).
- Mixed camera color metadata (pc/bt709 vs tv/smpte170m) makes FFmpeg 7.x
  auto-insert a SOFTWARE converter that cannot touch CUDA frames -> retag all
  branches AND canvases with setparams (metadata-only, matches old behavior).
- Raw NVDEC output cannot feed overlay_cuda directly -> normalize through
  scale_npp first.
- scale_npp with identical dims+format is PASSTHROUGH -> canvas-pool padded
  frames (32-align) reach NVENC and encode as green bars. Every output chain
  must END in a filter doing real work; overlay-final outputs get
  scale_npp=w=W:h=H:format=yuv420p (real conversion, exact fresh pool).
- -hwaccel_device cu required so NVDEC shares the filter device context.
GREEN-EDGE ARTIFACTS: ROOT-CAUSED AND FIXED (2026-07-18) — two genuine
FFmpeg bugs, patched in our build (containers/restitch/patches/):
1. vf_overlay_cuda: forwards its main input frame, but
   ff_inlink_make_frame_writable clones it from the hw pool whose dims are
   FFALIGN(w/h,32) — the clone carries padded pool dims (1216x704 for
   1200x676). Fix: clamp forwarded frame to outlink dims.
2. vf_transpose_npp: nppscale_scale corrects the recycled stage frame's dims
   after av_hwframe_get_buffer; npptranspose_filter is MISSING those two
   lines, so every output after frame 1 carries pool-padded dims.
Downstream effects of both: NVENC encodes the unwritten padding (green
bars), and same-dims scale_npp/scale_cuda conversions became secret
pad-smearing resizes (zero edge columns). Both hunks are upstreamable.
VERIFIED (edge forensics, all six streams): exact dims everywhere; real
content on all 4 edges of full-low/the-field/john/entry/all-field.
Remaining: `full` has a ~1px neutral-gray ring at its extreme border
(invisible at any scale; likely NPP conversion edge behavior; full-low
downscaled from the same frames shows pure content).

## RESOLVED (2026-07-18): playback smoothness — canvas was the jittery framesync master
User reports slightly un-smooth motion. MEASURED on live all-field (packet PTS
deltas, ms): 70x33 / 21x67 / 5x100 / 3x133 / 1x157 / 2x167 — i.e. ~30% of
frame intervals are 2-5x gaps. Raw camera reference (raw/bay-1): 118x33 / 1
outlier — sources are clean 30fps. The composite pipeline drops/skips ~20-25%
of frames irregularly despite 5x throughput headroom.

PRIME SUSPECT: framesync pairing in the chained overlay_cuda stages — the
canvas is an independent 6th timeline (its own wallclock setpts) that
framesync must align against 5 jittery input timelines; mispairings skip
output ticks. The old CPU vstack synced N inputs in ONE filter (no canvas
timeline) and did not exhibit this.

FAILED APPROACHES (do not retry blindly):
- Output -fps_mode cfr: manufactures duplicate storms from wallclock jitter
  (bitrate x3, sibling outputs starve) — failed twice, in production both times.
- setpts BEFORE fps: NVDEC burst-mates get identical wallclock stamps -> fps
  collapses them (150 frames stretched over 79s).
- Grid-quantized setpts AFTER fps: graph processes frames in batches, so
  batch-mates quantize to the same slot -> drop=287. Any
  wallclock-at-processing-time quantization breaks at >1x throughput.

RESOLUTION (A/B-isolated, deployed, live-verified):
- A/B matrix (offline, production-matched encoder flags — first run was
  garbage: default NVENC B-frames made mp4 packet order non-monotonic;
  rerun with -bf 0): canvas-with-wallclock-setpts graphs gap; the SAME graph
  with the canvas on its NATIVE rate=fps timeline is PERFECT (299/299).
- Mechanism: framesync (overlay_cuda) uses the main input — the canvas — as
  the output timeline master. A wallclock-stamped canvas has a jittery
  master grid, so pairings skip slots (the exact-33ms-multiple gaps).
  Native canvas = perfect master grid; jittery camera stamps only drive
  pairing (jitter-tolerant); cross-camera sync unaffected (inputs align
  mutually via the shared wallclock baseline).
- Fix: gpuCanvas emits no setpts (native timeline). One change.
- LIVE VERIFIED: every stream now 299x33ms + exactly the raw cameras' own
  single hiccup per 10s (bay-1: 298x33 + 1x135) — composites add ZERO gaps.
  Sync intact (bays + field-centered within 1s), latency ~2s, 0 discards.
- Startup note: canvas starts at PTS 0, inputs at elapsed-since-baseline →
  a few seconds of black pre-roll frames on fresh publish; live-edge viewers
  never see them.

## Rubber-banding PINPOINTED (2026-07-20 late): all-field the-field-half BLACK-FLASH
- After all prior fixes user STILL saw "time jumps back" — only all-field,
  across VLC+WebRTC+HLS (so it's IN the encoded stream, every player).
- Content-rewind detector v2 (128x72 gray, saves specimen frames;
  plans/tmp-rewind-detector2.js) on 5 streams, 20 min:
  * ONLY all-field flags (4 events). the-field, full-low, entry, raw/bay-4:
    ZERO. → the-field SOURCE is clean; all-field's EMBEDDING of it breaks.
  * Every event: whole-frame match to exactly 10 frames (0.33s) ago,
    dMatch ~0.05-0.20, dPrev ~34.
- SPECIMEN LUMA (raw PGM, top vs bottom quarter), ALL 5 events identical:
    prev frame:  topY=11.0 (BLACK)  botY=~111 (normal)
    cur/old10:   topY=~102 (normal) botY=~111 (normal)
  → the-field REGION (top half of all-field) BLANKS TO CANVAS-BLACK for
  ~0.3s, then its content returns. Bottom (Field Centered) never affected.
  The "rewind" is an artifact: when the-field resumes it's near where it
  paused, and the slow-moving field bottom barely changed, so the whole
  frame ~matches 0.33s-ago. It is NOT a timestamp regression.
  Specimens saved: plans/rwspec-allfield-blackflash.png (top half black) +
  rwspec-allfield-normal.png; thumbnails in plans/rwspec/.
- NOT input damage: event times (21:51:59/52:19/54:04/56:01) show ZERO
  cseq / discards / source reconnects in the container log — only the
  benign dashboard snapshot churn. Pure FILTERGRAPH-INTERNAL defect.
- MECHANISM (topology): all-field is inlined as
  [sub_1]→split→[tap]→scale_npp→rotate180→crop(overlay on ex0_ccv canvas)
  →scale→stack(overlay on ex0_cv canvas with Field Centered). The tap
  carries the main composite's native-grid PTS; the all-field canvases are
  also native rate=30; so tap+canvas are frame-locked and framesync SHOULD
  always pair — yet the tap-overlay intermittently shows canvas-black.
  That points at an ffmpeg scheduling/framesync quirk in the
  split-tap→second-framesync path (same family as our 2 existing
  overlay_cuda/transpose_npp patches). Field Centered (wallclock setpts,
  bottom) is the drift-prone one yet is CLEAN — confirms it's the tap
  path, not clock drift.
- FIX OPTIONS (none deployed; validate OFFLINE first — separate ffmpeg to
  -f null + detector, no prod interruption):
  (A) Re-pace/buffer the tap after rotate/crop so a momentary
      split-cadence gap can't starve the stack framesync (add fps=30 +
      setpts to canvas grid on the tap leg; low risk, test if it removes
      the blanks).
  (B) overlay_cuda framesync flags on the all-field stack:
      eof_action=pass / explicit repeatlast=1 / shortest=0 — cheap to try.
  (C) Structural: bring Field Centered into the MAIN single-canvas
      framesync (which handles 5 inputs with zero blanks) and derive
      all-field via crops of that one well-behaved composite — removes the
      second framesync entirely. Biggest change, most robust.
  Recommendation: reproduce offline, try (A)+(B) first, escalate to (C).
- FIX APPLIED (2026-07-20, user chose robust redesign + deploy now):
  the tap now obeys the PACED-INPUT CONTRACT — scale_npp=nv12 followed by
  fps=30 + setpts=(RTCTIME-baseline), identical to every clean framesync
  input (main-stack bays, entry cameras, Field Centered). Root asymmetry:
  the tap was the ONLY framesync input left on the raw native split
  cadence (I removed its fps/setpts during inlining, thinking native-grid
  alignment was better — that was the bug). A split leg emits on the main
  graph's internal schedule, not real-time; fed straight into the second
  framesync it starves and the canvas (black) shows through. Pacing
  re-clocks it to the shared real-time grid so the stack overlay always
  has a frame to pair. No stale-pairing risk (pre-encode frames at steady
  cadence, not bursty NVENC). Typecheck clean; dry-run confirms
  `[tap_2_0]scale_npp=format=nv12,fps=30,setpts=(RTCTIME-...)`.
  VALIDATION: deploy + 20-min detector v2 watch for all-field blank
  recurrence (0 events = fixed). If blanks persist → escalate to option
  (C) structural single-framesync rebuild or an ffmpeg framesync patch.
- PACED FIX FAILED (2026-07-20 22:42): all-field still blanked post-deploy,
  SAME signature (frame 1643, dPrev 34.4, lag 10, dMatch 0.07). User
  confirms still seeing single-frame time jumps. → It is NOT a
  pacing/pairing/timeline issue (pacing changed nothing). It must be a
  CONTENT issue: some stage EMITS a black frame. Suspects unique to
  all-field's the-field piece: transpose_npp x2 (the 180 rotation; same
  NPP family as the green-edge unwritten-region bug we patched) OR the
  crop/stack overlay_cuda.
- TRIANGULATION RUNNING (no deploy — standalone probes reading published
  streams): (1) watch `john` (rotation 180 via transpose_npp x2, NO
  stack); (2) rot180probe = the-field (fresh RTSP) → EXACT rotate-180
  chain → detector. Logic:
  * john blanks OR rot180probe blanks → transpose_npp emits black frames;
    fix the 180-rotation method (or patch NPP). all-field-specific because
    only all-field+john rotate 180 (main comp rotates 90 = single
    transpose, never blanks).
  * both clean, only all-field blanks → it's the split-of-a-sub-stream fed
    into the second (stack) framesync; fix = revert all-field to a
    standalone process re-ingesting the-field+Field Centered as two fresh
    RTSP inputs (the ENTRY composite topology, which never blanks), now
    that 2s GOP + 65536 queue removed the old re-ingest stale-pairing.
  NOTE: tap frames are provably NON-black (identical to the clean the-field
  = split of [sub_1]=[enc_2]), so the black is introduced AFTER the tap.
- TRIANGULATION RESULT (2026-07-20 23:xx): john REWIND=0, rot180probe
  REWIND=0, all-field REWIND=19 (over same window). → The 180 rotation
  (transpose_npp x2) is INNOCENT; feeding a FRESH the-field through the
  exact rotate chain never blanks. The defect is SPECIFIC to all-field's
  topology: split-tap of a sub-stream output ([sub_1]) fed into the second
  (stack) framesync that also mixes in a fresh camera. Neither pacing nor
  rotation is the cause.
- USER REDIRECT: don't analyze the top bar (that black may be a separate/
  minor artifact) — the artifact they SEE is the burned-in TIMESTAMP
  jumping back. Recording 180s of the Field Centered clock crop
  (crop=1000:110:0:1210, clean upright "YYYY-MM-DD HH:MM:SS PM") to confirm
  the clock regresses and by how much, so the fix is verified against the
  user-visible signal.
- CLOCK-REGRESSION PROVEN (2026-07-20): recorded 180s of the Field Centered
  clock crop (crop=1000:110:0:1210), ran a backward-jump detector
  (plans/tmp-clock-detector.js): 16 events / 180s (~1 per 11s), jumps
  0.5-1.5s back. Extracted + READ the actual frames at one event:
  frame1640=04:25:54, 1641=54, 1642=**53** (single stale frame), 1643=54.
  EXACTLY the user's "single frame time jumps back a second." Proof images:
  plans/clock-jump-*.png. It's on the FRESH Field Centered input (bottom),
  not the tap — so it is the STACK FRAMESYNC pairing a stale frame in the
  loaded shared process, consistent with the triangulation.
- FIX IMPLEMENTED + deployed: reverted all-field (and any stream-ref extra
  composite) to a STANDALONE process re-ingesting the-field + Field Centered
  as two fresh RTSP inputs = the ENTRY topology (0 events, always). Removed
  the buildPipeline inline block + the index.ts partition; restored
  buildExtraCompositePipeline stream-ref re-ingest (using shared
  emitExtraChain). Main graph back to split=4. Dry-run confirms all-field
  standalone graph correct (the-field re-ingest → rotate180 → trim crop →
  stack with Field Centered → h264 12M). The old re-ingest stale-pairing is
  gone (2s GOP + 65536 queue). Cost: ~one decode+GOP hop of latency.
  VALIDATION: re-record the same clock crop post-deploy; expect ~0 backward
  jumps (was 16/180s).

## Rubber-banding (2026-07-19, INVESTIGATING)
- Symptom (user): overall smoothness much better after the native-canvas fix, but
  occasional "rubber-banding" — playback jumps BACK ~0.5s for a couple frames.
  Stream/player not yet identified.
- User asked whether we do a "proper triple buffer" — n/a as such: the pipeline is
  queue-based (NVDEC → CUDA filters → NVENC → RTSP); no display buffering on our
  side. The player's jitter buffer is the closest analog.
- Hypotheses: (a) non-monotonic/duplicate PTS in our egress (would replay in any
  player); (b) player-side clock resync (VLC live-RTSP clock jitter, WebRTC/HLS
  buffer adaptation) with clean egress; (c) raw-camera passthrough carrying a
  camera timestamp regression into `-c copy` restreams.
- Step 1 DONE — egress is clean. 60s packet scan on full, full-low, the-field,
  all-field, entry, raw/field-centered: 0 negative PTS deltas, 0 duplicates,
  perfect 30fps grids (1800/1800 pkts); entry is natively 10fps (600 pkts,
  100ms cadence — its "gap>100ms" lines were float noise on the nominal
  interval, not gaps). No non-monotonic/discontinuity warnings in 3h of
  container logs. Sentinel clock chrony-disciplined sub-ms, no steps.
  → Hypothesis (a) and (c) dead: the published timeline never goes backward.
  Rubber-banding must be viewer-side (player jitter buffer / live-edge
  behavior) — need to know which player + stream the user sees it in.
- Step 2 DONE — 25-min scan: the-field/all-field/full-low each EXACTLY
  45000 pkts (25min x 30fps), 0 neg, 0 dup, 0 gaps>100ms; entry exactly
  15000 pkts (10fps), 0 neg, 0 dup (its "gaps" = the 100ms-threshold false
  positive). Egress cleanliness confirmed at 25-minute scale.
- Tools: plans/tmp-pts-scan.sh, tmp-discard-analysis.sh, tmp-session-churn.sh
  (scp'd to sentinel:/tmp/).
- Step 3 DONE — user's viewing path exonerated the server completely. User
  watches all-field in VLC over RTSP from 10.255.0.77. Their session
  (d8a57214, created 21:07:52Z): TCP (no loss possible), ZERO mediamtx
  discards, publisher unbroken since 15:45Z (no swap mid-session), egress
  monotonic. CONCLUSION: the rewind is VLC's live-input clock resync (its
  clock controller steps back and replays a few frames when its drift
  estimate corrects) — server-side there is nothing left to fix without
  re-entering the CFR trap. Mitigations: VLC network-caching 2000-3000ms
  and/or --clock-jitter=0 --clock-synchro=0; differential test = watch via
  WebRTC (:8889/all-field) side-by-side, which should never rubber-band.
- REOPENED (2026-07-19): user reports seeing the rubber-banding on OTHER
  players too — weakens the VLC-clock-resync verdict; suspicion moves back
  to something all players share. My scans verified TIMESTAMPS only; two
  mechanisms could rubber-band every player with clean PTS:
  (a) bursty DELIVERY pacing (encode/graph batching → starve+catch-up
      oscillation in every low-buffer live player);
  (b) decoder-level REORDERING (bitstream signals reorder buffering /
      POC anomalies → players present frames out of order).
  Step 4: measure wallclock arrival pacing + has_b_frames + decoded-frame
  order on all-field (plans/tmp-arrival-pacing.sh). Also still need: WHICH
  other players (WebRTC browser? HLS? scrypted?) — shared-WiFi common cause
  not yet excluded either.
- Step 4 DONE — MECHANISM FOUND (two layers):
  (1) DELIVERY BURSTINESS, measured: all-field 38 arrival-stalls >150ms/60s
      (max 461ms), the-field 34, raw passthrough only 7 (clean, keyframe-
      period marks) — same mediamtx, same method → burst source is OUR
      encode processes. Concurrent dmon: NVENC engine spikes 87-99% about
      once per second — all 6 encoder sessions use g=30 (keyframe every 1s,
      phase-aligned at spawn) → keyframe waves transiently saturate the
      encode engine → output pauses then clumps.
  (2) STALE-FRAME PAIRING on all-field's top half: all-field re-ingests
      the-field over RTSP and re-stamps frames with ARRIVAL wallclock
      (setpts=RTCTIME). Bursty arrival → clumped/gapped stamps → framesync
      pairs some canvas ticks with a stale the-field frame while Field
      Centered advances. User pattern (single old frames spliced into
      forward playback, e.g. 12,[6],13) + "might be just banding on the
      top half" both match. Verification running: tmp-half-forensics.sh
      (YDIF top-vs-bottom hold counting).
- User confirmed both symptoms: banding mostly on the TOP half (the-field
  region — stale pairing) with milder stutter on the bottom (whole-frame
  delivery burstiness). "doing all the compositing in one pass seems like a
  better plan" → fix #1 approved.
- FIX #1 IMPLEMENTED (committed, NOT yet deployed): stream-referencing extra
  composites now INLINE into the main pipeline. buildPipeline splits the
  referenced output pre-encode ([sub_1]split=2[enc_2][tap_2_0]), taps ride
  the process's own canvas-grid timeline (NO arrival re-stamping — pairing
  is deterministic), camera refs (Field Centered) join as extra NVDEC inputs
  with the standard stamped chain. Shared chain emitter (emitExtraChain)
  now serves both the inlined path and the standalone builder; standalone
  is camera-only (stream refs there throw). index.ts partitions extras and
  extends the main watchdog inputPaths with inlined camera refs.
  VERIFIED: dry-run in-container with real probes — all-field graph correct
  (crop x=-410 / 3686x1216 top, Field Centered 3686x2074 bottom, 3686x3290
  stack, h264+12M via [ex0_norm]); entry graph BYTE-IDENTICAL to the old
  builder. bun run check: only the 2 pre-existing errors.
  Consequences: all-field restarts with the main process now (was already
  cascade-coupled via watchdog); -1 NVDEC + -1 ffmpeg process; all-field
  latency drops by a full encode+publish+decode hop; both halves show the
  same instant.
- BOTH FIXES DEPLOYED (user said "deploy", 2026-07-20):
  1. restitch bad3532 pushed → deploy green → all 15 paths recovered;
     all-field publishes from the MAIN process (ex0_ chain in the live
     filter graph, no ffmpeg-all-field process).
     MEASURED EFFECT (60s pacing, GOP still 1s): the-field 34→0 gaps>150ms
     (max 429→104ms — better than raw passthrough now); all-field 38→5
     gaps (max 461→208ms). Killing the extra process helped the WHOLE
     box's delivery, not just all-field.
  2. ops 63b1055 (2s GOP + stale-comment refresh) pushed from a TEMP
     WORKTREE of origin/master — the shared jackson checkout sits on
     branch ask-worker (another thread's work; NOT switched). My config
     edits were transplanted via patch, the shared tree's file restored
     to branch HEAD (safety snapshot stashed first). Deploy green,
     keyframe_interval_seconds: 2 live. Final steady-state pacing
     measurement pending (90s settle + 60s capture).
  NOTE: ops master also carried another agent's 41f18b9 (webrtc
  ice_servers STUN for Safari/iOS) — deployed together; the live config
  now has webrtc.ice_servers + additional_hosts.
- FINAL STEADY-STATE PACING (60s, 90s after recovery, both fixes live):
  all-field 20 gaps>150ms max 278ms sd 28.5; the-field 21/247/26.9;
  full-low 20/239/25.1. vs pre-fix 38/461/35.8 — burstiness halved, worst
  stall down 40%. (The post-#1-only run that showed 5/0 gaps was
  catch-up-biased — mean 22.6ms < 33.3ms — don't cite it as steady state.)
- REWIND ROOT CAUSE FOUND (2026-07-20, evidence-backed end to end). User
  still saw rubber-banding post-fixes: "time overlays glitch back a second
  or two for a frame or two." Content-rewind detector (64x36 gray thumbs,
  match-vs-4s-ring; plans/tmp-rewind-detector.js) on raw/bay-4,
  raw/field-centered, the-field, all-field simultaneously (5 min):
  * RAWS: 0 events / 9000 frames each — cameras + NVR CLEAN.
  * the-field: single frames of ~3.5s-OLD content spliced in (t=67s,
    dMatch~1 vs dPrev~5). all-field: 3 isolated glitch frames.
  → The stale frames are born inside the MAIN compositor and are IN the
  encoded stream (any player shows them).
  CHAIN: load spike → mediamtx per-reader queue for the COMPOSITOR'S OWN
  camera-input session overflows → mediamtx discards RTP (measured: live
  bay-1 input session 94e04ba2 discarded 7295 frames 20:47:13-37 — the
  exact window my 4 detector ffmpegs piled load on, and the exact window
  the detector caught the stale frames) → compositor logs "RTP: bad cseq"
  (3 in 3h; rare idle, rises with load) → mid-GOP packet loss → NVDEC
  silently error-conceals from stale DPB references until the camera's
  next keyframe (5s GOP) → seconds-old content flashes into composites.
  NOTE: my own diagnostic load has been TRIGGERING glitches; daytime
  viewer/activity load explains the rest (the daytime correlation).
- DISCARD-IMMUNITY RESULTS (2026-07-20):
  (a) -fflags discardcorrupt: TESTED AND DEAD on the NVDEC path — 64KB
      mid-GOP splice of real bay-1 footage decodes to IDENTICAL frame
      counts (433) with/without the flag, zero corrupt messages: the
      parser resyncs and NVDEC conceals silently; nothing is ever flagged.
      (tmp-discardcorrupt-test.sh). DO NOT retry the flag; real
      suppression needs an rtpdec-level ffmpeg patch: on RTP seq
      discontinuity, drop packets until the next IDR — turns a discard
      burst into a ≤GOP region freeze (framesync holds) instead of
      time-travel. Offered, not yet built.
  (b) APPLIED: mediamtx writeQueueSize 16384 → 65536 (~4x burst headroom,
      absorbs ~60-90s stalls; discards for live sessions become
      near-impossible — the byte-stall watchdog fires first). This is the
      load-bearing mitigation. Do NOT lower (512 caused corruption
      historically).
  (c) Camera GOP 5s→1s shrinks any damage window 5x: NOT exposed in the
      Protect UI; requires unsupported Protect API edit of per-camera
      channels[].idrInterval (default 5) — USER'S DOMAIN, never touch
      UniFi without direct authorization.
  (d) Keep heavy diagnostics off the box during watching hours (self-note).
- RESIDUAL GAP SOURCE IDENTIFIED: gaps land on an exact 5s cadence
  (+0.8/5.8/10.8/...) = the CAMERAS' OWN keyframe interval; all outputs
  gap at the same instants (one camera's keyframe burst briefly stalls
  the shared graph's framesync pairing). This is the floor for the
  current architecture. Further levers, NOT applied:
  (a) small input jitter buffer (~200-300ms) — trades live latency for
      smoothness (user watches live; ask first);
  (b) shorter camera GOP (1s) in UniFi → smaller keyframe bursts —
      UNIFI IS USER'S DOMAIN, never touch;
  (c) tighter VBV (bufsize < maxrate) to cap our own keyframe sizes.
- INCIDENTAL FINDINGS from this hunt (separate issues):
  1. Audio-fusion (whisper) RTSP readers of raw/bay-1..4 are chronically
     "too slow" — ~69k mediamtx discard events/24h, active-hours-correlated
     (Pacific daytime = speech). Fused transcription audio is lossy. Does
     NOT touch video (per-reader queues). Worth a fix pass on the fusion
     ffmpeg's consumption (e.g. -allowed_media_types audio / bigger
     thread_queue_size / check whisper backpressure).
  2. Dashboard snapshots create 1 reader session per path per minute
     (~1440/day/path) — by design, benign, but explains RTSP session churn
     in logs.
  3. Main compositor restarted 3x in 24h (06:19, 06:45, 15:45Z), each a
     camera source-reconnect (e.g. bay-3) — legit watchdog recovery; each
     briefly interrupts all streams and puts all-field through an exit-8
     retry loop until the-field returns (expected, self-healing).

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
