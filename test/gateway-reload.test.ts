import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeBots, planReload, reloadPlan } from "../internal/gateway.ts";
import type { Bots } from "../internal/bots.ts";

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

test("a poller that died is started again by the next reload", () => {
  // bob's poller died on a fetch failure and left the map; his config is still there.
  // The old call site compared configs, saw no change, and started nothing.
  const live = new Map([["telegram:alice", { fingerprint: "t1" }]]);
  const next = { alice: { token: "t1" }, bob: { token: "t2" } };
  const token = (cfg: unknown): string => (cfg as { token: string }).token;
  assert.deepEqual(planReload(live, "telegram", next, token), { stop: [], start: ["bob"] });
});

test("a poller that is alive with the same token is not moved", () => {
  const live = new Map([
    ["telegram:alice", { fingerprint: "t1" }],
    ["telegram:bob", { fingerprint: "t2" }],
  ]);
  const next = { alice: { token: "t1" }, bob: { token: "t2" } };
  const token = (cfg: unknown): string => (cfg as { token: string }).token;
  assert.deepEqual(planReload(live, "telegram", next, token), { stop: [], start: [] });
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

test("a bot whose token went missing keeps polling with the old one", () => {
  // a half-written bots.json is the case the reload is supposed to survive: the entry
  // survives with the token the poller already holds, so nothing is stopped
  const merged = mergeBots({ alice: { token: "old" }, bob: { token: "t2" } }, {
    alice: { allow: [7] },
    bob: { token: "t2" },
  });
  assert.deepEqual(merged.bots, { alice: { token: "old", allow: [7] }, bob: { token: "t2" } });
  assert.equal(merged.notes.length, 1);
  const tokens = (b: Bots): Record<string, string> =>
    Object.fromEntries(Object.entries(b).map(([k, c]) => [k, c.token]));
  assert.deepEqual(reloadPlan(tokens({ alice: { token: "old" }, bob: { token: "t2" } }), tokens(merged.bots)), {
    stop: [],
    start: [],
  });
});

test("a blank token counts as missing, not as a new token", () => {
  const merged = mergeBots({ alice: { token: "old" } }, { alice: { token: "   " } });
  assert.deepEqual(merged.bots, { alice: { token: "old" } });
  assert.deepEqual(reloadPlan({ alice: "old" }, { alice: "old" }), { stop: [], start: [] });
});

test("a bot with no token and no old one is dropped", () => {
  const merged = mergeBots({ alice: { token: "t1" } }, { alice: { token: "t1" }, carol: {} });
  assert.deepEqual(Object.keys(merged.bots), ["alice"]);
  assert.equal(merged.notes.length, 1);
});

test("a token that really changed still moves its poller", () => {
  const merged = mergeBots({ alice: { token: "old" } }, { alice: { token: "new" } });
  assert.deepEqual(merged.bots, { alice: { token: "new" } });
  assert.deepEqual(merged.notes, []);
});
