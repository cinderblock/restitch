import { parseArgs } from "util";
import { resolve } from "path";
import YAML from "yaml";
import { ConfigSchema, type Config } from "./config.ts";
import { writeFileSync } from "fs";
import {
  buildPipeline,
  buildExtraCompositePipeline,
  buildCommand,
  buildStitchdConfig,
  ensureHwaccelWorks,
  type ProbeResult,
  type Pipeline,
  type PipelineOutput,
} from "./ffmpeg.ts";
import { probeAllCameras } from "./probe.ts";
import { writeMediaMTXConfig, rawStreamName } from "./mediamtx.ts";
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
    "stitchd-bin": { type: "string", default: "stitchd" },
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

  // Which compositor? "native" = stitchd (custom CUDA compositor, one process
  // for ALL outputs); "ffmpeg" = the classic filtergraph (main + one per extra).
  const nativeCompositor = config.compositor === "native";
  const cameraByName = new Map(config.cameras.map((c) => [c.name, c]));

  let pipeline: Pipeline | undefined;
  let extraPipelines: {
    name: string;
    extra: (typeof config.extra_composites)[number];
    pipeline: Pipeline;
    cmd: string[];
  }[] = [];
  let stitchd:
    | { text: string; inputPaths: string[]; outputNames: string[] }
    | undefined;
  let allOutputs: PipelineOutput[];

  if (nativeCompositor) {
    stitchd = buildStitchdConfig(config, cameraProbes);
    allOutputs = stitchd.outputNames.map((name) => ({ name, mapLabel: name }));
    console.log("\n--- stitchd (native compositor) config ---");
    console.log(stitchd.text);
    console.log("--- Output Streams ---");
    for (const n of stitchd.outputNames)
      console.log(`  ${n} -> ${config.output.base_url}/${n}`);
  } else {
    // Main FFmpeg pipeline (composite + sub-streams) + one pipeline per extra
    // composite (each its own process; see the launch note below). Kept as
    // `extra` config so the launch factory can rebuild the command per spawn.
    pipeline = buildPipeline(config, cameraProbes);
    extraPipelines = config.extra_composites.map((extra) => {
      const p = buildExtraCompositePipeline(config, extra, cameraProbes);
      return { name: extra.name, extra, pipeline: p, cmd: buildCommand(config, p) };
    });
    console.log("\n--- Filter Complex (main) ---");
    console.log(pipeline.filterComplex);
    console.log("\n--- Output Streams ---");
    allOutputs = [
      ...pipeline.outputs,
      ...extraPipelines.flatMap((e) => e.pipeline.outputs),
    ];
    for (const out of allOutputs)
      console.log(`  ${out.name} -> ${config.output.base_url}/${out.name}`);
    if (extraPipelines.length > 0) {
      console.log("\n--- Extra Composites ---");
      for (const e of extraPipelines) {
        console.log(`[${e.name}]`);
        console.log(e.pipeline.filterComplex);
      }
    }
  }

  if (values["dry-run"]) {
    if (nativeCompositor) {
      console.log("\n--- stitchd command (dry run) ---");
      console.log(
        `stitchd --config <runtime>/stitchd.conf --out ${config.output.base_url}`
      );
    } else {
      console.log("\n--- FFmpeg Command (main, dry run) ---");
      console.log(buildCommand(config, pipeline!).join(" \\\n  "));
      for (const e of extraPipelines) {
        console.log(`\n--- FFmpeg Command (${e.name}, dry run) ---`);
        console.log(e.cmd.join(" \\\n  "));
      }
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

  if (nativeCompositor) {
    // stitchd: ONE process produces every output. Rewrite its config file each
    // (re)spawn (cheap; keeps behavior identical to the ffmpeg factory which
    // rebuilds per spawn). The watchdog restarts it if any output path stalls
    // or any input source reconnects — same contract as the ffmpeg compositor.
    const stitchdConfPath = `${runtimeDir}/stitchd.conf`;
    const stitchdProc = launchManaged("stitchd", () => {
      writeFileSync(
        stitchdConfPath,
        buildStitchdConfig(config, cameraProbes).text
      );
      return {
        cmd: [
          values["stitchd-bin"] ?? "stitchd",
          "--config",
          stitchdConfPath,
          "--out",
          config.output.base_url,
        ],
        onStderr: stderrFilter("stitchd"),
      };
    });
    processes.push(stitchdProc);
    watched.push({
      name: "stitchd",
      paths: stitchd!.outputNames,
      process: stitchdProc,
      inputPaths: stitchd!.inputPaths,
    });
  } else {
  const ffmpegProc = launchManaged("ffmpeg", () => ({
    cmd: buildCommand(config, buildPipeline(config, cameraProbes)),
    onStderr: stderrFilter("ffmpeg"),
  }));
  processes.push(ffmpegProc);
  // Raw input paths the main compositor reads (the composite cameras). If any
  // of these sources reconnects, the watchdog restarts the compositor before a
  // wedged read can silently freeze that bay.
  watched.push({
    name: "ffmpeg",
    paths: pipeline!.outputs.map((o) => o.name),
    process: ffmpegProc,
    inputPaths: config.cameras
      .filter((c) => c.composite !== false)
      .map((c) => rawStreamName(c)),
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
    watched.push({
      name: `ffmpeg-${e.name}`,
      paths: e.pipeline.outputs.map((o) => o.name),
      process: proc,
      // Restart this composite when one of its input sources reconnects — that
      // reconnect is what wedges the read and freezes a half (e.g. foyer).
      // Camera refs watch raw/<slug>; stream refs watch the produced stream's
      // own path (so e.g. all-field restarts right after the main compositor).
      inputPaths: e.extra.inputs.flatMap((ref) => {
        if (ref.stream !== undefined) return [ref.stream];
        const cam = cameraByName.get(ref.name!);
        return cam ? [rawStreamName(cam)] : [];
      }),
    });
  }
  }

  // Transcription stack (whisper-server + audio fusion pump). Spawns its
  // own supervised subprocesses into `processes`. Returns the ring+stats
  // synchronously; the audio pump attaches once whisper warms up.
  const transcription = startTranscription(config, processes);

  // Watchdog: restart any ffmpeg whose mediamtx output path stops receiving
  // bytes, OR whose input source reconnects (which wedges the read and freezes
  // a composite half). Catches stuck-but-alive ffmpegs the supervisor can't see.
  const watchdog = startWatchdog(watched);

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
