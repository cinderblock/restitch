# Custom GPU Compositor (project)

Plan path: `plans/custom-compositor.md`

## Goal
Replace the ffmpeg-filtergraph compositor (main + extra composites) with a
purpose-built GPU-resident compositor we fully control. Decode each camera
ONCE on NVDEC, keep frames in GPU memory, composite EVERY output from those
same frames with a deterministic "newest available frame per output tick"
pairing policy, encode each output on NVENC, publish to mediamtx. This
eliminates the ffmpeg framesync/scheduling defects (stale-frame pairing,
canvas-black show-through) by construction, and makes cross-composite reuse
(e.g. all-field embedding the-field) a single hop with NO re-decode and NO
second generation of lossy compression.

Decision to build this: user, 2026-07-20, after the ffmpeg framesync
stale-pairing bug in all-field proved intractable inline (multiple failed
fixes; only a separate-process re-ingest worked, at the cost of a re-decode +
generation loss). User explicitly wants: (a) the full custom compositor, and
(b) built-in "smarts" to DROP compositions and/or inputs when outputs aren't
draining. User is OK with slightly slow cold starts.

## Why a custom compositor (the payoff)
- **Single hop / no generation loss:** produced-stream references (all-field →
  the-field) sample the-field's COMPOSITED pre-encode pixels straight from GPU
  memory. No encode→publish→re-decode→re-encode. Best quality, lowest latency.
- **Deterministic pairing:** a wall-clock tick samples the newest available
  frame from each input. No framesync, no free-running-canvas race, no stale
  frames, no black show-through. The whole class of bugs we chased is gone.
- **Backpressure smarts (user ask):** per-output independent pacing; if an
  output's encoder/RTSP queue isn't draining, DROP that output's frames (skip
  ticks) instead of blocking siblings. Drop whole compositions or inputs under
  resource pressure, by policy/priority. One slow reader can't starve others
  (the sibling-starvation failure we hit with CFR is impossible here).
- **No unwritten-region / padded-pool bugs:** our kernels write every output
  pixel, so the green-edge and padded-dims classes (which needed ffmpeg
  patches) can't occur.
- **Exact control** of color handling, SAR, GOP alignment, keyframe phase
  (can de-phase per-output keyframes to avoid the NVENC keyframe-wave spikes).

## Environment / context
- Box: sentinel — RTX 4090 (Ada, sm_89), Ubuntu 24.04, driver 595.71.05,
  24-core CPU. restitch runs in Docker (container `restitch`), single bun
  supervisor process launching mediamtx + ffmpeg(s) + whisper + dashboard.
- Repo: cinderblock/restitch, local `C:\Users\camer\git\Personal Projects\Top
  Down`. Config owned by ops repo (cinderblock/ops, local `…\jackson`),
  delivered to `/opt/restitch/config.yaml`.
- We ALREADY build ffmpeg from source in the image (ffmpeg-builder stage:
  n7.1.5, --enable-nonfree --enable-cuda-nvcc --enable-libnpp, sm_89, + our 2
  patches). That build produces libav* we can LINK against.
- Current pipeline detail lives in `plans/composite-substream-startup-stall.md`
  (the framesync saga, all the hard-won filtergraph rules, the detectors).

## Architecture (recommended — confirm before building)
**Native C++/CUDA binary, linking our existing libav\*, supervised by bun.**

- **I/O + codec: reuse libavformat/libavcodec (NOT the ffmpeg CLI, NOT a
  from-scratch RTSP/NVDEC/NVENC).** libavformat handles RTSP demux (pull
  raw/<cam> from mediamtx) and RTSP mux (publish outputs). libavcodec gives
  NVDEC decode (frames as AV_PIX_FMT_CUDA hwframes — a CUdeviceptr we read
  directly) and NVENC encode (feed our composited CUDA frames). We do NOT
  reinvent RTSP/reconnection/timestamps/codec glue — those work fine; only the
  FILTERGRAPH was broken. This is still a "full custom compositor": we own the
  entire decode→composite→encode loop and all compositing; we just stand on
  libav for the plumbing. Rationale in plan §Decisions.
- **Compositing core: our own CUDA kernels (+ NPP where it helps).** Per output,
  a kernel writes every output pixel by sampling the right input(s) with the
  needed transform (crop/rotate/stack/scale). High-quality separable
  resample (lanczos) as a kernel or via NPP — must match/beat current quality
  (bilinear was explicitly rejected). Internal composites (the main 5-bay
  composite, the-field, etc.) are GPU buffers other outputs can sample.
- **Pairing/scheduler: tick-based.** Each input decode runs in its own thread,
  atomically publishing its latest frame (+capture wallclock) into a slot. A
  scheduler ticks at the composite fps; each tick, each output composites from
  the newest available input slots, then hands the result to its encoder.
  Inputs that stall → last frame reused (or dropped, by policy). Inputs that
  flood → slot overwritten (natural drop).
- **Backpressure/drop:** each output has its own encode+mux worker with a
  bounded queue. Tick tries to enqueue; if full (not draining), DROP that
  output's frame this tick. Per-output priority + drop policy in config.
  Optional: drop an input's decode if it wedges; drop a whole composition if
  the GPU can't sustain realtime (loud log, never silent quality downgrade —
  per gpu-or-error policy).
- **Cold start:** wait until every required input has delivered its first
  frame before starting output ticks (user OK with slow cold start). Side
  benefit: eliminates the black pre-roll entirely.
- **Integration:** new Docker builder stage compiles the binary against our
  libav* + CUDA + NPP + NVENC. The bun supervisor launches it exactly where it
  launches the main ffmpeg today (launchManaged), reading the SAME config.yaml
  (passed as JSON on argv or a path). mediamtx, dashboard, transcription,
  watchdog, deploy flow all unchanged. Raw camera pull + output publish stay on
  mediamtx (one upstream connection per camera, fan-out preserved).
- **Rollback/safety:** config switch `compositor: ffmpeg | native` (default
  ffmpeg until proven). Build the native path to run SIDE BY SIDE producing a
  DIFFERENTLY-NAMED output first, validate with the existing detectors
  (clock-regression, whole-frame blank, arrival pacing), then cut over
  output-by-output, keep ffmpeg fallback for a while.

## Decisions already made (don't re-ask)
- Build the full custom compositor (user, 2026-07-20). Not a patch, not a
  filter — user chose the biggest option deliberately.
- Must include drop-compositions/drop-inputs backpressure smarts.
- Slightly slow cold starts are acceptable.
- GPU-or-error policy still holds: any failure to build the GPU path = loud
  error, never CPU fallback, never silent quality downgrade. Drops must be
  logged, never silent. [[gpu-or-error]]
- **CONFIRMED (user, 2026-07-20): C++/CUDA, linking our existing libav\*** for
  RTSP I/O + NVDEC/NVENC. Not bare-metal (no from-scratch RTSP/NVIDIA SDK).
  Compositing + tick pairing + drop scheduler are all ours.
- Repo placement: `compositor/` dir in restitch, own CMake, new Dockerfile
  builder stage (proceeding with this default; flag if you want a separate repo).
- Codename: `stitchd` (binary/dir) unless you object.

## Plan / steps (phased — MVP first, keep ffmpeg fallback)
0. **[current] Architecture sign-off** — confirm the C++/CUDA + libav* approach,
   language, and phasing with the user. Resolve open questions below.
1. **Skeleton + one passthrough output.** New builder stage; binary that pulls
   ONE raw camera via libavformat, NVDEC-decodes, NVENC-encodes (no
   compositing), publishes to a test path. Proves the libav*/NVDEC/NVENC/RTSP
   loop end-to-end in our own code. Validate: plays, monotonic, GPU-only.
2. **One real composite output (`full`).** Add the 5-bay decode→CUDA
   stack→rotate→encode. Validate against the ffmpeg `full` (quality, pacing,
   sync) with the detectors. Establish the CUDA compositing + tick scheduler.
3. **Sub-streams (crops of `full`).** full-low/the-field/john as crops of the
   in-GPU composite. Validate.
4. **Extra composites incl. produced-stream refs (all-field, entry).** all-field
   samples the-field's in-GPU buffer (the payoff). Validate clock-regression =
   0 and quality (no generation loss vs current).
5. **Backpressure/drop scheduler.** Per-output bounded queues, drop policy,
   priorities; input drop/stall handling. Test by throttling a reader.
6. **Cutover.** Flip `compositor: native` on sentinel; keep ffmpeg fallback a
   while; then remove the ffmpeg compositor path.

## Findings / gotchas (append as we learn)
- Dev loop established. The old `ffmpeg-npp-test:latest` image already carries
  the ffmpeg-builder contents: static libav* + headers + pkgconfig at
  /opt/ffmpeg, CUDA 12.9 devel (nvcc), g++, NPP. Built `stitchd-dev:latest` =
  that + cmake 3.28. Compile in it (no GPU needed); run with `--gpus all`
  `-e NVIDIA_DRIVER_CAPABILITIES=compute,video`. Source synced to
  sentinel:/tmp/stitchd-src. libav is n7.1.5 (avformat 61.7.103).
- libav is STATIC (.a, no --enable-shared). CMake links via pkg-config; use
  the `_STATIC_STATIC_LIBRARIES` var + `PKG_CONFIG_PATH=/opt/ffmpeg/lib/pkgconfig`
  to pull transitive deps. Works (Phase 1a links clean).
- compositor/** is NOT in deploy.yml trigger paths (src/**, containers/**,
  servers/**), so committing compositor code does NOT trigger a sentinel
  deploy. Safe to iterate freely until we wire it into the image/config.
- Phase 1 gotchas (all resolved):
  * RTSP publish to mediamtx needs AV_CODEC_FLAG_GLOBAL_HEADER on the encoder
    (SPS/PPS in extradata for the SDP ANNOUNCE) — set it BEFORE avcodec_open2,
    gated on (oformat->flags & AVFMT_GLOBALHEADER).
  * The restitch mediamtx config only allows publishing to CONFIGURED paths
    (each output `source: publisher`); an unconfigured path → "400 Bad
    Request" / "path is not configured". So dev-testing publishes can't use a
    random path — validate to a FILE, or (later) publish to the real output
    names inside the container. In production stitchd publishes the configured
    names, so this is a non-issue.
  * File muxers need avio_open on fmt->pb (rtsp is AVFMT_NOFILE, doesn't).
  * mp4 "moov atom not found" = process killed before trailer. Added SIGTERM/
    SIGINT → g_stop → clean flush+trailer (the supervisor stops us with
    SIGTERM, so graceful shutdown is needed in production anyway).
  * Zero-copy transcode confirmed: encoder reuses the decoder frame's
    hw_frames_ctx (av_buffer_ref frame->hw_frames_ctx), pix_fmt=CUDA,
    sw_pix_fmt=NV12 — NVENC consumes NVDEC frames directly, no download.
  * Dev-test containers can leak if `timeout`/`docker stop` detaches them;
    clean strays with `docker ps --filter ancestor=stitchd-dev -q | xargs -r
    docker rm -f`. Prefer `--frames N` for a self-terminating run.

## Progress log
- [x] Phase 0: architecture signed off (C++/CUDA + libav*, confirmed by user).
- [x] Phase 1a: toolchain/link check. stitchd binary links static libav* +
      CUDA + NPP, runs on the 4090, confirms h264 decoder + h264_nvenc +
      hevc_nvenc present and CUDA hwdevice creates. "PHASE-1A OK".
- [x] Phase 1: zero-copy transcode loop in our own libav* code. RTSP in →
      NVDEC (CUDA frames) → NVENC → mux, shared CUDA device, no PCIe download.
      Validated to a file: 300 frames in → 300 out, 9.97s, h264 2688x1512,
      clean trailer. Graceful SIGTERM flush added. RTSP-out path is the same
      code (works once publishing to a configured mediamtx path).
- [x] Phase 2: `full` composite (5-bay CUDA stack+rotate90 gather kernel +
      threaded per-input decoders + tick scheduler). Produces HEVC 7560x2688,
      300/300 frames, 9.97s, geometry + colors correct, NO green edges (verified
      visually: plans/stitchd-full.png). Sustains real-time 30fps (300 frames
      in 10.3s). Natural drop confirmed: inputs decoded 318-750 frames each over
      10s; tick sampled newest, dropped the rest. Primary CUDA context shared by
      decode/encode/kernel (AV_CUDA_USE_PRIMARY_CONTEXT) — no push/pop needed.
- [x] Phase 3: sub-streams. Build composite ONCE into a pitched work buffer
      (cudaMallocPitch), then derive every output with a crop+scale+rot180
      Lanczos-3 gather kernel, each into its own NV12 pool + encoder. All 4
      production outputs correct: full (hevc 7560x2688), full-low (h264
      3600x1280 scaled), the-field (h264 4096x1216 crop+scale), john (h264
      3024x1344 crop+rot180) — 300/300 frames each, geometry + colors + Lanczos
      scaling all verified (plans/p3-*.png). Scale-aware Lanczos support
      (radius = 3/min(1,dst/src)) antialiases downscale; no bilinear shortcut.
- [~] Phase 4: extra composites. all-field DONE (the payoff) — built by
      sampling the-field's PRE-ENCODE output frame directly (crop left 3686 +
      rot180 == rot180-then-trim-left-10%) + Field Centered scaled to the
      bottom → 3686x3290 h264. NO re-decode, NO re-encode, NO second framesync:
      the stale-frame bug is structurally impossible, and the top half is
      HIGHER quality than production (prod re-encoded+re-decoded the-field;
      stitchd uses pristine pre-encode pixels). 300/300 frames, dims exact,
      geometry/flip/colors verified (plans/p4-all-field.png). Field Centered is
      an AUX decoder (not in the 5-bay stack); same-stream ordering means
      the-field's kernel completes before all-field reads it (no extra sync).
      `entry` DONE too (Doorbell crop over Foyer, 1200x1352, aux decoders via a
      small Aux helper). **100% OUTPUT PARITY**: stitchd now produces ALL 6
      production outputs (full/full-low/the-field/john/all-field/entry) from
      ONE process + ONE decode set (5 bays + 3 aux cams), all dims exact,
      300/300 frames, all verified (plans/p4-*.png). ~22.7 fps for all 6
      outputs concurrent with live production sharing the GPU.
- [ ] Phase 5: backpressure/drop scheduler.
- [ ] Phase 6: cutover behind `compositor: native`, ffmpeg fallback retained.

## Phase 2 design (the CUDA compositing core — next to build)
Target: reproduce `full` (5 bays vstack → rotate 90 CW → HEVC 7560x2688) in
our own code, proving the compositing kernel + the async tick scheduler.

- **Refactor first** (out of the single-file passthrough):
  - `Device` — the shared AVBufferRef CUDA hwdevice + a CUstream.
  - `Decoder` — one per input; a thread runs the read→send→receive loop and
    publishes its LATEST AVFrame (CUDA) into a double-buffered slot behind a
    mutex (+ capture wallclock). Stall = last frame retained; flood = slot
    overwritten (natural drop). This slot IS the deterministic pairing source.
  - `Encoder` — one per output (from phase 1's open_output/drain, generalized).
  - `Compositor` — owns the output NV12 GPU buffer(s) + the kernels.
- **NV12 layout:** Y plane W*H (8-bit), then interleaved UV plane W*(H/2)
  (u,v,u,v…), chroma subsampled 2x2. Allocate output as a CUDA hwframe from an
  AV_PIX_FMT_CUDA/NV12 hw_frames_ctx so NVENC consumes it directly.
- **Stack+rotate as ONE gather kernel** (writes every output pixel exactly once
  → no unwritten-region/green-edge class). For `full`:
  - Stacked S = Ws×Hs = 2688×7560 (5 bays of 2688×1512, input i at rows
    [i*1512,(i+1)*1512)). Output O after 90° CW = Wo×Ho = 7560×2688.
  - Inverse map (gather): O(co,ro) ← S(cs,rs) with cs=ro, rs=Hs-1-co.
  - Then S(cs,rs): input_idx = rs/1512, local=(cs, rs%1512); sample that
    decoder's Y at (local); UV at (local.x&~1, local.y/2). Write O.Y(co,ro)
    and, for even co,ro, O.UV. (Handle chroma on the rotated grid carefully —
    likely a separate chroma pass or compute chroma from the 2x2 luma block's
    source coords to avoid color fringing on rotation.)
  - Launch: 2D grid over O; one thread per luma pixel, chroma in a second
    kernel or guarded in the same.
- **Tick scheduler:** a wallclock timer at composite fps. Each tick: snapshot
  every Decoder's latest slot, run the kernel into a fresh output frame, set
  its pts from the tick index (clean monotonic grid — no wallclock jitter),
  send to the Encoder. Missing input at cold start → wait (phase says slow cold
  start OK); missing mid-stream → reuse last (or blank per policy).
- **Validate:** produce `full` to a file; compare against ffmpeg `full`
  (dims, a few frames visually, monotonic pts, no green edges); check sync by
  the burned-in clocks across bays. Then Phase 3 adds scale for full-low etc.
- Open kernel question: do rotation+subsampled-chroma in one pass or two.
  Start with a correctness-first two-pass (luma, then chroma resampled from
  source), optimize later. Quality must match (no bilinear shortcut).

## Benchmark: stitchd vs ffmpeg producing `full` (2026-07-21)
Both produce the identical 7560x2688 HEVC (cq18/p4/hq/bf0/g60), 5-bay
vstack+rotate90. Run on sentinel concurrently with live production (shared
GPU), so absolute numbers are suppressed but the RATIO is fair.
- **Max throughput (unpaced, 600 frames from 5 local files):**
  stitchd **37.1 fps** (16.2s) vs ffmpeg **30.4 fps** (19.7s) → stitchd
  ~1.22x faster for the same output. Expected: stitchd does the composite in
  ONE gather kernel + encode; ffmpeg's chain is scale_npp x5 + canvas
  hwupload + scale_cuda + 5x overlay_cuda + scale_npp + transpose_npp +
  scale_npp + encode (many more launches + intermediate buffers).
- **Real-time (30fps) resource cost, delta over live baseline:** too noisy to
  split cleanly — production's own encode load swings ±15% (keyframe waves).
  Both add ~13% NVDEC (5 decodes). stitchd did NOT spike enc/sm the way the
  ffmpeg run did (enc 43% vs 69% during each). stitchd container CPU 3.6%;
  both trivial-CPU (GPU-resident).
- Caveats: single runs (not averaged); stitchd decoders read the file once
  then held last frame (slightly less decode than ffmpeg's continuous decode);
  encode dominates at this resolution so the kernel-vs-filtergraph delta is the
  real signal. Benchmark added transient GPU load; production stayed 15/15
  ready (no outage).
- Bottom line: stitchd is at least as fast, ~20% faster here, trivial CPU,
  pixel-correct — AND with deterministic pairing (no framesync bug) + headroom.
  Tools: plans/tmp-bench-compositor.sh (resource), tmp-bench-throughput.sh (fps).

## Open questions for the user (numbered; my recommendation in [])
1. **Language:** C++/CUDA linking libav*? [Yes — natural for CUDA+NVENC+libav;
   Rust bindings are less mature for this stack.] Or do you want Rust?
2. **I/O approach:** reuse libavformat/libavcodec for RTSP + NVDEC/NVENC
   [strongly recommended], or go fully bare-metal (NVIDIA Video Codec SDK +
   a raw RTSP lib like live555)? Bare-metal is weeks more work for little gain
   since RTSP/codec aren't what's broken.
3. **Scope of replacement:** replace ONLY the compositors (main + extras),
   leaving mediamtx serving + raw camera ingest as-is [recommended], or is the
   longer-term goal to also own serving/ingest?
4. **Repo placement:** new top-level dir in restitch (e.g. `compositor/` C++/CUDA
   sources + its own CMake), built by a new Dockerfile stage [recommended].
   Or a separate repo?
5. **Codename** for the binary/dir? [proposal: `stitchd`] — cosmetic.

## Things not to do
- Don't reimplement RTSP, reconnection, or codec glue from scratch unless we
  decide bare-metal — libav* already does it well; the filtergraph was the only
  broken part.
- Don't big-bang replace the ffmpeg compositor. Phase it behind a config switch
  with the ffmpeg path as fallback until the native path is detector-verified.
- Don't drop frames/compositions silently — every drop is a logged event
  (gpu-or-error: loud failures, no silent degradation).
- Don't reintroduce bilinear or any quality shortcut to hit realtime; if the
  GPU can't sustain it, error/drop loudly and we fix the real thing.
- Don't lose the hard-won rules in `composite-substream-startup-stall.md`
  (color handling tv/bt709, SAR=1, keyframe de-phasing, no CFR dup spiral) —
  carry the intent into the native implementation.
