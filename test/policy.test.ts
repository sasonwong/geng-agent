import { test } from "node:test";
import assert from "node:assert/strict";
import { policyDrift, templateValue } from "../internal/policy.ts";


test("a policy copy is compared with the template key by key", () => {
  const template = {
    schema: 1,
    runner: "local",
    container: { image: "x", proxyChain: "auto", proxyAllowCidrs: ["*"], removed: true },
  };
  const copy = { schema: 1, runner: "docker", container: { image: "x", removed: true, legacy: 1 } };
  const drift = policyDrift(template, copy);
  // missing = the instance is running on a default nobody chose
  assert.deepEqual(drift.missing, ["container.proxyAllowCidrs", "container.proxyChain"]);
  // stale = it still declares something nothing reads
  assert.deepEqual(drift.stale, ["container.legacy"]);
  // a value that differs is not drift: that is the operator's decision
  assert.equal(policyDrift(template, { ...copy, runner: "docker" }).missing.includes("runner"), false);
  assert.deepEqual(templateValue(template, "container.proxyChain"), "auto");
  assert.equal(templateValue(template, "container.nope"), undefined);
});
