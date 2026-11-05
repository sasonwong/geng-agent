import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, parkNotice, planFor, timeoutNotice, type Escalation } from "../internal/escalation.ts";
import { classify } from "../internal/symptoms.ts";
import type { RpcResult } from "../internal/rpc.ts";

const FRESH: Escalation = { level: 0, streak: 0, symptom: null, detail: "", updatedAt: null };

function rpc(over: Partial<RpcResult>): RpcResult {
  return {
    settled: true,
    aborted: false,
    timedOut: false,
    startFailed: false,
    toolCalls: [],
    openCall: null,
    repeat: null,
    finalText: "好",
    stats: null,
    interventions: [],
    injections: [],
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

test("consecutive failures climb 1 → 4 and then stay parked", () => {
  let e = FRESH;
  const levels: number[] = [];
  for (let i = 0; i < 6; i++) {
    e = advance(e, "timeout");
    levels.push(e.level);
  }
  assert.deepEqual(levels, [1, 2, 3, 4, 4, 4]);
  assert.equal(e.streak, 6);
});

test("plans only change the next waking, and each level differs", () => {
  const hint = (level: number) => planFor({ ...FRESH, level, symptom: "timeout", streak: level });
  assert.equal(hint(0).hint, null);

  assert.match(hint(1).hint ?? "", /上一轮超时/);
  assert.equal(hint(1).backoff, 1);
  assert.equal(hint(1).parked, false);

  // waiting longer is the cheapest thing that is left once context is always fresh
  assert.equal(hint(2).backoff, 2);
  assert.equal(hint(3).backoff, 3);
  assert.match(hint(4).hint ?? "", /连着 4 轮没有结果/);
  assert.equal(hint(4).parked, true);
});

test("the first failure only tells it what happened", () => {
  const e = advance(FRESH, "repeat", { repeat: { name: "bash", count: 3 } });
  assert.equal(e.level, 1);
  assert.equal(e.detail, "bash 同样的参数重复了 3 次");
  assert.equal(planFor(e).parked, false);
  assert.equal(planFor(e).backoff, 1);
});

test("the parked rung is announced once, on the way in, where a person looks", () => {
  let e = FRESH;
  const notices: string[] = [];
  for (let i = 0; i < 6; i++) {
    const before = e;
    e = advance(e, "start-failed");
    const n = parkNotice(before, e);
    if (n !== null) notices.push(n);
  }
  // the rung repeats for as long as the streak lasts; the line must not
  assert.equal(notices.length, 1);
  const [first] = notices;
  assert.ok(first !== undefined);
  assert.match(first, /连着 4 轮没有结果（没起来）/);
  // the way back in is the part the reader can act on
  assert.match(first, /再敲它一下还能醒/);
});

test("levels below the parked rung, and getting well again, are not announced", () => {
  let e = FRESH;
  for (let i = 0; i < 3; i++) {
    const before = e;
    e = advance(e, "empty");
    assert.equal(parkNotice(before, e), null);
  }
  const before = e;
  e = advance(e, "empty");
  assert.equal(e.level, 4);
  assert.notEqual(parkNotice(before, e), null);
  // waking is not news, and it resets the streak
  const ok = advance(e, "ok");
  assert.equal(parkNotice(e, ok), null);
  assert.equal(ok.streak, 0);
});

test("a round cut at the wall is said once per run, not once per cut", () => {
  let e = FRESH;
  const first = advance(e, "timeout");
  // the first cut is news: nothing else tells the reader that the words stopped
  assert.match(timeoutNotice(e, first) ?? "", /跑到时间上限被杀了/);
  // and the second one in the same run is not: the streak is the daemon's business now
  const second = advance(first, "timeout");
  assert.equal(timeoutNotice(first, second), null);
  // a different symptom is not a timeout, and a clean round ends the run
  const ok = advance(second, "ok");
  assert.equal(timeoutNotice(second, ok), null);
  assert.equal(ok.streak, 0);
  // the next cut after a clean round is news again
  assert.notEqual(timeoutNotice(ok, advance(ok, "timeout")), null);
});

test("a run of cuts says one thing until it parks, and the parked line says the rest", () => {
  // four cuts in a row: the first is the only one worth a line, and the fourth parks it
  let e = FRESH;
  const said: string[] = [];
  for (let i = 0; i < 4; i++) {
    const before = e;
    e = advance(e, "timeout");
    const park = parkNotice(before, e);
    const cut = park === null ? timeoutNotice(before, e) : null;
    if (park !== null) said.push("park");
    if (cut !== null) said.push("cut");
  }
  assert.deepEqual(said, ["cut", "park"]);
  assert.equal(e.level, 4);
});

test("a round whose last request errored is not reported as an empty one", () => {
  // the same silence, two causes: pi retries a failed request, records an empty assistant
  // message, and settles normally — so without the count this round looks like a quiet one
  assert.equal(classify(rpc({ endedOnModelError: true })), "model-error");
  // even when it got some work done before the network went away
  assert.equal(
    classify(
      rpc({
        endedOnModelError: true,
        toolCalls: [{ name: "bash", key: "k", preview: "ls", atMs: 0, durationMs: 5, isError: false }],
      }),
    ),
    "model-error",
  );
  // an error it recovered from is not a failed round: the last thing it said was words
  assert.equal(classify(rpc({ endedOnModelError: false })), "ok");
});
