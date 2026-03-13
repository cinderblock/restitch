/**
 * Auto-detect available hardware acceleration.
 * Returns the best available hwaccel type, or "none".
 */
export async function detectHwAccel(ffmpegPath: string): Promise<string> {
  const isWindows = process.platform === "win32";

  // Rather than trusting -hwaccels (which lists compiled-in, not available),
  // we try to actually initialize each device and see if it works.
  const candidates = isWindows
    ? ["cuda", "qsv"]         // vaapi is Linux-only
    : ["vaapi", "qsv", "cuda"];

  for (const candidate of candidates) {
    if (await testHwAccel(ffmpegPath, candidate)) {
      const mapped = candidate === "cuda" ? "nvenc" : candidate;
      return mapped;
    }
  }

  return "none";
}

async function testHwAccel(ffmpegPath: string, device: string): Promise<boolean> {
  try {
    // Try to init the hw device with a null input — exits immediately
    // but will fail if the device isn't actually available
    const proc = Bun.spawn(
      [ffmpegPath, "-v", "quiet", "-init_hw_device", `${device}=test`, "-f", "lavfi", "-i", "nullsrc=s=64x64:d=0.01", "-frames:v", "1", "-f", "null", "-"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Given a detected hwaccel type, suggest an appropriate encoder codec.
 */
export function suggestEncoder(hwaccel: string): string {
  switch (hwaccel) {
    case "vaapi":
      return "h264_vaapi";
    case "qsv":
      return "h264_qsv";
    case "nvenc":
      return "h264_nvenc";
    default:
      return "libx264";
  }
}
