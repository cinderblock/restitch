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
  transcription_api_url: z
    .string()
    .default("http://localhost:9001")
    .describe("Where the dashboard reaches the transcription service (proxied to /api/transcriptions)"),
});

const TranscriptionSchema = z.object({
  enabled: z.boolean().default(true),
  api_address: z
    .string()
    .default(":9001")
    .describe("Bind address for the transcription service's HTTP API"),
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
  chunk_seconds: z
    .number()
    .int()
    .positive()
    .default(30)
    .describe("Seconds of audio per transcription chunk"),
  max_entries_per_camera: z
    .number()
    .int()
    .positive()
    .default(200)
    .describe("Ring buffer size per camera (oldest dropped beyond this)"),
});

export const ConfigSchema = z.object({
  cameras: z.array(CameraSchema).min(1),
  composite: CompositeSchema.default({
    name: "full",
    direction: "vertical",
    rotation: "0",
  }),
  sub_streams: z.array(SubStreamSchema).default([]),
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
    transcription_api_url: "http://localhost:9001",
  }),
  transcription: TranscriptionSchema.default({
    enabled: true,
    api_address: ":9001",
    whisper_server: {
      bin: "whisper-server",
      address: "127.0.0.1:9876",
      model: "/opt/restitch/models/ggml-distil-large-v3.bin",
      vad_model: "/opt/restitch/models/ggml-silero-v5.1.2.bin",
    },
    chunk_seconds: 30,
    max_entries_per_camera: 200,
  }),
  ffmpeg_path: z.string().default("ffmpeg"),
  ffprobe_path: z.string().default("ffprobe"),
  log_level: z.enum(["quiet", "error", "warning", "info", "verbose", "debug"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Camera = z.infer<typeof CameraSchema>;
export type SubStream = z.infer<typeof SubStreamSchema>;
export type Composite = z.infer<typeof CompositeSchema>;
export type Encoder = z.infer<typeof EncoderSchema>;
export type Dashboard = z.infer<typeof DashboardSchema>;
export type Transcription = z.infer<typeof TranscriptionSchema>;
