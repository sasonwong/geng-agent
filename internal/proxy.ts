import { connect as tcpConnect } from "node:net";
import { lookup } from "node:dns/promises";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * An HTTP proxy served on the book socket, so the container can reach the network without
 * having one.
 *
 * The container runs with `--network none`: no interface but loopback, no DNS, no route.
 * Everything that leaves it does so through `socat`, which bridges a loopback port to this
 * socket. The daemon answers CONNECT for the hosts its policy names and refuses the rest —
 * so "which host did it talk to" is a line in a log, not an absence of evidence.
 *
 * A proxy that forwards anything is worse than an open network: it can reach the host's own
 * services. Every host is resolved first and refused if it lands in a private, loopback or
 * link-local range, and the connection is made to the address that was checked.
 */
export interface ProxyRule {
  /** Host names it may reach, matched as itself or as a suffix of `.name`. `!` excludes. */
  allow: string[];
  /** Address ranges, checked after resolution. `!` excludes, and an exclusion always wins. */
  cidrs: string[];
}

/** An IPv4 or IPv6 address as bytes, so a prefix is a byte comparison. */
function bytesOf(ip: string): { bytes: Buffer; bits: number } | null {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const parts = [v4[1], v4[2], v4[3], v4[4]].map((x) => Number(x));
    if (parts.some((n) => n > 255)) return null;
    return { bytes: Buffer.from(parts as number[]), bits: 32 };
  }
  if (!ip.includes(":")) return null;
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  if (tail === undefined && left.length !== 8) return null;
  const groups = [...left, ...(tail === undefined ? [] : Array(8 - left.length - right.length).fill("0")), ...right];
  if (groups.length !== 8) return null;
  const bytes = Buffer.alloc(16);
  for (const [i, group] of groups.entries()) {
    const value = Number.parseInt(group === "" ? "0" : group, 16);
    if (!Number.isFinite(value) || value > 0xffff) return null;
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return { bytes, bits: 128 };
}

/** Does `ip` fall inside `cidr`? A bare address is its own /32 or /128. */
export function inCidr(ip: string, cidr: string): boolean {
  const [net, prefixText] = cidr.split("/");
  const a = bytesOf(ip.replace(/^\[|\]$/g, ""));
  const b = bytesOf((net ?? "").replace(/^\[|\]$/g, ""));
  if (a === null || b === null || a.bits !== b.bits) return false;
  const prefix = prefixText === undefined ? a.bits : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > a.bits) return false;
  const full = Math.floor(prefix / 8);
  for (let i = 0; i < full; i++) if (a.bytes[i] !== b.bytes[i]) return false;
  const rest = prefix % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((a.bytes[full] as number) & mask) === ((b.bytes[full] as number) & mask);
}

/** `!` entries are exclusions and they win: order never changes the answer. */
function entries(rule: string[]): { allow: string[]; deny: string[] } {
  return {
    allow: rule.filter((e) => !e.startsWith("!")),
    deny: rule.filter((e) => e.startsWith("!")).map((e) => e.slice(1)),
  };
}

/** `github.com` allows itself and `codeload.github.com`, never `evil-github.com`. */
export function hostAllowed(host: string, rule: string[]): boolean {
  const want = host.toLowerCase().replace(/\.$/, "");
  const { allow, deny } = entries(rule);
  const matches = (entry: string): boolean => {
    if (entry === "*") return true;
    const name = entry.toLowerCase().replace(/\.$/, "");
    return want === name || want.endsWith(`.${name}`);
  };
  if (deny.some(matches)) return false;
  return allow.some(matches);
}

/** The address half. Named `addrAllowed`, not "public", because it is only what the rules say. */
export function addrAllowed(ip: string, rule: string[]): { ok: boolean; by?: string } {
  const { allow, deny } = entries(rule);
  const denied = deny.find((entry) => inCidr(ip, entry));
  if (denied !== undefined) return { ok: false, by: `!${denied}` };
  const allowed = allow.find((entry) => inCidr(ip, entry));
  return allowed === undefined ? { ok: false } : { ok: true, by: allowed };
}

export type Chain =
  | { kind: "http"; host: string; port: number; auth?: string }
  | { kind: "socks5"; host: string; port: number; auth?: { user: string; pass: string } };

/**
 * Where the daemon sends its own connections.
 *
 * `auto` follows the daemon's environment, because the machine that runs it may itself be
 * behind a proxy and the environment is where that fact usually lives. `off` is a decision,
 * not an absence: it means direct even when `HTTPS_PROXY` is set, which is what a leftover
 * systemd `Environment=` looks like otherwise. A URL overrides both.
 */
export function chainFrom(value: string): Chain | null {
  const wanted = value.trim();
  const raw =
    wanted === "" || wanted === "auto"
      ? (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? "")
      : wanted === "off"
        ? ""
        : wanted;
  if (raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const port = url.port === "" ? (url.protocol === "socks5:" || url.protocol === "socks5h:" ? 1080 : 80) : Number(url.port);
  if (url.hostname === "") return null;
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  if (url.protocol === "socks5:" || url.protocol === "socks5h:") {
    return { kind: "socks5", host: url.hostname, port, ...(user === "" ? {} : { auth: { user, pass } }) };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    const auth = user === "" ? undefined : `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    return { kind: "http", host: url.hostname, port, ...(auth === undefined ? {} : { auth }) };
  }
  return null;
}

/**
 * The address to connect to, or why not. Every answer has to pass the address rules: a name
 * that resolves to one allowed and one forbidden address is the shape of a rebinding
 * attack, and "one of them was fine" is not a defence.
 */
export async function resolveChecked(
  host: string,
  cidrs: string[],
): Promise<{ addr: string; by?: string } | { why: string }> {
  let found: string[];
  if (bytesOf(host) !== null) {
    found = [host];
  } else {
    try {
      found = (await lookup(host, { all: true })).map((a) => a.address);
    } catch (err) {
      return { why: `${host} 解析不了：${(err as Error).message}` };
    }
    if (found.length === 0) return { why: `${host} 没有地址` };
  }
  let by: string | undefined;
  for (const address of found) {
    const verdict = addrAllowed(address, cidrs);
    if (!verdict.ok) {
      return {
        why: `${host} 指向 ${address}${verdict.by === undefined ? "，不在 proxyAllowCidrs 里" : `，命中 ${verdict.by}`}`,
      };
    }
    by ??= verdict.by;
  }
  const addr = found[0] as string;
  return by === undefined ? { addr } : { addr, by };
}

export interface Decision {
  ok: boolean;
  why?: string;
}

export async function checkTarget(
  raw: string,
  rule: ProxyRule,
  skipAddressCheck = false,
): Promise<Decision & { host?: string; port?: number; addr?: string; by?: string }> {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(raw.trim());
  if (match === null) return { ok: false, why: `看不懂的目标：${raw}` };
  const host = match[1] as string;
  const port = Number(match[2]);
  if (!hostAllowed(host, rule.allow)) return { ok: false, why: `${host} 不在放行名单里`, host, port };
  if (skipAddressCheck) return { ok: true, host, port };
  const resolved = await resolveChecked(host, rule.cidrs);
  if ("why" in resolved) return { ok: false, why: resolved.why, host, port };
  return { ok: true, host, port, addr: resolved.addr, by: resolved.by };
}

/**
 * Answer `CONNECT host:port` — the request that carries every TLS connection a proxy ever
 * makes. Bytes are piped both ways afterwards; nothing here reads them.
 */
export async function handleConnect(
  raw: string,
  socket: Duplex,
  head: Buffer,
  rule: ProxyRule,
  log: (line: string) => void,
  chain: Chain | null = null,
  report: (ok: boolean, why?: string) => void = () => {},
): Promise<void> {
  // One connection is one line, whatever happens after it opens: `net=N` counts the places
  // a round went, so a tunnel that broke halfway must not be reported a second time as if
  // it had never opened.
  let reported = false;
  const once = (ok: boolean, why?: string): void => {
    if (reported) return;
    reported = true;
    report(ok, why);
  };
  // `checkTarget` resolves the name as part of the address check, so its `addr` is the
  // one that was vetted. Resolving again below would be a second lookup whose answer
  // nothing checks — the shape of a rebinding window.
  const decision = await checkTarget(raw, rule, chain !== null);
  if (!decision.ok || decision.host === undefined || decision.port === undefined) {
    const why = decision.why ?? "?";
    log(`proxy 拒绝 ${raw}：${why}`);
    once(false, why);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  if (chain !== null) {
    // The daemon lifts its own proxy's weight: the name check already ran, and resolving
    // here would fail on a host that has no DNS of its own.
    tunnel(socket, head, chain, { connect: raw, then: `${decision.host}:${decision.port}` }, log, once);
    return;
  }
  const upstream = tcpConnect(decision.port, decision.addr as string);
  // Attached before the connection can fail. It used to live inside the connect callback,
  // so a refused port emitted an 'error' with no listener — an uncaught exception that takes
  // the daemon down with the round it was serving.
  upstream.on("error", (err) => {
    log(`proxy ${raw} 连不上：${err.message}`);
    once(false, err.message);
    socket.destroy();
  });
  upstream.on("connect", () => {
    tunnelDone(socket, upstream, head, once, decision.by);
  });
}

/**
 * Open a connection — directly, or by asking the daemon's own proxy for a CONNECT first —
 * and hand the client's raw socket to it.
 */
function tunnelDone(
  socket: Duplex,
  upstream: import("node:net").Socket,
  head: Buffer,
  report: (ok: boolean, why?: string) => void,
  by?: string,
): void {
  // The socket's error handler is attached where the socket is created, not here: by the
  // time this runs a failure has already been reported once.
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  // "出去" means a connection exists, so it is said here and nowhere earlier: a chain
  // proxy that refused would otherwise be logged as a successful trip.
  report(true, by);
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) upstream.write(head);
  upstream.pipe(socket);
  socket.pipe(upstream);
}

function tunnel(
  socket: Duplex,
  head: Buffer,
  chain: Chain,
  o: { connect: string; then: string },
  log: (line: string) => void,
  report: (ok: boolean, why?: string) => void,
): void {
  const host = chain.host;
  const port = chain.port;
  const upstream = tcpConnect(port, host);
  if (chain.kind === "socks5") {
    socks5(upstream, socket, head, chain, o, log, report);
    return;
  }
  let ready = false;
  upstream.on("error", (err) => {
    log(`proxy ${o.connect} 连不上 ${host}:${port}：${err.message}`);
    report(false, err.message);
    socket.destroy();
  });
  upstream.on("data", function first(chunk: Buffer) {
    if (ready) return;
    const text = chunk.toString("latin1");
    if (!text.includes("\r\n\r\n")) return;
    upstream.removeListener("data", first);
    if (!/^HTTP\/1\.[01] 2\d\d/.test(text)) {
      const line = text.split("\r\n")[0] ?? "?";
      log(`proxy 上游拒绝了 ${o.then}：${line}`);
      report(false, `上游代理：${line}`);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy();
      return;
    }
    ready = true;
    // the upstream may have sent bytes of the tunnel in the same chunk
    const rest = chunk.subarray(text.indexOf("\r\n\r\n") + 4);
    tunnelDone(socket, upstream, head, report);
    if (rest.length > 0) upstream.unshift(rest);
  });
  upstream.on("connect", () => {
    const auth = chain.auth === undefined ? "" : `Proxy-Authorization: ${chain.auth}\r\n`;
    upstream.write(`CONNECT ${o.then} HTTP/1.1\r\nHost: ${o.then}\r\n${auth}\r\n`);
  });
}

/**
 * SOCKS5, because a proxy that is only spoken to as HTTP is half a proxy: the one on this
 * machine is SOCKS, and `ALL_PROXY=socks5://…` is how people write it.
 */
function socks5(
  upstream: import("node:net").Socket,
  socket: Duplex,
  head: Buffer,
  chain: Extract<Chain, { kind: "socks5" }>,
  o: { connect: string; then: string },
  log: (line: string) => void,
  report: (ok: boolean, why?: string) => void,
): void {
  const [host, portText] = o.then.split(":");
  const port = Number(portText);
  upstream.on("error", (err) => {
    log(`proxy ${o.connect} 连不上 ${chain.host}:${chain.port}：${err.message}`);
    report(false, err.message);
    socket.destroy();
  });
  upstream.on("connect", () => {
    upstream.write(chain.auth === undefined ? Buffer.from([5, 1, 0]) : Buffer.from([5, 1, 2]));
  });

  type Phase = "method" | "auth" | "connect";
  let phase: Phase = "method";
  let buffered = Buffer.alloc(0);

  const step = (): void => {
    if (phase === "method") {
      if (buffered.length < 2) return;
      const method = buffered[1];
      buffered = buffered.subarray(2);
      if (method === 0xff) {
        log("proxy 上游不接受我们的认证方式");
        report(false, "上游代理不接受认证方式");
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        upstream.destroy();
        return;
      }
      if (method === 2) {
        if (chain.auth === undefined) {
          socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          upstream.destroy();
          return;
        }
        const { user, pass } = chain.auth;
        upstream.write(Buffer.concat([Buffer.from([1, user.length]), Buffer.from(user), Buffer.from([pass.length]), Buffer.from(pass)]));
        phase = "auth";
        return;
      }
      phase = "connect";
      askConnect();
      return;
    }
    if (phase === "auth") {
      if (buffered.length < 2) return;
      const ok = buffered[1] === 0;
      buffered = buffered.subarray(2);
      if (!ok) {
        log("proxy 上游的 SOCKS 认证没过");
        report(false, "上游代理的 SOCKS 认证没过");
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        upstream.destroy();
        return;
      }
      phase = "connect";
      askConnect();
      return;
    }
    // connect reply: VER REP RSV ATYP BND.ADDR BND.PORT
    if (buffered.length < 4) return;
    const rep = buffered[1];
    const atyp = buffered[3];
    const addrLen = atyp === 1 ? 4 : atyp === 4 ? 16 : buffered.length >= 5 ? (buffered[4] as number) + 1 : 99;
    if (buffered.length < 4 + addrLen + 2) return;
    const rest = buffered.subarray(4 + addrLen + 2);
    upstream.removeAllListeners("data");
    if (rep !== 0) {
      log(`proxy 上游拒绝了 ${o.then}（SOCKS 应答 ${rep}）`);
      report(false, `上游代理：SOCKS 应答 ${rep}`);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy();
      return;
    }
    tunnelDone(socket, upstream, head, report);
    if (rest.length > 0) upstream.unshift(rest);
  };

  const askConnect = (): void => {
    if (host === undefined || !Number.isFinite(port)) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy();
      return;
    }
    const name = Buffer.from(host);
    upstream.write(
      Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]),
    );
  };

  upstream.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    step();
  });
}

/**
 * Plain HTTP through the proxy: the client sends `GET http://host/path HTTP/1.1`, and the
 * proxy makes the request. Most traffic is https and arrives as CONNECT, but an agent that
 * fetches an `http://` URL would otherwise get a 405 from the book router and no
 * explanation — a silent hole in the middle of a proxy that is supposed to be the only way
 * out.
 */
export async function forwardPlain(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  body: Buffer,
  rule: ProxyRule,
  chain: Chain | null,
  report: (ok: boolean, why?: string) => void,
): Promise<void> {
  const raw = req.url ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `看不懂的地址：${raw}` }));
    report(false, "看不懂的地址");
    return;
  }
  if (url.protocol !== "http:") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "只有 http:// 走这条路；https 用 CONNECT" }));
    report(false, "非 http 的绝对地址");
    return;
  }
  // A chain proxy that speaks HTTP wants the same absolute-form request, but piping a
  // response back through one is more machinery than this is worth: say it plainly.
  if (chain !== null) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "配了链式代理时不代理明文 HTTP：请用 https" }));
    report(false, "链式代理下的明文 HTTP");
    return;
  }
  const decision = await checkTarget(`${url.hostname}:${url.port === "" ? "80" : url.port}`, rule);
  if (!decision.ok) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: decision.why ?? "拒绝" }));
    report(false, decision.why);
    return;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (typeof value !== "string" || lower === "host" || lower === "connection" || lower === "content-length") continue;
    headers[lower] = value;
  }
  const upstream = await fetch(url.toString(), {
    method: req.method ?? "GET",
    headers,
    body: body.length === 0 ? undefined : new Uint8Array(body),
  });
  report(true, decision.by);
  const out: Record<string, string> = { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" };
  res.writeHead(upstream.status, out);
  if (upstream.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]), res);
}
