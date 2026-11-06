import { test } from "node:test";
import assert from "node:assert/strict";
import { runChild } from "../internal/docker.ts";

/**
 * `process.execPath` stands in for the docker CLI: it is an executable on every platform
 * and can be told to stay silent for a minute without creating a fake binary on PATH.
 */
test("a docker client that never answers is cut off instead of freezing the round", async () => {
  const started = Date.now();
  const r = await runChild(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], false, 60);
  assert.equal(r.code, null, "被掐掉不是一次成功的调用");
  assert.ok(Date.now() - started < 10_000, "一轮不能陪一个不回话的 docker 等下去");
});

test("a command that answers really does give its stdout and exit code", async () => {
  const r = await runChild(process.execPath, ["-e", "process.stdout.write('sha256:abc\\n')"], true, 5_000);
  assert.equal(r.code, 0);
  assert.equal(r.text.trim(), "sha256:abc");
});

test("a failed command is a null code, not an empty answer that reads as success", async () => {
  const r = await runChild(process.execPath, ["-e", "process.exit(3)"], true, 5_000);
  assert.equal(r.code, 3);
});
