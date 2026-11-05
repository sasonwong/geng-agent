import { connect as tcpConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
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
  const clean = ip.replace(/%.+$/, "");
  const family = isIP(clean);
  if (family === 4) return { bytes: Buffer.from(clean.split(".").map(Number)), bits: 32 };
  if (family !== 6) return null;

  // isIP has already validated the spelling, including an optional dotted IPv4 tail.
  // Convert that tail to its two hexadecimal groups before expanding `::`.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(clean);
  const expandedInput = dotted === null
    ? clean
    : (() => {
        const v4 = bytesOf(dotted[1] as string)?.bytes as Buffer;
        const tail = `${v4.readUInt16BE(0).toString(16)}:${v4.readUInt16BE(2).toString(16)}`;
        return clean.slice(0, clean.length - (dotted[1] as string).length) + tail;
      })();
  const halves = expandedInput.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : (halves[1] as string).split(":");
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const bytes = Buffer.alloc(16);
  for (const [i, group] of groups.entries()) bytes.writeUInt16BE(Number.parseInt(group, 16), i * 2);
  return { bytes, bits: 128 };
}

/**
 * The IPv4 address inside an IPv4-mapped IPv6 address (`::ffff:0:0/96`).
 *
 * Only the mapped block: Linux connects `::ffff:a.b.c.d` to `a.b.c.d`, and does not do
 * that for the older IPv4-*compatible* form (`::a.b.c.d` keeps hanging in `connect`).
 * Treating compatible as mapped is not a harmless over-refusal — the compatible block is
 * `::/96`, so `::1` became `0.0.0.1` and passed a `cidrs: ["0.0.0.0/0"]` allow list,
 * which is the host's own loopback.
 */
function embeddedV4(ip: string): string | null {
  const parsed = bytesOf(ip);
  if (parsed === null || parsed.bits !== 128) return null;
  const b = parsed.bytes;
  if (!b.subarray(0, 10).every((n) => n === 0) || b[10] !== 0xff || b[11] !== 0xff) return null;
  return [...b.subarray(12)].join(".");
}

/** Whether this is syntactically an address or an address/prefix rule. */
export function validCidr(cidr: string): boolean {
  const [net, prefixText, extra] = cidr.split("/");
  if (extra !== undefined) return false;
  const parsed = bytesOf((net ?? "").replace(/^\[|\]$/g, ""));
  if (parsed === null) return false;
  if (prefixText === undefined) return true;
  const prefix = Number(prefixText);
  return /^\d+$/.test(prefixText) && Number.isInteger(prefix) && prefix >= 0 && prefix <= parsed.bits;
}

/** Does `ip` fall inside `cidr`? A bare address is its own /32 or /128. */
export function inCidr(ip: string, cidr: string): boolean {
  const [net, prefixText] = cidr.split("/");
  if (!validCidr(cidr)) return false;
  const a = bytesOf(ip.replace(/^\[|\]$/g, ""));
  const b = bytesOf((net ?? "").replace(/^\[|\]$/g, ""));
  if (a === null || b === null || a.bits !== b.bits) return false;
  const prefix = prefixText === undefined ? a.bits : Number(prefixText);
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
  // The kernel connects an IPv4-mapped literal to the embedded IPv4 address, so both
  // spellings are judged: checking only the 128-bit one lets `::ffff:127.0.0.1` sail past
  // `!127/8`, and checking only the embedded one lets a `!::ffff:0:0/96` deny be ignored.
  const addresses = [ip, ...(embeddedV4(ip) === null ? [] : [embeddedV4(ip) as string])];
  for (const address of addresses) {
    const denied = deny.find((entry) => inCidr(address, entry));
    if (denied !== undefined) return { ok: false, by: `!${denied}` };
  }
  for (const address of addresses) {
    const allowed = allow.find((entry) => inCidr(address, entry));
    if (allowed !== undefined) return { ok: true, by: allowed };
  }
  return { ok: false };
}

export type Chain =
  | { kind: "http" | "https"; host: string; port: number; auth?: string }
  | { kind: "socks5"; host: string; port: number; auth?: { user: string; pass: string } };

/**
 * Where the daemon sends its own connections.
 *
 * `auto` follows the daemon's environment, because the machine that runs it may itself be
 * behind a proxy and the environment is where that fact usually lives. `off` is a decision,
 * not an absence: it means direct even when `HTTPS_PROXY` is set, which is what a leftover
 * systemd `Environment=` looks like otherwise. A URL overrides both.
 */
/**
 * The port as written, because WHATWG URL silently drops an unparsable one and answers as
 * if the default had been asked for. `host:not-a-port` is a typo, not port 80.
 */
function writtenPort(raw: string): string | null {
  const withoutScheme = raw.slice(raw.indexOf("://") + 3);
  const authority = withoutScheme.replace(/[/?#].*$/, "");
  const atUser = authority.lastIndexOf("@");
  const hostPart = authority.slice(atUser === -1 ? 0 : atUser + 1);
  const afterHost = hostPart.startsWith("[") ? hostPart.slice(hostPart.indexOf("]") + 1) : hostPart;
  const at = afterHost.indexOf(":");
  return at === -1 ? null : afterHost.slice(at + 1);
}

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
  let user: string;
  let pass: string;
  try {
    url = new URL(raw);
    user = decodeURIComponent(url.username);
    pass = decodeURIComponent(url.password);
  } catch {
    return null;
  }
  const typed = writtenPort(raw);
  if (typed !== null && (!/^\d+$/.test(typed) || Number(typed) < 1 || Number(typed) > 65535)) return null;
  const port = url.port === ""
    ? (url.protocol === "socks5:" || url.protocol === "socks5h:" ? 1080 : url.protocol === "https:" ? 443 : 80)
    : Number(url.port);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (url.protocol === "socks5:" || url.protocol === "socks5h:") {
    return { kind: "socks5", host, port, ...(user === "" ? {} : { auth: { user, pass } }) };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    const auth = user === "" ? undefined : `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    return { kind: url.protocol === "https:" ? "https" : "http", host, port, ...(auth === undefined ? {} : { auth }) };
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
): Promise<Decision & { host?: string; port?: number; addr?: string; by?: string }> {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(raw.trim());
  if (match === null) return { ok: false, why: `看不懂的目标：${raw}` };
  const host = match[1] as string;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, why: `端口要是 1 到 65535：${raw}`, host, port };
  }
  if (!hostAllowed(host, rule.allow)) return { ok: false, why: `${host} 不在放行名单里`, host, port };
  // Both keys, always — including when the daemon itself goes through a chain. Skipping the
  // address half there made `!127.0.0.0/8` a decoration: the chain would happily CONNECT to
  // the loopback address the rule exists to refuse.
  const resolved = await resolveChecked(host, rule.cidrs);
  if ("why" in resolved) return { ok: false, why: resolved.why, host, port };
  return { ok: true, host, port, addr: resolved.addr, by: resolved.by };
}

/**
 * `host:port` where the host may be an IPv6 literal, so the separator is the *last* colon.
 * `o.then` is built as `${host}:${port}` and a literal host already contains colons.
 */
export function splitAuthority(authority: string): { host: string; port: number } | null {
  const at = authority.lastIndexOf(":");
  if (at <= 0) return null;
  const port = Number(authority.slice(at + 1));
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? { host: authority.slice(0, at), port }
    : null;
}

/**
 * The SOCKS5 CONNECT request, address type and all.
 *
 * A liter is sent as an address: some servers reject ATYP=domain for "127.0.0.1", and
 * sending what is already bytes through a resolver is how a name gets looked up twice.
 */
export function socksConnectBody(host: string, port: number): Buffer | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const literal = bytesOf(host);
  let head: Buffer;
  let address: Buffer;
  if (literal !== null) {
    head = Buffer.from([literal.bits === 32 ? 1 : 4]);
    address = literal.bytes;
  } else {
    const name = Buffer.from(host);
    if (name.length === 0 || name.length > 255) return null;
    head = Buffer.from([3, name.length]);
    address = name;
  }
  return Buffer.concat([Buffer.from([5, 1, 0]), head, address, Buffer.from([port >> 8, port & 0xff])]);
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
  // The client may disappear while DNS is still in flight. Without a listener from the
  // start, that ordinary reset is an uncaught `error` and takes the daemon down.
  socket.on("error", (err) => {
    log(`proxy ${raw} 的客户端断了：${err.message}`);
    once(false, err.message);
  });
  // `checkTarget` resolves the name as part of the address check, so its `addr` is the
  // one that was vetted. Resolving again below would be a second lookup whose answer
  // nothing checks — the shape of a rebinding window.
  const decision = await checkTarget(raw, rule);
  if (!decision.ok || decision.host === undefined || decision.port === undefined) {
    const why = decision.why ?? "?";
    log(`proxy 拒绝 ${raw}：${why}`);
    once(false, why);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  if (chain !== null) {
    // The name travelled in the CONNECT: the chain resolves it, so this side has to be the
    // one that says which address was vetted (`by`), or the log loses the rule that matched.
    tunnel(socket, head, chain, { connect: raw, then: `${decision.host}:${decision.port}` }, log, once, decision.by);
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
  // Both ends die together, and each end's failure is one event, not two: `report` is the
  // `once` from handleConnect, so an error that arrives after "出去" cannot be logged a
  // second time as if the tunnel had never opened.
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
  by?: string,
): void {
  const host = chain.host;
  const port = chain.port;
  const upstream = chain.kind === "https"
    ? tlsConnect({ host, port, servername: isIP(host) === 0 ? host : undefined })
    : tcpConnect(port, host);
  if (chain.kind === "socks5") {
    socks5(upstream, socket, head, chain, o, log, report, by);
    return;
  }
  let buffered = Buffer.alloc(0);
  upstream.on("error", (err) => {
    log(`proxy ${o.connect} 连不上 ${host}:${port}：${err.message}`);
    report(false, err.message);
    socket.destroy();
  });
  upstream.on("data", function first(chunk: Buffer) {
    // TCP does not preserve HTTP writes: a proxy's headers may arrive in any number of
    // chunks. Looking for the terminator in each chunk alone turns a valid tunnel into
    // a 502 (or a hang) depending on where the split happened.
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf("\r\n\r\n");
    if (end === -1) {
      if (buffered.length <= 16 * 1024) return;
      report(false, "上游代理的响应头太大");
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy();
      return;
    }
    upstream.removeListener("data", first);
    const text = buffered.subarray(0, end).toString("latin1");
    if (!/^HTTP\/1\.[01] 2\d\d/.test(text)) {
      const line = text.split("\r\n")[0] ?? "?";
      log(`proxy 上游拒绝了 ${o.then}：${line}`);
      report(false, `上游代理：${line}`);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy();
      return;
    }
    // the upstream may have sent bytes of the tunnel in the same chunk
    const rest = buffered.subarray(end + 4);
    tunnelDone(socket, upstream, head, report, by);
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
  by?: string,
): void {
  const target = splitAuthority(o.then);
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
          report(false, "上游代理要求认证，但没有配置账号");
          socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          upstream.destroy();
          return;
        }
        const user = Buffer.from(chain.auth.user);
        const pass = Buffer.from(chain.auth.pass);
        if (user.length === 0 || user.length > 255 || pass.length > 255) {
          report(false, "SOCKS 账号或密码超过 255 字节");
          socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          upstream.destroy();
          return;
        }
        upstream.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
        phase = "auth";
        return;
      }
      if (method !== 0) {
        report(false, `上游代理选了不支持的认证方式 ${String(method)}`);
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        upstream.destroy();
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
    tunnelDone(socket, upstream, head, report, by);
    if (rest.length > 0) upstream.unshift(rest);
  };

  const askConnect = (): void => {
    const body = target === null ? null : socksConnectBody(target.host, target.port);
    if (body === null) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy();
      return;
    }
    upstream.write(body);
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
  if (!decision.ok || decision.addr === undefined) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: decision.why ?? "拒绝" }));
    report(false, decision.why);
    return;
  }
  const headers: Record<string, string> = { host: url.host, connection: "close" };
  const hop = new Set(["host", "connection", "proxy-connection", "content-length", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization"]);
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (typeof value !== "string" || hop.has(lower)) continue;
    headers[lower] = value;
  }
  if (body.length > 0) headers["content-length"] = String(body.length);
  // Not `fetch`, for two reasons that are the whole point of this file.
  //
  // It resolves the name a second time: `checkTarget` above vetted one answer, and the
  // request would connect to whatever the second lookup returns — the rebinding window
  // `handleConnect` deliberately refuses to open. And it follows `Location:` by itself, so
  // one redirect from a public host reached any address at all: the rules were asked once,
  // about the first URL, and never again. A redirect now goes back to the client, whose next
  // request arrives here and is checked like any other.
  const upstream = await plainRequest(url, decision.addr, decision.port as number, req.method ?? "GET", headers, body);
  report(true, decision.by);
  // Everything but the hop-by-hop headers. A whitelist here lost `Location` on the first
  // redirect it tried to pass back — a 302 with no destination, which is a dead end rather
  // than a refusal. `content-encoding` is the other reason: the body below is byte for byte
  // what the server sent, so the client has to be told how to read it.
  const backHop = new Set([
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
    "te", "trailer", "transfer-encoding", "upgrade",
  ]);
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || backHop.has(name)) continue;
    out[name] = value;
  }
  if (out["content-type"] === undefined) out["content-type"] = "application/octet-stream";
  res.writeHead(upstream.statusCode ?? 502, out);
  await pipeline(upstream, res);
}

/** One request to the address that was checked, with the name only in the `Host` header. */
function plainRequest(
  url: URL,
  address: string,
  port: number,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<import("node:http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        method,
        // the vetted address, so a virtual host still works and a second lookup cannot
        // answer with something else
        host: address,
        port,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host },
      },
      resolve,
    );
    req.on("error", reject);
    req.end(body.length === 0 ? undefined : body);
  });
}
