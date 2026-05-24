import type { Config, Camera, SubStream, Encoder } from "./config.ts";
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

function encoderArgs(encoder: Encoder, streamName: string, codecOverride?: string): string[] {
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
      args.push("-tune", "ll");
      args.push("-bf", "0");
    } else {
      args.push("-tune", "hq");
      args.push("-multipass", "fullres");
    }
    args.push("-pix_fmt", encoder.pixel_format);
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

  if (encoder.maxrate) {
    args.push("-maxrate", encoder.maxrate);
  }
  if (encoder.bufsize) {
    args.push("-bufsize", encoder.bufsize);
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
export function buildPipeline(
  config: Config,
  cameraProbes: Map<string, ProbeResult>
): Pipeline {
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
  // Wall clock timestamps ensure all inputs share the same time base,
  // which is critical for vstack to produce output frames.
  for (const cam of cameras) {
    const sourceUrl = `${config.output.base_url}/${rawStreamName(cam)}`;
    inputArgs.push(
      ...hwaccelInputArgs(config.hwaccel),
      "-use_wallclock_as_timestamps", "1",
      "-thread_queue_size", "4096",
      // Cameras advertise 3 tracks (MPEG-4 Audio, Opus, H264). We only encode
      // video — pulling the audio tracks too floods FFmpeg's RTP demuxer with
      // packets it just discards, producing "bad cseq" warnings and dropping
      // video packets along the way. That corrupts the encoded output enough
      // to keep WebRTC clients stuck waiting for a clean keyframe.
      "-allowed_media_types", "video",
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

    // fps filter forces constant framerate, dropping/duplicating as needed
    const fpsLabel = `[fps_${i}]`;
    filters.push(`[${i}:v]fps=${probe.fps}${fpsLabel}`);

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
      `${compositeLabel}scale=${config.composite.scale.width}:${config.composite.scale.height}:flags=lanczos${scaleLabel}`
    );
    compositeLabel = scaleLabel;
  }

  const outputs: PipelineOutput[] = [
    { name: config.composite.name, mapLabel: compositeLabel },
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

  // Compute composite dimensions (post-rotation, pre-scale) for percentage resolution
  const firstCam = cameras[0]!;
  const firstProbe = cameraProbes.get(firstCam.name)!;
  const camRotated = rotatedDimensions(firstProbe.width, firstProbe.height, firstCam.rotation);
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
  const compRotated = rotatedDimensions(compositeW, compositeH, config.composite.rotation);

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
      cropFilter += `,scale=${sub.scale.width}:${sub.scale.height}:flags=lanczos`;
    }

    filters.push(`${cropFilter}${cropLabel}`);
    outputs.push({ name: sub.name, mapLabel: cropLabel, codecOverride: sub.codec });
  }

  const filterComplex = filters.join(";\n");

  return { inputArgs, filterComplex, outputs };
}

function hwaccelInputArgs(hwaccel: string): string[] {
  // Use hw accel for decode, but output to CPU-accessible pixel format.
  // FFmpeg 7.x QSV defaults hwaccel_output_format to qsv (GPU surfaces)
  // which breaks CPU-based filters (vstack, transpose, crop).
  // We explicitly request yuv420p output to force the download.
  switch (hwaccel) {
    case "vaapi":
      return ["-hwaccel", "vaapi", "-hwaccel_output_format", "yuv420p"];
    case "qsv":
      return ["-hwaccel", "qsv", "-hwaccel_output_format", "yuv420p"];
    case "nvenc":
      return ["-hwaccel", "cuda", "-hwaccel_output_format", "yuv420p"];
    default:
      return [];
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
    cmd.push(...encoderArgs(config.encoder, out.name, out.codecOverride));
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
