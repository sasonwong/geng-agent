import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { readEnvFile } from "./secret.ts";
import { ensureGatewayDirs } from "./mute.ts";
import { readJson, writeJson } from "./fs.ts";

/**
 * The search key must not live in the container, so the container only gets a socket
 * path. Quota is enforced here, where the agent can't edit the counter.
 *
 * A unix socket rather than a port on the bridge: a port is reachable by anything on
 * the network, and needed an exception in a firewall to be usable at all. The
 * socket needs neither an exception nor a token — the filesystem already says who may
 * connect, and a second copy of a secret in the container's environment protects nothing.
 */
export interface SearchEnv {
  apiKey: string;
  socket: string;
  dailyLimit: number;
}

/**
 * Where the socket lives when nobody says otherwise.
 *
 * `RuntimeDirectory=geng` is created by the **user** manager under `$XDG_RUNTIME_DIR`
 * (normally `/run/user/<uid>/geng`), not at `/run/geng` — that is where a *system* unit
 * would put it. Every unit in deploy/ is a user unit and update.sh restarts them with
 * `systemctl --user`, so hard-coding `/run/geng` made the service listen on a path that
 * did not exist and that a non-root process could not create. The daemon reads the same
 * variable, so the two sides agree on the socket without copying a uid into config.
 */
export function defaultSearchSocket(): string {
  const runtime = process.env.XDG_RUNTIME_DIR ?? "";
  return join(runtime === "" ? "/run" : runtime, "geng", "search.sock");
}

/**
 * A line like `GENG_SEARCH_DAILY=` carries no number, and `Number("")` is 0 — which the
 * quota then reads as "no searches today", silently, forever. An empty value means the
 * file does not carry that key: fall through to the environment, then to the default.
 *
 * A trailing note goes too: `EnvironmentFile=` hands the whole line over as the value,
 * and an operator who adds `# 少搜点` after the number did not mean to lower the quota.
 * A number that stops being a number falls back *silently*, so this is the one reading
 * worth being tolerant about; a mangled GENG_SEARCH_SOCKET fails loudly at listen time.
 */
function limitOf(file: Record<string, string>, key: string, fallback: number): number {
  for (const raw of [file[key], process.env[key]]) {
    if (raw === undefined) continue;
    const text = raw.replace(/\s+#.*$/, "").trim();
    if (text === "") continue;
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * The file first, the environment second.
 *
 * `geng-search.service` loads the same file with `EnvironmentFile=`, which freezes its
 * contents at start: reading `process.env` first made a quota edit a no-op. The
 * environment is only the fallback for a value the file does not carry.
 *
 * There is no longer a token here. Authorization was never the token's job: the socket is
 * the boundary (`0600`, and the directory above it), and a copy of a secret in the
 * container's environment was just something else to leak — the same reason the model key
 * and the GitHub token moved out.
 */
export function readSearchEnv(root: string): SearchEnv | null {
  const file = readEnvFile(join(root, "secrets", "search.env"));
  const apiKey = file.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (apiKey === "") return null;
  const bind = file.GENG_SEARCH_SOCKET ?? process.env.GENG_SEARCH_SOCKET ?? defaultSearchSocket();
  return {
    apiKey,
    socket: bind,
    dailyLimit: limitOf(file, "GENG_SEARCH_DAILY", 200),
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Quota {
  day?: string;
  count?: number;
  /** Written by the running server: the limit it is actually enforcing. */
  limit?: number;
}

const UPSTREAM = "https://api.deepseek.com/v1/tools";

/**
 * The endpoint this instance may use, or null.
 *
 * Two things have to be true together: the host endpoint is configured and its socket
 * exists. If either is missing the tool is simply not there — and the page must not
 * promise a quota it cannot spend.
 */
export function searchReady(root: string): SearchEnv | null {
  const host = readSearchEnv(root);
  if (host === null || !existsSync(host.socket)) return null;
  return host;
}

/** Whether *this container* has the tool. One predicate, so the page and the daemon
 * cannot disagree about it. */
export function searchConfigured(root: string): boolean {
  return searchReady(root) !== null;
}

/** How much searching is left today — the agent has to know to weigh it. */
export function searchQuota(root: string): { limit: number; left: number } | null {
  if (searchReady(root) === null) return null;
  const file = readEnvFile(join(root, "secrets", "search.env"));
  const q = readJson<Quota>(join(root, "data", "_ops", "usage", "search.json"), {});
  const limit = q.limit ?? limitOf(file, "GENG_SEARCH_DAILY", 200);
  const used = q.day === today() ? (q.count ?? 0) : 0;
  return { limit, left: Math.max(0, limit - used) };
}

export interface SearchServerOptions {
  root: string;
  env: SearchEnv;
  log?: (line: string) => void;
}

export function startSearchServer(o: SearchServerOptions): Promise<Server> {
  const { ops } = ensureGatewayDirs(o.root);
  const quotaFile = join(ops, "usage", "search.json");
  const log = o.log ?? ((line: string) => process.stdout.write(line + "\n"));

  // The limit this process enforces, written down so the packet reports the same
  // number the server actually applies — restarting used to be what made a new limit
  // real; now secrets/search.env is re-read per request (see refresh below).
  writeJson(quotaFile, { ...readJson<Quota>(quotaFile, {}), limit: o.env.dailyLimit });

  // The env is the operator's knob and nothing here outlives a request, so it is re-read
  // on every one: a quota change then needs no restart. Only bind is fixed, at
  // listen time, and saying so is cheaper than pretending it reloaded.
  let env = o.env;
  let socketWarned = false;
  const refresh = (): void => {
    const next = readSearchEnv(o.root);
    if (next === null) return; // half a config is a typo: keep serving with the old one
    if (next.socket !== env.socket) {
      if (!socketWarned) {
        log(`search.env 的 socket 变了，要重启才换；继续听 ${env.socket}`);
        socketWarned = true;
      }
    } else {
      socketWarned = false;
    }
    const changed = next.apiKey !== env.apiKey || next.dailyLimit !== env.dailyLimit;
    env = { ...next, socket: env.socket };
    if (!changed) return;
    const q = readJson<Quota>(quotaFile, {});
    if (q.limit !== env.dailyLimit) writeJson(quotaFile, { ...q, limit: env.dailyLimit });
    log(`search.env 重读了：每天 ${env.dailyLimit} 次`);
  };

  // Two halves, because a failed call costs nothing and used to cost a search: a wrong
  // key burned the whole day's quota in one round, and the quota is the only limit here.
  const allowance = (): { ok: boolean; remaining: number } => {
    const q = readJson<Quota>(quotaFile, {});
    const count = q.day === today() ? (q.count ?? 0) : 0;
    const left = Math.max(0, env.dailyLimit - count);
    return left === 0 ? { ok: false, remaining: 0 } : { ok: true, remaining: left };
  };

  /** Charge one search. Only called for an answer that actually came back. */
  const charge = (): number => {
    const q = readJson<Quota>(quotaFile, {});
    const count = q.day === today() ? (q.count ?? 0) : 0;
    const next = count + 1;
    writeJson(quotaFile, { day: today(), count: next, limit: env.dailyLimit });
    return Math.max(0, env.dailyLimit - next);
  };

  const remaining = (): number => {
    const q = readJson<Quota>(quotaFile, {});
    return Math.max(0, env.dailyLimit - (q.day === today() ? (q.count ?? 0) : 0));
  };

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    };

    refresh();
    if (req.method !== "POST") return send(405, { error: "POST only" });
    // Reachable is authorized: the socket is the boundary, and asking for a token as well
    // would only add a second place for the same secret to live.

    const operation = req.url === "/fetch" ? "fetch" : req.url === "/search" ? "search" : null;
    if (operation === null) return send(404, { error: "unknown path" });

    let body = "";
    let over = false;
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      if (over) return; // drain the rest; do not parse a truncated body
      body += c;
      if (body.length > 64 * 1024) over = true;
    });
    req.on("end", () => {
      // destroy() closes the socket under the answer, and leaves the client with a
      // connection reset instead of a reason. Answer once, on a whole stream.
      if (over) return send(413, { error: "请求体太大" });
      let params: Record<string, unknown>;
      try {
        params = JSON.parse(body || "{}");
      } catch {
        return send(400, { error: "bad json" });
      }
      const allowed =
        operation === "search"
          ? ["query", "count", "need_content", "ori_question", "localization"]
          : ["url"];
      const forwarded: Record<string, unknown> = {};
      for (const key of allowed) {
        if (params[key] !== undefined) forwarded[key] = params[key];
      }

      const gate = allowance();
      if (!gate.ok) {
        return send(200, { error: "今天的搜索用完了", remaining: 0 });
      }

      void (async () => {
        try {
          const response = await fetch(`${UPSTREAM}/${operation}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(forwarded),
            signal: AbortSignal.timeout(60_000),
          });
          const text = await response.text();
          if (!response.ok) {
            log(`${operation} 上游 ${response.status}: ${text.slice(0, 200)}`);
            return send(502, { error: `上游 ${response.status}`, remaining: remaining() });
          }
          // Everything that can throw happens before the headers go out. A malformed
          // upstream answer used to throw inside res.end() after writeHead(200), and
          // the catch then called writeHead(502) on an already-sent response — an
          // ERR_HTTP_HEADERS_SENT in a fire-and-forget promise, with nobody to catch it.
          const payload = JSON.stringify({ data: JSON.parse(text), remaining: charge() });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(payload);
        } catch (err) {
          log(`${operation} 出错：${(err as Error).message}`);
          if (res.headersSent) {
            res.destroy();
            return;
          }
          send(502, { error: (err as Error).message, remaining: remaining() });
        }
      })();
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // RuntimeDirectory=geng is a systemd favour: the directory exists for the unit,
    // but `node cmd/geng/index.ts search` (documented in docs/install.md §5.2) has no
    // manager to make it. listen() does not create parent directories, so a foreground
    // run used to die with ENOENT before it ever served a request.
    mkdirSync(dirname(env.socket), { recursive: true, mode: 0o700 });
    // A socket left by an earlier run is a corpse that refuses connections, and the
    // error looks exactly like "the service is down" — remove it before binding.
    rmSync(env.socket, { force: true });
    server.listen(env.socket, () => {
      // 0600: the directory is what keeps other users out, but an instance runs as the
      // same uid as this service, so the mode is not the boundary — it is the reminder.
      try {
        chmodSync(env.socket, 0o600);
      } catch {
        // a filesystem that does not support it is not a reason to stop serving
      }
      log(`search 端点 ${env.socket}（每天 ${env.dailyLimit} 次）`);
      resolve(server);
    });
  });
}
