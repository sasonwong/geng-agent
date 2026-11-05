import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidLock, pidLockHeld } from "../internal/guard.ts";

test("a pidfile counts only while the process it names is alive", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-guard-"));
  const file = join(dir, "daemon.pid");
  assert.equal(pidLockHeld(file), false, "没有 pidfile 就是没有 daemon");
  // our own pid is the one live pid a test is allowed to name
  writeFileSync(file, JSON.stringify({ pid: process.pid }));
  assert.equal(pidLockHeld(file), false, "自己不算另一个 daemon");
  writeFileSync(file, JSON.stringify({ pid: 0x7ffffff }));
  assert.equal(pidLockHeld(file), false, "一个不可能存在的 pid 不是活着的 daemon");
  // the shape a crashed daemon leaves: a number that no longer names a process. Above
  // pid_max, so it cannot name one on a busy machine either — 999_999 can, and did
  writeFileSync(file, JSON.stringify({ pid: 0x7fffffe }));
  assert.equal(pidLockHeld(file), false);
});

test("a live pid that is not ours really does hold the lock", async () => {
  // Every assertion in the test above expects false, so a pidLockHeld() that always
  // returned false would pass all of them — and `geng-dev once` would then start a
  // second daemon over a running one. Here is the positive half.
  const dir = mkdtempSync(join(tmpdir(), "geng-guard-live-"));
  const file = join(dir, "daemon.pid");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  try {
    assert.ok(child.pid !== undefined, "spawn 没给出 pid");
    writeFileSync(file, JSON.stringify({ pid: child.pid }));
    assert.equal(pidLockHeld(file), true, "活着的另一个进程要算 daemon");
    assert.throws(() => acquirePidLock(file), /另一个 daemon 正在跑/, "第二个 daemon 必须被挡住");
  } finally {
    child.kill();
    // wait for the child so no orphan is left behind on Windows
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      setTimeout(resolve, 3_000);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
