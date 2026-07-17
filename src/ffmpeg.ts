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
    args.push("-pix_fmt", encoder.pixel_format);
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

  // --- Per-camera fps normalization + rotation ---
  // Force all inputs to the same constant framerate so vstack can align them.
  const rotatedLabels: string[] = [];
  for (let i = 0; i < cameras.length; i++) {
    const cam = cameras[i]!;
    const probe = cameraProbes.get(cam.name);
    if (!probe) {
      throw new Error(
        `No probe result for camera "${cam.name}". Run probe first.`
      );
    }

    // fps=N forces CFR (smoothing out bursty/jittery arrival), then
    // setpts re-stamps each frame with REAL elapsed wall-clock time
    // (RTCTIME-RTCSTART). Two reasons over frame-index PTS (N/fps/TB):
    //   1. Real-time stamps self-heal — a dropped/stalled input doesn't
    //      permanently shift its frame mapping, so cross-input skew can't
    //      accumulate over hours.
    //   2. Stamping AFTER fps (which already smoothed the arrival bursts)
    //      avoids the 1fps collapse that demux-side -use_wallclock_as_-
    //      timestamps caused.
    // Combined with -fflags nobuffer on the inputs (jump to live, skip the
    // stale buffered GOP) all inputs reference near-identical start points,
    // keeping the composite internally in sync.
    const fpsLabel = `[fps_${i}]`;
    filters.push(
      `[${i}:v]fps=${probe.fps},setpts=(RTCTIME-${baseline})/(TB*1000000)${fpsLabel}`
    );

    const rots = rotationFilters(cam.rotation);
    if (rots.length > 0) {
      let prev = fpsLabel;
      for (let r = 0; r < rots.length; r++) {
        const label = `[rot_${i}_${r}]`;
        filters.push(`${prev}${rots[r]}${label}`);
        prev = label;
      }
      rotatedLabels.push(prev);
    } else {
      rotatedLabels.push(fpsLabel);
    }
  }

  // --- Stack ---
  const stackInputs = rotatedLabels.join("");
  const stackFilter =
    config.composite.direction === "vertical" ? "vstack" : "hstack";
  const stackLabel = "[stacked]";
  filters.push(
    `${stackInputs}${stackFilter}=inputs=${cameras.length}${stackLabel}`
  );

  // --- Composite rotation ---
  let compositeLabel = stackLabel;
  const compRots = rotationFilters(config.composite.rotation);
  for (let r = 0; r < compRots.length; r++) {
    const label = `[comp_rot_${r}]`;
    filters.push(`${compositeLabel}${compRots[r]}${label}`);
    compositeLabel = label;
  }

  // --- Composite scale (optional) ---
  if (config.composite.scale) {
    const scaleLabel = "[comp_scaled]";
    filters.push(
      `${compositeLabel}scale=${config.composite.scale.width}:${config.composite.scale.height}:flags=${config.encoder.scale_flags}${scaleLabel}`
    );
    compositeLabel = scaleLabel;
  }

  // Composite frame rate: every composite input was forced to its own probe fps
  // upstream (fps=N), and vstack requires them equal, so the stacked composite
  // runs at the first composite camera's rate. Carry it onto every output as the
  // CFR target (see PipelineOutput.fps).
  const compositeFps = cameraProbes.get(cameras[0]!.name)!.fps;

  const outputs: PipelineOutput[] = [
    { name: config.composite.name, mapLabel: compositeLabel, fps: compositeFps },
  ];

  // --- Sub-streams (crop from pre-scale composite) ---
  // Sub-streams crop from the stacked+rotated composite BEFORE any composite scale,
  // so they get native resolution crops. We branch off from the post-rotation label.
  const preScaleLabel =
    compRots.length > 0
      ? `[comp_rot_${compRots.length - 1}]`
      : stackLabel;

  // If we have sub-streams AND a composite scale, we need to split the pre-scale
  // output so it can feed both the scaler and the crop filters.
  let subStreamSource = preScaleLabel;
  if (config.sub_streams.length > 0 && config.composite.scale) {
    // Rebuild: remove the scale filter we just added and replace with split
    const scaleFilter = filters.pop()!; // remove scale
    const splitCount = config.sub_streams.length + 1;
    const splitOutputs = Array.from(
      { length: splitCount },
      (_, i) => `[split_${i}]`
    );
    filters.push(
      `${preScaleLabel}split=${splitCount}${splitOutputs.join("")}`
    );
    // Re-add scale on split_0
    const scalePart = scaleFilter
      .replace(preScaleLabel, "[split_0]");
    filters.push(scalePart);
    // Update composite output to use scaled
    outputs[0]!.mapLabel = "[comp_scaled]";
    subStreamSource = "split"; // marker
  } else if (config.sub_streams.length > 0 && !config.composite.scale) {
    // Need to split the composite for sub-streams + main output
    const splitCount = config.sub_streams.length + 1;
    const splitOutputs = Array.from(
      { length: splitCount },
      (_, i) => `[split_${i}]`
    );
    filters.push(
      `${compositeLabel}split=${splitCount}${splitOutputs.join("")}`
    );
    outputs[0]!.mapLabel = "[split_0]";
    subStreamSource = "split";
  }

  // Composite dimensions (post-rotation, pre-scale) for percentage resolution
  const compRotated = mainCompositeDims(config, cameraProbes);

  for (let i = 0; i < config.sub_streams.length; i++) {
    const sub = config.sub_streams[i]!;
    const srcLabel =
      subStreamSource === "split"
        ? `[split_${i + 1}]`
        : compositeLabel;
    const cropLabel = `[sub_${i}]`;
    const cropX = resolveDimension(sub.x, compRotated.width);
    const cropY = resolveDimension(sub.y, compRotated.height);
    const cropW = resolveDimension(sub.width, compRotated.width);
    const cropH = resolveDimension(sub.height, compRotated.height);
    const subRotFilters = rotationFilters(sub.rotation);
    let cropFilter = `${srcLabel}crop=${cropW}:${cropH}:${cropX}:${cropY}`;

    if (subRotFilters.length > 0) {
      cropFilter += `,${subRotFilters.join(",")}`;
    }

    if (sub.scale) {
      cropFilter += `,scale=${sub.scale.width}:${sub.scale.height}:flags=${config.encoder.scale_flags}`;
    }

    filters.push(`${cropFilter}${cropLabel}`);
    outputs.push({
      name: sub.name,
      mapLabel: cropLabel,
      codecOverride: sub.codec,
      maxrateOverride: sub.maxrate,
      bufsizeOverride: sub.bufsize,
      // crop/scale/transpose above strip the framerate metadata — set the CFR
      // target explicitly so the encoder doesn't fall back to 25fps.
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
  for (const { path, ref } of resolved) {
    const sourceUrl = `${config.output.base_url}/${path}`;
    inputArgs.push(
      // Produced-stream (`stream:`) inputs decode on CPU, cameras on NVDEC.
      // Adding stream inputs' NVDEC sessions starved the main compositor's
      // 5-bay lockstep decode (its bay reads fell behind realtime → mediamtx
      // "reader too slow" discards → gap-ridden input → filtergraph wedged
      // permanently; observed live the moment all-field connected). The box
      // has cores to spare — two software decodes are cheap; the main
      // compositor's NVDEC budget is not.
      ...(ref.stream !== undefined ? [] : hwaccelInputArgs(config.hwaccel)),
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

  // --- Per-input fps / rotation / crop / scale ---
  // For each input we want: fps norm → rotate → crop → (later) scale-to-first
  // First pass compute post-rotation, post-crop dimensions for each input so
  // we can auto-scale them all to match in the stacking axis.
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
    // fps smooths bursty arrival; setpts=(RTCTIME-RTCSTART) stamps real
    // wall-clock time so the stacked regions pair by the same moment and
    // skew can't accumulate. Paired with -fflags nobuffer on the inputs.
    const fpsLabel = `[xc_fps_${i}]`;
    filters.push(
      `[${i}:v]fps=${input.fps},setpts=(RTCTIME-${baseline})/(TB*1000000)${fpsLabel}`
    );
    let prev = fpsLabel;

    // Rotation: input ref override > camera default (0 for stream refs)
    const rots = rotationFilters(rotation);
    for (let r = 0; r < rots.length; r++) {
      const lbl = `[xc_rot_${i}_${r}]`;
      filters.push(`${prev}${rots[r]}${lbl}`);
      prev = lbl;
    }
    const rotated = rotatedDimensions(input.width, input.height, rotation);
    let w = rotated.width;
    let h = rotated.height;

    // Optional crop (percentages resolve against post-rotation dimensions)
    if (ref.crop) {
      const cx = resolveDimension(ref.crop.x, w);
      const cy = resolveDimension(ref.crop.y, h);
      const cw = resolveDimension(ref.crop.width, w);
      const ch = resolveDimension(ref.crop.height, h);
      const cropLbl = `[xc_crop_${i}]`;
      filters.push(`${prev}crop=${cw}:${ch}:${cx}:${cy}${cropLbl}`);
      prev = cropLbl;
      w = cw;
      h = ch;
    }

    perInput.push({ label: prev, width: w, height: h });
  }

  // --- Auto-scale to first input's stacking-axis dimension ---
  const referenceWidth = perInput[0]!.width;
  const referenceHeight = perInput[0]!.height;
  const stackLabels: string[] = [];

  for (let i = 0; i < perInput.length; i++) {
    const r = perInput[i]!;
    let lbl = r.label;
    let needScale = false;
    let targetW = r.width;
    let targetH = r.height;
    if (extra.direction === "vertical" && r.width !== referenceWidth) {
      needScale = true;
      targetW = referenceWidth;
      // Preserve aspect ratio (-2 = compute even integer)
      targetH = -2;
    } else if (extra.direction === "horizontal" && r.height !== referenceHeight) {
      needScale = true;
      targetH = referenceHeight;
      targetW = -2;
    }
    if (needScale) {
      const scaleLbl = `[xc_scale_${i}]`;
      filters.push(
        `${lbl}scale=${targetW}:${targetH}:flags=${config.encoder.scale_flags}${scaleLbl}`
      );
      lbl = scaleLbl;
    }
    stackLabels.push(lbl);
  }

  // --- Stack ---
  const stackFilter = extra.direction === "vertical" ? "vstack" : "hstack";
  const stackedLbl = `[xc_stacked]`;
  filters.push(
    `${stackLabels.join("")}${stackFilter}=inputs=${perInput.length}${stackedLbl}`
  );

  // --- Post-stack rotation ---
  let outLbl = stackedLbl;
  const postRot = rotationFilters(extra.rotation);
  for (let r = 0; r < postRot.length; r++) {
    const lbl = `[xc_post_rot_${r}]`;
    filters.push(`${outLbl}${postRot[r]}${lbl}`);
    outLbl = lbl;
  }

  // --- Optional post-stack scale ---
  if (extra.scale) {
    const lbl = `[xc_scaled]`;
    filters.push(
      `${outLbl}scale=${extra.scale.width}:${extra.scale.height}:flags=${config.encoder.scale_flags}${lbl}`
    );
    outLbl = lbl;
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
  // hwaccel_output_format picks the pixel format the hw decoder delivers
  // to the software filter chain. We use the GPU's NATIVE CPU layout:
  //
  //   NVDEC → nv12  (interleaved UV plane)
  //   VAAPI → nv12  (native)
  //   QSV   → nv12  (native)
  //
  // ffmpeg auto-converts to yuv420p (or whatever -pix_fmt the encoder
  // wants) right before encode. The vstack/crop/scale/transpose filters
  // along the way all handle nv12 natively, so we avoid the lossy /
  // green-frames bug we hit when claiming "yuv420p" while the bytes
  // were actually nv12.
  //
  // Per-frame NVDEC failures (cuvid sometimes rejects odd RTSP packets)
  // still fall back to software for that frame without breaking the
  // filter chain. CATASTROPHIC failure (driver missing, container
  // misconfigured) is surfaced at startup by ensureHwaccelWorks().
  switch (hwaccel) {
    case "vaapi":
      return ["-hwaccel", "vaapi", "-hwaccel_output_format", "nv12"];
    case "qsv":
      return ["-hwaccel", "qsv", "-hwaccel_output_format", "nv12"];
    case "nvenc":
      return ["-hwaccel", "cuda", "-hwaccel_output_format", "nv12"];
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
  const cmd = [
    config.ffmpeg_path,
    "-loglevel", "error",
    "-hide_banner",
    "-hwaccel", "cuda",
    "-f", "lavfi",
    "-i", "testsrc=duration=0.1:size=320x240:rate=10",
    "-c:v", "hevc_nvenc",
    "-frames:v", "3",
    "-f", "null",
    "-",
  ];
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `hwaccel=${config.hwaccel} requested but CUDA / NVENC probe failed (exit ${code}).\n` +
        `Probe command: ${cmd.join(" ")}\n` +
        `stderr:\n${stderr}\n` +
        `Set hwaccel: none in config.yaml to opt into CPU decode if this is intentional.`
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
