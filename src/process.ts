import type { Subprocess } from "bun";

export interface ManagedProcess {
  name: string;
  process: Subprocess;
  restart(): Promise<void>;
  stop(): void;
}

export type ProcessFactory = () => {
  cmd: string[];
  onStderr?: (line: string) => void;
  /** Optional raw stdout chunk callback. When set, stdout is piped instead
   *  of inherited so callers can consume the byte stream (e.g. audio PCM). */
  onStdout?: (chunk: Uint8Array) => void;
};

/**
 * Launch and manage a child process with automatic restart on crash.
 */
export function launchManaged(
  name: string,
  factory: ProcessFactory,
  opts: { restartDelayMs?: number; maxDelayMs?: number } = {}
): ManagedProcess {
  const baseDelayMs = opts.restartDelayMs ?? 3000;
  const maxDelayMs = opts.maxDelayMs ?? 60_000;
  let restartCount = 0;
  let stopped = false;
  let proc: Subprocess;

  function spawn(): Subprocess {
    const { cmd, onStderr, onStdout } = factory();
    console.log(`[${name}] Starting: ${cmd.join(" ").slice(0, 200)}...`);

    const child = Bun.spawn(cmd, {
      stdout: onStdout ? "pipe" : "inherit",
      stderr: "pipe",
    });

    // Stream stdout to caller as raw byte chunks if requested
    if (onStdout && child.stdout) {
      const stdoutReader = child.stdout.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await stdoutReader.read();
            if (done) break;
            if (value) onStdout(value);
          }
        } catch {
          // stream closed
        }
      })();
    }

    // Stream stderr for logging
    if (child.stderr) {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const line of text.split("\n").filter(Boolean)) {
              if (onStderr) {
                onStderr(line);
              } else {
                console.error(`[${name}] ${line}`);
              }
            }
          }
        } catch {
          // stream closed
        }
      })();
    }

    // Watch for exit and auto-restart with exponential backoff
    child.exited.then((code) => {
      if (stopped) return;
      restartCount++;
      const delay = Math.min(baseDelayMs * 2 ** (restartCount - 1), maxDelayMs);
      console.warn(
        `[${name}] Exited with code ${code}. Restarting (attempt ${restartCount}) in ${(delay / 1000).toFixed(0)}s...`
      );
      setTimeout(() => {
        if (!stopped) {
          proc = spawn();
        }
      }, delay);
    });

    return child;
  }

  proc = spawn();

  return {
    name,
    get process() {
      return proc;
    },
    async restart() {
      proc.kill();
      await proc.exited;
      restartCount = 0;
      proc = spawn();
    },
    stop() {
      stopped = true;
      proc.kill();
    },
  };
}
