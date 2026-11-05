import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, excerpt } from "../internal/fs.ts";


test("a log that only grows keeps one previous copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-fs-"));
  const file = join(dir, "net.log");
  for (let i = 1; i <= 5; i++) appendLine(file, `line ${i}`, 2);
  // a rotation happens *before* the write that would exceed the limit, so neither file
  // ever holds more than `max` lines and nothing is lost
  assert.deepEqual(
    readFileSync(file, "utf8").trim().split("\n"),
    ["line 5"],
  );
  assert.deepEqual(
    readFileSync(`${file}.1`, "utf8").trim().split("\n"),
    ["line 3", "line 4"],
  );
  // one previous copy is the whole promise: the total on disk is bounded at 2×max, and
  // what falls off the end is oldest — the trade a log file makes
  const total = (readFileSync(`${file}.1`, "utf8") + readFileSync(file, "utf8")).trim().split("\n");
  assert.ok(total.length <= 4, `盘上最多 2×max 行，实际 ${total.length}`);
  assert.deepEqual(total, ["line 3", "line 4", "line 5"]);
});

test("a cut field keeps its marker on the same line", () => {
  // 页面上五个调用点把它放在「」或（）里，都在一行上：一个自带换行的标记会变成一条没有
  // 说话人的线程行，或者一个单独成段的右括号。
  const long = "第一句。" + "很长的理由。".repeat(30);
  const out = excerpt(long, 20);
  assert.equal(out.includes("\n"), false);
  assert.match(out, /…\(截断\)$/);
  assert.equal(out.startsWith(long.slice(0, 20)), true);
  // 没超长的原样，空的还是空
  assert.equal(excerpt("短的", 20), "短的");
  assert.equal(excerpt(null, 20), "");
  assert.equal(excerpt("  带空白的  ", 20), "带空白的");
});
