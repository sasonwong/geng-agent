import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alarmSpent, knockFloorMs, knockable, parseAfter, readWaiting } from "../internal/schedule.ts";
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

// `waiting.json` 是盘上的状态，不是这个进程刚写出来的值：手改、旧版本、恢复的快照都会
// 往里放别的东西。`after: null` 以前会走到 `null.trim()`，而这一行在 daemon 主循环的
// 第一条语句上——抛出去就是每次启动都死，日志里一个字都没有。读不认识的形状要答 null，
// 和这个函数其它每一条分支一样。
test("an alarm file full of shapes nobody wrote is not a reason to die", () => {
  for (const after of [null, true, {}, [], "20 minutes", ""]) {
    const f = tmpFile(JSON.stringify({ wake: { after } }));
    assert.equal(readWaiting(f), null, `after=${JSON.stringify(after)} 该答 null`);
  }
  // 数字是分钟：旧写法留下的形状，还得认
  const f = tmpFile(JSON.stringify({ wake: { after: 30 } }));
  assert.equal(readWaiting(f)?.dueAtMs, statSync(f).mtimeMs + 30 * 60_000);
});

test("a duration that overflows is not a duration", () => {
  // JSON 里 NaN 和 Infinity 都会变成 null，走不到这一段，只能直接喂给解析器。
  // 不挡的话 `dueAt` 是 Infinity：一个再也不会醒的实例，而不是一个坏掉的闹钟。
  assert.equal(parseAfter(Number.NaN), null);
  assert.equal(parseAfter(Number.POSITIVE_INFINITY), null);
  assert.equal(parseAfter("9".repeat(400) + "m"), null);
  assert.equal(parseAfter(30), 30 * 60_000);
  assert.equal(parseAfter("1.5h"), 90 * 60_000);
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
    const rung = planFor({ level, streak: level, symptom: "timeout", detail: "", updatedAt: null });
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
