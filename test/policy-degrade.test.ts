// A policy.json that does not parse is a file a human is halfway through editing, not a
// reason to die. Before this, the daemon threw, systemd started it again ten seconds later,
// and the same read threw again: a loop with no ops line, no daemon.log line and no rounds,
// which `status` showed as "it is asleep". This asserts the process stays up, says each
// complaint once, and keeps re-reading the file. Re-reading is shown by saving a second
// broken version: a different parse error is a different message, so a second ops line
// proves the file was read again — and because it still does not parse, no round starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { POLICY_RETRY_MS } from "../internal/daemon.ts";

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

// Polls instead of sleeping a fixed time: the retry schedule belongs to the daemon, and a
// test that guesses at it either flakes on a slow box or has to be edited whenever it changes.
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

test("a broken policy keeps the daemon alive, says each complaint once, and keeps reading the file", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-policy-"));
  const instance = "probe";
  const policy = join(root, "data", instance, "policy.json");
  mkdirSync(join(root, "data", instance), { recursive: true });
  writeFileSync(policy, '{"schema": 1,\n');

  const child = spawn(process.execPath, [CLI, "daemon", "--instance", instance, "--root", root], {
    stdio: "ignore",
  });
  const said = (): string[] => opsLines(root).filter((line) => line.includes("policy.json 读不出来"));
  try {
    assert.ok(await until(() => said().length >= 1, 10_000), "读坏了要说话，不能一声不吭地退");
    assert.equal(child.exitCode, null, "配置读不出来也要活着：退出会让 systemd 每十秒拉起一次");

    // Two intervals, taken from the table rather than guessed at: reads land at 0 s and 1 s,
    // so two intervals is past the second read with a whole interval to spare. A dedupe that
    // is not there shows up as a second line long before this wait is over.
    await new Promise((r) => setTimeout(r, POLICY_RETRY_MS[0]! * 2));
    assert.equal(said().length, 1, `同一句话只该说一次，实际 ${said().length} 行`);

    writeFileSync(policy, '{"schema": 1, trailing}');
    assert.ok(await until(() => said().length >= 2, 20_000), "文件改过之后要再读一次，不是就此等着");

    const lines = said();
    assert.equal(new Set(lines).size, lines.length, `同一句话只该说一次，实际 ${lines.length} 行`);
    assert.ok(lines.every((line) => line.includes("等你修")), "每一行都要说清楚它在等人，而不是已经放弃");
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

test("a policy from a newer version is named as one, and the daemon still waits for the fix", async () => {
  // Different case, different line. "读不出来" is false here — the file parsed, and the code
  // is what is too old. Saying "等你修" without naming the two ways out sends the operator
  // looking for a JSON typo that does not exist.
  const root = mkdtempSync(join(tmpdir(), "geng-policy-"));
  const instance = "probe";
  const policy = join(root, "data", instance, "policy.json");
  mkdirSync(join(root, "data", instance), { recursive: true });
  writeFileSync(policy, JSON.stringify({ schema: 999 }));

  const child = spawn(process.execPath, [CLI, "daemon", "--instance", instance, "--root", root], {
    stdio: "ignore",
  });
  const said = (): string[] => opsLines(root).filter((line) => line.includes("schema"));
  try {
    assert.ok(await until(() => said().length >= 1, 10_000), "版本冲突要说话，不能一声不吭地等着");
    assert.equal(
      child.exitCode,
      null,
      "版本冲突也不退出：退出会被 systemd 每十秒拉起一次，而且每次都会再 pager 一次",
    );

    const [line] = said();
    assert.ok(line?.includes("更新版本"), "要说出这是更新版本写的");
    assert.ok(!line?.includes("读不出来"), "它读得出来，只是不能跑：不要把它说成读不出来");
    assert.ok(line?.includes("降回去"), "要给出那两条出路之一，而不是一句含糊的等你修");

    // A different number is a different complaint, so a second line proves the file is still
    // being read while the daemon waits — and it still does not start a round.
    writeFileSync(policy, JSON.stringify({ schema: 1000 }));
    assert.ok(await until(() => said().length >= 2, 20_000), "文件改过之后要再读一次，不是就此等着");
    const lines = said();
    assert.equal(new Set(lines).size, lines.length, `同一句话只该说一次，实际 ${lines.length} 行`);
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
