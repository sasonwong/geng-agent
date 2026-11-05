import { connect as tcpConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
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
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const parts = [v4[1], v4[2], v4[3], v4[4]].map((x) => Number(x));
    if (parts.some((n) => n > 255)) return null;
    return { bytes: Buffer.from(parts as number[]), bits: 32 };
  }
  const clean = ip.replace(/%.*$/, "");
  if (isIP(clean) === 0) return null;
  // RFC 4291 §2.2.3 lets the last 32 bits be a dotted quad in *any* IPv6 spelling, not
  // only `::ffff:…`. `parseInt("127.0.0.1", 16)` stops at the first dot, so the fully
  // written `0:0:0:0:0:ffff:127.0.0.1` used to become a different 128-bit address — one
  // that matched `::/0` and none of the `!127.0.0.0/8` rules. Turn the tail into its two
  // hex groups before the `::` expansion, and let the mapped-address collapse below do
  // the rest.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(clean);
  let text = clean;
  if (dotted !== null) {
    const quad = bytesOf(dotted[1] as string);
    if (quad === null) return null;
    const b = quad.bytes;
    text = `${clean.slice(0, clean.length - (dotted[1] as string).length)}${b.readUInt16BE(0).toString(16)}:${b.readUInt16BE(2).toString(16)}`;
  }
  const [head, tail] = text.split("::");
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
  // The same mapping in the hex spelling (`::ffff:7f00:1`): ten zero bytes, then
  // 0xffff, then the four v4 bytes. It has to collapse here too or the dotted form
  // above is a rule with one spelling and a hole in the other.
  if (
    bytes.subarray(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return { bytes: Buffer.from(bytes.subarray(12)), bits: 32 };
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

/**
 * Whether this is an address or an address/prefix rule at all. `policy` needs this at
 * load time: a rule that can never match (a host name, a prefix wider than the family,
 * an IPv6 group that is not hex) is otherwise silent, and the operator reads "proxy
 * ignores my rule" instead of a config error.
 */
export function validCidr(cidr: string): boolean {
  const parts = cidr.split("/");
  if (parts.length > 2) return false;
  const parsed = bytesOf((parts[0] ?? "").replace(/^\[|\]$/g, ""));
  if (parsed === null) return false;
  if (parts[1] === undefined) return true;
  const prefix = Number(parts[1]);
  return /^\d+$/.test(parts[1]) && Number.isInteger(prefix) && prefix >= 0 && prefix <= parsed.bits;
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

/**
 * `bytesOf` collapses the mapped form (`::ffff:a.b.c.d`), but an IPv4-*compatible*
 * literal (`::127.0.0.1`) stays 128 bits, and Node connects it to the embedded IPv4
 * address. Without the second spelling every `!127.0.0.0/8` rule is blind to it.
 */
function embeddedV4(ip: string): string | null {
  const parsed = bytesOf(ip);
  if (parsed === null || parsed.bits !== 128) return null;
  if (!parsed.bytes.subarray(0, 12).every((b) => b === 0)) return null;
  return [...parsed.bytes.subarray(12)].join(".");
}

/** The address half. Named `addrAllowed`, not "public", because it is only what the rules say. */
export function addrAllowed(ip: string, rule: string[]): { ok: boolean; by?: string } {
  const { allow, deny } = entries(rule);
  const embedded = embeddedV4(ip);
  const forms = embedded === null ? [ip] : [ip, embedded];
  // An exclusion wins for whichever spelling it matches; an allow has to match one too.
  // Checking both is not a second chance to get in — it is the only way a v4 rule can
  // describe an address that will be connected as v4.
  for (const form of forms) {
    const denied = deny.find((entry) => inCidr(form, entry));
    if (denied !== undefined) return { ok: false, by: `!${denied}` };
  }
  for (const form of forms) {
    const allowed = allow.find((entry) => inCidr(form, entry));
    if (allowed !== undefined) return { ok: true, by: allowed };
  }
  return { ok: false };
}

export type Chain =
  | { kind: "http"; host: string; port: number; auth?: string; tls?: boolean }
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
 * The port as it was written. WHATWG `URL` silently drops a port it cannot parse and
 * answers as if the default had been asked for: `http://proxy.example:not-a-port` used
 * to become a perfectly valid chain to port 80, i.e. a proxy the operator configured
 * and a connection that ignored it.
 */
function writtenPort(raw: string): string | null {
  const authority = raw.slice(raw.indexOf("://") + 3).replace(/[/?#].*$/, "");
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
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const port =
    url.port === ""
      ? url.protocol === "socks5:" || url.protocol === "socks5h:"
        ? 1080
        : url.protocol === "https:"
          ? 443
          : 80
      : Number(url.port);
  const typed = writtenPort(raw);
  if (typed !== null && (!/^\d+$/.test(typed) || Number(typed) < 1 || Number(typed) > 65535)) return null;
  if (url.hostname === "" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  // A URL with a broken `%` escape is a config typo. `decodeURIComponent` throws on it,
  // and this getter runs on every proxied request — an uncaught throw there takes the
  // daemon down, not just the connection.
  let user = "";
  let pass = "";
  try {
    user = decodeURIComponent(url.username);
    pass = decodeURIComponent(url.password);
  } catch {
    return null;
  }
  if (url.protocol === "socks5:" || url.protocol === "socks5h:") {
    return { kind: "socks5", host: url.hostname, port, ...(user === "" ? {} : { auth: { user, pass } }) };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    const auth = user === "" ? undefined : `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    return {
      kind: "http",
      host: url.hostname,
      port,
      ...(auth === undefined ? {} : { auth }),
      // An `https://` upstream needs a TLS socket before the CONNECT line. Sending a
      // plaintext CONNECT to port 443 used to be the whole support for that spelling.
      ...(url.protocol === "https:" ? { tls: true } : {}),
    };
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
  // `net.connect` throws synchronously on a port outside 1..65535; from inside this
  // async function that is an unhandled rejection on the daemon's request handler.
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
  // An HTTP server removes its own error listener before emitting `connect`: from here
  // on the socket is ours. A client that gives up while DNS is still in flight
  // (`curl --max-time 5`, a round killed mid-handshake) would otherwise be an uncaught
  // exception that takes the daemon down. It has to be attached before the first await,
  // because the first await is the address check.
  socket.on("error", (err: Error) => {
    log(`proxy ${raw} 客户端那一头断了：${err.message}`);
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
  // The client left while the name was being resolved or the chain was handshaking. Its
  // 'close' has already fired, so the listener below will never run: without this the
  // upstream connection stays open for as long as the far end keeps it.
  if (socket.destroyed) {
    upstream.destroy();
    return;
  }
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
  by?: string,
): void {
  const host = chain.host;
  const port = chain.port;
  const upstream = chain.kind === "http" && chain.tls === true
    ? tlsConnect(port, host, { servername: host })
    : tcpConnect(port, host);
  if (chain.kind === "socks5") {
    socks5(upstream, socket, head, chain, o, log, report, by);
    return;
  }
  let ready = false;
  upstream.on("error", (err) => {
    log(`proxy ${o.connect} 连不上 ${host}:${port}：${err.message}`);
    report(false, err.message);
    socket.destroy();
  });
  // A CONNECT response is not guaranteed to arrive in one chunk. Reading each chunk on
  // its own and looking for `\r\n\r\n` there meant a header split across two reads was
  // silently dropped and the tunnel never opened. Accumulate until the terminator.
  let header = Buffer.alloc(0);
  upstream.on("data", function first(chunk: Buffer) {
    if (ready) return;
    header = Buffer.concat([header, chunk]);
    const at = header.indexOf("\r\n\r\n");
    if (at === -1) {
      if (header.length > 64 * 1024) {
        upstream.removeListener("data", first);
        log(`proxy 上游的 CONNECT 应答没有结束：${o.then}`);
        report(false, "上游代理的 CONNECT 应答没有结束");
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        upstream.destroy();
      }
      return;
    }
    upstream.removeListener("data", first);
    const text = header.subarray(0, at + 4).toString("latin1");
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
    const rest = header.subarray(at + 4);
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
          // A refusal has to be reported like every other refusal: without this the
          // round says net=0 and the log has a dead tunnel with no line explaining it.
          log("proxy 上游要 SOCKS 认证，但没配用户名口令");
          report(false, "上游代理要 SOCKS 认证，但没配用户名口令");
          socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          upstream.destroy();
          return;
        }
        const user = Buffer.from(chain.auth.user);
        const pass = Buffer.from(chain.auth.pass);
        // RFC 1929 puts each length in one byte; a JS `.length` counts UTF-16 units,
        // and a longer name silently wraps into a frame the server reads as garbage.
        if (user.length === 0 || user.length > 255 || pass.length > 255) {
          log("proxy 上游要 SOCKS 认证，但账号或口令的字节数不合法");
          report(false, "SOCKS 账号或口令的字节数不合法");
          socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          upstream.destroy();
          return;
        }
        upstream.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
        phase = "auth";
        return;
      }
      // 0xff was handled above; 1 (GSSAPI) and every other value is a method we never
      // offered. Falling through to "no auth" would send a CONNECT into a handshake the
      // server is still waiting to finish.
      if (method !== 0) {
        log(`proxy 上游选了不支持的认证方式 ${String(method)}`);
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
      log(`proxy 上游的目标写不成 SOCKS 请求：${o.then}`);
      report(false, "上游目标写不成 SOCKS 请求");
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
/** Headers that describe this hop, not the request. Passing them on corrupts framing. */
const HOP_BY_HOP = new Set([
  "host", "connection", "content-length", "transfer-encoding", "proxy-authorization",
  "proxy-authenticate", "proxy-connection", "keep-alive", "te", "trailer", "upgrade",
]);

export async function forwardPlain(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  rule: ProxyRule,
  chain: Chain | null,
  report: (ok: boolean, why?: string) => void,
): Promise<void> {
  // One connection is one line in net.log, including a connection that broke halfway.
  let reported = false;
  const once = (ok: boolean, why?: string): void => {
    if (reported) return;
    reported = true;
    report(ok, why);
  };
  const raw = req.url ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `看不懂的地址：${raw}` }));
    once(false, "看不懂的地址");
    return;
  }
  if (url.protocol !== "http:") {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "只有 http:// 走这条路；https 用 CONNECT" }));
    once(false, "非 http 的绝对地址");
    return;
  }
  // A chain proxy that speaks HTTP wants the same absolute-form request, but piping a
  // response back through one is more machinery than this is worth: say it plainly.
  if (chain !== null) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "配了链式代理时不代理明文 HTTP：请用 https" }));
    once(false, "链式代理下的明文 HTTP");
    return;
  }
  const decision = await checkTarget(`${url.hostname}:${url.port === "" ? "80" : url.port}`, rule);
  if (!decision.ok) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: decision.why ?? "拒绝" }));
    once(false, decision.why);
    return;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (typeof value !== "string" || HOP_BY_HOP.has(lower)) continue;
    headers[lower] = value;
  }
  // The socket goes to the address that was vetted; the Host header keeps the name the
  // server expects. `fetch(url)` resolved the name a *second* time (a rebinding window)
  // and followed a 302 on its own — straight to an address no rule had ever looked at.
  // Node's http.request follows no redirect: the client's next request is a new proxy
  // request, so it passes through checkTarget again.
  headers.host = url.host;
  if (body.length > 0) headers["content-length"] = String(body.length);

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (why: string): void => {
      once(false, why);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `代理请求失败：${why}` }));
      } else {
        res.destroy();
      }
      done();
    };
    const upstream = httpRequest(
      {
        hostname: decision.addr as string,
        port: decision.port,
        path: `${url.pathname}${url.search}`,
        method: req.method ?? "GET",
        headers,
        agent: false,
      },
      (answer) => {
        once(true, decision.by);
        const type = answer.headers["content-type"];
        res.writeHead(answer.statusCode ?? 502, {
          "content-type": Array.isArray(type)
            ? (type[0] ?? "application/octet-stream")
            : (type ?? "application/octet-stream"),
        });
        pipeline(answer, res).then(done, () => done());
      },
    );
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("上游 30 秒没有应答")));
    upstream.on("error", (err: Error) => fail(err.message));
    if (body.length > 0) upstream.write(body);
    upstream.end();
  });
}
