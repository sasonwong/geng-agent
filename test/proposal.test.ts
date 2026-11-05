import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProposal } from "../internal/proposal.ts";
import { makePaths } from "../internal/paths.ts";
import { defaultPolicy, loadPolicy } from "../internal/policy.ts";
import { writeJson } from "../internal/fs.ts";

function fixture(): ReturnType<typeof makePaths> {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  for (const d of [paths.book, paths.meta]) mkdirSync(d, { recursive: true });
  writeJson(paths.policy, defaultPolicy());
  return paths;
}

test("a negotiable field is applied and the old policy is archived", () => {
  const paths = fixture();
  writeJson(join(paths.book, "policy.proposal.json"), {
    cycle: { defaultWakeMinutes: 45 },
  });

  const result = applyProposal(paths);
  assert.deepEqual(result?.applied, [
    { key: "cycle.defaultWakeMinutes", from: 30, to: 45 },
  ]);
  assert.equal(loadPolicy(paths.policy).cycle.defaultWakeMinutes, 45);
  // the old policy is archived next to it, unchanged, for the day the change was wrong
  const history = readdirSync(join(paths.meta, "policy.history"));
  assert.equal(history.length, 1);
  assert.match(readFileSync(join(paths.meta, "policy.history", history[0] as string), "utf8"), /"defaultWakeMinutes": 30/);
});

test("out-of-range values are rejected and nothing is written", () => {
  const paths = fixture();
  writeJson(join(paths.book, "policy.proposal.json"), {
    cycle: { defaultWakeMinutes: 100000 },
  });
  const result = applyProposal(paths);
  assert.equal(result?.applied.length, 0);
  assert.match(result?.rejected[0]?.reason ?? "", /超出范围/);
  assert.equal(loadPolicy(paths.policy).cycle.defaultWakeMinutes, 30);
});

test("the frame is not negotiable", () => {
  const paths = fixture();
  writeJson(join(paths.book, "policy.proposal.json"), {
    container: { network: null },
    cycle: { timeoutSec: 999999 },
  });
  const result = applyProposal(paths);
  assert.equal(result?.applied.length, 0);
  const rejected = result?.rejected.map((r) => r.key) ?? [];
  assert.ok(rejected.includes("container.network"));
  assert.ok(rejected.includes("cycle.timeoutSec"));
  assert.equal(loadPolicy(paths.policy).cycle.timeoutSec, 1800);
});

test("no proposal means no work", () => {
  const paths = fixture();
  assert.equal(applyProposal(paths), null);
});

test("a malformed proposal is set aside, not obeyed", () => {
  const paths = fixture();
  writeFileSync(join(paths.book, "policy.proposal.json"), "{not json");
  const result = applyProposal(paths);
  assert.equal(result?.applied.length, 0);
  assert.equal(result?.rejected[0]?.key, "*");
  assert.equal(loadPolicy(paths.policy).cycle.defaultWakeMinutes, 30);
});

test("applying a proposal keeps the keys this build does not know", () => {
  // Adding a field to the policy is the one change the interface promises is safe, which
  // only holds if the writer does not rebuild the file from what it understands. It did:
  // the draft started from `loadPolicy()`'s output, so one proposal on an older build
  // dropped every field a newer build had added.
  const paths = fixture();
  const base = defaultPolicy();
  writeJson(paths.policy, { ...base, cycle: { ...base.cycle, aNewerKey: true } });
  writeJson(join(paths.book, "policy.proposal.json"), { cycle: { defaultWakeMinutes: 45 } });

  assert.equal(applyProposal(paths)?.applied.length, 1);
  const written = JSON.parse(readFileSync(paths.policy, "utf8")) as { cycle: Record<string, unknown> };
  assert.equal(written.cycle.aNewerKey, true, "采用一个提议不该删掉它不认识的字段");
  assert.equal(written.cycle.defaultWakeMinutes, 45);
});
