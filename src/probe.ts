import type { Config } from "./config.ts";
import type { ProbeResult } from "./stitchd.ts";

/**
 * Probe every camera for its native resolution and frame rate.
 *
 * These dimensions decide the whole layout — the composite size and every
 * piece rectangle in the generated stitchd config — so they have to be known
 * before stitchd starts. stitchd answers this itself (`--probe <url>...`)
 * using the same libavformat it will open the cameras with; this used to spawn
 * one ffprobe per camera, which was a second implementation of the same
 * question and one more external binary in the image.
 *
 * One process for all cameras, and they are opened concurrently inside it.
 */
export async function probeAllCameras(
  config: Config,
  stitchdBin = "stitchd"
): Promise<Map<string, ProbeResult>> {
  const cameras = config.cameras;
  if (cameras.length === 0) return new Map();

  const proc = Bun.spawn(
    [stitchdBin, "--probe", ...cameras.map((c) => c.url)],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`stitchd --probe failed (exit ${exitCode}): ${stderr}`);
  }

  let rows: { width: number; height: number; fps: number }[];
  try {
    rows = JSON.parse(stdout);
  } catch {
    throw new Error(`stitchd --probe returned unparseable output: ${stdout}`);
  }
  if (rows.length !== cameras.length) {
    throw new Error(
      `stitchd --probe returned ${rows.length} rows for ${cameras.length} cameras`
    );
  }

  const out = new Map<string, ProbeResult>();
  for (let i = 0; i < cameras.length; i++) {
    const cam = cameras[i]!;
    const r = rows[i]!;
    // A camera that would not open comes back as zeros. Fail loudly: a silent
    // default here would silently mis-size the composite for everyone.
    if (!r.width || !r.height) {
      throw new Error(
        `could not probe camera "${cam.name}" — no video stream at its URL`
      );
    }
    out.set(cam.name, {
      width: r.width,
      height: r.height,
      fps: r.fps > 0 ? r.fps : 30,
    });
  }
  return out;
}
