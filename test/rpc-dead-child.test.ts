import { test } from "node:test";
import assert from "node:assert/strict";
import { runWaking } from "../internal/rpc.ts";
import { classify } from "../internal/symptoms.ts";

test("a child that dies before answering becomes a symptom, not a silent hang", async () => {
  const started = Date.now();
  const r = await runWaking({
    command: { cmd: "sh", args: ["-c", "exit 1"], env: {}, cwd: "/tmp" },
    instance: "probe",
    timeoutMs: 30_000,
    prompt: "hi",
    repeatThreshold: 3,
  });
  assert.equal(r.startFailed, true);
  assert.equal(r.settled, false);
  // the real failure was 20 minutes of nothing: it must come back in seconds
  assert.ok(Date.now() - started < 10_000);
});

test("a round killed at the wall is a timeout, not a failure to start", async () => {
  // The child starts, accepts the prompt, then hangs — a round stuck inside one action,
  // which is the case `meta/cut.json` exists for. pi does not settle, the daemon kills
  // it, and the exit that follows used to be read as "it never started": the symptom
  // said `start-failed`, so the cut note (written only for `timeout`) never appeared and
  // the page could not say what the round had been doing.
  const script = `
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      buf += c;
      let at;
      while ((at = buf.indexOf("\\n")) !== -1) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 1);
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec.type === "prompt") {
          process.stdout.write(JSON.stringify({ type: "response", id: rec.id, data: { disposition: "started" } }) + "\\n");
        }
        // a hung action dies with the abort, and never settles
        if (rec.type === "abort") process.exit(0);
      }
    });
    process.stdin.on("end", () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const r = await runWaking({
    command: { cmd: process.execPath, args: ["-e", script], env: {}, cwd: process.cwd() },
    instance: "probe",
    timeoutMs: 200,
    prompt: "hi",
    repeatThreshold: 3,
  });
  assert.equal(r.timedOut, true);
  assert.equal(r.startFailed, false, "它起来了，只是没跑完");
  assert.equal(classify(r), "timeout");
});
