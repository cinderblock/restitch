import type { Camera, Config } from "./config.ts";
import { layoutCameras, type ProbeResult } from "./stitchd.ts";

/**
 * Ask stitchd for the native resolution and frame rate of each camera.
 *
 * stitchd answers this itself (`--probe <url>...`) using the same libavformat
 * it will open the cameras with; this used to spawn one ffprobe per camera,
 * which was a second implementation of the same question and one more external
 * binary in the image. One process for all of them.
 *
 * A camera that does not answer is simply absent from the result — what that
 * means is the caller's decision, and it is never fatal here.
 */
export async function probeCameras(
  cameras: Camera[],
  stitchdBin = "stitchd"
): Promise<Map<string, ProbeResult>> {
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
    const r = rows[i]!;
    // A camera that would not open comes back as zeros.
    if (!r.width || !r.height) continue;
    out.set(cameras[i]!.name, {
      width: r.width,
      height: r.height,
      fps: r.fps > 0 ? r.fps : 30,
    });
  }
  return out;
}

/**
 * Geometry for every camera that sizes a layout, as far as it can be known
 * right now, plus the cameras it could not be known for.
 *
 * These dimensions decide the composite size and every piece rectangle in the
 * generated stitchd config, so they have to be settled before stitchd starts —
 * but a camera being down must not stop the service from starting, so "settled"
 * cannot mean "everyone answered":
 *
 *  - A main-composite member that does not answer takes the geometry of one
 *    that did. That is not a guess: the compositor stacks identical inputs
 *    (see CompositeInputs in compositor/src/cuda_composite.h), so the members
 *    share one geometry by construction. stitchd paints the absent one black.
 *  - Anything else has nothing to borrow from. It is returned in `missing`;
 *    buildStitchdConfig leaves out the outputs that need it, and the caller
 *    re-probes until it answers. The main composite's members land here too if
 *    not one of them answered.
 */
export async function probeLayout(
  config: Config,
  stitchdBin = "stitchd",
  /** Only ask these; everyone else keeps what `known` already holds. */
  only?: Camera[],
  known: Map<string, ProbeResult> = new Map()
): Promise<{ probes: Map<string, ProbeResult>; missing: Camera[] }> {
  const layout = layoutCameras(config);
  const probes = new Map(known);
  for (const [name, p] of await probeCameras(only ?? layout, stitchdBin))
    probes.set(name, p);

  const members = layout.filter((c) => c.composite !== false);
  const sibling = members.map((c) => probes.get(c.name)).find((p) => p);
  if (sibling) {
    for (const cam of members) {
      if (probes.has(cam.name)) continue;
      console.warn(
        `[probe] "${cam.name}" did not answer — using the main composite's ` +
          `${sibling.width}x${sibling.height}; its slot is black until it connects`
      );
      probes.set(cam.name, sibling);
    }
  }
  return { probes, missing: layout.filter((c) => !probes.has(c.name)) };
}
