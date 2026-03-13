import type { Config, Camera } from "./config.ts";
import type { ProbeResult } from "./ffmpeg.ts";

/**
 * Probe a single camera stream to get its native resolution and frame rate.
 */
export async function probeCamera(
  ffprobePath: string,
  camera: Camera
): Promise<ProbeResult> {
  const args = [
    "-v",
    "quiet",
    "-rtsp_transport",
    "tcp",
    "-print_format",
    "json",
    "-show_streams",
    "-select_streams",
    "v:0",
    camera.url,
  ];

  const proc = Bun.spawn([ffprobePath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `ffprobe failed for camera "${camera.name}" (exit ${exitCode}): ${stderr}`
    );
  }

  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  if (!stream) {
    throw new Error(
      `ffprobe returned no video streams for camera "${camera.name}"`
    );
  }

  const width = Number(stream.width);
  const height = Number(stream.height);

  // Parse frame rate from r_frame_rate (e.g. "30/1" or "30000/1001")
  let fps = 30;
  if (stream.r_frame_rate) {
    const parts = stream.r_frame_rate.split("/");
    if (parts.length === 2) {
      fps = Number(parts[0]) / Number(parts[1]);
    }
  }

  return { width, height, fps };
}

/**
 * Probe all cameras and return a map of name -> ProbeResult.
 */
export async function probeAllCameras(
  config: Config
): Promise<Map<string, ProbeResult>> {
  const results = new Map<string, ProbeResult>();

  // Probe in parallel
  const entries = await Promise.all(
    config.cameras.map(async (cam) => {
      const result = await probeCamera(config.ffprobe_path, cam);
      return [cam.name, result] as const;
    })
  );

  for (const [name, result] of entries) {
    results.set(name, result);
  }

  return results;
}
