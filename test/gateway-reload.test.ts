import { test } from "node:test";
import assert from "node:assert/strict";
import { reloadPlan } from "../internal/gateway.ts";

test("an allow-only edit moves no poller", () => {
  // the common case: add a person to bots.json. A poller per token is the only thing a
  // reload has to move, and this one did not change.
  assert.deepEqual(reloadPlan({ alice: "t1", bob: "t2" }, { alice: "t1", bob: "t2" }), {
    stop: [],
    start: [],
  });
});

test("a changed token is stopped before it is started", () => {
  const plan = reloadPlan({ alice: "old", bob: "t2" }, { alice: "new", bob: "t2" });
  assert.deepEqual(plan, { stop: ["alice"], start: ["alice"] });
});

test("a bot that came or went moves only its own poller", () => {
  assert.deepEqual(reloadPlan({ alice: "t1" }, { alice: "t1", carol: "t3" }), {
    stop: [],
    start: ["carol"],
  });
  assert.deepEqual(reloadPlan({ alice: "t1", carol: "t3" }, { alice: "t1" }), {
    stop: ["carol"],
    start: [],
  });
});
