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
  if (allow.includes("*")) return true;
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

export type Chain =
  | { kind: "http"; host: string; port: number; auth?: string }
  | { kind: "socks5"; host: string; port: number; auth?: { user: string; pass: string } };

/**
 * Where the daemon sends its own connections.
 *
 * `auto` follows the daemon's environment, because the machine that runs it may itself be
 * behind a proxy and the environment is where that fact usually lives. `off` is a
 * decision, not an absence: it means direct even when `HTTPS_PROXY` is set, which is what
 * a leftover systemd `Environment=` looks like otherwise. A URL overrides both.
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
  chain: Chain | null = null,
  report: (ok: boolean, why?: string) => void = () => {},
): Promise<void> {
  const decision = await checkTarget(raw, rule, chain !== null);
  if (!decision.ok || decision.host === undefined || decision.port === undefined) {
    const why = decision.why ?? "?";
    log(`proxy 拒绝 ${raw}：${why}`);
    report(false, why);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  report(true);
  if (chain !== null) {
    // The daemon lifts its own proxy's weight: the name check already ran, and resolving
    // here would fail on a host that has no DNS of its own.
    tunnel(socket, head, chain, { connect: raw, then: `${decision.host}:${decision.port}` }, log);
    return;
  }
  const resolved = await resolvePublic(decision.host);
  if ("why" in resolved) {
    log(`proxy 拒绝 ${raw}：${resolved.why}`);
    report(false, resolved.why);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  report(true);
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
  chain: Chain,
  o: { connect: string; then: string },
  log: (line: string) => void,
): void {
  const host = chain.host;
  const port = chain.port;
  const upstream = tcpConnect(port, host);
  if (chain.kind === "socks5") {
    socks5(upstream, socket, head, chain, o, log);
    return;
  }
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
): void {
  const [host, portText] = o.then.split(":");
  const port = Number(portText);
  upstream.on("error", (err) => {
    log(`proxy ${o.connect} 连不上 ${chain.host}:${chain.port}：${err.message}`);
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
        log(`proxy 上游不接受我们的认证方式`),
          socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"),
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
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      upstream.destroy();
      return;
    }
    tunnelDone(socket, upstream, head, log, o.connect);
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
