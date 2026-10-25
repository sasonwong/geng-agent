import { rmSync } from "node:fs";
import { ExpectedError } from "./errors.ts";
import { readJson, writeJson } from "./state.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The systemd unit holds an flock, which only protects the systemd path. A manual
 * `geng daemon` start would slip past it, so the daemon also claims a pidfile.
 * Not a real lock (racy by nature), but it catches the case that actually happens:
 * someone starting a second copy by hand.
 */
export function acquirePidLock(file: string): () => void {
  const existing = readJson<{ pid?: number }>(file, {});
  if (typeof existing.pid === "number" && existing.pid !== process.pid && alive(existing.pid)) {
    throw new ExpectedError(`另一个 daemon 正在跑（pid ${existing.pid}，${file}）`);
  }
  writeJson(file, { pid: process.pid, startedAt: new Date().toISOString() });

  const release = () => {
    const now = readJson<{ pid?: number }>(file, {});
    if (now.pid === process.pid) rmSync(file, { force: true });
  };
  process.on("exit", release);
  return release;
}
