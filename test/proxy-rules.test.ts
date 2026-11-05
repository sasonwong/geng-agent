import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addrAllowed,
  chainFrom,
  checkTarget,
  validCidr,
} from "../internal/proxy.ts";

const DEFAULT_RULE = ["0.0.0.0/0", "::/0", "!127.0.0.0/8", "!::1/128"];

test("an address rule that can never match is refused as a rule", () => {
  for (const good of ["0.0.0.0/0", "10.0.0.0/8", "127.0.0.1", "::/0", "fe80::/10", "::ffff:127.0.0.1"]) {
    assert.equal(validCidr(good), true, `${good} 是网段`);
  }
  for (const bad of ["github.com", "!10.0.0.0/8", "10.0.0.0/33", "::/129", "1.2.3.4/8/9", "999.1.1.1", "not-an-ip", "1.2.3.4/-1"]) {
    assert.equal(validCidr(bad), false, `${bad} 不能当网段`);
  }
  // A mapped prefix is a v4 rule with a v6-shaped number: this code compares mapped
  // addresses as their 32-bit v4 selves, so a /96 prefix can never match anything.
  // Refusing the spelling is better than keeping a rule that looks like it excluded
  // the whole mapped block but did nothing.
  assert.equal(validCidr("::ffff:0:0/96"), false);
});

test("an IPv4-compatible IPv6 literal is checked as the IPv4 address it connects to", () => {
  // `::127.0.0.1` used to be parsed with parseInt("127.0.0.1", 16) — which stops at
  // the first dot — turning it into `::7f00`, a 128-bit address no `!127.0.0.0/8`
  // rule could see. Node connects it to the loopback address inside it.
  assert.equal(addrAllowed("::127.0.0.1", DEFAULT_RULE).ok, false);
  assert.equal(addrAllowed("::ffff:127.0.0.1", DEFAULT_RULE).ok, false);
  assert.equal(addrAllowed("0:0:0:0:0:ffff:127.0.0.1", DEFAULT_RULE).ok, false);
  // a genuinely public v6 address is still allowed
  assert.equal(addrAllowed("2606:50c0::1", DEFAULT_RULE).ok, true);
});

test("a port that WHATWG URL silently drops is a config error, not port 80", () => {
  assert.equal(chainFrom("http://proxy.example:not-a-port"), null);
  assert.equal(chainFrom("http://proxy.example:99999"), null);
  assert.equal(chainFrom("http://proxy.example:0"), null);
  const good = chainFrom("http://proxy.example:8080");
  assert.equal(good?.kind, "http");
  assert.equal(good?.port, 8080);
  assert.equal(chainFrom("https://proxy.example")?.port, 443);
});

test("a CONNECT to an out-of-range port is refused before net.connect can throw", async () => {
  const rule = { allow: ["*"], cidrs: ["0.0.0.0/0"] };
  for (const raw of ["192.0.2.1:0", "192.0.2.1:65536", "192.0.2.1:99999"]) {
    const d = await checkTarget(raw, rule);
    assert.equal(d.ok, false, `${raw} 要被拒绝`);
    assert.match(d.why ?? "", /端口/);
  }
  const ok = await checkTarget("192.0.2.1:443", rule);
  assert.equal(ok.ok, true);
});
