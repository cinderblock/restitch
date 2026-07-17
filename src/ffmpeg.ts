import type {
  Config,
  Camera,
  SubStream,
  Encoder,
  ExtraComposite,
} from "./config.ts";
import { rawStreamName } from "./mediamtx.ts";

/**
 * Given a rotation string, return the effective width and height of a frame
 * after rotation. We need the input dimensions to compute this.
 */
function rotatedDimensions(
  w: number,
  h: number,
  rotation: string
): { width: number; height: number } {
  if (rotation === "90" || rotation === "270") return { width: h, height: w };
  return { width: w, height: h };
}

/**
 * Build the rotation filter expression for a given rotation value.
 * FFmpeg transpose: 1=90CW, 2=90CCW, 0=90CCW+vflip, 3=90CW+vflip
 * For 180 we chain two transpose=1 (simpler than hflip+vflip for hw compat).
 */
function rotationFilters(rotation: string): string[] {
  switch (rotation) {
    case "90":
      return ["transpose=1"];
    case "180":
      return ["transpose=1", "transpose=1"];
    case "270":
      return ["transpose=2"];
    default:
      return [];
  }
}

// --- GPU filtergraph primitives -------------------------------------------
// The whole pixel path runs on the GPU in CUDA frames (user policy: GPU or
// error). Empirically validated format rules for this ffmpeg build (NPP):
//   * overlay_cuda accepts nv12 ONLY  → the graph's working format is nv12
//   * transpose_npp accepts yuv420p ONLY → rotations are sandwiched between
//     GPU-side scale_npp format conversions (nv12→yuv420p→rotate→nv12)
//   * scale_npp handles both formats and does scaling + format conversion
// Structural building blocks:
//   * canvas: a color source (16x16, uploaded once per frame — trivially
//     small) scaled up ON the GPU to the target size; stacking = chained
//     overlay_cuda placements onto it
//   * crop: overlay the source at NEGATIVE offsets onto an output-sized
//     canvas; out-of-canvas pixels clip away (no crop filter exists in CUDA)

/**
 * Uniform color metadata retag for every branch that meets overlay_cuda.
 * FFmpeg 7.x negotiates colorspace/range per filter link; the cameras disagree
 * (bays/foyer: yuvj420p pc + bt709, doorbell: tv + smpte170m/bt470bg), and on
 * a mismatch ffmpeg auto-inserts a SOFTWARE converter — which cannot touch
 * CUDA frames, killing the whole graph ("Impossible to convert between the
 * formats..."). setparams is metadata-only (no pixel math), which matches the
 * old CPU pipeline's behavior: it never colorspace-converted either, it just
 * tagged the output tv and composited the bytes as-is.
 */
const GPU_COLOR_RETAG =
  "setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709";

/** Map config scale_flags (swscale names) to NPP interpolation algorithms. */
function gpuInterp(scaleFlags: string): string {
  const map: Record<string, string> = {
    lanczos: "lanczos",
    bilinear: "linear",
    fast_bilinear: "linear",
    bicubic: "cubic",
    area: "super",
    neighbor: "nn",
  };
  return map[scaleFlags] ?? "lanczos";
}

/** GPU rotation: nv12 in → nv12 out via the transpose_npp yuv420p sandwich. */
function gpuRotationChain(rotation: string): string[] {
  const dirs: Record<string, string[]> = {
    "90": ["clock"],
    "180": ["clock", "clock"],
    "270": ["cclock"],
  };
  const t = dirs[rotation];
  if (!t) return [];
  return [
    "scale_npp=format=yuv420p",
    ...t.map((d) => `transpose_npp=dir=${d}`),
    "scale_npp=format=nv12",
  ];
}

/**
 * Emit a GPU canvas source: a black nv12 frame of the given size living on
 * the CUDA device, stamped with the same wallclock setpts expression as the
 * camera inputs so overlay_cuda pairs frames on one timeline.
 */
function gpuCanvas(
  label: string,
  width: number,
  height: number,
  fps: number,
  baseline: number
): string {
  return (
    `color=black:size=16x16:rate=${fps},format=nv12,${GPU_COLOR_RETAG},` +
    `setpts=(RTCTIME-${baseline})/(TB*1000000),` +
    `hwupload_cuda,scale_npp=w=${width}:h=${height}:format=nv12${label}`
  );
}

/**
 * Resolve a dimension value that may be a pixel count or a percentage string.
 * Percentages are resolved against the given reference size and rounded to
 * the nearest even integer (required by most video codecs).
 */
function resolveDimension(value: number | string, reference: number): number {
  if (typeof value === "number") return value;
  const pct = parseFloat(value) / 100;
  return Math.round((pct * reference) / 2) * 2;
}

function isQsvEncoder(codec: string): boolean {
  return codec.endsWith("_qsv");
}

function isNvencEncoder(codec: string): boolean {
  return codec.endsWith("_nvenc");
}

/**
 * Map libx264-style preset names to NVENC p1-p7 presets.
 * If the preset is already in pN format, pass it through.
 */
function mapNvencPreset(preset: string): string {
  if (/^p[1-7]$/.test(preset)) return preset;
  const map: Record<string, string> = {
    ultrafast: "p1",
    superfast: "p1",
    veryfast: "p2",
    faster: "p3",
    fast: "p4",
    medium: "p4",
    slow: "p5",
    slower: "p6",
    veryslow: "p7",
  };
  return map[preset] ?? "p4";
}

function encoderArgs(
  encoder: Encoder,
  streamName: string,
  codecOverride?: string,
  maxrateOverride?: string,
  bufsizeOverride?: string
): string[] {
  const codec = codecOverride ?? encoder.codec;
  const args: string[] = [];

  args.push("-c:v", codec);

  if (isNvencEncoder(codec)) {
    // NVENC: constant quality via VBR rate control with -cq.
    // -b:v 0 ensures true constant quality (no bitrate target).
    // -tune hq enables B-frames and look-ahead for better quality.
    // -multipass fullres does a two-pass encode for better quality.
    args.push("-rc:v", "vbr");
    args.push("-cq", String(encoder.crf));
    args.push("-b:v", "0");
    args.push("-preset", mapNvencPreset(encoder.preset));
    if (codec.includes("264")) {
      // Low-latency H.264: no B-frames (no reorder delay), no encoder
      // lookahead, and -delay 0 so NVENC emits each frame immediately
      // instead of holding a reorder/output buffer.
      args.push("-tune", "ll");
      args.push("-bf", "0");
      args.push("-rc-lookahead", "0");
      args.push("-delay", "0");
    } else {
      // HEVC `full` is the quality master — keep -tune hq, but NO multipass
      // and NO B-frames. At 7560x2688 (the bays stream 2688x1512 since
      // 2026-07-16; they were 2560x1440) multipass+B-frames costs more NVENC
      // than realtime allows, and the pipeline's wallclock-setpts + CFR
      // output turns any sustained deficit into a death spiral: hiccup →
      // PTS gap → CFR emits duplicate frames → encoder chews extras → bigger
      // gap → wedge. Reproduced with -f null outputs (mediamtx exonerated);
      // the 2×h264-only variant sustained 1.05x while the 4-output variant
      // with multipass hevc crawled at 0.3x and froze.
      args.push("-tune", "hq");
      args.push("-bf", "0");
    }
    // GOP / keyframe interval. Shorter = lower latency + faster stream
    // start (players can only begin decoding at a keyframe), at the cost
    // of bitrate. Default 1s; was 2s. Assumes 30fps source.
    const gop = Math.max(1, Math.round(encoder.keyframe_interval_seconds * 30));
    args.push("-g", String(gop));
    args.push("-keyint_min", String(gop));
    // NOTE: no -pix_fmt here. The filtergraph hands NVENC CUDA frames whose
    // underlying format is nv12 (the GPU graph's working format); forcing
    // encoder.pixel_format would make ffmpeg try to insert a software format
    // conversion, which cannot touch GPU frames and breaks the graph.
    // Force limited (TV) range output. Without this NVENC inherits the
    // full-range flag from UniFi's H.264 VUI, encodes as yuvj420p, and
    // strict players (VLC's H.264 path) refuse to load the result.
    args.push("-color_range", "tv");
  } else if (isQsvEncoder(codec)) {
    // QSV: use ICQ (intelligent constant quality) rate control mode
    // with -global_quality. Requires explicit -look_ahead 1 for quality.
    args.push("-global_quality", String(encoder.crf));
    args.push("-look_ahead", "1");
    args.push("-preset", encoder.preset);
    // QSV needs explicit framerate when input is variable or from filters
    args.push("-r", "30");
  } else if (codec.includes("264") || codec.includes("265")) {
    args.push("-preset", encoder.preset);
    args.push("-crf", String(encoder.crf));
    args.push("-pix_fmt", encoder.pixel_format);
  }

  // Per-output bitrate cap takes precedence over the global encoder setting.
  // Capping converts NVENC's unlimited-bitrate CQ mode into capped VBR,
  // which bounds keyframe size — large high-res composites otherwise emit
  // multi-MB keyframes that overflow RTSP/client buffers (VLC won't play,
  // snapshots glitch). bufsize defaults to maxrate (≈1s VBV) for smooth
  // keyframes when only maxrate is given.
  const maxrate = maxrateOverride ?? encoder.maxrate;
  const bufsize = bufsizeOverride ?? encoder.bufsize ?? (maxrateOverride ? maxrateOverride : undefined);
  if (maxrate) {
    args.push("-maxrate", maxrate);
  }
  if (bufsize) {
    args.push("-bufsize", bufsize);
  }

  args.push(...encoder.extra_args);

  return args;
}

export interface ProbeResult {
  width: number;
  height: number;
  fps: number;
}

export interface PipelineOutput {
  name: string;
  mapLabel: string;
  codecOverride?: string;
  maxrateOverride?: string;
  bufsizeOverride?: string;
  /**
   * Target constant frame rate for this output (frames/sec). Emitted as `-r`
   * so ffmpeg conforms the (wall-clock-stamped, slightly jittery) filter output
   * to a clean monotonic CFR grid. REQUIRED on any output whose filter chain
   * runs crop/scale/transpose: those filters drop the framerate metadata, so
   * without an explicit rate ffmpeg falls back to 25fps and (a) drops ~5 of
   * every 30 real frames and (b) emits a flood of non-monotonic DTS warnings.
   */
  fps?: number;
}

export interface Pipeline {
  inputArgs: string[];
  filterComplex: string;
  outputs: PipelineOutput[];
}

/**
 * Build the full FFmpeg pipeline for the composite + sub-streams.
 *
 * cameraProbes: map from camera name to probed dimensions. Required so we can
 * compute post-rotation sizes and composite layout without hardcoding.
 */
/**
 * Shared PTS baseline (microseconds since the Unix epoch) for the real-time
 * setpts expressions. All inputs of a vstack reference the SAME baseline so a
 * frame captured at a given real instant gets the same PTS on every input —
 * that's what keeps the stacked cameras internally synced regardless of which
 * input delivered its first frame first (RTCSTART, which we used before, is
 * per-input and leaves a startup skew of up to one camera GOP). Using a recent
 * baseline rather than 0 / the absolute epoch keeps the PTS small enough that
 * the muxer doesn't choke.
 */
function ptsBaselineMicros(): number {
  return Date.now() * 1000;
}

export function buildPipeline(
  config: Config,
  cameraProbes: Map<string, ProbeResult>
): Pipeline {
  const baseline = ptsBaselineMicros();
  // Only cameras with composite !== false enter the stack. Restream-only
  // cameras (composite: false) are still served by mediamtx for direct clients
  // but skipped here — they have no order/rotation that matters to the stack.
  const cameras = config.cameras
    .filter((c) => c.composite !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const filters: string[] = [];
  const inputArgs: string[] = [];

  // --- Inputs ---
  // Pull from the local mediamtx raw paths, not the upstream cameras directly.
  // mediamtx holds the single connection per camera and fans out — that keeps
  // the upstream NVR's client count low (1 per camera, regardless of how many
  // consumers there are: this compositor, HA, browsers, ...).
  //
  // NOTE: deliberately NO -use_wallclock_as_timestamps. It stamps each frame
  // with its RTSP arrival time; with NVDEC decode (which delivers frames in
  // bursts) the per-input arrival cadences differ enough that the fps filter
  // collapses inputs to ~2fps and vstack pairs stale frames. We instead let
  // fps smooth the bursts, then re-stamp with REAL elapsed wall-clock time
  // (setpts=(RTCTIME-RTCSTART) below) so all inputs share a real-time grid:
  // smooth, internally synced, and self-healing (skew can't accumulate).
  for (const cam of cameras) {
    const sourceUrl = `${config.output.base_url}/${rawStreamName(cam)}`;
    inputArgs.push(
      ...hwaccelInputArgs(config.hwaccel),
      // Low-latency input: don't pre-buffer the demuxer, decode with low
      // delay. Keeps the compositor reading at the live edge so latency
      // doesn't slowly accumulate (setpts makes the pipeline latency-blind,
      // so the input must not hoard frames).
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-thread_queue_size", "4096",
      // Cameras advertise 3 tracks (MPEG-4 Audio, Opus, H264). We only encode
      // video — pulling the audio tracks too floods FFmpeg's RTP demuxer with
      // packets it just discards, producing "bad cseq" warnings and dropping
      // video packets along the way. That corrupts the encoded output enough
      // to keep WebRTC clients stuck waiting for a clean keyframe.
      "-allowed_media_types", "video",
      // Exit if no RTSP data for 30s. Without this the compositor will
      // keep running with the last frame from a stalled input forever,
      // and the supervisor never gets a chance to restart it.
      "-timeout", "30000000",
      "-rtsp_transport", "tcp",
      "-i", sourceUrl
    );
  }

  // Composite frame rate: every input is forced to its probe rate upstream,
  // so the composite runs at the first camera's rate.
  const compositeFps = cameraProbes.get(cameras[0]!.name)!.fps;
  const interp = gpuInterp(config.encoder.scale_flags);

  // --- Per-camera fps normalization + GPU rotation ---
  // fps=N paces bursty arrival; setpts re-stamps with REAL elapsed wall-clock
  // time so all inputs (and the canvas) share one timeline — that's what keeps
  // the stacked cameras internally synced and self-healing. Rotation happens
  // on the GPU (transpose_npp sandwich, see gpuRotationChain).
  const readyLabels: string[] = [];
  const readyDims: { width: number; height: number }[] = [];
  for (let i = 0; i < cameras.length; i++) {
    const cam = cameras[i]!;
    const probe = cameraProbes.get(cam.name);
    if (!probe) {
      throw new Error(
        `No probe result for camera "${cam.name}". Run probe first.`
      );
    }
    // Every branch must pass through an NPP filter before meeting
    // overlay_cuda: raw NVDEC output feeding overlay directly fails format
    // negotiation (ffmpeg tries to auto-insert a software scaler, which
    // cannot touch GPU frames). The rotation sandwich already ends in
    // scale_npp=format=nv12; unrotated branches get an explicit normalizer.
    const rot = gpuRotationChain(cam.rotation);
    const chain = [
      GPU_COLOR_RETAG,
      `fps=${probe.fps}`,
      `setpts=(RTCTIME-${baseline})/(TB*1000000)`,
      ...(rot.length > 0 ? rot : ["scale_npp=format=nv12"]),
    ];
    filters.push(`[${i}:v]${chain.join(",")}[in_${i}]`);
    readyLabels.push(`[in_${i}]`);
    readyDims.push(rotatedDimensions(probe.width, probe.height, cam.rotation));
  }

  // --- Stack: GPU canvas + chained overlay_cuda placements ---
  const vertical = config.composite.direction === "vertical";
  const stackW = vertical
    ? readyDims[0]!.width
    : readyDims.reduce((s, d) => s + d.width, 0);
  const stackH = vertical
    ? readyDims.reduce((s, d) => s + d.height, 0)
    : readyDims[0]!.height;
  filters.push(gpuCanvas("[stack_cv]", stackW, stackH, compositeFps, baseline));
  let prev = "[stack_cv]";
  let off = 0;
  for (let i = 0; i < cameras.length; i++) {
    const label = i === cameras.length - 1 ? "[stacked]" : `[st_${i}]`;
    const x = vertical ? 0 : off;
    const y = vertical ? off : 0;
    filters.push(`${prev}${readyLabels[i]}overlay_cuda=x=${x}:y=${y}${label}`);
    off += vertical ? readyDims[i]!.height : readyDims[i]!.width;
    prev = label;
  }

  // --- Composite rotation (GPU) ---
  let compositeLabel = "[stacked]";
  const compRotChain = gpuRotationChain(config.composite.rotation);
  if (compRotChain.length > 0) {
    filters.push(`${compositeLabel}${compRotChain.join(",")}[comp_rot]`);
    compositeLabel = "[comp_rot]";
  } else {
    // Overlay-final frames carry the canvas's padded allocation as their
    // dimensions (green bars in the encode); a dimensionless scale_npp
    // restores the true link dimensions. Rotation sandwiches do this
    // implicitly.
    filters.push(`${compositeLabel}scale_npp=format=nv12[comp_norm]`);
    compositeLabel = "[comp_norm]";
  }

  // Composite dimensions (post-rotation, pre-scale) for percentage resolution
  const compRotated = mainCompositeDims(config, cameraProbes);

  const outputs: PipelineOutput[] = [
    { name: config.composite.name, mapLabel: compositeLabel, fps: compositeFps },
  ];

  // --- Split the (pre-scale) composite for the main output + sub-streams ---
  const splitCount = config.sub_streams.length + 1;
  if (splitCount > 1 || config.composite.scale) {
    const splitOutputs = Array.from(
      { length: splitCount },
      (_, i) => `[split_${i}]`
    );
    filters.push(`${compositeLabel}split=${splitCount}${splitOutputs.join("")}`);
    outputs[0]!.mapLabel = "[split_0]";
    if (config.composite.scale) {
      filters.push(
        `[split_0]scale_npp=w=${config.composite.scale.width}:h=${config.composite.scale.height}:` +
          `interp_algo=${interp}:format=nv12[comp_scaled]`
      );
      outputs[0]!.mapLabel = "[comp_scaled]";
    }
  }

  // --- Sub-streams: GPU crop (negative overlay) + rotation + scale ---
  for (let i = 0; i < config.sub_streams.length; i++) {
    const sub = config.sub_streams[i]!;
    const cropX = resolveDimension(sub.x, compRotated.width);
    const cropY = resolveDimension(sub.y, compRotated.height);
    const cropW = resolveDimension(sub.width, compRotated.width);
    const cropH = resolveDimension(sub.height, compRotated.height);

    // Crop = place the composite at negative offsets on a crop-sized canvas;
    // everything outside the canvas clips away.
    filters.push(gpuCanvas(`[sub_cv_${i}]`, cropW, cropH, compositeFps, baseline));
    let cur = `[sub_crop_${i}]`;
    filters.push(
      `[sub_cv_${i}][split_${i + 1}]overlay_cuda=x=${-cropX}:y=${-cropY}${cur}`
    );

    const post: string[] = [...gpuRotationChain(sub.rotation)];
    if (sub.scale) {
      post.push(
        `scale_npp=w=${sub.scale.width}:h=${sub.scale.height}:interp_algo=${interp}:format=nv12`
      );
    }
    // Overlay-final chains inherit the canvas's PADDED surface allocation as
    // frame dimensions (e.g. 3686x3290 -> 3712x3296) and the padding encodes
    // as green bars. A trailing scale_npp re-emits the true link dimensions,
    // so every output must end in scale_npp (rotation sandwiches and explicit
    // scales already do).
    if (post.length === 0) {
      post.push("scale_npp=format=nv12");
    }
    const outLabel = `[sub_${i}]`;
    filters.push(`${cur}${post.join(",")}${outLabel}`);
    cur = outLabel;

    outputs.push({
      name: sub.name,
      mapLabel: cur,
      codecOverride: sub.codec,
      maxrateOverride: sub.maxrate,
      bufsizeOverride: sub.bufsize,
      // Filters strip framerate metadata — carry the rate for -fps_mode vfr
      // gating on the output (see buildCommand).
      fps: compositeFps,
    });
  }

  const filterComplex = filters.join(";\n");

  return { inputArgs, filterComplex, outputs };
}

/**
 * Dimensions of the main composite frame (post-rotation, PRE-scale) — the
 * space sub_stream crop percentages resolve against.
 */
function mainCompositeDims(
  config: Config,
  cameraProbes: Map<string, ProbeResult>
): { width: number; height: number } {
  const cameras = config.cameras
    .filter((c) => c.composite !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const firstCam = cameras[0]!;
  const firstProbe = cameraProbes.get(firstCam.name)!;
  const camRotated = rotatedDimensions(
    firstProbe.width,
    firstProbe.height,
    firstCam.rotation
  );
  let compositeW: number, compositeH: number;
  if (config.composite.direction === "vertical") {
    compositeW = camRotated.width;
    compositeH = cameras.reduce((sum, cam) => {
      const p = cameraProbes.get(cam.name)!;
      const r = rotatedDimensions(p.width, p.height, cam.rotation);
      return sum + r.height;
    }, 0);
  } else {
    compositeH = camRotated.height;
    compositeW = cameras.reduce((sum, cam) => {
      const p = cameraProbes.get(cam.name)!;
      const r = rotatedDimensions(p.width, p.height, cam.rotation);
      return sum + r.width;
    }, 0);
  }
  return rotatedDimensions(compositeW, compositeH, config.composite.rotation);
}

/**
 * Output dimensions of a produced stream (the main composite or a sub_stream),
 * derived from config + camera probes, so extra composites can reference one
 * as an input without probing it live (it may not be publishing yet at build
 * time — the extra composite and the main compositor start concurrently).
 */
function producedStreamDims(
  config: Config,
  cameraProbes: Map<string, ProbeResult>,
  streamName: string
): { width: number; height: number } | null {
  const comp = mainCompositeDims(config, cameraProbes);
  if (streamName === config.composite.name) {
    return config.composite.scale ?? comp;
  }
  const sub = config.sub_streams.find((s) => s.name === streamName);
  if (!sub) return null;
  if (sub.scale) return { width: sub.scale.width, height: sub.scale.height };
  const w = resolveDimension(sub.width, comp.width);
  const h = resolveDimension(sub.height, comp.height);
  return rotatedDimensions(w, h, sub.rotation);
}

/**
 * Build an FFmpeg pipeline for a single "extra" composite — a vstack or hstack
 * of an arbitrary subset of inputs, with optional per-input crop and
 * post-stack rotation/scale. Produces a single output stream named
 * extra.name. Inputs are cameras (pulled from local mediamtx raw paths) or
 * already-produced streams (`stream:` refs, pulled from their own mediamtx
 * path — reuses the encoded stream instead of re-decoding its sources).
 *
 * Inputs are auto-scaled to the FIRST input's stacking-axis dimension so
 * vstack/hstack doesn't reject mismatched widths/heights.
 */
export function buildExtraCompositePipeline(
  config: Config,
  extra: ExtraComposite,
  cameraProbes: Map<string, ProbeResult>
): Pipeline {
  const baseline = ptsBaselineMicros();
  const cameraByName = new Map<string, Camera>(
    config.cameras.map((c) => [c.name, c])
  );
  const filters: string[] = [];
  const inputArgs: string[] = [];

  // Produced streams are CFR at the composite rate (see PipelineOutput.fps);
  // used as the fps for `stream:` inputs.
  const compositeCams = config.cameras.filter((c) => c.composite !== false);
  const compositeFps = compositeCams[0]
    ? (cameraProbes.get(compositeCams[0].name)?.fps ?? 30)
    : 30;

  // Resolve each input to a mediamtx path + dimensions + rate. Cameras pull
  // from raw/<slug> with probed dims; `stream:` refs pull the produced stream's
  // own path with dims derived from config (it may not be publishing yet —
  // this ffmpeg and the main compositor start concurrently).
  const resolved = extra.inputs.map((ref) => {
    if (ref.stream !== undefined) {
      const dims = producedStreamDims(config, cameraProbes, ref.stream);
      if (!dims) {
        throw new Error(
          `extra_composite "${extra.name}" references unknown stream ` +
            `"${ref.stream}" (must be the main composite or a sub_stream name)`
        );
      }
      return {
        ref,
        path: ref.stream,
        width: dims.width,
        height: dims.height,
        fps: compositeFps,
        rotation: ref.rotation ?? ("0" as const),
      };
    }
    const cam = cameraByName.get(ref.name!);
    if (!cam) {
      throw new Error(
        `extra_composite "${extra.name}" references unknown camera "${ref.name}"`
      );
    }
    const probe = cameraProbes.get(ref.name!);
    if (!probe) {
      throw new Error(
        `extra_composite "${extra.name}": no probe result for "${ref.name}"`
      );
    }
    return {
      ref,
      path: rawStreamName(cam),
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      rotation: ref.rotation ?? cam.rotation,
    };
  });

  // --- Inputs ---
  // NOTE: deliberately NO -use_wallclock_as_timestamps here (unlike the
  // main compositor). The extra composites stack DIFFERENT camera models
  // (e.g. doorbell + foyer) whose RTSP arrival latency/jitter differ.
  // Demux-side -use_wallclock_as_timestamps desyncs those inputs and the
  // fps filter then collapses the higher-latency input to ~1fps (measured:
  // 13 unique frames vs 173 without it over 15s). Instead we let fps smooth
  // the bursts, then re-stamp with real elapsed wall-clock time
  // (setpts=(RTCTIME-RTCSTART) below) — same approach as the main
  // compositor — so both inputs share a real-time grid that stays smooth
  // AND internally synced.
  for (const { path } of resolved) {
    const sourceUrl = `${config.output.base_url}/${path}`;
    inputArgs.push(
      // ALL inputs decode on the GPU — including produced-stream (`stream:`)
      // refs. (An earlier CPU-decode exception here was misattributed blame:
      // the compositor wedge it tried to avoid was actually the NVENC budget
      // overrun + CFR dup spiral, both since fixed. User policy: GPU or error.)
      ...hwaccelInputArgs(config.hwaccel),
      // Low-latency input (same rationale as the main compositor): read at
      // the live edge so latency doesn't accumulate behind the latency-blind
      // setpts timeline.
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-thread_queue_size",
      "4096",
      "-allowed_media_types",
      "video",
      // Exit if no RTSP data for 30s so the supervisor restarts us
      // instead of running forever with one input frozen.
      "-timeout",
      "30000000",
      "-rtsp_transport",
      "tcp",
      "-i",
      sourceUrl
    );
  }

  // --- Per-input fps / GPU rotation / GPU crop, then scale-to-match ---
  // GPU graph (see buildPipeline): rotation = transpose_npp sandwich; crop =
  // negative-offset overlay_cuda onto a crop-sized canvas; scaling = scale_npp.
  const interp = gpuInterp(config.encoder.scale_flags);
  type Resolved = {
    label: string; // output label for this input after fps+rotate+crop
    width: number;
    height: number;
  };
  const perInput: Resolved[] = [];

  for (let i = 0; i < resolved.length; i++) {
    const { ref, rotation } = resolved[i]!;
    const input = resolved[i]!;
    // Real-time PTS after fps — see buildPipeline for the full rationale.
    // Unrotated branches get the scale_npp format normalizer (see
    // buildPipeline: raw NVDEC → overlay_cuda fails format negotiation).
    const rot = gpuRotationChain(rotation);
    const chain = [
      GPU_COLOR_RETAG,
      `fps=${input.fps}`,
      `setpts=(RTCTIME-${baseline})/(TB*1000000)`,
      ...(rot.length > 0 ? rot : ["scale_npp=format=nv12"]),
    ];
    let prev = `[xc_in_${i}]`;
    filters.push(`[${i}:v]${chain.join(",")}${prev}`);

    const rotated = rotatedDimensions(input.width, input.height, rotation);
    let w = rotated.width;
    let h = rotated.height;

    // Optional crop (percentages resolve against post-rotation dimensions):
    // place at negative offsets on a crop-sized GPU canvas.
    if (ref.crop) {
      const cx = resolveDimension(ref.crop.x, w);
      const cy = resolveDimension(ref.crop.y, h);
      const cw = resolveDimension(ref.crop.width, w);
      const ch = resolveDimension(ref.crop.height, h);
      filters.push(gpuCanvas(`[xc_ccv_${i}]`, cw, ch, input.fps, baseline));
      filters.push(
        `[xc_ccv_${i}]${prev}overlay_cuda=x=${-cx}:y=${-cy}[xc_crop_${i}]`
      );
      // Re-normalize after the crop overlay: an overlay_cuda output feeding
      // another overlay's second pad fails format negotiation; routing it
      // through scale_npp pins the link to nv12.
      const normLbl = `[xc_cn_${i}]`;
      filters.push(`[xc_crop_${i}]scale_npp=format=nv12${normLbl}`);
      prev = normLbl;
      w = cw;
      h = ch;
    }

    perInput.push({ label: prev, width: w, height: h });
  }

  // --- Scale mismatched inputs to the first input's stacking-axis dimension ---
  const referenceWidth = perInput[0]!.width;
  const referenceHeight = perInput[0]!.height;
  const stackPieces: { label: string; width: number; height: number }[] = [];

  for (let i = 0; i < perInput.length; i++) {
    const r = perInput[i]!;
    let { label, width, height } = r;
    // scale_npp has no -2 auto-dimension; compute the even aspect-preserving
    // size explicitly.
    if (extra.direction === "vertical" && width !== referenceWidth) {
      const target = Math.round((height * referenceWidth) / width / 2) * 2;
      filters.push(
        `${label}scale_npp=w=${referenceWidth}:h=${target}:interp_algo=${interp}:format=nv12[xc_scale_${i}]`
      );
      label = `[xc_scale_${i}]`;
      width = referenceWidth;
      height = target;
    } else if (extra.direction === "horizontal" && height !== referenceHeight) {
      const target = Math.round((width * referenceHeight) / height / 2) * 2;
      filters.push(
        `${label}scale_npp=w=${target}:h=${referenceHeight}:interp_algo=${interp}:format=nv12[xc_scale_${i}]`
      );
      label = `[xc_scale_${i}]`;
      width = target;
      height = referenceHeight;
    }
    stackPieces.push({ label, width, height });
  }

  // --- Stack: GPU canvas + chained overlay_cuda ---
  const xcVertical = extra.direction === "vertical";
  const xcW = xcVertical
    ? stackPieces[0]!.width
    : stackPieces.reduce((s, p) => s + p.width, 0);
  const xcH = xcVertical
    ? stackPieces.reduce((s, p) => s + p.height, 0)
    : stackPieces[0]!.height;
  filters.push(gpuCanvas("[xc_cv]", xcW, xcH, resolved[0]!.fps, baseline));
  let outLbl = "[xc_cv]";
  let xcOff = 0;
  for (let i = 0; i < stackPieces.length; i++) {
    const lbl = `[xc_st_${i}]`;
    const x = xcVertical ? 0 : xcOff;
    const y = xcVertical ? xcOff : 0;
    filters.push(
      `${outLbl}${stackPieces[i]!.label}overlay_cuda=x=${x}:y=${y}${lbl}`
    );
    xcOff += xcVertical ? stackPieces[i]!.height : stackPieces[i]!.width;
    outLbl = lbl;
  }

  // --- Post-stack rotation (GPU) ---
  const postRot = gpuRotationChain(extra.rotation);
  if (postRot.length > 0) {
    filters.push(`${outLbl}${postRot.join(",")}[xc_post_rot]`);
    outLbl = "[xc_post_rot]";
  }

  // --- Optional post-stack scale (GPU) ---
  if (extra.scale) {
    filters.push(
      `${outLbl}scale_npp=w=${extra.scale.width}:h=${extra.scale.height}:interp_algo=${interp}:format=nv12[xc_scaled]`
    );
    outLbl = "[xc_scaled]";
  } else if (postRot.length === 0) {
    // Overlay-final: restore true dimensions (see buildPipeline — the canvas's
    // padded allocation otherwise encodes as green bars).
    filters.push(`${outLbl}scale_npp=format=nv12[xc_norm]`);
    outLbl = "[xc_norm]";
  }

  const filterComplex = filters.join(";\n");
  const outputs: PipelineOutput[] = [
    {
      name: extra.name,
      mapLabel: outLbl,
      codecOverride: extra.codec,
      maxrateOverride: extra.maxrate,
      bufsizeOverride: extra.bufsize,
      // scale-to-match + post-stack scale strip framerate metadata; pin the CFR
      // target to the first input's rate (all inputs forced to it upstream).
      fps: resolved[0]!.fps,
    },
  ];
  return { inputArgs, filterComplex, outputs };
}

function hwaccelInputArgs(hwaccel: string): string[] {
  // GPU-resident decode (user policy: the whole pixel path runs on the GPU;
  // GPU failure = loud error, never CPU fallback).
  //
  // nvenc: `-hwaccel_output_format cuda` keeps decoded frames in GPU memory
  // (underlying format nv12) — no PCIe download. `-hwaccel_device cu` pins the
  // decoder to the SAME named CUDA context the filters use; without it NVDEC
  // creates its own context and overlay_cuda/scale_npp refuse to mix frames
  // across devices ("Error reinitializing filters" on the first real frame).
  //
  // Catastrophic GPU failure (driver missing, container misconfigured, filter
  // set absent) is surfaced at startup by ensureHwaccelWorks() — the process
  // refuses to run rather than degrade to CPU.
  switch (hwaccel) {
    case "vaapi":
      return ["-hwaccel", "vaapi", "-hwaccel_output_format", "nv12"];
    case "qsv":
      return ["-hwaccel", "qsv", "-hwaccel_output_format", "nv12"];
    case "nvenc":
      return [
        "-hwaccel", "cuda",
        "-hwaccel_device", "cu",
        "-hwaccel_output_format", "cuda",
      ];
    default:
      return [];
  }
}

/**
 * Run a tiny ffmpeg command that exercises CUDA decode + NVENC. Throws
 * with a clear error if the box can't actually use the GPU. Catches the
 * "running on a host without a driver" / "container missing NVIDIA caps"
 * case at startup, before we spawn the real long-running pipelines.
 */
export async function ensureHwaccelWorks(config: Config): Promise<void> {
  if (config.hwaccel === "none") return;
  if (config.hwaccel !== "nvenc") {
    // For vaapi/qsv we don't have a probe set up; trust the config.
    return;
  }
  // Fail-fast policy (user directive): the entire pixel path — decode, filter,
  // scale, rotate, composite, encode — runs on the GPU. If ANY piece is
  // missing or broken, refuse to start with a clear error. Never fall back to
  // CPU filtering: a CPU "fallback" that can't keep up degrades silently
  // (latency creep, frozen composite halves) instead of failing loudly.
  //
  // The smoke graph exercises every GPU primitive the pipeline builders emit:
  //   hwupload_cuda + scale_cuda  (canvas creation + scaling)
  //   transpose_npp               (rotation — needs our NPP-enabled ffmpeg)
  //   overlay_cuda                (stacking + negative-offset cropping)
  //   hevc_nvenc                  (encode from CUDA frames)
  const cmd = [
    config.ffmpeg_path,
    "-loglevel", "error",
    "-hide_banner",
    "-init_hw_device", "cuda=smoke",
    "-filter_hw_device", "smoke",
    "-f", "lavfi",
    "-i", "color=black:size=64x64:rate=10",
    "-f", "lavfi",
    "-i", "testsrc=duration=0.5:size=320x240:rate=10",
    "-filter_complex",
    // Mirrors the production recipe exactly: color retag, nv12 working format,
    // transpose_npp sandwiched in scale_npp format conversions (it rejects
    // nv12), canvas via scale_npp, negative-offset overlay crop.
    `[0:v]format=nv12,${GPU_COLOR_RETAG},hwupload_cuda,scale_npp=w=480:h=640:format=nv12:interp_algo=lanczos[cv];` +
      `[1:v]format=nv12,${GPU_COLOR_RETAG},hwupload_cuda,scale_npp=format=yuv420p,transpose_npp=dir=clock,scale_npp=format=nv12[rot];` +
      "[cv][rot]overlay_cuda=x=-8:y=16[out]",
    "-map", "[out]",
    "-frames:v", "3",
    "-c:v", "hevc_nvenc",
    "-f", "null",
    "-",
  ];
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `hwaccel=${config.hwaccel}: GPU pipeline probe FAILED (exit ${code}) — refusing to start.\n` +
        `The pixel path must run fully on the GPU (decode/scale/rotate/composite/encode).\n` +
        `A missing piece usually means the ffmpeg build lacks NPP/CUDA filters ` +
        `(transpose_npp, scale_cuda, overlay_cuda) or the NVIDIA runtime is not mounted.\n` +
        `Probe command: ${cmd.join(" ")}\n` +
        `stderr:\n${stderr}`
    );
  }
}

/**
 * Build the complete FFmpeg command line.
 */
export function buildCommand(config: Config, pipeline: Pipeline): string[] {
  const cmd: string[] = [config.ffmpeg_path];

  // Global options
  cmd.push("-loglevel", config.log_level);
  cmd.push("-y");

  // One named CUDA context shared by the decoders (-hwaccel_device cu) and
  // the filtergraph (-filter_hw_device cu). Without a shared context,
  // overlay_cuda/scale_npp reject frames from NVDEC's private context.
  if (config.hwaccel === "nvenc") {
    cmd.push("-init_hw_device", "cuda=cu");
    cmd.push("-filter_hw_device", "cu");
  }

  // Inputs
  cmd.push(...pipeline.inputArgs);

  // Filter complex
  cmd.push("-filter_complex", pipeline.filterComplex);

  // Outputs
  for (const out of pipeline.outputs) {
    cmd.push("-map", out.mapLabel);
    cmd.push(
      ...encoderArgs(
        config.encoder,
        out.name,
        out.codecOverride,
        out.maxrateOverride,
        out.bufsizeOverride
      )
    );
    // VFR: emit frames at the PTS the filtergraph assigned, dropping any
    // same/backwards-PTS frames (keeps DTS monotonic without the passthrough
    // mode's warning spam). Deliberately NOT cfr: CFR gap-fills PTS jumps with
    // duplicate frames, and with the wallclock setpts upstream that is a
    // positive feedback loop — any transient deficit creates a PTS gap, CFR
    // manufactures thousands of dup frames, the encoders fall further behind,
    // the next gap is bigger, and the pipeline death-spirals into a permanent
    // wedge (inputs unread, sub-streams at 0 bytes). Observed live once the
    // bays' resolution bump pushed the encode budget near its limit. The
    // upstream fps=N filter already paces each input, so healthy output is
    // ~CFR anyway; vfr just refuses to amplify hiccups.
    if (out.fps) {
      cmd.push("-fps_mode", "vfr");
    }
    cmd.push("-an"); // no audio
    if (config.output.format === "rtsp") {
      cmd.push("-rtsp_transport", "tcp");
    }
    cmd.push("-f", outputFormat(config.output.format));
    cmd.push(outputUrl(config.output, out.name));
  }

  return cmd;
}

/**
 * Build an ingester command for a single camera.
 * Copies the stream with no re-encoding to a local mediamtx path.
 */
export function buildIngesterCommand(
  config: Config,
  camera: Camera
): string[] {
  const cmd: string[] = [config.ffmpeg_path];
  cmd.push("-loglevel", config.log_level);
  cmd.push("-y");

  // Input from remote camera (no hwaccel needed — we're just copying)
  cmd.push("-rtsp_transport", "tcp", "-i", camera.url);

  // Copy video stream only (no re-encode), push to local mediamtx
  cmd.push("-c:v", "copy");
  cmd.push("-an"); // no audio
  cmd.push("-rtsp_transport", "tcp");
  cmd.push("-f", "rtsp");
  cmd.push(`${config.output.base_url}/${rawStreamName(camera)}`);

  return cmd;
}

function outputFormat(format: string): string {
  switch (format) {
    case "rtsp":
      return "rtsp";
    case "hls":
      return "hls";
    case "mpegts":
      return "mpegts";
    default:
      return "rtsp";
  }
}

function outputUrl(
  output: { format: string; base_url: string },
  streamName: string
): string {
  if (output.format === "rtsp") {
    return `${output.base_url}/${streamName}`;
  }
  // For HLS/mpegts the base_url is a directory path
  return `${output.base_url}/${streamName}.m3u8`;
}
