import { parseArgs } from "util";
import { resolve } from "path";
import YAML from "yaml";
import { ConfigSchema, type Config } from "./config.ts";
import { writeFileSync } from "fs";
import { buildStitchdConfig, type ProbeResult } from "./stitchd.ts";
import { probeAllCameras } from "./probe.ts";
import { launchManaged, type ManagedProcess } from "./process.ts";
import { startDashboard } from "./dashboard.ts";
import { startTranscription, type PcmSink } from "./transcribe.ts";
import { startWatchdog, type WatchedProcess } from "./watchdog.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: "string", short: "c", default: "config.yaml" },
    "dry-run": { type: "boolean", default: false },
    "skip-probe": { type: "boolean", default: false },
    "stitchd-bin": { type: "string", default: "stitchd" },
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

  const config = await loadConfig(configPath);

  // No hwaccel probe here any more. It tested ffmpeg's CUDA support for the
  // filtergraph compositor, which is gone. stitchd builds a CUDA device and
  // opens NVDEC/NVENC at startup and exits with an error if it can't — the
  // GPU-or-loud-error guarantee now lives in the thing that actually uses the
  // GPU, rather than in a proxy check against a different binary.

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
    cameraProbes = await probeAllCameras(config, values["stitchd-bin"] ?? "stitchd");
    for (const [name, probe] of cameraProbes) {
      console.log(
        `  ${name}: ${probe.width}x${probe.height} @ ${probe.fps.toFixed(1)}fps`
      );
    }
  }

  const stitchd = buildStitchdConfig(config, cameraProbes);
  console.log("\n--- stitchd config ---");
  console.log(stitchd.text);
  console.log("--- Output Streams ---");
  for (const n of stitchd.outputNames)
    console.log(`  ${n} -> ${config.output.base_url}/${n}`);

  if (values["dry-run"]) {
    console.log("\n--- stitchd command (dry run) ---");
    console.log("stitchd --config <runtime>/stitchd.conf --out null");
    return;
  }

  // Generated config goes in a WRITABLE runtime dir, not next to config.yaml —
  // in the container the config dir is mounted read-only (owned by the ops
  // repo), so writing there fails with EROFS. RESTITCH_RUNTIME_DIR overrides.
  const processes: ManagedProcess[] = [];
  const runtimeDir = process.env.RESTITCH_RUNTIME_DIR || "/tmp";

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

  const watched: WatchedProcess[] = [];

  // stitchd emits the merged N-channel PCM on its stdout. The consumer is
  // installed later (startTranscription, once whisper is up), so this holder
  // lets the compositor launch first without reordering startup. Bytes before
  // then are dropped on purpose — queueing audio for a server that cannot
  // answer just builds a backlog.
  const pcmSink: PcmSink = { write: null };

  // stitchd writes fMP4 HLS segments here; the dashboard serves them at
  // /hls/<output>/index.m3u8.
  const hlsDir = `${runtimeDir}/hls`;

  // stitchd owns the client-facing ports outright: 8554 (RTSP), 8889 (WHEP +
  // /api/status) and 8189 (media UDP mux). 8189 in particular must not move —
  // the office WAN forward points at exactly that port.
  const stitchdRtspPort = 8554;
  const stitchdWebrtcPort = 8889;
  const stitchdWebrtcUdp = 8189;

  // ONE process produces every output. Its config file is rewritten on each
  // (re)spawn — cheap, and it keeps a restart picking up any config change.
  // The watchdog restarts it if an output path stalls or an input reconnects.
  const stitchdConfPath = `${runtimeDir}/stitchd.conf`;
  const stitchdProc = launchManaged("stitchd", () => {
    writeFileSync(stitchdConfPath, buildStitchdConfig(config, cameraProbes).text);
    return {
      cmd: [
        values["stitchd-bin"] ?? "stitchd",
        "--config", stitchdConfPath,
        // Nothing to publish to: stitchd serves RTSP/HLS/WebRTC itself, so the
        // outputs stay in-process rather than being pushed back out over
        // localhost RTSP and read in again.
        "--out", "null",
        "--hls-dir", hlsDir,
        "--rtsp-port", String(stitchdRtspPort),
        "--webrtc-port", String(stitchdWebrtcPort),
        "--webrtc-udp", String(stitchdWebrtcUdp),
        ...config.webrtc.ice_servers.flatMap((u) => ["--ice-server", u]),
        ...config.webrtc.additional_hosts.flatMap((h) => ["--webrtc-host", h]),
      ],
      onStderr: stderrFilter("stitchd"),
      // Raw interleaved s16le from stitchd's audio mixer. Only meaningful when
      // the config declares audio-ch lines; otherwise stitchd writes nothing
      // here and this is never called.
      onStdout: (chunk: Uint8Array) => pcmSink.write?.(chunk),
    };
  });
  processes.push(stitchdProc);
  watched.push({
    name: "stitchd",
    paths: stitchd.outputNames,
    process: stitchdProc,
    inputPaths: stitchd.inputPaths,
  });

  // Transcription stack (whisper-server). Spawns its own supervised
  // subprocesses into `processes`. stitchd already demuxes every camera and
  // hands us the merged audio directly, so there is no separate audio pump.
  const transcription = startTranscription(config, processes, pcmSink);

  // Watchdog: restart stitchd if an output stops producing, or if one of its
  // inputs reconnects. Catches a stuck-but-alive process the supervisor
  // cannot see.
  const watchdog = startWatchdog(watched, {
    statusUrl: `http://127.0.0.1:${stitchdWebrtcPort}/api/status`,
  });

  // Dashboard HTTP server: stream state from stitchd's /api/status, plus
  // /api/system and the transcription ring buffer.
  const dashServer = config.dashboard.enabled
    ? startDashboard(
        config.dashboard,
        `http://127.0.0.1:${stitchdWebrtcPort}/api/status`,
        transcription,
        hlsDir
      )
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
