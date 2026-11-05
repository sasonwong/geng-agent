import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttp, request } from "node:http";
import { makePaths } from "../internal/paths.ts";
import { startBookServer, socketPath } from "../internal/book.ts";
import assert from "node:assert/strict";
import { connect, createServer as createTcp } from "node:net";
import {
  addrAllowed,
  chainFrom,
  hostAllowed,
  inCidr,
  checkTarget,
  handleConnect,
  socksConnectBody,
  splitAuthority,
} from "../internal/proxy.ts";

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

test("the private ranges are excluded by the rules, not by a hardcoded idea of private", () => {
  const rule = ["0.0.0.0/0", "!10.0.0.0/8", "!127.0.0.0/8", "!169.254.0.0/16", "::/0", "!fc00::/7"];
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "fd00::1"]) {
    assert.deepEqual(addrAllowed(ip, rule).ok, false, `${ip} 要被排除`);
  }
  for (const ip of ["192.0.2.7", "198.51.100.9", "2606:50c0::1"]) {
    assert.deepEqual(addrAllowed(ip, rule).ok, true, `${ip} 是公网`);
  }
  // a rule that says nothing allows nothing: silence is not permission
  assert.equal(addrAllowed("192.0.2.7", []).ok, false);
  // `!` wins over `*`, whatever the order
  assert.equal(addrAllowed("192.0.2.7", ["*", "!192.0.2.0/24"]).ok, false);
  assert.equal(addrAllowed("192.0.2.7", ["!192.0.2.0/24", "*"]).ok, false);
});

test("a prefix is a byte comparison, not a string one", () => {
  assert.equal(inCidr("10.1.2.3", "10.0.0.0/8"), true);
  assert.equal(inCidr("10.1.2.3", "10.1.0.0/16"), true);
  assert.equal(inCidr("10.1.2.3", "10.1.2.0/24"), true);
  assert.equal(inCidr("10.1.2.3", "10.1.3.0/24"), false);
  // a /23 spans two /24s: 10.1.2.0–10.1.3.255 is in, 10.1.4.0 is out
  assert.equal(inCidr("10.1.2.3", "10.1.2.0/23"), true);
  assert.equal(inCidr("10.1.3.255", "10.1.2.0/23"), true);
  assert.equal(inCidr("10.1.4.0", "10.1.2.0/23"), false);
  assert.equal(inCidr("10.0.0.0", "10.0.0.0/32"), true);
  assert.equal(inCidr("10.0.0.1", "10.0.0.0/32"), false);
  // v6, and the two families never match each other
  assert.equal(inCidr("2001:db8::5", "2001:db8::/32"), true);
  assert.equal(inCidr("2001:db9::5", "2001:db8::/32"), false);
  assert.equal(inCidr("2001:db8::5", "10.0.0.0/8"), false);
  // an IPv6 address written with its IPv4 tail is one shape, not a parser guess
  assert.equal(inCidr("::ffff:192.0.2.9", "::ffff:192.0.2.0/121"), true);
  assert.equal(inCidr("::ffff:192.0.2.9", "::ffff:192.0.2.0/125"), false);
  // a malformed rule is not a rule
  assert.equal(inCidr("2001:db8::5", "2001:db8:::32"), false);
  assert.equal(inCidr("2001:db8::5", "2001:db8::/32/8"), false);
});

test("an IPv4 address in IPv6 clothes is refused by the IPv4 rule", () => {
  // Node connects `::ffff:127.0.0.1` (and the older `::127.0.0.1`) to 127.0.0.1, so a
  // rule that only sees the 128-bit spelling is decoration. The default is what matters:
  // the address has to be denied through its embedded v4 form.
  const rule = ["0.0.0.0/0", "::/0", "!127.0.0.0/8", "!10.0.0.0/8", "!169.254.0.0/16"];
  for (const ip of ["::ffff:127.0.0.1", "::ffff:10.0.0.7", "::ffff:169.254.169.254", "::127.0.0.1"]) {
    assert.equal(addrAllowed(ip, rule).ok, false, `${ip} 要被当成内网地址`);
  }
  // an explicit v4-only rule governs the embedded form too
  assert.equal(addrAllowed("::ffff:192.0.2.7", ["192.0.2.0/24"]).ok, true);
  assert.equal(addrAllowed("::ffff:192.0.2.7", ["192.0.2.1/32"]).ok, false);
});

test("a target has to be both named and public before it is opened", async () => {
  // the name is allowed; the address is refused — that is the two-key design
  const rule = { allow: ["localhost", "example.com"], cidrs: ["0.0.0.0/0", "!127.0.0.0/8"] };
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
    // an https chain is TLS, not HTTP spoken to a TLS port; and brackets are not the host
    assert.deepEqual(chainFrom("https://proxy.example:3129"), { kind: "https", host: "proxy.example", port: 3129 });
    assert.equal(chainFrom("https://[2001:db8::1]:3129")?.host, "2001:db8::1");
    // a URL that does not parse is no chain at all, and must not become "direct"
    assert.equal(chainFrom("http://"), null);
    assert.equal(chainFrom("http://proxy.example:not-a-port"), null);
    assert.equal(chainFrom("http://%zz@proxy.example"), null);
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved;
  }
});

test("`*` is how everything is allowed, and an empty list is how nothing is", () => {
  assert.equal(hostAllowed("anything.example", ["*"]), true);
  // `!` on the name list, and it wins
  assert.equal(hostAllowed("evil.example", ["*", "!evil.example"]), false);
  assert.equal(hostAllowed("sub.evil.example", ["*", "!evil.example"]), false);
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
      void handleConnect(`localhost:${port}`, socket as never, Buffer.alloc(0), { allow: ["localhost"], cidrs: ["0.0.0.0/0", "!127.0.0.0/8"] }, (l) => {
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

test("a SOCKS chain names an address as an address, and finds the host in an IPv6 target", () => {
  // `o.then` is `${host}:${port}` and an IPv6 host contains colons: splitting on the first
  // one turned `::1:443` into host "" and a 502. And a literal was always sent as ATYP=domain,
  // so the chain resolved a string that was already an address.
  assert.deepEqual(splitAuthority("127.0.0.1:443"), { host: "127.0.0.1", port: 443 });
  assert.deepEqual(splitAuthority("::1:443"), { host: "::1", port: 443 });
  assert.deepEqual(splitAuthority("localhost:80"), { host: "localhost", port: 80 });
  assert.equal(splitAuthority("nonsense"), null);
  assert.equal(splitAuthority(":443"), null);
  assert.equal(splitAuthority("host:0"), null);

  // VER=5, NMETHODS=1, METHOD=0, then ATYP and the address
  assert.deepEqual([...socksConnectBody("127.0.0.1", 443)!], [5, 1, 0, 1, 127, 0, 0, 1, 1, 187]);
  const v6 = socksConnectBody("::1", 443)!;
  assert.equal(v6[3], 4, "IPv6 is ATYP 4");
  assert.deepEqual([...v6.subarray(4, 20)], [...Buffer.from("00000000000000000000000000000001", "hex")]);
  const name = socksConnectBody("localhost", 80)!;
  assert.equal(name[3], 3, "a name is ATYP 3");
  assert.equal(name[4], "localhost".length);
  assert.equal(name.subarray(5, 14).toString(), "localhost");
  // nothing is invented for what cannot be sent
  assert.equal(socksConnectBody("localhost", 70000), null);
  assert.equal(socksConnectBody("", 80), null);
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
  // `localhost` resolves without a network; the chain stub never looks at the name
  const clientSide = createTcp((socket) => {
    void handleConnect("localhost:443", socket, Buffer.alloc(0), { allow: ["localhost"], cidrs: ["127.0.0.0/8", "::1/128"] }, () => {}, chain);
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

test("a CONNECT answer that arrives in pieces is still a CONNECT answer", async () => {
  // The old tunnel checked each TCP chunk for `\r\n\r\n` on its own. A proxy that split
  // `HTTP/1.1 200\r\n\r\n` in the middle was read as a hang or a 502; HTTP does not
  // promise one write per header, so the reader has to accumulate.
  const upstream = createTcp((socket) => {
    socket.once("data", () => {
      socket.write("HTTP/1.1 200 Con");
      setTimeout(() => socket.write("nection Established\r\n\r\ntunnel-ready"), 10);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const chain = chainFrom(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`);
  const clientSide = createTcp((socket) => {
    void handleConnect("localhost:443", socket, Buffer.alloc(0), { allow: ["localhost"], cidrs: ["127.0.0.0/8", "::1/128"] }, () => {}, chain);
  });
  await new Promise<void>((r) => clientSide.listen(0, "127.0.0.1", () => r()));
  try {
    const out = await new Promise<string>((resolve) => {
      const c = connect((clientSide.address() as { port: number }).port, "127.0.0.1", () => c.write("ping"));
      let text = "";
      const finish = (): void => {
        c.destroy();
        resolve(text);
      };
      c.on("data", (d) => {
        text += String(d);
        if (text.includes("tunnel-ready")) finish();
      });
      setTimeout(finish, 2000);
    });
    assert.match(out, /200 Connection Established/);
    assert.match(out, /tunnel-ready/);
  } finally {
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
    void handleConnect("localhost:443", socket, Buffer.alloc(0), { allow: ["localhost"], cidrs: ["127.0.0.0/8", "::1/128"] }, () => {}, chain);
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
    assert.deepEqual(seen, ["localhost"]);
  } finally {
    front.close();
    socks.close();
  }
});

test("a chain does not buy an address the rules refuse", async () => {
  // `!127.0.0.0/8` is the rule that stops the container from reaching the host's own
  // services. Skipping the address check when a chain was configured made it decoration:
  // the chain is usually on this very host, and it would CONNECT anywhere the name allowed.
  // a chain that answers properly: if the address check is skipped this becomes a working
  // tunnel, and the assertion below fails instead of waiting for a reply that never comes
  const reached: string[] = [];
  const chainStub = createTcp((socket) => {
    reached.push("connected");
    // it refuses on purpose: if the address check is skipped the chain answers 403 and the
    // tunnel is torn down, so the broken case fails fast instead of half-open
    socket.once("data", () => socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"));
  });
  await new Promise<void>((r) => chainStub.listen(0, "127.0.0.1", () => r()));
  const chain = chainFrom(`http://127.0.0.1:${(chainStub.address() as { port: number }).port}`);
  try {
    const answer = await new Promise<string>((resolve) => {
      const socket = {
        write: (s: string) => resolve(s),
        end: (s?: string) => resolve(s ?? ""),
        on: () => {},
        destroy: () => {},
      };
      void handleConnect(
        "localhost:22",
        socket as never,
        Buffer.alloc(0),
        { allow: ["localhost"], cidrs: ["0.0.0.0/0", "!127.0.0.0/8"] },
        () => {},
        chain,
      );
    });
    assert.match(answer, /403/);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(reached, [], "到链那一侧的连接一次都不该建立");
  } finally {
    chainStub.close();
  }
});

test("plain http is proxied too, and refused by the same address rules", async () => {
  const target = createHttp((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`hello ${req.url ?? ""}`);
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
  const up = makePaths(mkdtempSync(join(tmpdir(), "geng-proxy-")), "alice");
  const ask = (url: string): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: socketPath(up),
          path: url,
          method: "GET",
          agent: false,
          headers: { host: new URL(url).host },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  const port = (target.address() as { port: number }).port;
  // The rule is read per request: the daemon reloads policy.json every cycle, so a
  // snapshot taken when the endpoint started is a security setting that quietly stopped
  // being read. One server, one `rule`, edited in between — that is the whole test.
  let rule = { allow: ["*"], cidrs: ["0.0.0.0/0", "!127.0.0.0/8"] };
  const server = await startBookServer({ paths: up, log: () => {}, proxy: () => rule });
  try {
    // the rule refuses it before anything is fetched: 127/8 is excluded
    const denied = await ask(`http://127.0.0.1:${port}/a`);
    assert.equal(denied.status, 403);
    assert.match(denied.body, /127\.0\.0\.1/);

    // the operator opens loopback in policy.json; no restart, no new endpoint
    rule = { allow: ["*"], cidrs: ["0.0.0.0/0"] };
    const ok = await ask(`http://127.0.0.1:${port}/a`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "hello /a");
  } finally {
    server.close();
    target.close();
  }
});

test("one connection is one report, and it is said only once the tunnel is up", async () => {
  // A socket pair, so the proxy has a client end to speak into without a container.
  const pair = async (): Promise<{ mine: import("node:net").Socket; peer: import("node:net").Socket }> => {
    let resolvePeer!: (s: import("node:net").Socket) => void;
    const ready = new Promise<import("node:net").Socket>((r) => (resolvePeer = r));
    const server = createTcp((s) => resolvePeer(s));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const mine = connect((server.address() as { port: number }).port, "127.0.0.1");
    const peer = await ready;
    server.close();
    return { mine, peer };
  };

  const target = createTcp((s) => s.end("hello"));
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
  const port = (target.address() as { port: number }).port;

  const { mine, peer } = await pair();
  const reports: [boolean, string | undefined][] = [];
  await handleConnect(
    `127.0.0.1:${port}`,
    peer,
    Buffer.alloc(0),
    { allow: ["*"], cidrs: ["127.0.0.0/8", "::1/128"] },
    () => {},
    null,
    (ok, why) => reports.push([ok, why]),
  );
  await new Promise((r) => setTimeout(r, 200));
  mine.destroy();
  target.close();

  // net=N is a count of places it went: two lines for one connection would double it,
  // and it used to be exactly that on the direct path (the chained path reported once,
  // which is why nobody saw it).
  assert.equal(reports.length, 1, JSON.stringify(reports));
  assert.equal(reports[0]?.[0], true);
});

test("a refused direct connection is a refusal, not an uncaught error", async () => {
  // A port that was just closed, so "nothing is listening" is the truth on any machine.
  const probe = createTcp(() => {});
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));

  // The error listener used to be attached inside the connect callback, so ECONNREFUSED
  // arrived on a socket with no listener: an uncaught 'error' event takes the daemon down
  // with the round it was serving. A listener here is what lets the test see that happen.
  const crashes: unknown[] = [];
  const onCrash = (e: unknown): void => {
    crashes.push(e);
  };
  process.on("uncaughtException", onCrash);
  const reports: [boolean, string | undefined][] = [];
  const fake = { write: () => {}, end: () => {}, on: () => {}, destroy: () => {} };
  try {
    await handleConnect(
      `127.0.0.1:${port}`,
      fake as never,
      Buffer.alloc(0),
      { allow: ["*"], cidrs: ["127.0.0.0/8", "::1/128"] },
      () => {},
      null,
      (ok, why) => reports.push([ok, why]),
    );
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    process.off("uncaughtException", onCrash);
  }
  assert.deepEqual(crashes, [], "一次拒连不该把 daemon 带走");
  // And it is a refusal, said once: `net=N` counts places it went.
  assert.deepEqual(reports.map((r) => r[0]), [false], JSON.stringify(reports));
  assert.match(reports[0]?.[1] ?? "", /ECONNREFUSED/);
});
