import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyProposal } from "../internal/proposal.ts";
import { makePaths } from "../internal/paths.ts";
import { loadPolicy } from "../internal/policy.ts";
import { defaultPolicy } from "../internal/policy.ts";
import { writeJson } from "../internal/state.ts";

function fixture(): ReturnType<typeof makePaths> {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  for (const d of [paths.palimpsest, paths.meta]) mkdirSync(d, { recursive: true });
  writeJson(paths.policy, defaultPolicy());
  return paths;
}

test("a negotiable field is applied and the old policy is archived", () => {
  const paths = fixture();
  writeJson(join(paths.palimpsest, "policy.proposal.json"), {
    cycle: { defaultWakeMinutes: 45 },
  });

  const result = applyProposal(paths);
  assert.deepEqual(result?.applied, [
    { key: "cycle.defaultWakeMinutes", from: 30, to: 45 },
  ]);
  assert.equal(loadPolicy(paths.policy).cycle.defaultWakeMinutes, 45);
  assert.ok(result?.archived && readFileSync(result.archived, "utf8").includes("30"));
});

test("out-of-range values are rejected and nothing is written", () => {
  const paths = fixture();
  writeJson(join(paths.palimpsest, "policy.proposal.json"), {
    cycle: { defaultWakeMinutes: 100000 },
  });
  const result = applyProposal(paths);
  assert.equal(result?.applied.length, 0);
  assert.match(result?.rejected[0]?.reason ?? "", /超出范围/);
  assert.equal(loadPolicy(paths.policy).cycle.defaultWakeMinutes, 30);
});

test("the frame is not negotiable", () => {
  const paths = fixture();
  writeJson(join(paths.palimpsest, "policy.proposal.json"), {
    container: { network: null },
    cycle: { timeoutSec: 999999 },
  });
  const result = applyProposal(paths);
  assert.equal(result?.applied.length, 0);
  const rejected = result?.rejected.map((r) => r.key) ?? [];
  assert.ok(rejected.includes("container.network"));
  assert.ok(rejected.includes("cycle.timeoutSec"));
  assert.equal(loadPolicy(paths.policy).cycle.timeoutSec, 1200);
});

test("no proposal means no work", () => {
  const paths = fixture();
  assert.equal(applyProposal(paths), null);
});

test("a malformed proposal is set aside, not obeyed", () => {
  const paths = fixture();
  writeFileSync(join(paths.palimpsest, "policy.proposal.json"), "{not json");
  const result = applyProposal(paths);
  assert.equal(result?.applied.length, 0);
  assert.equal(result?.rejected[0]?.key, "*");
  assert.equal(loadPolicy(paths.policy).cycle.defaultWakeMinutes, 30);
});
