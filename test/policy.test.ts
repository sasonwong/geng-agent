import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPolicy, loadPolicy, policyDrift, templateValue } from "../internal/policy.ts";
import { writeJson } from "../internal/fs.ts";

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
  // a value that differs is not drift: that is the operator's decision. (Asserted on the
  // whole list, not on `missing`: the old check asked whether a key the template never had
  // was missing, which is true of every copy and proved nothing.)
  assert.deepEqual(policyDrift(template, { ...copy, container: { ...copy.container, image: "别的镜像" } }), {
    missing: ["container.proxyAllowCidrs", "container.proxyChain"],
    stale: ["container.legacy", "runner"],
  });
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

test("a policy from a newer build is refused, not quietly rewritten", () => {
  // The same hazard `stateSchema` exists for, on the file that decides how the daemon runs:
  // a field that was renamed or removed reads as missing to an older build, every default
  // applies, and the instance runs as something the operator never wrote — with nothing
  // saying so. Additions never bump the stamp: a reader uses only the keys it knows.
  const file = join(mkdtempSync(join(tmpdir(), "geng-policy-")), "policy.json");
  writeJson(file, { ...defaultPolicy(), schema: defaultPolicy().schema + 1 });
  assert.throws(() => loadPolicy(file), /更新版本/);
  // the current stamp and no stamp at all are both readable: older is not unknown
  writeJson(file, defaultPolicy());
  assert.equal(loadPolicy(file).cycle.timeoutSec, 1800);
  const { schema: _, ...unstamped } = defaultPolicy();
  writeJson(file, unstamped);
  assert.equal(loadPolicy(file).cycle.timeoutSec, 1800);
});

test("a key that merely ends in .schema is a key, not a version stamp", () => {
  // `policyDrift` used to drop every leaf whose name ended in `.schema`, a filter left over
  // from a nested version field no policy has ever had. Filtering by spelling means a real
  // key can be hidden from the only check that reports it.
  const drift = policyDrift({ cycle: { schema: 1, defaultWakeMinutes: 30 } }, {});
  assert.deepEqual(drift.missing, ["cycle.defaultWakeMinutes", "cycle.schema"]);
});
