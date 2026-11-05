import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy, loadPolicy, policyDrift, templateValue } from "../internal/policy.ts";


test("a policy copy is compared with the template key by key", () => {
  const template = {
    schema: 1,
    container: { image: "x", proxyChain: "auto", proxyAllowCidrs: ["*"], removed: true },
  };
  const copy = { schema: 1, runner: "docker", container: { image: "x", removed: true, legacy: 1 } };
  const drift = policyDrift(template, copy);
  // missing = the instance is running on a default nobody chose
  assert.deepEqual(drift.missing, ["container.proxyAllowCidrs", "container.proxyChain"]);
  // stale = it still declares something nothing reads
  assert.deepEqual(drift.stale, ["container.legacy", "runner"]);
  // a value that differs is not drift: that is the operator's decision
  assert.equal(policyDrift(template, { ...copy, timezone: "UTC" }).missing.includes("timezone"), false);
  assert.deepEqual(templateValue(template, "container.proxyChain"), "auto");
  assert.equal(templateValue(template, "container.nope"), undefined);
});

test("a wrong type in an allow list is an error, not a silent empty list", () => {
  const file = join(mkdtempSync(join(tmpdir(), "geng-policy-")), "policy.json");
  const good = defaultPolicy() as unknown as Record<string, unknown>;
  const container = good.container as Record<string, unknown>;
  const bad: [string, unknown][] = [
    ["proxyAllow", "*"],
    ["proxyAllowCidrs", "0.0.0.0/0"],
    ["proxyAllow", [1, 2]],
    ["proxyAllowCidrs", [null]],
  ];
  for (const [key, value] of bad) {
    writeFileSync(file, JSON.stringify({ ...good, container: { ...container, [key]: value } }));
    // An array-shaped typo used to collapse to `[]` — "refuse every host" — with no
    // error at all, which is exactly the silent fallback loadPolicy promises not to do.
    assert.throws(() => loadPolicy(file), /字符串数组/, `${key} 类型错了要明说`);
  }
  // An actually empty list is a decision (nothing goes out), not a typo.
  writeFileSync(file, JSON.stringify({ ...good, container: { ...container, proxyAllow: [] } }));
  assert.deepEqual(loadPolicy(file).container.proxyAllow, []);
});
