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
 *  - raw camera ingest streams (one per camera, fed by per-camera FFmpeg)
 *  - composite + sub-stream outputs (fed by the compositor FFmpeg)
 */
export function generateMediaMTXConfig(
  config: Config,
  outputs: PipelineOutput[]
): string {
  const paths: Record<string, object> = {};

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
