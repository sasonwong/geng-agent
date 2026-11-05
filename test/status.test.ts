import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printStatus, spendSince } from "../internal/status.ts";
import { makePaths } from "../internal/paths.ts";
import { writeText } from "../internal/fs.ts";

test("a day that straddles a log rotation is still one day", () => {
  // daemon.log rotates at 20 000 lines. Reading only the live file made "花费" report the
  // rounds since the rotation as if they were the whole day's.
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const p = makePaths(root, "alice");
  const round = (at: string, tokens: number, cost: string): string =>
    `${at} #1 wake=timer sym=ok lvl=0 dur=1s tools=1 tokens=${tokens} cost=${cost} timedout=no`;
  writeText(`${p.daemonLog}.1`, `${round("2026-03-02T06:00:00.000Z", 100, "0.0010")}\n`);
  writeText(p.daemonLog, `${round("2026-03-02T11:00:00.000Z", 250, "0.0025")}\n`);

  const spend = spendSince(p, Date.parse("2026-03-02T12:00:00Z"));
  assert.equal(spend.cycles, 2);
  assert.equal(spend.tokens, 350);
  assert.equal(Number(spend.cost.toFixed(4)), 0.0035);
});

test("status counts open loops the way the page does: files, not the old JSON shape", async () => {
  // `open-loops` used to be a single JSON file and became one file per thing. Reading it
  // as JSON now throws EISDIR and falls back to [], so status said 0 no matter what.
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const p = makePaths(root, "alice");
  mkdirSync(join(p.openLoops, "closed"), { recursive: true });
  writeText(join(p.openLoops, "一件.md"), "x");
  writeText(join(p.openLoops, "closed", "已闭.md"), "x");

  const lines: string[] = [];
  const old = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    await printStatus(root, "alice");
  } finally {
    console.log = old;
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(lines.join("\n"), /未闭合\s+1 件/);
});

test("快照列表读不出时 status 说「读不出」，不是笼统的「没有」", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const p = makePaths(root, "alice");
  mkdirSync(p.openLoops, { recursive: true });
  // 没有 secrets/rustic.env，也没有 RUSTIC_PASSWORD：listSnapshots 返回 ok:false。
  // 旧实现把读不出和空列表都吞成 []，status 只说「没有（或 rustic 不可用）」。
  const lines: string[] = [];
  const old = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    await printStatus(root, "alice");
  } finally {
    console.log = old;
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(lines.join("\n"), /快照\s+读不出（/);
});

test("session 文件在列出来之后消失，status 不崩", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const p = makePaths(root, "alice");
  mkdirSync(p.sessionDir, { recursive: true });
  // dangling symlink：readdirSync 会把它当 .jsonl 列出来，statSync 却抛 ENOENT，
  // 正是「列出来之后被轮转/清理删掉」的形状。旧实现里整个 printStatus 会抛出去。
  symlinkSync(join(p.sessionDir, "gone.jsonl"), join(p.sessionDir, "dangling.jsonl"), "file");
  const lines: string[] = [];
  const old = console.log;
  console.log = (s: string) => lines.push(s);
  try {
    await printStatus(root, "alice");
  } finally {
    console.log = old;
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(lines.join("\n"), /session\s+1 文件/, "列的那一件还在，只是按 0 字节算");
});
