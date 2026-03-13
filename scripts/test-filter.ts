/**
 * Quick test: build the filter_complex with sub-streams and rotation
 * to verify the pipeline generator handles all cases correctly.
 */
import { ConfigSchema } from "../src/config.ts";
import { buildPipeline, buildCommand, type ProbeResult } from "../src/ffmpeg.ts";

const config = ConfigSchema.parse({
  cameras: [
    { name: "Bay 1", url: "rtsp://bay-1:554/stream", rotation: "0", order: 0 },
    { name: "Bay 2", url: "rtsp://bay-2:554/stream", rotation: "0", order: 1 },
    { name: "Bay 3", url: "rtsp://bay-3:554/stream", rotation: "0", order: 2 },
    { name: "Bay 4", url: "rtsp://bay-4:554/stream", rotation: "0", order: 3 },
    { name: "Bay 5", url: "rtsp://bay-5:554/stream", rotation: "0", order: 4 },
  ],
  composite: {
    name: "full",
    direction: "vertical",
    rotation: "90",
  },
  sub_streams: [
    { name: "workbench", x: 0, y: 0, width: 2880, height: 2560 },
    { name: "entrance", x: 5760, y: 0, width: 1440, height: 2560 },
  ],
  hwaccel: "none",
});

const probes = new Map<string, ProbeResult>([
  ["Bay 1", { width: 2560, height: 1440, fps: 30 }],
  ["Bay 2", { width: 2560, height: 1440, fps: 30 }],
  ["Bay 3", { width: 2560, height: 1440, fps: 30 }],
  ["Bay 4", { width: 2560, height: 1440, fps: 30 }],
  ["Bay 5", { width: 2560, height: 1440, fps: 30 }],
]);

const pipeline = buildPipeline(config, probes);

console.log("=== Filter Complex ===");
console.log(pipeline.filterComplex);
console.log("\n=== Outputs ===");
for (const out of pipeline.outputs) {
  console.log(`  ${out.name} -> ${out.mapLabel}`);
}

console.log("\n=== Full Command ===");
const cmd = buildCommand(config, pipeline);
console.log(cmd.join(" \\\n  "));
