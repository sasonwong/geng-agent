import { spawn } from "node:child_process";

/**
 * Every `docker` call the daemon makes is a short question to a local daemon. When that
 * daemon is wedged, the CLI can wait forever: `image inspect` then freezes the wake
 * packet, `ps`/`kill` freeze orphan cleanup, and `docker kill` freezes a timed-out round.
 * A hung client is not an answer, so there is a hard upper bound on all of them.
 */
export const DOCKER_TIMEOUT_MS = 15_000;

export interface ChildRun {
  /** null means the child failed to start or was cut off, never "docker said nothing". */
  code: number | null;
  text: string;
}

export function runChild(
  cmd: string,
  args: string[],
  collectStdout: boolean,
  timeoutMs: number,
): Promise<ChildRun> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, text });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", collectStdout ? "pipe" : "ignore", "ignore"],
      });
    } catch {
      resolve({ code: null, text: "" });
      return;
    }
    // Resolve on our own clock, not on `close`: a killed CLI can leave grandchildren
    // holding a pipe open, and `close` then never arrives. `finish` is idempotent, so
    // whichever happens first wins.
    timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);
    if (collectStdout) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => {
        text += c;
      });
    }
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

export function dockerRun(
  args: string[],
  collectStdout: boolean,
  timeoutMs: number = DOCKER_TIMEOUT_MS,
): Promise<ChildRun> {
  return runChild("docker", args, collectStdout, timeoutMs);
}
