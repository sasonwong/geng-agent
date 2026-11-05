import { connect as tcpConnect } from "node:net";
import { lookup } from "node:dns/promises";
import type { Duplex } from "node:stream";

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
  /** Host names it may reach, matched as itself or as a suffix of `.name`. */
  allow: string[];
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function isPublicAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::" || low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) {
      return false;
    }
    // an IPv4-mapped address is the v4 check again
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
    return mapped ? isPublicAddress(mapped[1] as string) : true;
  }
  return !PRIVATE_V4.some((re) => re.test(ip));
}

/** `github.com` allows itself and `codeload.github.com`, never `evil-github.com`. */
export function hostAllowed(host: string, allow: string[]): boolean {
  const want = host.toLowerCase().replace(/\.$/, "");
  return allow.some((raw) => {
    const entry = raw.toLowerCase().replace(/\.$/, "");
    return want === entry || want.endsWith(`.${entry}`);
  });
}

/** The address to connect to, or the reason not to. */
export async function resolvePublic(host: string): Promise<{ addr: string } | { why: string }> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    return isPublicAddress(host) ? { addr: host } : { why: `${host} 不是公网地址` };
  }
  let found: { address: string }[];
  try {
    found = await lookup(host, { all: true });
  } catch (err) {
    return { why: `${host} 解析不了：${(err as Error).message}` };
  }
  if (found.length === 0) return { why: `${host} 没有地址` };
  // every address it resolves to has to be public: one private answer is enough to say no
  const bad = found.find((a) => !isPublicAddress(a.address));
  if (bad) return { why: `${host} 指向 ${bad.address}` };
  return { addr: (found[0] as { address: string }).address };
}

/**
 * Where the daemon itself sends its connections. On a machine with direct internet this is
 * unset and the proxy connects itself; behind one, the chain is the daemon's own env — the
 * container should not have to know which world the host lives in.
 */
export function chainProxy(): { host: string; port: number } | null {
  const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? "";
  if (raw.trim() === "") return null;
  try {
    const url = new URL(raw);
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    return url.hostname === "" ? null : { host: url.hostname, port };
  } catch {
    return null;
  }
}

export interface Decision {
  ok: boolean;
  why?: string;
}

export async function checkTarget(
  raw: string,
  rule: ProxyRule,
  skipAddressCheck = false,
): Promise<Decision & { host?: string; port?: number }> {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(raw.trim());
  if (match === null) return { ok: false, why: `看不懂的目标：${raw}` };
  const host = match[1] as string;
  const port = Number(match[2]);
  if (!hostAllowed(host, rule.allow)) return { ok: false, why: `${host} 不在放行名单里`, host, port };
  if (skipAddressCheck) return { ok: true, host, port };
  const resolved = await resolvePublic(host);
  if ("why" in resolved) return { ok: false, why: resolved.why, host, port };
  return { ok: true, host, port };
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
): Promise<void> {
  const decision = await checkTarget(raw, rule, chainProxy() !== null);
  if (!decision.ok || decision.host === undefined || decision.port === undefined) {
    log(`proxy 拒绝 ${raw}：${decision.why ?? "?"}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const chain = chainProxy();
  if (chain !== null) {
    // The daemon lifts its own proxy's weight: the name check already ran, and resolving
    // here would fail on a host that has no DNS of its own.
    tunnel(socket, head, chain.host, chain.port, { connect: raw, then: `${decision.host}:${decision.port}` }, log);
    return;
  }
  const resolved = await resolvePublic(decision.host);
  if ("why" in resolved) {
    log(`proxy 拒绝 ${raw}：${resolved.why}`);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  const upstream = tcpConnect(decision.port, resolved.addr, () => {
    tunnelDone(socket, upstream, head, log, raw);
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
  log: (line: string) => void,
  label: string,
): void {
  upstream.on("error", (err) => {
    log(`proxy ${label} 连不上：${err.message}`);
    socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) upstream.write(head);
  upstream.pipe(socket);
  socket.pipe(upstream);
}

function tunnel(
  socket: Duplex,
  head: Buffer,
  host: string,
  port: number,
  o: { connect: string; then: string },
  log: (line: string) => void,
): void {
  const upstream = tcpConnect(port, host);
  let ready = false;
  upstream.on("error", (err) => {
    log(`proxy ${o.connect} 连不上 ${host}:${port}：${err.message}`);
    socket.destroy();
  });
  upstream.on("data", function first(chunk: Buffer) {
    if (ready) return;
    const text = chunk.toString("latin1");
    if (!text.includes("\r\n\r\n")) return;
    upstream.removeListener("data", first);
    if (!/^HTTP\/1\.[01] 2\d\d/.test(text)) {
      log(`proxy 上游拒绝了 ${o.then}：${text.split("\r\n")[0] ?? "?"}`);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy();
      return;
    }
    ready = true;
    // the upstream may have sent bytes of the tunnel in the same chunk
    const rest = chunk.subarray(text.indexOf("\r\n\r\n") + 4);
    tunnelDone(socket, upstream, head, log, o.connect);
    if (rest.length > 0) upstream.unshift(rest);
  });
  upstream.on("connect", () => {
    upstream.write(`CONNECT ${o.then} HTTP/1.1\r\nHost: ${o.then}\r\n\r\n`);
  });
}
