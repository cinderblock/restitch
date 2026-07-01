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
  // How long to wait for a graceful (SIGTERM) exit before force-killing
  // (SIGKILL). ffmpeg reading a half-dead RTSP input — or hung tearing down
  // an NVENC session — can ignore SIGTERM until its own 30s input timeout
  // fires; without a hard deadline `await proc.exited` in restart() hangs
  // forever, and overlapping watchdog restarts then leak orphan ffmpegs.
  const forceKillMs = 5_000;
  let restartCount = 0;
  let stopped = false;
  // Set by restart() so the exit handler doesn't ALSO schedule a respawn —
  // otherwise an intentional restart spawns two processes (the one restart()
  // creates + the one the exit handler creates), which then fight over the
  // mediamtx publish path ("closing existing publisher" → Broken pipe →
  // crash loop).
  let intentionalRestart = false;
  // Guards restart() against re-entry. The watchdog polls on an interval and
  // can call restart() again while a previous call is still waiting for a
  // wedged ffmpeg to die; each hung call would spawn its own replacement when
  // the old process finally exits, leaking orphan compositors that nothing
  // tracks or kills (→ NVENC session exhaustion, all composites go dark).
  let restarting = false;
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
      // An intentional restart() already spawned the replacement — don't
      // double-spawn. Clear the flag and bail.
      if (intentionalRestart) {
        intentionalRestart = false;
        return;
      }
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
      if (stopped || restarting) return;
      restarting = true;
      try {
        // Tell the exit handler not to auto-respawn; we'll spawn the one
        // replacement ourselves once the old process is gone.
        intentionalRestart = true;
        const dying = proc;
        dying.kill(); // SIGTERM — ask nicely first
        // ...then force-kill if it doesn't exit promptly, so we never wedge
        // here waiting on an unresponsive ffmpeg (see forceKillMs above).
        const sigkill = setTimeout(() => {
          try {
            dying.kill(9); // SIGKILL
          } catch {
            // already exited
          }
        }, forceKillMs);
        await dying.exited;
        clearTimeout(sigkill);
        restartCount = 0;
        proc = spawn();
      } finally {
        restarting = false;
      }
    },
    stop() {
      stopped = true;
      const dying = proc;
      dying.kill();
      // Force-kill if it lingers, so container shutdown isn't blocked by a
      // wedged ffmpeg.
      setTimeout(() => {
        try {
          dying.kill(9);
        } catch {
          // already exited
        }
      }, forceKillMs);
    },
  };
}
