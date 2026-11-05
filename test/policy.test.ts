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

test("an unparsable chain is a bad policy, not a silent direct connection", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-policy-"));
  const file = join(dir, "policy.json");
  const base = defaultPolicy();

  const write = (proxyChain: string): void =>
    writeFileSync(file, JSON.stringify({ ...base, container: { ...base.container, proxyChain } }));
  // these all carry the http(s) prefix, so the old string check waved them through;
  // `chainFrom` answered null and the daemon quietly went direct
  for (const bad of ["http://", "http://proxy.example:not-a-port", "http://%zz@proxy.example"]) {
    write(bad);
    assert.throws(() => loadPolicy(file), /proxyChain/, bad);
  }
  write("https://proxy.example:3129");
  assert.equal(loadPolicy(file).container.proxyChain, "https://proxy.example:3129");
});

test("an address rule that is not an address is a bad policy", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-policy-"));
  const file = join(dir, "policy.json");
  const base = defaultPolicy();

  for (const bad of ["localhost", "10.0.0.0/8/8", "1.2.3.4/99", "2001:db8:::32", "10.0.0.256/8"]) {
    writeFileSync(file, JSON.stringify({ ...base, container: { ...base.container, proxyAllowCidrs: [bad] } }));
    assert.throws(() => loadPolicy(file), /proxyAllowCidrs/, bad);
  }
  writeFileSync(
    file,
    JSON.stringify({ ...base, container: { ...base.container, proxyAllowCidrs: ["::ffff:192.0.2.0/120"] } }),
  );
  assert.doesNotThrow(() => loadPolicy(file));
});

test("integer fields do not become half a container or a fractional threshold", () => {
  const dir = mkdtempSync(join(tmpdir(), "geng-policy-"));
  const file = join(dir, "policy.json");
  const base = defaultPolicy();
  for (const [path, value] of [
    ["container.pidsLimit", 512.5],
    ["cycle.repeatThreshold", 3.5],
  ] as const) {
    const merged = path === "container.pidsLimit"
      ? { ...base, container: { ...base.container, pidsLimit: value } }
      : { ...base, cycle: { ...base.cycle, repeatThreshold: value } };
    writeFileSync(file, JSON.stringify(merged));
    assert.throws(() => loadPolicy(file), new RegExp(path), `${path} = ${value}`);
  }
});
