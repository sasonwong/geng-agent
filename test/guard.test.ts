import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidLockHeld } from "../internal/guard.ts";

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
