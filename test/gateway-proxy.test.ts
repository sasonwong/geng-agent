import { test } from "node:test";
import assert from "node:assert/strict";
import { assertProxySupport } from "../internal/gateway.ts";

// NODE_USE_ENV_PROXY 是 22.21.0 / 24.0.0 才有的开关。旧的网关在配了代理却跑在
// 22.18 的机器上时，fetch 会直接忽略 HTTP(S)_PROXY，症状和「Telegram 不通」完全
// 一样，而每一处配置看起来都是对的。这里钉的是「该早失败」而不是「该悄悄直连」。

const clean = {};
const proxy = { HTTPS_PROXY: "http://127.0.0.1:3128" };

test("no proxy configured means there is nothing to check", () => {
  assert.doesNotThrow(() => assertProxySupport(clean, "22.18.0"));
});

test("a proxy on a runtime that ignores the switch is refused with a usable version", () => {
  for (const version of ["22.18.0", "22.20.1", "23.11.0", "20.19.0"]) {
    assert.throws(
      () => assertProxySupport(proxy, version),
      (err: Error) => /22\.21\.0 或 24/.test(err.message) && err.message.includes(version),
      `Node ${version} 必须停下来`,
    );
  }
});

test("the versions that do read the switch are allowed through", () => {
  for (const version of ["22.21.0", "22.23.4", "24.0.0", "24.14.0", "26.1.0"]) {
    assert.doesNotThrow(() => assertProxySupport(proxy, version), version);
  }
});

test("the lowercase spelling counts as a configured proxy too", () => {
  assert.throws(() => assertProxySupport({ http_proxy: "http://127.0.0.1:3128" }, "22.18.0"));
});
