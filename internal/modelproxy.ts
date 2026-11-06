import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Paths } from "./paths.ts";
import { readModelKey, modelUpstream } from "./model.ts";

/**
 * The model proxy: the container talks to the daemon, the daemon talks to the provider.
 *
 * This is the whole point of not handing the key out. `/model/key` moved the key out of
 * `env`, but anything the container can fetch, its `bash` can fetch too. A proxy leaves
 * the key on the host: the container's request carries no credential at all, and what it
 * gets back is the provider's answer, streamed.
 *
 * It is deliberately a pipe, not a gateway: no rewriting, no logging of bodies, no
 * decisions about what the model may be asked. Everything it can be told to do, the
 * container could have done itself with a key.
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

export async function proxyModel(
  p: Paths,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const upstream = modelUpstream(p);
  if (upstream === null) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "没有配置模型上游：写 secrets/<实例>.model.env 的 GENG_MODEL_UPSTREAM" }));
    return;
  }
  const found = readModelKey(p);
  if (found === null) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "没有模型密钥：写 secrets/<实例>.model.env 的 OPENCODE_API_KEY" }));
    return;
  }
  const suffix = (req.url ?? "").slice(MODEL_PREFIX.length) || "/";
  const target = upstream.replace(/\/$/, "") + suffix;
  const headers = modelHeaders(req.headers, found.key);
  const method = (req.method ?? "POST").toUpperCase();
  // undici refuses a body on GET/HEAD outright. A provider that answers a health check
  // with GET must not turn into a 500 just because the client sent a few stray bytes.
  const sendBody = method !== "GET" && method !== "HEAD" && body.length > 0;

  const controller = new AbortController();
  // A round that is killed takes the provider request with it, instead of leaving a
  // half-open stream nobody reads until the provider gives up. But a response that has
  // already finished also closes, and aborting then cancels the next thing this socket
  // would do for no reason — so only an unfinished one counts.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const response = await fetchImpl(target, {
    method,
    headers,
    body: sendBody ? new Uint8Array(body) : undefined,
    signal: controller.signal,
  });
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
    return;
  }
  // Bytes are forwarded as they arrive; the client's framing is the provider's. `pipeline`
  // rather than `pipe`: it ends the response and propagates an abort or an error instead
  // of leaving a half-written answer that the other side reads as an empty one.
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
}
