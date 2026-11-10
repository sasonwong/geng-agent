import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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

// The 8s after an abort is a cap, not a floor. Waiting it out anyway kept `agent-<instance>`
// taken long after the round was reported over, so whatever starts next races the name — and
// every test that tripped the wall held an armed timer for the full grace, 8s of suite time.
test("a timed-out round hands the container name back before it reports the round over", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-kill-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "docker.log");
  // the only thing this test needs from the CLI is `kill agent-<instance>`, recorded
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
  const killed = (): boolean => existsSync(log) && readFileSync(log, "utf8").includes("kill agent-probe");
  try {
    const r = await runWaking({
      command: { cmd: process.execPath, args: ["-e", HUNG_CHILD], env: {}, cwd: "/tmp" },
      instance: "probe",
      timeoutMs: 200,
      prompt: "hi",
      repeatThreshold: 3,
    });
    assert.equal(r.timedOut, true);
    const deadline = Date.now() + 3_000;
    while (!killed() && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(killed(), "child 已经退了（容器跟着退了），kill 不能还等在宽限期的末尾");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
