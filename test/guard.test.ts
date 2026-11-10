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
      // the fallback is cleared, or an armed 3s timer outlives the child and holds the
      // runner open long after the assertions are done
      const giveUp = setTimeout(resolve, 3_000);
      const done = (): void => {
        clearTimeout(giveUp);
        resolve();
      };
      if (child.exitCode !== null) return done();
      child.once("exit", done);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EPERM 不是空锁：别的用户的进程不能读成没人在", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-guard-eperm-"));
  const file = join(dir, "daemon.pid");
  const pid = 424242;
  writeFileSync(file, JSON.stringify({ pid }));
  const eperm = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  // 这个 pid 存在，但不属于当前用户：kill(pid, 0) 抛 EPERM，而不是 ESRCH。
  const probe = () => { throw eperm; };
  try {
    assert.equal(pidLockHeld(file, probe), true, "EPERM 必须算锁还被占着");
    assert.throws(() => acquirePidLock(file, probe), /另一个 daemon 正在跑/, "第二个 daemon 必须被挡住");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("只有 ESRCH 才说明真的没人，其它错误一律当作还占着锁", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-guard-errors-"));
  const file = join(dir, "daemon.pid");
  writeFileSync(file, JSON.stringify({ pid: 424243 }));
  const esrch = Object.assign(new Error("no such process"), { code: "ESRCH" });
  const unknown = Object.assign(new Error("unknown"), { code: "EUNKNOWN" });
  try {
    assert.equal(pidLockHeld(file, () => { throw esrch; }), false, "ESRCH 说明进程真的没了");
    assert.equal(pidLockHeld(file, () => { throw unknown; }), true, "未知错误不能读成没人");
    assert.equal(pidLockHeld(file, () => {}), true, "探得到就是活着");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非正 / 非安全整数的 pid 根本不会被拿去发信号", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-guard-badpid-"));
  const file = join(dir, "daemon.pid");
  let probed = 0;
  const probe = () => { probed++; };
  try {
    for (const pid of [0, -1, 1.5, 1e20]) {
      writeFileSync(file, JSON.stringify({ pid }));
      assert.equal(pidLockHeld(file, probe), false, `pid ${pid} 不算活着的 daemon`);
    }
    assert.equal(probed, 0, "kill(0, 0) 会探整个进程组：非法 pid 必须在发信号前挡掉");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
