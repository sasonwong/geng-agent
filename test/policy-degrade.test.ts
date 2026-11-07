// A policy.json that does not parse is a file a human is halfway through editing, not a
// reason to die. Before this, the daemon threw, systemd started it again ten seconds later,
// and the same read threw again: a loop with no ops line, no daemon.log line and no rounds,
// which `status` showed as "it is asleep". This asserts the process stays up and says so
// once. That it keeps re-reading the file is not asserted here: nothing observable changes
// until the file parses, and fixing it would start a real round.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dirname, "../cmd/geng/index.ts");

function opsLines(root: string): string[] {
  const dir = join(root, "data", "_ops", "outbox");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readFileSync(join(dir, f), "utf8"));
  } catch {
    return [];
  }
}

test("a broken policy keeps the daemon alive, says it once, and does not stop reading the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-policy-"));
  const instance = "probe";
  const policy = join(root, "data", instance, "policy.json");
  mkdirSync(join(root, "data", instance), { recursive: true });
  writeFileSync(policy, '{"schema": 1,\n');

  const child = spawn(process.execPath, [CLI, "daemon", "--instance", instance, "--root", root], {
    stdio: "ignore",
  });
  try {
    // Two reads happen by now (0 s and 1 s), so a de-duplication that did not exist shows up
    // as two lines rather than one.
    await new Promise<void>((r) => setTimeout(r, 2_600));
    assert.equal(child.exitCode, null, "配置读不出来也要活着：退出会让 systemd 每十秒拉起一次");
    const said = opsLines(root).filter((line) => line.includes("policy.json 读不出来"));
    assert.equal(said.length, 1, `同一个错只该说一次，实际 ${said.length} 次`);
    assert.ok(said[0]?.includes("等你修"), "这条要说清楚它在等人，而不是已经放弃");
  } finally {
    child.kill();
    await new Promise<void>((done) => {
      if (child.exitCode !== null) return done();
      child.once("exit", () => done());
      setTimeout(done, 3_000);
    });
    rmSync(root, { recursive: true, force: true });
  }
});
