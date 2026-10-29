import { createServer } from "node:http";
import { join } from "node:path";
import { readEnvFile } from "./secret.ts";
import { ensureGatewayDirs } from "./mute.ts";
import { readJson, readText, writeJson } from "./state.ts";

/**
 * The search key must not live in the container, so the container only gets a URL
 * and a token that can do nothing but search. Quota is enforced here, where the
 * agent can't edit the counter.
 */
export interface SearchEnv {
  token: string;
  apiKey: string;
  bind: { host: string; port: number };
  dailyLimit: number;
}

export function readSearchEnv(root: string): SearchEnv | null {
  const file = readEnvFile(join(root, "secrets", "search.env"));
  const token = process.env.GENG_SEARCH_TOKEN ?? file.GENG_SEARCH_TOKEN ?? "";
  const apiKey = process.env.DEEPSEEK_API_KEY ?? file.DEEPSEEK_API_KEY ?? "";
  if (token === "" || apiKey === "") return null;
  const bind = process.env.GENG_SEARCH_BIND ?? file.GENG_SEARCH_BIND ?? "0.0.0.0:8787";
  const [host, port] = bind.split(":");
  return {
    token,
    apiKey,
    bind: { host: host || "0.0.0.0", port: Number(port ?? 8787) },
    dailyLimit: Number(process.env.GENG_SEARCH_DAILY ?? file.GENG_SEARCH_DAILY ?? 200),
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
 * Whether *this container* has the tool: the extension only registers when the
 * instance env carries a URL. The host having a search.env means nothing to it.
 */
export function searchConfigured(instanceEnvFile: string): boolean {
  return (readEnvFile(instanceEnvFile).GENG_SEARCH_URL ?? "") !== "";
}

/** How much searching is left today — the agent has to know to weigh it. */
export function searchQuota(root: string, instanceEnvFile: string): { limit: number; left: number } | null {
  if (!searchConfigured(instanceEnvFile)) return null;
  const file = readEnvFile(join(root, "secrets", "search.env"));
  const q = readJson<Quota>(join(root, "data", "_ops", "usage", "search.json"), {});
  const limit = q.limit ?? Number(process.env.GENG_SEARCH_DAILY ?? file.GENG_SEARCH_DAILY ?? 200);
  const used = q.day === today() ? (q.count ?? 0) : 0;
  return { limit, left: Math.max(0, limit - used) };
}

export interface SearchServerOptions {
  root: string;
  env: SearchEnv;
  log?: (line: string) => void;
}

export function startSearchServer(o: SearchServerOptions): Promise<{ close: () => void }> {
  const { ops } = ensureGatewayDirs(o.root);
  const quotaFile = join(ops, "usage", "search.json");
  const log = o.log ?? ((line: string) => process.stdout.write(line + "\n"));

  // The limit this process enforces, written down so the packet reports the same
  // number the server actually applies — restarting is what makes a new limit real.
  writeJson(quotaFile, { ...readJson<Quota>(quotaFile, {}), limit: o.env.dailyLimit });

  const spend = (): { ok: boolean; remaining: number } => {
    const q = readJson<Quota>(quotaFile, {});
    const count = q.day === today() ? (q.count ?? 0) : 0;
    if (count >= o.env.dailyLimit) return { ok: false, remaining: 0 };
    writeJson(quotaFile, { day: today(), count: count + 1, limit: o.env.dailyLimit });
    return { ok: true, remaining: o.env.dailyLimit - count - 1 };
  };

  const remaining = (): number => {
    const q = readJson<Quota>(quotaFile, {});
    return Math.max(0, o.env.dailyLimit - (q.day === today() ? (q.count ?? 0) : 0));
  };

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    };

    if (req.method !== "POST") return send(405, { error: "POST only" });
    if (req.headers["x-geng-token"] !== o.env.token) return send(401, { error: "bad token" });

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
              authorization: `Bearer ${o.env.apiKey}`,
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
    server.listen(o.env.bind.port, o.env.bind.host, () => {
      log(`search 端点 ${o.env.bind.host}:${o.env.bind.port}（每天 ${o.env.dailyLimit} 次）`);
      resolve({ close: () => server.close() });
    });
  });
}
