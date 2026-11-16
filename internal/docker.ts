import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";

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
  outFile?: string,
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
    // A build's output is too long to collect and too useful to drop. `outFile` sends both
    // streams there instead of a pipe nobody reads; the child keeps its own descriptor, so
    // ours is closed as soon as spawn returns.
    let out: number | null = null;
    try {
      out = outFile === undefined ? null : openSync(outFile, "a");
      child = spawn(cmd, args, {
        stdio: ["ignore", collectStdout ? "pipe" : (out ?? "ignore"), out ?? "ignore"],
      });
    } catch {
      if (out !== null) closeSync(out);
      resolve({ code: null, text: "" });
      return;
    }
    if (out !== null) closeSync(out);
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

/**
 * A container whose only job is to keep an image from being pruned. `docker system prune
 * -a` removes every image no container references, and it removes stopped containers
 * first, so the reference has to be a *running* one. The name carries a hash because
 * sanitising `a:1/b` and `a_1/b` would otherwise land on the same container.
 */
export function keeperName(image: string): string {
  const readable = image.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 48);
  return `geng-image-keeper-${readable}-${createHash("sha256").update(image).digest("hex").slice(0, 8)}`;
}

export type PinResult = "kept" | "pinned" | "failed";

/**
 * Make sure a running container references `image` at `id`. Docker has no pin; this is the
 * only reference `prune -a` does not remove. `kept` is the common answer (the keeper is
 * already running that id), `pinned` means it was recreated, `failed` means docker did not
 * answer or the run failed — the caller says so and the waking still goes ahead.
 */
export async function pinImage(image: string, id: string): Promise<PinResult> {
  const name = keeperName(image);
  const now = await dockerRun(
    ["inspect", "--type", "container", "--format", "{{.State.Running}} {{.Image}}", name],
    true,
  );
  // A docker that did not answer is not a keeper that needs replacing: rm and run would
  // only burn two more timeouts before saying the same thing.
  if (now.code === null) return "failed";
  if (now.code === 0) {
    const [running, current] = now.text.trim().split(/\s+/);
    if (running === "true" && current === id) return "kept";
  }
  await dockerRun(["rm", "-f", name], false);
  const run = await dockerRun(
    [
      "run", "-d", "--name", name, "--restart", "unless-stopped", "--network", "none",
      "--entrypoint", "/bin/sh", image, "-c", "sleep infinity",
    ],
    false,
  );
  if (run.code === 0) return "pinned";
  // Two daemons sharing one image race between rm and run: the loser's run fails on the
  // name, and the winner's container is the same pin. `start` is a no-op on a running
  // container, and the inspect below is what decides whether it is really the current id.
  await dockerRun(["start", name], false);
  const after = await dockerRun(
    ["inspect", "--type", "container", "--format", "{{.State.Running}} {{.Image}}", name],
    true,
  );
  if (after.code === 0) {
    const [running, current] = after.text.trim().split(/\s+/);
    if (running === "true" && current === id) return "kept";
  }
  return "failed";
}
