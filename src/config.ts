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
        "If false, republish this camera at raw/<name> but exclude it from the composite stack"
      ),
    transcribe: z
      .boolean()
      .default(true)
      .describe(
        "If false, exclude this camera's audio from the transcription pump. " +
          "Every camera costs one more channel in stitchd's audio mixer " +
          "and one more channel for the consumer to process, so cameras whose " +
          "audio is never useful (outdoor/bullet cams, duplicate coverage) are " +
          "worth turning off — the pump has been observed saturating and " +
          "starving the other inputs behind it."
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

// Only what stitchd actually consumes. preset/crf/pixel_format/extra_args/
// scale_flags were ffmpeg encoder arguments and did nothing once stitchd took
// over — it sets its own NVENC parameters. keyframe_interval_seconds went the
// same way: stitchd hardcodes a ~2s GOP (see out.enc->gop_size in
// compositor/src/main.cpp), which is the value this was tuned to anyway.
const EncoderSchema = z.object({
  codec: z.string().default("h264_nvenc").describe("NVENC encoder name"),
  maxrate: z.string().optional().describe("Max bitrate, e.g. '20M'"),
  bufsize: z.string().optional().describe("Buffer size, e.g. '40M'"),
});

const OutputSchema = z.object({
  format: z.enum(["rtsp", "hls", "mpegts"]).default("rtsp"),
  base_url: z
    .string()
    .default("rtsp://localhost:8554")
    .describe("Base URL for the restream server"),
});

const WebRTCSchema = z.object({
  ice_servers: z
    .array(z.string())
    .default([])
    .describe(
      "STUN/TURN server URLs, e.g. " +
        "'stun:stun.l.google.com:19302'. With STUN, the server discovers its " +
        "WAN address through the UDP mux port and advertises it as a " +
        "numeric-IP srflx candidate — required for Safari/iOS viewers, which " +
        "ignore non-mDNS FQDN candidates (additional_hosts alone is not " +
        "enough for them), and self-tracks a dynamic WAN IP. Also handed to " +
        "clients via the WHIP/WHEP Link header for their own gathering."
    ),
  additional_hosts: z
    .array(z.string())
    .default([])
    .describe(
      "Extra hosts/IPs advertised as ICE candidates (" +
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
  encoder: EncoderSchema.default({ codec: "h264_nvenc" }),
  output: OutputSchema.default({
    format: "rtsp",
    base_url: "rtsp://localhost:8554",
  }),
  webrtc: WebRTCSchema.default({ ice_servers: [], additional_hosts: [] }),
  dashboard: DashboardSchema.default({ enabled: true, address: ":9000" }),
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
