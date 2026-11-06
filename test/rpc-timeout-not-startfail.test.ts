import { test } from "node:test";
import assert from "node:assert/strict";
import { runWaking } from "../internal/rpc.ts";
import { classify } from "../internal/symptoms.ts";

// A child that takes the prompt, then on abort exits without ever sending agent_settled:
// the shape a hung round has when the wall kills it. It must be read as a timeout, not as
// a round that never started.
const HUNG_CHILD = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "prompt") {
    console.log(JSON.stringify({ id: m.id, type: "response", data: { disposition: "started" } }));
  }
  if (m.type === "abort") setTimeout(() => process.exit(0), 50);
});
setInterval(() => {}, 1000);
`;

test("a round killed at the wall is a timeout, not a round that never started", async () => {
  const r = await runWaking({
    command: { cmd: process.execPath, args: ["-e", HUNG_CHILD], env: {}, cwd: "/tmp" },
    instance: "probe",
    timeoutMs: 200,
    prompt: "hi",
    repeatThreshold: 3,
  });
  assert.equal(r.timedOut, true);
  // both flags used to be true, and classify() reads startFailed first: a cut round was
  // reported as "没起来" and the timeout notice never fired.
  assert.equal(r.startFailed, false);
  assert.equal(classify(r), "timeout");
});
