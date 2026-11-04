import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile } from "./secret.ts";
import { ensureGatewayDirs } from "./mute.ts";
import { readJson, readText, writeJson } from "./fs.ts";

/**
 * The search key must not live in the container, so the container only gets a socket
 * path and a token that can do nothing but search. Quota is enforced here, where the
 * agent can't edit the counter.
 *
 * A unix socket rather than a port on the bridge: a port is reachable by anything on
 * the network, which is why it needed both a token and an exception in the egress rules.
 * The socket needs neither — the filesystem already says who may connect.
 */
export interface SearchEnv {
  token: string;
  apiKey: string;
  socket: string;
  dailyLimit: number;
}

/** Where the socket lives when nobody says otherwise: `RuntimeDirectory=geng` owns it. */
export const DEFAULT_SEARCH_SOCKET = "/run/geng/search.sock";

/**
 * A line like `GENG_SEARCH_DAILY=` carries no number, and `Number("")` is 0 — which the
 * quota then reads as "no searches today", silently, forever. An empty value means the
 * file does not carry that key: fall through to the environment, then to the default.
 *
 * A trailing note goes too: `docs/install.md` itself writes `GENG_SEARCH_DAILY=200   # 改
 * 了不用重启`, and `EnvironmentFile=` hands that whole line over as the value. A number
 * that stops being a number falls back *silently*, so this is the one reading worth being
 * tolerant about; a mangled GENG_SEARCH_SOCKET fails loudly at listen time instead.
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
 * contents at start: reading `process.env` first made a token rotation invisible (the old
 * token stayed valid forever) and a quota edit a no-op. The environment is only the
 * fallback for a value the file does not carry.
 */
export function readSearchEnv(root: string): SearchEnv | null {
  const file = readEnvFile(join(root, "secrets", "search.env"));
  const token = file.GENG_SEARCH_TOKEN ?? process.env.GENG_SEARCH_TOKEN ?? "";
  const apiKey = file.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
  if (token === "" || apiKey === "") return null;
  const bind = file.GENG_SEARCH_SOCKET ?? process.env.GENG_SEARCH_SOCKET ?? DEFAULT_SEARCH_SOCKET;
  return {
    token,
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
 * Three halves have to be true together: the host endpoint is configured, its socket
 * exists, and the instance env carries the token. Any one missing and the tool is simply
 * not there — and the page must not promise a quota it cannot spend.
 */
export function searchReady(root: string, instanceEnvFile: string): SearchEnv | null {
  const host = readSearchEnv(root);
  if (host === null || !existsSync(host.socket)) return null;
  if ((readEnvFile(instanceEnvFile).GENG_SEARCH_TOKEN ?? "") === "") return null;
  return host;
}

/** Whether *this container* has the tool. One predicate, so the page and the daemon
 * cannot disagree about it. */
export function searchConfigured(root: string, instanceEnvFile: string): boolean {
  return searchReady(root, instanceEnvFile) !== null;
}

/** How much searching is left today — the agent has to know to weigh it. */
export function searchQuota(root: string, instanceEnvFile: string): { limit: number; left: number } | null {
  if (searchReady(root, instanceEnvFile) === null) return null;
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
  // on every one: a quota or token change then needs no restart. Only bind is fixed, at
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
    const changed =
      next.token !== env.token || next.apiKey !== env.apiKey || next.dailyLimit !== env.dailyLimit;
    env = { ...next, socket: env.socket };
    if (!changed) return;
    const q = readJson<Quota>(quotaFile, {});
    if (q.limit !== env.dailyLimit) writeJson(quotaFile, { ...q, limit: env.dailyLimit });
    log(`search.env 重读了：每天 ${env.dailyLimit} 次`);
  };

  const spend = (): { ok: boolean; remaining: number } => {
    const q = readJson<Quota>(quotaFile, {});
    const count = q.day === today() ? (q.count ?? 0) : 0;
    if (count >= env.dailyLimit) return { ok: false, remaining: 0 };
    writeJson(quotaFile, { day: today(), count: count + 1, limit: env.dailyLimit });
    return { ok: true, remaining: env.dailyLimit - count - 1 };
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
    if (req.headers["x-geng-token"] !== env.token) return send(401, { error: "bad token" });

    const operation = req.url === "/fetch" ? "fetch" : req.url === "/search" ? "search" : null;
    if (operation === null) return send(404, { error: "unknown path" });

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on("end", () => {
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

      const gate = spend();
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
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: JSON.parse(text), remaining: remaining() }));
        } catch (err) {
          log(`${operation} 出错：${(err as Error).message}`);
          send(502, { error: (err as Error).message, remaining: remaining() });
        }
      })();
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
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
