import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POLICY_SCHEMA, defaultPolicy, loadPolicy, policyDrift, templateValue } from "../internal/policy.ts";
import { ExpectedError, SchemaVersionError } from "../internal/errors.ts";


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

test("a timezone that cannot format a date is a bad policy, not a crashing waking", () => {
  // Intl.DateTimeFormat throws RangeError on a typo, and buildPacket has no catch:
  // one misspelled value made every waking die and systemd restart into the same
  // line, while doctor still said the policy was fine.
  const file = join(mkdtempSync(join(tmpdir(), "geng-policy-")), "policy.json");
  const base = defaultPolicy() as unknown as Record<string, unknown>;
  for (const bad of ["Asia/Shangai", "Mars/Olympus", ""]) {
    writeFileSync(file, JSON.stringify({ ...base, timezone: bad }));
    assert.throws(() => loadPolicy(file), /合法的时区名|non-empty string/, `${bad} 要在读 policy 时就被挡住`);
  }
  // half-hour zones must still be accepted — they are the reason the page prints an offset
  writeFileSync(file, JSON.stringify({ ...base, timezone: "Asia/Kolkata" }));
  assert.equal(loadPolicy(file).timezone, "Asia/Kolkata");
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

test("次数和进程上限必须是整数，不是小数", () => {
  const file = join(mkdtempSync(join(tmpdir(), "geng-policy-")), "policy.json");
  const base = defaultPolicy() as unknown as Record<string, unknown>;
  const cycle = base.cycle as Record<string, unknown>;
  const container = base.container as Record<string, unknown>;

  // 旧实现用 num()，2.5 次「卡住」判定、512.5 个进程都照单全收。
  writeFileSync(file, JSON.stringify({ ...base, cycle: { ...cycle, repeatThreshold: 2.5 } }));
  assert.throws(() => loadPolicy(file), /integer/, "2.5 次卡住判定要被挡住");
  writeFileSync(file, JSON.stringify({ ...base, container: { ...container, pidsLimit: 512.5 } }));
  assert.throws(() => loadPolicy(file), /integer/, "512.5 个进程要被挡住");

  writeFileSync(
    file,
    JSON.stringify({ ...base, cycle: { ...cycle, repeatThreshold: 4 }, container: { ...container, pidsLimit: 256 } }),
  );
  assert.equal(loadPolicy(file).cycle.repeatThreshold, 4);
  assert.equal(loadPolicy(file).container.pidsLimit, 256);
});

test("chainFrom 读不懂的 proxyChain 被拒绝，而不是悄悄直连", () => {
  const file = join(mkdtempSync(join(tmpdir(), "geng-policy-")), "policy.json");
  const base = defaultPolicy() as unknown as Record<string, unknown>;
  const container = base.container as Record<string, unknown>;
  // 端口越界：正则认得 http://，但 chainFrom() 返回 null。旧实现原样放行，操作者
  // 配的代理就这么被无声忽略，daemon 自己直连。
  writeFileSync(
    file,
    JSON.stringify({ ...base, container: { ...container, proxyChain: "http://proxy.example:99999" } }),
  );
  assert.throws(() => loadPolicy(file), /proxyChain/);
  writeFileSync(
    file,
    JSON.stringify({ ...base, container: { ...container, proxyChain: "http://proxy.example:3128" } }),
  );
  assert.equal(loadPolicy(file).container.proxyChain, "http://proxy.example:3128");
});

test("proxyAllowCidrs 里一段垃圾地址被挡住，而不是永远匹配不上", () => {
  const file = join(mkdtempSync(join(tmpdir(), "geng-policy-")), "policy.json");
  const base = defaultPolicy() as unknown as Record<string, unknown>;
  const container = base.container as Record<string, unknown>;
  for (const bad of ["999.999.999.999", "0.0.0.0/999", "!999.999.999.999"]) {
    writeFileSync(
      file,
      JSON.stringify({ ...base, container: { ...container, proxyAllowCidrs: ["0.0.0.0/0", bad] } }),
    );
    // 旧的正则只量字符形状：越界的八位数、过大的前缀都混过来了。
    assert.throws(() => loadPolicy(file), /proxyAllowCidrs/, `${bad} 要被挡住`);
  }
  writeFileSync(
    file,
    JSON.stringify({ ...base, container: { ...container, proxyAllowCidrs: ["0.0.0.0/0", "!127.0.0.0/8"] } }),
  );
  assert.deepEqual(loadPolicy(file).container.proxyAllowCidrs, ["0.0.0.0/0", "!127.0.0.0/8"]);
});

test("a policy from a newer version is a version mismatch, not an unreadable file", () => {
  // The daemon waits out a file that does not parse, because a half-saved policy becomes
  // valid on its own. A schema from the future never does: the operator has to upgrade the
  // code or bring the file back. Same read, different answer — so the error has to carry
  // which one it is, or every caller tells the operator the wrong thing to do.
  const file = join(mkdtempSync(join(tmpdir(), "geng-policy-")), "policy.json");
  const base = defaultPolicy() as unknown as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...base, schema: POLICY_SCHEMA + 1 }));
  assert.throws(() => loadPolicy(file), SchemaVersionError);
  assert.throws(() => loadPolicy(file), /更新版本/);
  // Still an ExpectedError: the CLI prints one line, not a stack trace.
  assert.throws(() => loadPolicy(file), ExpectedError);
});

test("a policy that exists with bytes that are not UTF-8 throws, it does not default", () => {
  // readText says null for a missing file and for a file whose bytes are not UTF-8.
  // Defaulting on the second silently replaces proxyChain, proxyAllowCidrs, timezone and
  // the wake minutes with the built-in ones — the file is there, so this is malformed,
  // not absent.
  const file = join(mkdtempSync(join(tmpdir(), "geng-policy-")), "policy.json");
  writeFileSync(file, Buffer.from([0x7b, 0xe9, 0x7d]));
  assert.throws(() => loadPolicy(file), ExpectedError);
  assert.throws(() => loadPolicy(file), /UTF-8/);
  // A missing file is still the defaults init writes.
  assert.equal(loadPolicy(join(mkdtempSync(join(tmpdir(), "geng-policy-")), "policy.json")).timezone, defaultPolicy().timezone);
});
