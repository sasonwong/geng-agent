import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, planFor, type Escalation } from "../internal/escalation.ts";
import { classify } from "../internal/symptoms.ts";
import type { RpcResult } from "../internal/rpc.ts";

const FRESH: Escalation = { level: 0, streak: 0, symptom: null, detail: "", updatedAt: null };

function rpc(over: Partial<RpcResult>): RpcResult {
  return {
    settled: true,
    aborted: false,
    timedOut: false,
    startFailed: false,
    code: 0,
    signal: null,
    toolCalls: [],
    repeat: null,
    finalText: "好",
    stats: null,
    interventions: [],
    stderrTail: "",
    durationMs: 1000,
    ...over,
  };
}

test("classify reads only countable things", () => {
  assert.equal(classify(rpc({})), "ok");
  assert.equal(classify(rpc({ timedOut: true })), "timeout");
  assert.equal(classify(rpc({ startFailed: true })), "start-failed");
  assert.equal(classify(rpc({ settled: false })), "unsettled");
  assert.equal(classify(rpc({ aborted: true })), "aborted");
  assert.equal(classify(rpc({ finalText: "  " })), "empty");
  assert.equal(
    classify(rpc({ repeat: { name: "read", preview: "", count: 3 } })),
    "repeat",
  );
});

test("a good waking resets everything", () => {
  const next = advance({ ...FRESH, streak: 4, level: 5 }, "ok");
  assert.equal(next.streak, 0);
  assert.equal(next.level, 0);
});

test("consecutive failures climb 1 → 3 → 4 → 5 → 6", () => {
  let e = FRESH;
  const levels: number[] = [];
  for (let i = 0; i < 5; i++) {
    e = advance(e, "timeout");
    levels.push(e.level);
  }
  assert.deepEqual(levels, [1, 3, 4, 5, 6]);
  assert.equal(e.streak, 5);
});

test("plans only change the next waking, and each level differs", () => {
  const hint = (level: number) => planFor({ ...FRESH, level, symptom: "timeout", streak: level });
  assert.equal(hint(0).hint, null);

  assert.equal(hint(1).newSession, false);
  assert.match(hint(1).hint ?? "", /上一轮超时/);

  assert.equal(hint(3).newSession, true);
  assert.match(hint(3).hint ?? "", /新的会话/);

  assert.match(hint(4).hint ?? "", /两个不同的做法/);

  assert.equal(hint(5).backoff, 3);
  assert.match(hint(5).hint ?? "", /先放下/);

  assert.equal(hint(6).parked, true);
});

test("the first level keeps the same session", () => {
  const e = advance(FRESH, "repeat", { repeat: { name: "bash", count: 3 } });
  assert.equal(e.level, 1);
  assert.equal(e.detail, "bash 同样的参数重复了 3 次");
  assert.equal(planFor(e).newSession, false);
});
