import { rmSync } from "node:fs";
import { ExpectedError } from "./errors.ts";
import { readJson, writeJson } from "./fs.ts";

/** 注入给测试：用 signal 0 探一下 pid 在不在，失败就抛。 */
type PidProbe = (pid: number) => void;

const defaultProbe: PidProbe = (pid) => {
  process.kill(pid, 0);
};

/** 只有 ESRCH 才能证明这个 pid 真的没了。EPERM 说明进程存在但不属于当前用户，
 *  其它错误说明根本问不出来——任何一种都不许读成「没人在」。否则一个别的用户的
 *  进程会让第二个 daemon 起得来，两个 daemon 轮流写它的书、拉容器。
 *  非正或非有限（含非整数）的 pid 更不能拿去发信号：kill(0, 0) 会探整个进程组。 */
function alive(pid: number, probe: PidProbe = defaultProbe): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    probe(pid);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

/** Whether a live process holds this pidfile. Read by the dev commands, whose flock check
 *  in the unit does not cover a daemon started by hand — that one only leaves this. */
export function pidLockHeld(file: string, probe: PidProbe = defaultProbe): boolean {
  const existing = readJson<{ pid?: number }>(file, {});
  return typeof existing.pid === "number" && existing.pid !== process.pid && alive(existing.pid, probe);
}

/**
 * The systemd unit holds an flock, which only protects the systemd path. A manual
 * `geng daemon` start would slip past it, so the daemon also claims a pidfile.
 * Not a real lock (racy by nature), but it catches the case that actually happens:
 * someone starting a second copy by hand.
 */
export function acquirePidLock(file: string, probe: PidProbe = defaultProbe): () => void {
  const existing = readJson<{ pid?: number }>(file, {});
  if (pidLockHeld(file, probe)) {
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
