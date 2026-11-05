import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";
import { connect, createServer as createTcp } from "node:net";
import { hostAllowed, isPublicAddress, checkTarget, handleConnect } from "../internal/proxy.ts";

test("a host is allowed by itself or as a subdomain, never as a suffix of something else", () => {
  const allow = ["github.com", "npmjs.org"];
  assert.equal(hostAllowed("github.com", allow), true);
  assert.equal(hostAllowed("api.github.com", allow), true);
  assert.equal(hostAllowed("GITHUB.COM.", allow), true, "trailing dot is the same host");
  // the one that matters: `evil-github.com` ends with `github.com` as a string
  assert.equal(hostAllowed("evil-github.com", allow), false);
  assert.equal(hostAllowed("github.com.evil.test", allow), false);
  assert.equal(hostAllowed("example.com", allow), false);
});

test("a proxy that can reach the host's own network is worse than no proxy", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} 是内网地址`);
  }
  assert.equal(isPublicAddress("140.82.112.3"), true);
  // an IPv4-mapped loopback is still loopback
  assert.equal(isPublicAddress("::ffff:127.0.0.1"), false);
});

test("a target has to be both named and public before it is opened", async () => {
  const rule = { allow: ["localhost", "example.com"] };
  const named = await checkTarget("localhost:443", rule);
  assert.equal(named.ok, false, "放行名单里有它，但它解析到 127.0.0.1");
  const unknown = await checkTarget("not-on-the-list.test:443", rule);
  assert.equal(unknown.ok, false);
  assert.match(unknown.why ?? "", /不在放行名单/);
  const junk = await checkTarget("nonsense", rule);
  assert.equal(junk.ok, false);
});

function clearProxyEnv(): () => void {
  const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, ALL_PROXY: process.env.ALL_PROXY };
  for (const k of Object.keys(saved)) delete process.env[k];
  return () => {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  };
}

test("a CONNECT to a name that resolves inside the host's own network is refused", async () => {
  const restore = clearProxyEnv();
  const target = createTcp((socket) => socket.on("data", (b) => socket.write(`echo:${String(b)}`)));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (target.address() as { port: number }).port;
    const refusals: string[] = [];
    const denied = await new Promise<string>((resolve) => {
      const socket = {
        write: (s: string) => resolve(s),
        end: (s?: string) => resolve(s ?? ""),
        on: () => {},
        destroy: () => {},
      };
      void handleConnect(`localhost:${port}`, socket as never, Buffer.alloc(0), { allow: ["localhost"] }, (l) => {
        refusals.push(l);
      });
    });
    assert.match(denied, /403/);
    assert.match(refusals.join("\n"), /127\.0\.0\.1/);
  } finally {
    restore();
    await new Promise<void>((r) => target.close(() => r()));
  }
});

test("when the host is itself behind a proxy, the tunnel goes through it", async () => {
  // a stand-in for the machine's own proxy: it answers the CONNECT and then echoes
  const upstream = createTcp((socket) => {
    let greeted = false;
    socket.on("data", (b) => {
      if (!greeted) {
        greeted = true;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        return;
      }
      socket.write(`echo:${String(b)}`);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const restore = clearProxyEnv();
  process.env.HTTPS_PROXY = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const clientSide = createTcp((socket) => {
    void handleConnect("github.com:443", socket, Buffer.alloc(0), { allow: ["github.com"] }, () => {});
  });
  await new Promise<void>((r) => clientSide.listen(0, "127.0.0.1", () => r()));
  try {
    const out = await new Promise<string>((resolve) => {
      const c = connect((clientSide.address() as { port: number }).port, "127.0.0.1", () => {
        c.write("ping");
      });
      let text = "";
      const finish = (): void => {
        c.destroy();
        resolve(text);
      };
      c.on("data", (d) => {
        text += String(d);
        if (text.includes("echo:ping")) finish();
      });
      setTimeout(finish, 2000);
    });
    assert.match(out, /200 Connection Established/);
    assert.match(out, /echo:ping/);
  } finally {
    restore();
    clientSide.close();
    upstream.close();
  }
});
