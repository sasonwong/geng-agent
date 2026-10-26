import { test } from "node:test";
import assert from "node:assert/strict";
import { runWaking } from "../internal/rpc.ts";

test("a child that dies before answering becomes a symptom, not a silent hang", async () => {
  const started = Date.now();
  const r = await runWaking({
    command: { cmd: "sh", args: ["-c", "exit 1"], env: {}, cwd: "/tmp" },
    instance: "probe",
    isDocker: false,
    timeoutMs: 30_000,
    prompt: "hi",
    repeatThreshold: 3,
  });
  assert.equal(r.startFailed, true);
  assert.equal(r.settled, false);
  // the real failure was 20 minutes of nothing: it must come back in seconds
  assert.ok(Date.now() - started < 10_000);
});
