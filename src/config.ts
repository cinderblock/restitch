import { z } from "zod";

const RotationSchema = z.enum(["0", "90", "180", "270"]).default("0");

const CameraSchema = z
  .object({
    name: z.string().describe("Friendly name for this camera"),
    url: z.string().describe("RTSP URL for the camera stream"),
    rotation: RotationSchema.describe("Clockwise rotation in degrees"),
    order: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Position in the composite stack (0 = first). Required when composite is true."
      ),
    composite: z
      .boolean()
      .default(true)
      .describe(
        "If false, restream this camera through mediamtx but exclude it from the composite stack"
      ),
  })
  .refine((cam) => cam.composite === false || cam.order !== undefined, {
    message: "Cameras included in the composite must have 'order' set",
    path: ["order"],
  });

/** Accepts a pixel count (number) or a percentage string like "50%" */
const DimensionValue = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+(\.\d+)?%$/, 'Must be a percentage like "50%"'),
]);

const CropSchema = z.object({
  x: DimensionValue,
  y: DimensionValue,
  width: DimensionValue,
  height: DimensionValue,
});

const SubStreamSchema = z.object({
  name: z.string().describe("Stream name, used in the output URL path"),
  x: DimensionValue.describe("Crop origin X — pixels or percentage of composite width"),
  y: DimensionValue.describe("Crop origin Y — pixels or percentage of composite height"),
  width: DimensionValue.describe("Crop width — pixels or percentage of composite width"),
  height: DimensionValue.describe("Crop height — pixels or percentage of composite height"),
  rotation: RotationSchema.describe("Rotation applied to this sub-stream after cropping"),
  scale: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional()
    .describe("Optional output scale. Omit to keep native crop resolution"),
  codec: z.string().optional().describe("Override the global encoder codec for this sub-stream"),
  maxrate: z
    .string()
    .optional()
    .describe(
      "Cap this sub-stream's bitrate (e.g. '10M'). Bounds keyframe size so " +
        "large high-res composites don't produce multi-MB keyframes that " +
        "overflow client/RTSP buffers (VLC fails to play, snapshots glitch)."
    ),
  bufsize: z
    .string()
    .optional()
    .describe("VBV buffer for this sub-stream (e.g. '10M'). Smaller = smoother keyframes. Defaults to maxrate when maxrate is set."),
});

const HwAccelSchema = z
  .enum(["none", "vaapi", "qsv", "nvenc", "auto"])
  .default("auto");

const StackDirectionSchema = z.enum(["vertical", "horizontal"]).default("vertical");

const InputRefSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe("Camera name (must exist in top-level cameras list)"),
    stream: z
      .string()
      .optional()
      .describe(
        "Reference an already-produced stream (the main composite or a " +
          "sub_stream name, e.g. 'the-field') instead of a camera. Reuses the " +
          "encoded stream — much cheaper than re-decoding its source cameras."
      ),
    rotation: RotationSchema.optional().describe(
      "Rotation override for this input; falls back to the camera's own " +
        "rotation (cameras) or 0 (streams)"
    ),
    crop: CropSchema.optional().describe(
      "Crop applied to this input BEFORE stacking (after this input's " +
        "rotation). Percentages resolve against the source's post-rotation " +
        "dimensions."
    ),
  })
  .refine((r) => (r.name !== undefined) !== (r.stream !== undefined), {
    message:
      "Specify exactly one of 'name' (camera) or 'stream' (produced stream)",
  });

const ExtraCompositeSchema = z.object({
  name: z.string().describe("Output stream name (rtsp://host:8554/<name>)"),
  direction: StackDirectionSchema,
  rotation: RotationSchema.describe(
    "Rotation applied to the stacked composite (after stacking, before scale)"
  ),
  scale: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional()
    .describe("Optional scale applied to the final stacked output"),
  codec: z
    .string()
    .optional()
    .describe(
      "Override the global encoder codec for this composite (e.g. " +
        "'h264_nvenc' instead of the default hevc_nvenc — useful when " +
        "the output needs to play in stricter clients like VLC over RTSP)"
    ),
  maxrate: z.string().optional().describe("Cap this composite's bitrate (e.g. '10M'); bounds keyframe size for VLC/RTSP."),
  bufsize: z.string().optional().describe("VBV buffer for this composite; defaults to maxrate when maxrate is set."),
  inputs: z.array(InputRefSchema).min(1),
});

const CompositeSchema = z.object({
  name: z.string().default("full").describe("Stream name for the composite"),
  direction: StackDirectionSchema.describe("How cameras are stacked"),
  rotation: RotationSchema.describe(
    "Rotation applied to the final composite after stacking"
  ),
  scale: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional()
    .describe("Optional scale for the composite output. Omit for full resolution"),
});

const EncoderSchema = z.object({
  codec: z.string().default("libx264").describe("FFmpeg encoder name"),
  preset: z.string().default("medium").describe("Encoder preset"),
  crf: z.number().int().min(0).max(51).default(18).describe("Quality (lower = better)"),
  maxrate: z.string().optional().describe("Max bitrate, e.g. '20M'"),
  bufsize: z.string().optional().describe("Buffer size, e.g. '40M'"),
  pixel_format: z.string().default("yuv420p"),
  keyframe_interval_seconds: z
    .number()
    .positive()
    .default(1)
    .describe(
      "Seconds between keyframes (GOP length). Lower = lower latency / faster " +
        "stream start, at the cost of more bitrate. 1s is a good low-latency default."
    ),
  extra_args: z.array(z.string()).default([]).describe("Additional FFmpeg encoder args"),
  scale_flags: z
    .string()
    .default("lanczos")
    .describe(
      "swscale algorithm for all scale filters (composite + sub-streams + extra " +
        "composites). 'lanczos' is highest quality but CPU-heavy; 'bilinear' is " +
        "much cheaper (relevant since scaling runs on the CPU, not the GPU) with " +
        "minor quality loss on downscales. Others: bicubic, area, neighbor, fast_bilinear."
    ),
});

const OutputSchema = z.object({
  format: z.enum(["rtsp", "hls", "mpegts"]).default("rtsp"),
  base_url: z
    .string()
    .default("rtsp://localhost:8554")
    .describe("Base URL for the restream server"),
});

const WebRTCSchema = z.object({
  additional_hosts: z
    .array(z.string())
    .default([])
    .describe(
      "Extra hosts/IPs advertised as ICE candidates (mediamtx " +
        "webrtcAdditionalHosts) alongside the interface addresses. WebRTC " +
        "media bypasses any HTTP reverse proxy, so off-LAN viewers need a " +
        "candidate they can actually reach: add a public DNS name here (a " +
        "DDNS-tracked name keeps working across WAN IP changes) and forward " +
        "the UDP mux port (8189) from the WAN edge to this box. A " +
        "split-horizon name that resolves to this box on the LAN and to the " +
        "WAN edge externally serves both audiences with one entry."
    ),
});

const DashboardSchema = z.object({
  enabled: z.boolean().default(true),
  address: z
    .string()
    .default(":9000")
    .describe("Bind address for the dashboard HTTP server (host:port or :port)"),
  mediamtx_api_url: z
    .string()
    .default("http://localhost:9997")
    .describe("Where the dashboard reaches the mediamtx control API"),
});

const TranscriptionSchema = z.object({
  enabled: z.boolean().default(true),
  whisper_server: z
    .object({
      bin: z.string().default("whisper-server"),
      address: z.string().default("127.0.0.1:9876"),
      model: z.string().default("/var/lib/whisper-models/ggml-distil-large-v3.bin"),
      vad_model: z
        .string()
        .default("/var/lib/whisper-models/ggml-silero-v5.1.2.bin"),
    })
    .default({
      bin: "whisper-server",
      address: "127.0.0.1:9876",
      model: "/var/lib/whisper-models/ggml-distil-large-v3.bin",
      vad_model: "/var/lib/whisper-models/ggml-silero-v5.1.2.bin",
    }),
  silence_threshold_db: z
    .number()
    .default(-30)
    .describe(
      "RMS threshold in dBFS on the combined mono mix. Below this is treated as silence. " +
        "Higher (e.g. -25) = stricter; lower (e.g. -35) = more sensitive."
    ),
  rms_window_ms: z
    .number()
    .int()
    .positive()
    .default(100)
    .describe(
      "Window over which to compute RMS for silence detection and per-camera attribution"
    ),
  contribution_threshold_db: z
    .number()
    .nonnegative()
    .default(10)
    .describe(
      "A camera is listed as contributing to a transcription if its segment-mean RMS is " +
        "within this many dB of the loudest camera. Lower = stricter (only the loudest few)."
    ),
  silence_min_seconds: z
    .number()
    .positive()
    .default(0.8)
    .describe(
      "Seconds of continuous silence required before considering a speech segment ended. " +
        "This is the floor on end-of-speech latency; too low chops mid-sentence on natural pauses."
    ),
  pad_ms: z
    .number()
    .int()
    .nonnegative()
    .default(200)
    .describe("Milliseconds of audio padding around each detected speech segment"),
  max_segment_seconds: z
    .number()
    .positive()
    .default(20)
    .describe("Maximum length of a single speech segment before forced flush (rare; long monologue)"),
  min_segment_seconds: z
    .number()
    .positive()
    .default(0.4)
    .describe("Minimum speech length to bother transcribing (drops short blips / coughs)"),
  max_entries_per_camera: z
    .number()
    .int()
    .positive()
    .default(200)
    .describe("Ring buffer size per camera (oldest dropped beyond this)"),
  language: z
    .string()
    .default("en")
    .describe("Whisper language hint (e.g. 'en'); skips auto-detection"),
  initial_prompt: z
    .string()
    .default(
      "Conversation in a warehouse. Voices may be muffled by machinery, " +
        "forklifts, drills, and other industrial equipment in the background."
    )
    .describe("Few-shot prompt that biases whisper's vocabulary toward the domain"),
});

export const ConfigSchema = z.object({
  cameras: z.array(CameraSchema).min(1),
  composite: CompositeSchema.default({
    name: "full",
    direction: "vertical",
    rotation: "0",
  }),
  sub_streams: z.array(SubStreamSchema).default([]),
  extra_composites: z
    .array(ExtraCompositeSchema)
    .default([])
    .describe(
      "Additional composites built from arbitrary camera subsets. Each runs " +
        "as its own FFmpeg pipeline alongside the main composite."
    ),
  encoder: EncoderSchema.default({
    codec: "libx264",
    preset: "medium",
    crf: 18,
    pixel_format: "yuv420p",
    extra_args: [],
  }),
  hwaccel: HwAccelSchema,
  output: OutputSchema.default({
    format: "rtsp",
    base_url: "rtsp://localhost:8554",
  }),
  webrtc: WebRTCSchema.default({ additional_hosts: [] }),
  dashboard: DashboardSchema.default({
    enabled: true,
    address: ":9000",
    mediamtx_api_url: "http://localhost:9997",
  }),
  transcription: TranscriptionSchema.default({
    enabled: true,
    whisper_server: {
      bin: "whisper-server",
      address: "127.0.0.1:9876",
      model: "/var/lib/whisper-models/ggml-distil-large-v3.bin",
      vad_model: "/var/lib/whisper-models/ggml-silero-v5.1.2.bin",
    },
    silence_threshold_db: -30,
    rms_window_ms: 100,
    contribution_threshold_db: 10,
    silence_min_seconds: 0.8,
    pad_ms: 200,
    max_segment_seconds: 20,
    min_segment_seconds: 0.4,
    max_entries_per_camera: 200,
    language: "en",
    initial_prompt:
      "Conversation in a warehouse. Voices may be muffled by machinery, " +
      "forklifts, drills, and other industrial equipment in the background.",
  }),
  ffmpeg_path: z.string().default("ffmpeg"),
  ffprobe_path: z.string().default("ffprobe"),
  log_level: z.enum(["quiet", "error", "warning", "info", "verbose", "debug"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Camera = z.infer<typeof CameraSchema>;
export type SubStream = z.infer<typeof SubStreamSchema>;
export type ExtraComposite = z.infer<typeof ExtraCompositeSchema>;
export type InputRef = z.infer<typeof InputRefSchema>;
export type Crop = z.infer<typeof CropSchema>;
export type Composite = z.infer<typeof CompositeSchema>;
export type Encoder = z.infer<typeof EncoderSchema>;
export type Dashboard = z.infer<typeof DashboardSchema>;
export type WebRTC = z.infer<typeof WebRTCSchema>;
export type Transcription = z.infer<typeof TranscriptionSchema>;
