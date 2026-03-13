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
};

/**
 * Launch and manage a child process with automatic restart on crash.
 */
export function launchManaged(
  name: string,
  factory: ProcessFactory,
  opts: { maxRestarts?: number; restartDelayMs?: number } = {}
): ManagedProcess {
  const maxRestarts = opts.maxRestarts ?? 10;
  const restartDelayMs = opts.restartDelayMs ?? 3000;
  let restartCount = 0;
  let stopped = false;
  let proc: Subprocess;

  function spawn(): Subprocess {
    const { cmd, onStderr } = factory();
    console.log(`[${name}] Starting: ${cmd.join(" ").slice(0, 200)}...`);

    const child = Bun.spawn(cmd, {
      stdout: "inherit",
      stderr: "pipe",
    });

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

    // Watch for exit and auto-restart
    child.exited.then((code) => {
      if (stopped) return;
      console.warn(`[${name}] Exited with code ${code}`);
      if (restartCount < maxRestarts) {
        restartCount++;
        console.log(
          `[${name}] Restarting (attempt ${restartCount}/${maxRestarts}) in ${restartDelayMs}ms...`
        );
        setTimeout(() => {
          if (!stopped) {
            proc = spawn();
          }
        }, restartDelayMs);
      } else {
        console.error(
          `[${name}] Max restarts (${maxRestarts}) reached. Giving up.`
        );
      }
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
