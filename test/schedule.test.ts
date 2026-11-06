import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alarmSpent, formatDuration, knockFloorMs, knockable, parseAfter, readWaiting } from "../internal/schedule.ts";
import { planFor } from "../internal/escalation.ts";

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  const f = join(dir, "waiting.json");
  writeFileSync(f, content);
  return f;
}

test("a relative alarm counts from when it was written, not from when it is read", () => {
  const f = tmpFile(JSON.stringify({ wake: { after: "20m" }, why: "等 CI" }));
  const writtenAt = statSync(f).mtimeMs;
  const spec = readWaiting(f);
  assert.equal(spec?.dueAtMs, writtenAt + 20 * 60_000);
  assert.equal(spec?.why, "等 CI");

  // an alarm that came due while the machine was off is already overdue
  assert.ok((spec?.dueAtMs ?? Infinity) < writtenAt + 21 * 60_000);
});

test("a malformed wake.after is no alarm, not a crashing waking", () => {
  // `null !== undefined`, so a restored or hand-edited waiting.json with `"after": null`
  // reached parseAfter(null) and called null.trim(). The daemon has no catch around
  // readWaiting, so that was one whole waking gone with no log line.
  for (const bad of ["null", "true", "{}", "[]", "[1]"]) {
    const f = tmpFile(`{"wake":{"after":${bad}}}`);
    assert.equal(readWaiting(f), null, `${bad} 只能读作「没有闹钟」`);
  }
  assert.equal(parseAfter(Number.NaN), null, "NaN 分钟不是闹钟");
  assert.equal(parseAfter(Number.POSITIVE_INFINITY), null);
  assert.equal(parseAfter(20), 20 * 60_000);
});

test("readWaiting parses an absolute alarm", () => {
  const f = tmpFile(JSON.stringify({ wake: { at: "2026-03-02T01:00:00Z" } }));
  assert.equal(readWaiting(f)?.dueAtMs, Date.parse("2026-03-02T01:00:00Z"));
});

test("readWaiting returns null when no alarm was set", () => {
  assert.equal(readWaiting(join(tmpdir(), "geng-no-such-file.json")), null);
  assert.equal(readWaiting(tmpFile("{not json")), null);
  assert.equal(readWaiting(tmpFile(JSON.stringify({ why: "我忘了" }))), null);
  assert.equal(readWaiting(tmpFile(JSON.stringify({ wake: { after: "20 minutes" } }))), null);
});

test("a message already handed over does not knock again inside the floor", () => {
  const hold = { files: ["chat-1.json"], untilMs: 1_000 };
  assert.equal(knockable([], hold, 0), false, "nothing pending cannot knock");
  assert.equal(knockable(["chat-1.json"], hold, 0), false, "the same words again wait");
  assert.equal(knockable(["chat-1.json"], hold, 1_000), true, "the floor expires");
  assert.equal(knockable(["chat-2.json"], hold, 0), true, "a new message does not queue behind it");
  assert.equal(knockable(["chat-1.json"], null, 0), true, "no floor set: knock as before");
});

test("an alarm is spent only once its moment arrives", () => {
  const due = Date.parse("2026-03-02T01:00:00Z");
  const alarm = { dueAtMs: due, why: "等 CI" };
  assert.equal(alarmSpent(alarm, due - 1), false, "an earlier knock must not cancel the alarm");
  assert.equal(alarmSpent(alarm, due), true, "a wake at the appointed time spends it");
  assert.equal(alarmSpent(null, due), false, "no alarm: nothing to spend");
});

test("a batch that keeps failing waits like a timer, not a minute", () => {
  const minMs = 60_000;
  assert.equal(knockFloorMs(true, minMs, 2 * 60 * 60_000), minMs, "a clean round: one minute");
  assert.equal(knockFloorMs(false, minMs, 2 * 60 * 60_000), 2 * 60 * 60_000, "a failed one: the backoff");
  assert.equal(knockFloorMs(false, minMs, 0), minMs, "no backoff yet: still the floor");
});

test("the knock floor never goes backwards as the ladder climbs", () => {
  const minMs = 60_000;
  const defMs = 30 * 60_000;
  const floor = (level: number): number => {
    const rung = planFor({ level, streak: level, symptom: "timeout", detail: "" });
    return knockFloorMs(false, minMs, defMs * rung.backoff, rung.parked);
  };
  const floors = [1, 2, 3, 4].map(floor);
  for (let i = 1; i < floors.length; i++) {
    assert.ok(
      (floors[i] as number) >= (floors[i - 1] as number),
      `level ${i + 1} (${floors[i]}) must not wait less than level ${i} (${floors[i - 1]})`,
    );
  }
  // the parked rung has no timer behind it, so it must be the longest wait, not the shortest
  assert.ok((floors[3] as number) > (floors[2] as number), "level 4 is parked: backoff is 0");
});

test("formatDuration 对 NaN／无穷／负值也完备，不往唤醒纸里写 NaN", () => {
  // meta 里一个 "3"+"1" 的手拼字段会把 NaN 喂进来；旧代码 Math.max(0, NaN)
  // 留着 NaN，最后落到小时分支，唤醒纸上印出「NaNh」。
  assert.equal(formatDuration(Number.NaN), "未知");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "未知");
  assert.equal(formatDuration(Number.NEGATIVE_INFINITY), "未知");
  assert.equal(formatDuration(-1), "0s");
  assert.equal(formatDuration(-60_000), "0s");
  assert.doesNotMatch(formatDuration(Number.NaN), /NaN/);
  // 正常值一个都不能被这次改动碰坏
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(120_000), "2m");
  assert.equal(formatDuration(7_200_000), "2.0h");
});

test("parseAfter 不把 NaN、无穷、null 和 400 位数字当闹钟", () => {
  // 数字分支用 Number.isFinite 挡住：这几样都是 number，却永远不会到点。
  assert.equal(parseAfter(Number.NaN), null);
  assert.equal(parseAfter(Number.POSITIVE_INFINITY), null);
  assert.equal(parseAfter(Number.NEGATIVE_INFINITY), null);
  // 一个 400 位的数字在 JS 里就是 Infinity，到 Infinity 的闹钟等于没有
  assert.equal(parseAfter(1e400), null, "400 位数字溢出成 Infinity");
  // null 在 readWaiting 的边界就被挡掉，根本到不了 parseAfter
  assert.equal(readWaiting(tmpFile('{"wake":{"after":null}}')), null, "null 不是闹钟");
  assert.equal(parseAfter("20 minutes"), null, "字符串写法必须带单位");
  assert.equal(parseAfter(20), 20 * 60_000);
});
