import { spawn } from "node:child_process";

/**
 * The daemon's lock lives in the systemd unit (`flock -w 5 ...`), which means any
 * direct invocation skips it. Dev commands ask first: two cycles writing one
 * session is exactly the corruption this design exists to avoid.
 */
export async function lockHeld(lockFile: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const p = spawn("flock", ["-n", lockFile, "true"], { stdio: "ignore" });
    p.on("error", () => resolve(false)); // no flock binary: do not block the dev loop
    p.on("close", (code) => resolve(code !== 0));
  });
}
