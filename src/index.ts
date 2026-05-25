import { parseArgs } from "util";
import { resolve, dirname } from "path";
import YAML from "yaml";
import { ConfigSchema, type Config } from "./config.ts";
import { buildPipeline, buildCommand, type ProbeResult } from "./ffmpeg.ts";
import { probeAllCameras } from "./probe.ts";
import { writeMediaMTXConfig } from "./mediamtx.ts";
import { launchManaged, type ManagedProcess } from "./process.ts";
import { detectHwAccel, suggestEncoder } from "./hwaccel.ts";
import { startDashboard } from "./dashboard.ts";

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

  // Build the FFmpeg pipeline
  const pipeline = buildPipeline(config, cameraProbes);

  console.log("\n--- Filter Complex ---");
  console.log(pipeline.filterComplex);
  console.log("\n--- Output Streams ---");
  for (const out of pipeline.outputs) {
    console.log(`  ${out.name} -> ${config.output.base_url}/${out.name}`);
  }

  const fullCmd = buildCommand(config, pipeline);

  if (values["dry-run"]) {
    console.log("\n--- FFmpeg Command (dry run) ---");
    console.log(fullCmd.join(" \\\n  "));
    return;
  }

  // Write mediamtx config and launch it
  const processes: ManagedProcess[] = [];
  const configDir = dirname(configPath);

  if (!values["no-mediamtx"]) {
    const mtxConfigPath = await writeMediaMTXConfig(
      configDir,
      config,
      pipeline.outputs
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

  // Launch single FFmpeg that pulls directly from cameras,
  // composites, and pushes to mediamtx
  const ffmpegProc = launchManaged("ffmpeg", () => ({
    cmd: fullCmd,
    onStderr: stderrFilter("ffmpeg"),
  }));
  processes.push(ffmpegProc);

  // Dashboard HTTP server (proxies mediamtx API + exposes /api/system)
  const dashServer = config.dashboard.enabled
    ? startDashboard(config.dashboard)
    : null;
  if (dashServer) {
    console.log(
      `[dashboard] listening on http://${dashServer.hostname}:${dashServer.port}`
    );
  }

  // Handle shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
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
