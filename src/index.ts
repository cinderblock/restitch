import { parseArgs } from "util";
import { resolve } from "path";
import YAML from "yaml";
import { ConfigSchema, type Config } from "./config.ts";
import {
  buildPipeline,
  buildExtraCompositePipeline,
  buildCommand,
  ensureHwaccelWorks,
  type ProbeResult,
  type Pipeline,
} from "./ffmpeg.ts";
import { probeAllCameras } from "./probe.ts";
import { writeMediaMTXConfig } from "./mediamtx.ts";
import { launchManaged, type ManagedProcess } from "./process.ts";
import { detectHwAccel, suggestEncoder } from "./hwaccel.ts";
import { startDashboard } from "./dashboard.ts";
import { startTranscription } from "./transcribe.ts";
import { startWatchdog, type WatchedProcess } from "./watchdog.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: "string", short: "c", default: "config.yaml" },
    "dry-run": { type: "boolean", default: false },
    "skip-probe": { type: "boolean", default: false },
    "mediamtx-bin": { type: "string", default: "mediamtx" },
    "no-mediamtx": { type: "boolean", default: false },
  },
});

async function loadConfig(path: string): Promise<Config> {
  const raw = await Bun.file(path).text();
  const parsed = YAML.parse(raw);
  return ConfigSchema.parse(parsed);
}

async function main() {
  const configPath = resolve(values.config!);
  console.log(`Loading config from ${configPath}`);

  let config = await loadConfig(configPath);

  // Auto-detect hardware acceleration
  if (config.hwaccel === "auto") {
    const detected = await detectHwAccel(config.ffmpeg_path);
    console.log(`[hwaccel] Detected: ${detected}`);
    // Re-parse with the detected value applied
    config = { ...config, hwaccel: detected } as Config;
  }

  // Fail loudly if hwaccel is requested but the box can't actually use it
  // (driver missing, container missing NVIDIA capabilities, etc.). Catches
  // the "silent CPU fallback" footgun before we spawn long-running pipelines.
  await ensureHwaccelWorks(config);
  if (config.hwaccel !== "none") {
    console.log(`[hwaccel] ${config.hwaccel}: probe ok`);
  }

  // Probe cameras for native resolution
  let cameraProbes: Map<string, ProbeResult>;
  if (values["skip-probe"]) {
    console.log("Skipping camera probe (using defaults: 2560x1440@30fps)");
    cameraProbes = new Map(
      config.cameras.map((cam) => [
        cam.name,
        { width: 2560, height: 1440, fps: 30 },
      ])
    );
  } else {
    console.log("Probing cameras...");
    cameraProbes = await probeAllCameras(config);
    for (const [name, probe] of cameraProbes) {
      console.log(
        `  ${name}: ${probe.width}x${probe.height} @ ${probe.fps.toFixed(1)}fps`
      );
    }
  }

  // Build the main FFmpeg pipeline (Bay 1-5 composite + sub-streams)
  const pipeline = buildPipeline(config, cameraProbes);

  // Build a separate pipeline per extra composite. We keep the `extra` config
  // around so the launch factory can REBUILD the command on every (re)spawn —
  // see the note on the ffmpeg launch below for why a fresh build per spawn
  // matters (the setpts wall-clock baseline must be recomputed each restart).
  const extraPipelines: {
    name: string;
    extra: (typeof config.extra_composites)[number];
    pipeline: Pipeline;
    cmd: string[];
  }[] = config.extra_composites.map((extra) => {
    const p = buildExtraCompositePipeline(config, extra, cameraProbes);
    return { name: extra.name, extra, pipeline: p, cmd: buildCommand(config, p) };
  });

  console.log("\n--- Filter Complex (main) ---");
  console.log(pipeline.filterComplex);
  console.log("\n--- Output Streams ---");
  const allOutputs = [
    ...pipeline.outputs,
    ...extraPipelines.flatMap((e) => e.pipeline.outputs),
  ];
  for (const out of allOutputs) {
    console.log(`  ${out.name} -> ${config.output.base_url}/${out.name}`);
  }
  if (extraPipelines.length > 0) {
    console.log("\n--- Extra Composites ---");
    for (const e of extraPipelines) {
      console.log(`[${e.name}]`);
      console.log(e.pipeline.filterComplex);
    }
  }

  const fullCmd = buildCommand(config, pipeline);

  if (values["dry-run"]) {
    console.log("\n--- FFmpeg Command (main, dry run) ---");
    console.log(fullCmd.join(" \\\n  "));
    for (const e of extraPipelines) {
      console.log(`\n--- FFmpeg Command (${e.name}, dry run) ---`);
      console.log(e.cmd.join(" \\\n  "));
    }
    return;
  }

  // Write mediamtx config and launch it.
  // NOTE: write the generated mediamtx config to a WRITABLE runtime dir, not
  // next to config.yaml — in the container the config dir is mounted
  // read-only (it's owned by the jackson ops repo), so writing there fails
  // with EROFS. RESTITCH_RUNTIME_DIR overrides; default /tmp.
  const processes: ManagedProcess[] = [];
  const runtimeDir = process.env.RESTITCH_RUNTIME_DIR || "/tmp";

  if (!values["no-mediamtx"]) {
    const mtxConfigPath = await writeMediaMTXConfig(
      runtimeDir,
      config,
      allOutputs
    );
    const mtxBin = values["mediamtx-bin"]!;

    const mtxProc = launchManaged("mediamtx", () => ({
      cmd: [mtxBin, mtxConfigPath],
    }));
    processes.push(mtxProc);

    // Give mediamtx a moment to start listening
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Stderr filter to suppress noisy progress lines
  const stderrFilter = (prefix: string) => (line: string) => {
    if (
      config.log_level !== "verbose" &&
      config.log_level !== "debug" &&
      line.startsWith("frame=")
    ) {
      return;
    }
    console.error(`[${prefix}] ${line}`);
  };

  // Main FFmpeg: composite + sub-streams.
  //
  // REBUILD the command on every (re)spawn rather than reusing `fullCmd`. The
  // setpts expressions embed a wall-clock baseline (ptsBaselineMicros, captured
  // when buildPipeline runs). If we baked the baseline once at startup and the
  // supervisor restarted ffmpeg minutes/hours later, the first frame's PTS would
  // be (now − stale_baseline) = a large value; combined with CFR output that
  // makes ffmpeg duplicate-fill the entire gap before emitting a real frame, so
  // sub-streams took 9–14 min to start publishing after a restart. Recomputing
  // the baseline per spawn keeps PTS ~0 and the stream live immediately.
  const watched: WatchedProcess[] = [];
  const ffmpegProc = launchManaged("ffmpeg", () => ({
    cmd: buildCommand(config, buildPipeline(config, cameraProbes)),
    onStderr: stderrFilter("ffmpeg"),
  }));
  processes.push(ffmpegProc);
  watched.push({
    name: "ffmpeg",
    paths: pipeline.outputs.map((o) => o.name),
    process: ffmpegProc,
  });

  // One FFmpeg per extra composite — independent restart, independent CPU/GPU
  for (const e of extraPipelines) {
    // Rebuild per spawn for a fresh setpts baseline — same reason as the main
    // compositor above.
    const proc = launchManaged(`ffmpeg-${e.name}`, () => ({
      cmd: buildCommand(config, buildExtraCompositePipeline(config, e.extra, cameraProbes)),
      onStderr: stderrFilter(`ffmpeg-${e.name}`),
    }));
    processes.push(proc);
    // Content-freshness geometry: one band per stacked input. A vertical stack
    // splits into row-bands; a horizontal stack into col-bands; a 90/270°
    // post-stack rotation swaps the axis (the published frame is what we
    // sample). This catches the exact failure we keep hitting — an input's RTSP
    // read silently wedges and the fps filter duplicates its last frame forever,
    // so bytes keep flowing but that band goes pixel-static.
    const rot = Number(e.extra.rotation); // "0" | "90" | "180" | "270" enum
    const quarterTurn = rot === 90 || rot === 270;
    let freshnessAxis: "rows" | "cols" =
      e.extra.direction === "vertical" ? "rows" : "cols";
    if (quarterTurn) freshnessAxis = freshnessAxis === "rows" ? "cols" : "rows";
    watched.push({
      name: `ffmpeg-${e.name}`,
      paths: e.pipeline.outputs.map((o) => o.name),
      process: proc,
      freshnessBands: e.extra.inputs.length,
      freshnessAxis,
    });
  }

  // Transcription stack (whisper-server + audio fusion pump). Spawns its
  // own supervised subprocesses into `processes`. Returns the ring+stats
  // synchronously; the audio pump attaches once whisper warms up.
  const transcription = startTranscription(config, processes);

  // Watchdog: restart any ffmpeg whose mediamtx output path stops
  // receiving bytes. Catches stuck-but-alive ffmpegs that the supervisor
  // can't see (it only restarts on process exit). ffmpegPath/baseUrl enable
  // the content-freshness check that catches silently-frozen input branches
  // (byte flow stays healthy, so this samples the actual pixels).
  const watchdog = startWatchdog(watched, {
    ffmpegPath: config.ffmpeg_path,
    baseUrl: config.output.base_url,
  });

  // Dashboard HTTP server (proxies mediamtx API + exposes /api/system +
  // /api/transcriptions + /api/transcription-stats from the in-process
  // ring buffer)
  const dashServer = config.dashboard.enabled
    ? startDashboard(config.dashboard, transcription, {
        ffmpegPath: config.ffmpeg_path,
        baseUrl: config.output.base_url,
      })
    : null;
  if (dashServer) {
    console.log(
      `[dashboard] listening on http://${dashServer.hostname}:${dashServer.port}`
    );
  }

  // Handle shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    watchdog.stop();
    for (const p of processes) {
      p.stop();
    }
    dashServer?.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("\nRunning. Press Ctrl+C to stop.");

  // Keep alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
