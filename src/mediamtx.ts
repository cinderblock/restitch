import type { Config, Camera } from "./config.ts";
import type { PipelineOutput } from "./ffmpeg.ts";
import YAML from "yaml";
import { join } from "path";

export interface MediaMTXConfig {
  configPath: string;
  binaryPath: string;
}

/** Derive the mediamtx path name for a camera's raw ingested stream. */
export function rawStreamName(cam: Camera): string {
  return `raw/${cam.name.toLowerCase().replace(/\s+/g, "-")}`;
}

/**
 * Generate a mediamtx configuration file with paths for:
 *  - raw camera streams (one per camera, sourced directly from the upstream URL)
 *  - composite + sub-stream outputs (fed by the compositor FFmpeg)
 *
 * The raw paths make mediamtx the single upstream client per camera: it pulls
 * once and fans out to every consumer (the compositor, HA, browsers, …),
 * offloading the upstream NVR.
 */
export function generateMediaMTXConfig(
  config: Config,
  outputs: PipelineOutput[]
): string {
  const paths: Record<string, object> = {};

  // Raw camera restream paths — mediamtx holds a persistent TCP RTSP
  // connection to each camera and serves all downstream readers.
  for (const cam of config.cameras) {
    paths[rawStreamName(cam)] = {
      source: cam.url,
      rtspTransport: "tcp",
    };
  }

  // Composite and sub-stream output paths
  for (const out of outputs) {
    paths[out.name] = {
      source: "publisher",
    };
  }

  const mtxConfig = {
    logLevel: config.log_level === "quiet" ? "error" : config.log_level,

    // Very generous timeouts — the compositor takes ~30s to connect
    // to all 5 camera inputs before it starts producing output frames.
    // RTSP output sessions must survive this startup delay.
    readTimeout: "5m",
    writeTimeout: "5m",
    // Per-reader send-queue depth. This MUST be larger than the packet
    // count of the biggest single keyframe, or mediamtx discards part of
    // every keyframe ("reader is too slow, discarding N frames") and the
    // large composite streams come out corrupt (lost slices → smears).
    // A 7560x2688 HEVC keyframe alone is well over 1000 RTP packets, so
    // 512 was far too small — it corrupted full/full-low/the-field/john
    // while only the tiny `entry` keyframes fit. Latency is bounded
    // separately by -fflags nobuffer on the compositor inputs (they read
    // at the live edge), so a generous queue here costs nothing.
    writeQueueSize: 16384,

    // RTSP server
    rtsp: true,
    rtspAddress: ":8554",
    rtspTransports: ["tcp"],

    // HLS server (useful for browser/HA access)
    hls: true,
    hlsAddress: ":8890",

    // WebRTC (low latency browser viewing)
    webrtc: true,
    webrtcAddress: ":8889",
    // Single-port UDP mux for all WebRTC media sessions. Pinned explicitly
    // (matches the mediamtx default) because off-LAN access depends on a WAN
    // port-forward of exactly this port — a silently changed default would
    // break it.
    webrtcLocalUDPAddress: ":8189",
    ...(config.webrtc.additional_hosts.length > 0
      ? { webrtcAdditionalHosts: config.webrtc.additional_hosts }
      : {}),
    ...(config.webrtc.ice_servers.length > 0
      ? {
          webrtcICEServers2: config.webrtc.ice_servers.map((url) => ({ url })),
        }
      : {}),

    // Control API — unauthenticated, LAN only. Endpoints under /v3/:
    //   GET /v3/paths/list           paths + reader/source state + bytes
    //   GET /v3/paths/get/<name>     one path
    //   GET /v3/rtspsessions/list    active RTSP readers/publishers
    //   GET /v3/webrtcsessions/list  active WebRTC viewers
    //   GET /v3/hlsmuxers/list       active HLS muxers
    api: true,
    apiAddress: ":9997",

    // mediamtx defaults API access to 127.0.0.1/::1 only. Widen the
    // default user's permission set so LAN clients can also query.
    // Safe because the host itself is LAN-only.
    authInternalUsers: [
      {
        user: "any",
        ips: [],
        permissions: [
          { action: "publish" },
          { action: "read" },
          { action: "playback" },
        ],
      },
      {
        user: "any",
        ips: [],
        permissions: [
          { action: "api" },
          { action: "metrics" },
          { action: "pprof" },
        ],
      },
    ],

    // Stream paths
    paths,
  };

  return YAML.stringify(mtxConfig);
}

/**
 * Write mediamtx config to disk and return the path.
 */
export async function writeMediaMTXConfig(
  dir: string,
  config: Config,
  outputs: PipelineOutput[]
): Promise<string> {
  const configContent = generateMediaMTXConfig(config, outputs);
  const configPath = join(dir, "mediamtx.generated.yml");
  await Bun.write(configPath, configContent);
  console.log(`[mediamtx] Config written to ${configPath}`);
  return configPath;
}
