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
  // The inbound authorization is dropped, not merged: the only credential on the wire is
  // the host's, and a container that invents one cannot smuggle it upstream.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value !== "string") continue;
    const lower = name.toLowerCase();
    if (lower === "authorization" || lower === "host" || lower === "content-length" || lower === "connection") continue;
    headers[lower] = value;
  }
  headers.authorization = `Bearer ${found.key}`;

  const controller = new AbortController();
  // A round that is killed takes the provider request with it, instead of leaving a
  // half-open stream nobody reads until the provider gives up. But a response that has
  // already finished also closes, and aborting then cancels the next thing this socket
  // would do for no reason — so only an unfinished one counts.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const response = await fetchImpl(target, {
    method: req.method ?? "POST",
    headers,
    body: body.length === 0 ? undefined : new Uint8Array(body),
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
