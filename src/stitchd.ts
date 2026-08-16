// Builds stitchd's runtime config from config.yaml.
//
// stitchd is the only compositor: one CUDA process decodes each camera once and
// produces every output. This file used to also generate ffmpeg filtergraphs and
// a config for the pre-cutover streaming server; both are gone, so what remains
// is the translation from config.yaml into stitchd's line-oriented config
// (see parse_config() in compositor/src/main.cpp).

import type { Camera, Config } from "./config.ts";

/** Stream name stitchd republishes a camera at, verbatim: raw/<slug>. */
export function rawStreamName(cam: Camera): string {
  return `raw/${cam.name.toLowerCase().replace(/\s+/g, "-")}`;
}

export interface ProbeResult {
  width: number;
  height: number;
  fps: number;
}

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
 * Resolve a dimension value that may be a pixel count or a percentage string.
 * Percentages are resolved against the given reference size and rounded to
 * the nearest even integer (required by most video codecs).
 */
function resolveDimension(value: number | string, reference: number): number {
  if (typeof value === "number") return value;
  const pct = parseFloat(value) / 100;
  return Math.round((pct * reference) / 2) * 2;
}

/**
 * Dimensions of the main composite frame (post-rotation, PRE-scale) — the
 * space sub_stream crop percentages resolve against.
 */
function mainCompositeDims(
  config: Config,
  cameraProbes: Map<string, ProbeResult>
): { width: number; height: number } {
  const cameras = config.cameras
    .filter((c) => c.composite !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const firstCam = cameras[0]!;
  const firstProbe = cameraProbes.get(firstCam.name)!;
  const camRotated = rotatedDimensions(
    firstProbe.width,
    firstProbe.height,
    firstCam.rotation
  );
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
  return rotatedDimensions(compositeW, compositeH, config.composite.rotation);
}

/**
 * Output dimensions of a produced stream (the main composite or a sub_stream),
 * derived from config + camera probes, so extra composites can reference one
 * as an input without probing it live (it may not be publishing yet at build
 * time — the extra composite and the main compositor start concurrently).
 */
function producedStreamDims(
  config: Config,
  cameraProbes: Map<string, ProbeResult>,
  streamName: string
): { width: number; height: number } | null {
  const comp = mainCompositeDims(config, cameraProbes);
  if (streamName === config.composite.name) {
    return config.composite.scale ?? comp;
  }
  const sub = config.sub_streams.find((s) => s.name === streamName);
  if (!sub) return null;
  if (sub.scale) return { width: sub.scale.width, height: sub.scale.height };
  const w = resolveDimension(sub.width, comp.width);
  const h = resolveDimension(sub.height, comp.height);
  return rotatedDimensions(w, h, sub.rotation);
}

/** Parse a bitrate string like "8M" / "800k" into bits/sec (0 if absent). */
function parseRate(s: string | undefined): number {
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/.exec(s.trim());
  if (!m) return 0;
  const mult = { "": 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6, g: 1e9, G: 1e9 }[m[2]!]!;
  return Math.round(parseFloat(m[1]!) * mult);
}

/** stitchd piece rotation: the CUDA kernel supports 0 or 180. */
function stitchdRot(rotation: string, ctx: string): number {
  if (rotation === "0" || rotation === "180")
    return rotation === "180" ? 180 : 0;
  throw new Error(
    `stitchd (compositor: native) supports rotation 0 or 180 only; ` +
      `${ctx} uses "${rotation}". Use the ffmpeg compositor for this config.`
  );
}

/**
 * Generate the stitchd (native compositor) config from config.yaml. stitchd
 * decodes each camera once and builds every output GPU-resident. The config is
 * a simple line format (see compositor/src/main.cpp parse_config): composite
 * inputs + dims, aux cameras, and per-output `piece` lists. Every output is a
 * vertical stack of crop→scale→rot180 gather pieces whose source is
 * "composite", an aux camera slug, or a previously-declared output name (so
 * all-field samples the-field's in-GPU frame — no re-decode/re-encode).
 *
 * Returns the config text plus the raw input paths (for the watchdog) and the
 * output stream names. Assumes the composite is a vstack rotated 90 (the CUDA
 * kernel's fixed geometry); throws on unsupported rotations so we never
 * silently produce wrong output.
 */
export function buildStitchdConfig(
  config: Config,
  cameraProbes: Map<string, ProbeResult>
): {
  text: string;
  inputPaths: string[];
  outputNames: string[];
  /** Cameras stitchd will emit audio for, in interleave order. */
  audioChannels: Camera[];
} {
  if (config.composite.rotation !== "90") {
    throw new Error(
      `stitchd assumes composite rotation 90 (got "${config.composite.rotation}").`
    );
  }
  const base = config.output.base_url;
  const cameras = config.cameras
    .filter((c) => c.composite !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const fps = Math.round(cameraProbes.get(cameras[0]!.name)!.fps);
  const comp = mainCompositeDims(config, cameraProbes);
  const cameraByName = new Map(config.cameras.map((c) => [c.name, c]));

  const lines: string[] = [];
  const inputPaths: string[] = [];
  const outputNames: string[] = [];

  lines.push(`fps ${fps}`);
  lines.push(`comp-rot ${config.composite.rotation}`);
  lines.push(`comp-dim ${comp.width} ${comp.height}`);
  for (const cam of cameras) {
    const slug = rawStreamName(cam);
    // Straight to the camera: each is pulled exactly once, by stitchd.
    lines.push(`comp-in ${cam.url}`);
    inputPaths.push(slug);
  }

  // Aux cameras: those referenced by extra composites (by name, not stream).
  const aux = new Map<string, string>(); // slug -> url
  for (const extra of config.extra_composites)
    for (const ref of extra.inputs)
      if (ref.stream === undefined && ref.name) {
        const cam = cameraByName.get(ref.name);
        if (cam) aux.set(rawStreamName(cam), cam.url);
      }
  for (const [slug, url] of aux) {
    lines.push(`aux ${slug} ${url}`);
    inputPaths.push(slug);
  }

  // Transcription channels. Order is load-bearing: stitchd interleaves the
  // merged PCM in exactly this order and the consumer de-interleaves by index,
  // so this MUST match startTranscription's `config.cameras.filter(transcribe)`
  // — same source array, same filter, no sort. A camera already listed above
  // rides that existing connection; the rest open audio-only inside stitchd.
  // Republish EVERY camera verbatim at raw/<slug>. Home Assistant (and
  // anything else) then reads per-camera streams from stitchd instead of
  // opening a second connection to the NVR, which is the whole point of
  // pulling each camera exactly once.
  for (const cam of config.cameras) {
    lines.push(`raw ${rawStreamName(cam).replace(/^raw\//, "")} ${cam.url}`);
  }

  const audioChannels = config.cameras.filter((c) => c.transcribe);
  for (const cam of audioChannels) {
    const slug = rawStreamName(cam);
    lines.push(`audio-ch ${slug} ${cam.url}`);
  }

  type P = { src: string; cx: number; cy: number; cw: number; ch: number; sw: number; sh: number; rot: number };
  const emit = (name: string, codec: string, maxrate: number, pieces: P[]) => {
    lines.push(`out ${name} ${codec} ${maxrate}`);
    for (const p of pieces)
      lines.push(
        `piece ${p.src} ${p.cx} ${p.cy} ${p.cw} ${p.ch} ${p.sw} ${p.sh} ${p.rot}`
      );
    outputNames.push(name);
  };

  // Main composite (`full`): the whole composite, optional scale.
  const mScale = config.composite.scale;
  emit(config.composite.name, config.encoder.codec, 0, [
    {
      src: "composite", cx: 0, cy: 0, cw: comp.width, ch: comp.height,
      sw: mScale?.width ?? comp.width, sh: mScale?.height ?? comp.height, rot: 0,
    },
  ]);

  // Sub-streams: crop the composite, scale, rotate.
  for (const sub of config.sub_streams) {
    const cx = resolveDimension(sub.x, comp.width);
    const cy = resolveDimension(sub.y, comp.height);
    const cw = resolveDimension(sub.width, comp.width);
    const ch = resolveDimension(sub.height, comp.height);
    const scale = sub.scale ?? { width: cw, height: ch };
    emit(sub.name, sub.codec ?? config.encoder.codec, parseRate(sub.maxrate), [
      {
        src: "composite", cx, cy, cw, ch, sw: scale.width, sh: scale.height,
        rot: stitchdRot(sub.rotation, `sub_stream "${sub.name}"`),
      },
    ]);
  }

  // Extra composites: a vertical stack; each input a crop+scale+rot piece.
  for (const extra of config.extra_composites) {
    const raw = extra.inputs.map((ref, i) => {
      let src: string, srcW: number, srcH: number, rot: string;
      if (ref.stream !== undefined) {
        src = ref.stream;
        const d = producedStreamDims(config, cameraProbes, ref.stream);
        if (!d)
          throw new Error(
            `extra_composite "${extra.name}" refs unknown stream "${ref.stream}"`
          );
        srcW = d.width; srcH = d.height;
        rot = ref.rotation ?? "0";
      } else {
        const cam = cameraByName.get(ref.name!)!;
        src = rawStreamName(cam);
        const probe = cameraProbes.get(ref.name!)!;
        srcW = probe.width; srcH = probe.height;
        rot = ref.rotation ?? cam.rotation;
      }
      // restitch applies rotation THEN crop (crop is post-rotation). Resolve the
      // crop against post-rotation dims, then translate to stitchd's
      // crop-then-rot180 order.
      const pr = rotatedDimensions(srcW, srcH, rot);
      let cx = 0, cy = 0, cw = pr.width, ch = pr.height;
      if (ref.crop) {
        cx = resolveDimension(ref.crop.x, pr.width);
        cy = resolveDimension(ref.crop.y, pr.height);
        cw = resolveDimension(ref.crop.width, pr.width);
        ch = resolveDimension(ref.crop.height, pr.height);
      }
      const r = stitchdRot(rot, `extra_composite "${extra.name}" input ${i}`);
      // For 180, gather the mirrored source rect then rot180 the output.
      const scx = r === 180 ? srcW - cx - cw : cx;
      const scy = r === 180 ? srcH - cy - ch : cy;
      return { src, scx, scy, cw, ch, rot: r };
    });
    // Vertical stack: scale every piece to the first piece's width.
    const refW = raw[0]!.cw;
    const pieces: P[] = raw.map((p, i) => {
      const sw = refW;
      const sh = i === 0 ? p.ch : Math.round((p.ch * refW) / p.cw / 2) * 2;
      return { src: p.src, cx: p.scx, cy: p.scy, cw: p.cw, ch: p.ch, sw, sh, rot: p.rot };
    });
    emit(extra.name, extra.codec ?? config.encoder.codec,
         parseRate(extra.maxrate), pieces);
  }

  return { text: lines.join("\n") + "\n", inputPaths, outputNames, audioChannels };
}
