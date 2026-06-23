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
});

const HwAccelSchema = z
  .enum(["none", "vaapi", "qsv", "nvenc", "auto"])
  .default("auto");

const StackDirectionSchema = z.enum(["vertical", "horizontal"]).default("vertical");

const InputRefSchema = z.object({
  name: z.string().describe("Camera name (must exist in top-level cameras list)"),
  rotation: RotationSchema.optional().describe(
    "Rotation override for this composite; falls back to the camera's own rotation"
  ),
  crop: CropSchema.optional().describe(
    "Crop applied to this input BEFORE stacking. Percentages resolve against " +
      "the source camera's post-rotation dimensions."
  ),
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
  extra_args: z.array(z.string()).default([]).describe("Additional FFmpeg encoder args"),
});

const OutputSchema = z.object({
  format: z.enum(["rtsp", "hls", "mpegts"]).default("rtsp"),
  base_url: z
    .string()
    .default("rtsp://localhost:8554")
    .describe("Base URL for the restream server"),
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
      model: z.string().default("/opt/restitch/models/ggml-distil-large-v3.bin"),
      vad_model: z
        .string()
        .default("/opt/restitch/models/ggml-silero-v5.1.2.bin"),
    })
    .default({
      bin: "whisper-server",
      address: "127.0.0.1:9876",
      model: "/opt/restitch/models/ggml-distil-large-v3.bin",
      vad_model: "/opt/restitch/models/ggml-silero-v5.1.2.bin",
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
      model: "/opt/restitch/models/ggml-distil-large-v3.bin",
      vad_model: "/opt/restitch/models/ggml-silero-v5.1.2.bin",
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
export type Transcription = z.infer<typeof TranscriptionSchema>;
