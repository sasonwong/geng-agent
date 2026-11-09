import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Paths } from "./paths.ts";
import { readChain, readModelKey, modelUpstream, readNamedModelKey, readProviders, type ModelChainEntry } from "./model.ts";

/**
 * The model proxy: the container talks to the daemon, the daemon talks to the provider.
 *
 * This is the whole point of not handing the key out. `/model/key` moved the key out of
 * `env`, but anything the container can fetch, its `bash` can fetch too. A proxy leaves
 * the key on the host: the container's request carries no credential at all, and what it
 * gets back is the provider's answer, streamed.
 *
 * The one decision it makes is which route to try: `secrets/<instance>.model.json` lists
 * `provider/model` in preference order, and a route that comes back with an error hands
 * the request to the next one. pi cannot do this itself — its retry loop names a fixed set
 * of retryable errors and explicitly excludes the quota messages a free model answers with
 * (`FreeUsageLimitError`, `Monthly usage limit reached`), which is exactly the failure
 * this exists for. Everything else stays a pipe: no rewriting of anything but `model`, no
 * logging of bodies, no opinion about what the model may be asked.
 */
export const MODEL_PREFIX = "/model";

/**
 * Headers that describe one connection, not the request, plus the ones undici refuses
 * to let a caller set. pi talks to us over a local socket; forwarding `connection`,
 * `transfer-encoding`, `te`, `upgrade` or a `proxy-*` header makes `fetch()` throw
 * before a single byte reaches the provider, and the round reads that as a model error.
 * `Object.entries` is lower-cased by node:http already, so the set is case-insensitive.
 */
const HOP = new Set([
  "accept-charset",
  "accept-encoding",
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

/** Only the host's credential crosses. Everything else about the request survives. */
export function modelHeaders(inbound: IncomingMessage["headers"], key: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(inbound)) {
    if (typeof value !== "string") continue;
    const lower = name.toLowerCase();
    if (HOP.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) continue;
    headers[lower] = value;
  }
  headers.authorization = `Bearer ${key}`;
  return headers;
}

/** How long a provider has to start answering before the next route gets the request. */
const HEADER_TIMEOUT_MS = 60_000;
/** An error body is a sentence; anything longer is not one, and the status is the message. */
const FAILURE_BODY_CAP = 64 * 1024;

interface Attempt {
  provider: string;
  url: string;
  /** What to put in the body's `model`; null means "leave the body exactly as it came". */
  model: string | null;
  /** What to put in the body's `reasoning_effort`; null leaves the client's choice alone. */
  reasoningEffort: string | null;
  key: string;
}

type Plan = { attempts: Attempt[] } | { error: string };

function requestModel(body: Buffer): string | null {
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const model = (parsed as { model?: unknown }).model;
    return typeof model === "string" ? model : null;
  } catch {
    return null;
  }
}

/** `model` and an entry's `reasoning_effort` are top-level; nothing else is touched. */
function rewriteModel(body: Buffer, model: string, reasoningEffort: string | null): Buffer {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    parsed.model = model;
    if (reasoningEffort !== null) parsed.reasoning_effort = reasoningEffort;
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return body;
  }
}

function attemptFor(
  p: Paths,
  entry: ModelChainEntry,
  table: Record<string, { url: string; key?: string }>,
  ownKey: { name: string; key: string } | null,
  suffix: string,
  rewrite: boolean,
): Attempt | string {
  const provider = table[entry.provider];
  if (provider === undefined) return `deploy/providers.json 里没有 ${entry.provider}`;
  const key = provider.key === undefined ? (ownKey?.key ?? null) : readNamedModelKey(p, provider.key);
  if (key === null) return `secrets/${p.instance}.model.env 里没有 ${provider.key ?? "模型密钥"}`;
  return {
    provider: entry.provider,
    url: provider.url + suffix,
    model: rewrite ? entry.model : null,
    reasoningEffort: rewrite ? (entry.reasoningEffort ?? null) : null,
    key,
  };
}

/**
 * Which routes to try, in order, for this request.
 *
 * Only the configured primary is ours to rewrite. Anything else — an auxiliary model an
 * extension asked for, a `/models` listing — goes where it would have gone before, and is
 * never replaced by the chain: serving a different model than the one the client named is
 * only defensible when it is the model the operator said would be served.
 */
function routingPlan(p: Paths, suffix: string, body: Buffer): Plan {
  const ownKey = readModelKey(p);
  const chain = readChain(p);
  if (chain.chain.length === 0) {
    // No chain file: one route, exactly as before. A chain file that does not parse lands
    // here too, on purpose — the operator's typo is the doctor's to report, and a file
    // nobody can read must not take every round down with it.
    const legacy = modelUpstream(p);
    if (legacy === null) {
      return {
        error: "没有配置模型上游：写 secrets/<实例>.model.env 的 GENG_MODEL_UPSTREAM，或 deploy/providers.json 里给这个 provider 一行",
      };
    }
    if (ownKey === null) {
      return { error: "没有模型密钥：写 secrets/<实例>.model.env 的 OPENCODE_API_KEY" };
    }
    return { attempts: [{ provider: "?", url: legacy + suffix, model: null, reasoningEffort: null, key: ownKey.key }] };
  }

  const { table, error } = readProviders(p);
  if (error !== null) return { error };
  const [head, ...rest] = chain.chain;
  if (head === undefined) return { error: "模型链是空的" };
  const rewrite = requestModel(body) === head.model;
  const first = attemptFor(p, head, table, ownKey, suffix, rewrite);
  if (typeof first === "string") return { error: `${first}——模型链的第一条找不到地址` };
  if (!rewrite) return { attempts: [first] };
  const attempts = [first];
  for (const entry of rest) {
    // A fallback that cannot be resolved is skipped: it is one lever, not the whole round.
    const next = attemptFor(p, entry, table, ownKey, suffix, true);
    if (typeof next !== "string") attempts.push(next);
  }
  return { attempts };
}

async function withHeaderTimeout(pending: Promise<Response>, ms: number): Promise<Response> {
  // The losing side of the race is aborted by the caller; without this line its rejection
  // would have no handler and Node would take it as an unhandled rejection.
  pending.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${Math.round(ms / 1000)}s 内没有响应头`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readCapped(response: Response): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      chunks.push(Buffer.from(value));
      size += value.length;
      if (size >= FAILURE_BODY_CAP) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    // an error body that dies mid-read is still an error: the status already said so
  }
  return Buffer.concat(chunks);
}

export async function proxyModel(
  p: Paths,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  fetchImpl: typeof fetch = fetch,
  opts: { headerTimeoutMs?: number } = {},
): Promise<number> {
  const suffix = (req.url ?? "").slice(MODEL_PREFIX.length) || "/";
  const plan = routingPlan(p, suffix, body);
  if (!("attempts" in plan)) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: plan.error }));
    return 0;
  }
  const method = (req.method ?? "POST").toUpperCase();
  // undici refuses a body on GET/HEAD outright. A provider that answers a health check
  // with GET must not turn into a 500 just because the client sent a few stray bytes.
  const sendBody = method !== "GET" && method !== "HEAD" && body.length > 0;

  // A round that is killed takes the provider request with it, instead of leaving a
  // half-open stream nobody reads until the provider gives up. But a response that has
  // already finished also closes, and aborting then cancels the next thing this socket
  // would do for no reason — so only an unfinished one counts.
  let current: AbortController | null = null;
  res.on("close", () => {
    if (!res.writableFinished) current?.abort();
  });

  // Kept for the last word: the client asked about the first route, so that route's answer
  // is the one it gets, even when every route behind it has a more interesting reason.
  let first: { status: number; type: string; body: Buffer } | null = null;

  for (const [index, attempt] of plan.attempts.entries()) {
    current = new AbortController();
    const headers = modelHeaders(req.headers, attempt.key);
    const payload = attempt.model === null || !sendBody ? body : rewriteModel(body, attempt.model, attempt.reasoningEffort);
    let response: Response;
    try {
      response = await withHeaderTimeout(
        fetchImpl(attempt.url, {
          method,
          headers,
          body: sendBody ? new Uint8Array(payload) : undefined,
          signal: current.signal,
        }),
        opts.headerTimeoutMs ?? HEADER_TIMEOUT_MS,
      );
    } catch (err) {
      // The losing race partner must not keep a socket open to a provider we gave up on.
      current.abort();
      first ??= {
        status: 502,
        type: "application/json",
        body: Buffer.from(JSON.stringify({ error: `连不上 ${attempt.provider}：${(err as Error).message}` })),
      };
      continue;
    }
    if (response.status >= 400) {
      const text = await readCapped(response);
      first ??= { status: response.status, type: response.headers.get("content-type") ?? "application/json", body: text };
      continue;
    }
    const out: Record<string, string> = { "content-type": response.headers.get("content-type") ?? "application/json" };
    const type = out["content-type"] ?? "";
    if (type.includes("text/event-stream")) {
      // the whole point of a stream is that it is not buffered
      out["cache-control"] = "no-cache";
      out["x-accel-buffering"] = "no";
    }
    res.writeHead(response.status, out);
    if (response.body === null) {
      res.end();
      return index;
    }
    // Bytes are forwarded as they arrive; the client's framing is the provider's. `pipeline`
    // rather than `pipe`: it ends the response and propagates an abort or an error instead
    // of leaving a half-written answer that the other side reads as an empty one.
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
    return index;
  }

  const answer = first ?? {
    status: 503,
    type: "application/json",
    body: Buffer.from(JSON.stringify({ error: "模型链上没有一条路线能用" })),
  };
  res.writeHead(answer.status, { "content-type": answer.type });
  res.end(answer.body);
  return 0;
}
