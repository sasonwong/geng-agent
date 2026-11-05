import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp } from "node:http";
import { connect, createServer as createTcp } from "node:net";
import { chainFrom, hostAllowed, isPublicAddress, checkTarget, handleConnect } from "../internal/proxy.ts";

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
  assert.equal(isPublicAddress("192.0.2.7"), true, "文档段是公网段，只是不能路由");
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

test("the chain is a setting with three meanings, and `off` is one of them", () => {
  const saved = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://127.0.0.1:10808";
  try {
    // auto follows the environment; a URL overrides it; off ignores it entirely
    assert.deepEqual(chainFrom("auto"), { kind: "http", host: "127.0.0.1", port: 10808 });
    assert.deepEqual(chainFrom(""), { kind: "http", host: "127.0.0.1", port: 10808 });
    assert.deepEqual(chainFrom("http://10.0.0.9:3128"), { kind: "http", host: "10.0.0.9", port: 3128 });
    assert.equal(chainFrom("off"), null, "off 存在是为了压过环境里那行残留");
    // SOCKS is a different protocol, not a different spelling of the same one
    assert.deepEqual(chainFrom("socks5://127.0.0.1:1080"), { kind: "socks5", host: "127.0.0.1", port: 1080 });
    const withAuth = chainFrom("socks5://me:secret@127.0.0.1:1080");
    assert.equal(withAuth?.kind, "socks5");
    assert.deepEqual((withAuth as { auth?: unknown }).auth, { user: "me", pass: "secret" });
    // a proxy URL with credentials sends them as a header, never in the request line
    const http = chainFrom("http://me:pw@10.0.0.9:3128");
    assert.match(String((http as { auth?: string }).auth), /^Basic /);
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved;
  }
});

test("`*` is how everything is allowed, and an empty list is how nothing is", () => {
  assert.equal(hostAllowed("anything.example", ["*"]), true);
  assert.equal(hostAllowed("anything.example", []), false);
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
  const chain = chainFrom("auto");
  const clientSide = createTcp((socket) => {
    void handleConnect("github.com:443", socket, Buffer.alloc(0), { allow: ["github.com"] }, () => {}, chain);
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

test("a SOCKS5 chain does the handshake before it pipes anything", async () => {
  // stand-in SOCKS5 server: greeting, optional user/pass, CONNECT, then echo
  const seen: string[] = [];
  const socks = createTcp((socket) => {
    let stage = "greet";
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (stage === "greet") {
          if (buffered.length < 2) return;
          const methods = buffered[1] as number;
          if (buffered.length < 2 + methods) return;
          const offered = buffered.subarray(2, 2 + methods);
          buffered = buffered.subarray(2 + methods);
          // choose user/pass when it was offered, like a real server with credentials
          stage = offered.includes(2) ? "auth" : "connect";
          socket.write(Buffer.from([5, stage === "auth" ? 2 : 0]));
          continue;
        }
        if (stage === "auth") {
          if (buffered.length < 2) return;
          const userLen = buffered[1] as number;
          if (buffered.length < 2 + userLen + 1) return;
          const passLen = buffered[2 + userLen] as number;
          if (buffered.length < 3 + userLen + passLen) return;
          buffered = buffered.subarray(3 + userLen + passLen);
          stage = "connect";
          socket.write(Buffer.from([1, 0]));
          continue;
        }
        if (stage === "connect") {
          if (buffered.length < 5) return;
          const nameLen = buffered[4] as number;
          if (buffered.length < 5 + nameLen + 2) return;
          seen.push(buffered.subarray(5, 5 + nameLen).toString());
          buffered = buffered.subarray(5 + nameLen + 2);
          stage = "echo";
          // success, IPv4 0.0.0.0:0
          socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (buffered.length > 0) socket.write(`echo:${String(buffered)}`);
          continue;
        }
        socket.write(`echo:${String(buffered)}`);
        buffered = Buffer.alloc(0);
        return;
      }
    });
  });
  await new Promise<void>((r) => socks.listen(0, "127.0.0.1", () => r()));
  const chain = chainFrom(`socks5://me:secret@127.0.0.1:${(socks.address() as { port: number }).port}`);
  const front = createTcp((socket) => {
    void handleConnect("github.com:443", socket, Buffer.alloc(0), { allow: ["github.com"] }, () => {}, chain);
  });
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
  try {
    const out = await new Promise<string>((resolve) => {
      const c = connect((front.address() as { port: number }).port, "127.0.0.1", () => c.write("ping"));
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
    // the name travelled in the CONNECT, not resolved on the daemon side
    assert.deepEqual(seen, ["github.com"]);
  } finally {
    front.close();
    socks.close();
  }
});
