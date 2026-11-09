import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { proxyModel } from "../internal/modelproxy.ts";
import { readChain } from "../internal/model.ts";

function fixture(): ReturnType<typeof makePaths> {
  const root = mkdtempSync(join(tmpdir(), "geng-modelproxy-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  // split so the privacy gate does not read a fixture as a credential
  const line = (name: string, value: string): string => [name, value].join("=");
  writeFileSync(
    join(root, "secrets", "alice.model.env"),
    `${line("OPENCODE_API_KEY", "host-only-answer")}\n${line("GENG_MODEL_UPSTREAM", "https://provider.example/v1")}\n`,
  );
  return makePaths(root, "alice");
}

function fakeResponse(): ServerResponse {
  const res = {
    writableFinished: false,
    on() {
      return this;
    },
    writeHead() {
      return this;
    },
    end() {
      return this;
    },
  };
  return res as unknown as ServerResponse;
}

function capture(): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: Parameters<typeof fetch>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<typeof fetch>[1] }> = [];
  const fetchImpl = (async (url: string, init: Parameters<typeof fetch>[1]) => {
    calls.push({ url, init });
    return {
      status: 200,
      headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
      body: null,
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("one connection's headers are not forwarded as if they belonged to the request", async () => {
  const { fetchImpl, calls } = capture();
  const req = {
    url: "/model/chat/completions",
    method: "POST",
    headers: {
      "content-type": "application/json",
      // constructed, so the privacy gate does not read this fixture as a credential
      authorization: ["Bearer", "container-invented"].join(" "),
      host: "127.0.0.1:11434",
      "content-length": "2",
      connection: "keep-alive",
      "transfer-encoding": "chunked",
      te: "trailers",
      upgrade: "h2c",
      "proxy-authorization": "Basic invented",
      "sec-fetch-mode": "cors",
    },
  } as unknown as IncomingMessage;
  await proxyModel(fixture(), req, fakeResponse(), Buffer.from("{}"), fetchImpl);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers["content-type"], "application/json");
  // the inbound credential is dropped, not merged
  assert.equal(headers.authorization, "Bearer host-only-answer");
  for (const forbidden of [
    "host", "content-length", "connection", "transfer-encoding", "te",
    "upgrade", "proxy-authorization", "sec-fetch-mode",
  ]) {
    assert.equal(headers[forbidden], undefined, `${forbidden} 会让 undici 直接拒绝这次 fetch`);
  }
});

test("a GET with stray bytes is still a GET, not a rejected fetch", async () => {
  const { fetchImpl, calls } = capture();
  const req = {
    url: "/model/health",
    method: "GET",
    headers: { "content-type": "application/json" },
  } as unknown as IncomingMessage;
  await proxyModel(fixture(), req, fakeResponse(), Buffer.from("unexpected"), fetchImpl);
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.body, undefined, "GET/HEAD 带 body 会被 undici 整个拒绝");
});

test("a POST still carries its body to the provider", async () => {
  const { fetchImpl, calls } = capture();
  const req = {
    url: "/model/chat/completions",
    method: "POST",
    headers: { "content-type": "application/json" },
  } as unknown as IncomingMessage;
  await proxyModel(fixture(), req, fakeResponse(), Buffer.from("{}"), fetchImpl);
  assert.deepEqual([...(calls[0]?.init?.body as Uint8Array)], [...Buffer.from("{}")]);
});

// ---- the chain: which route answers, and what it is told ----

function chain(root: string, providers: unknown, chainSpec: unknown[], keyLines: string[] = []): ReturnType<typeof makePaths> {
  mkdirSync(join(root, "deploy"), { recursive: true });
  mkdirSync(join(root, "secrets"), { recursive: true });
  const line = (name: string, value: string): string => [name, value].join("=");
  writeFileSync(join(root, "deploy", "providers.json"), JSON.stringify(providers));
  writeFileSync(
    join(root, "secrets", "alice.model.env"),
    [
      line("OPENCODE_API_KEY", "primary-key-not-real"),
      line("GENG_MODEL_UPSTREAM", "https://legacy.example/v1"),
      ...keyLines,
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "secrets", "alice.model.json"), JSON.stringify(chainSpec));
  return makePaths(root, "alice");
}

function chainRoot(): string {
  return mkdtempSync(join(tmpdir(), "geng-modelchain-"));
}

/** A response the proxy will treat as an answer: no body means it ends there. */
function answer(status: number, openai = "application/json"): Response {
  return {
    status,
    headers: { get: (name: string) => (name === "content-type" ? openai : null) },
    body: null,
  } as unknown as Response;
}

function scripted(steps: Array<Response | (() => Promise<Response>)>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: Parameters<typeof fetch>[1] }>;
} {
  const calls: Array<{ url: string; init: Parameters<typeof fetch>[1] }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: Parameters<typeof fetch>[1]) => {
    calls.push({ url, init });
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    if (typeof step === "function") return step();
    return step;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function recordingResponse(): { res: ServerResponse; seen: { status?: number; body?: string } } {
  const seen: { status?: number; body?: string } = {};
  const res = {
    writableFinished: false,
    on() {
      return this;
    },
    writeHead(status: number) {
      seen.status = status;
      return this;
    },
    end(chunk?: unknown) {
      seen.body = chunk === undefined ? "" : String(chunk);
      return this;
    },
  };
  return { res: res as unknown as ServerResponse, seen };
}

function post(url: string): IncomingMessage {
  return {
    url,
    method: "POST",
    headers: { "content-type": "application/json" },
  } as unknown as IncomingMessage;
}

test("the first route that fails hands the request to the next one, model rewritten", async () => {
  const root = chainRoot();
  const p = chain(
    root,
    { primary: "https://a.example/v1", backup: "https://b.example/v1" },
    ["primary/primary-model", "backup/backup-model"],
  );
  const { fetchImpl, calls } = scripted([answer(429), answer(200)]);
  const request = { model: "primary-model", stream: true, messages: [{ role: "user", content: "hi" }] };
  const res = fakeResponse();
  const fallbacks = await proxyModel(p, post("/model/chat/completions"), res, Buffer.from(JSON.stringify(request)), fetchImpl);

  assert.equal(calls.length, 2, "429 没有交给下一条");
  assert.equal(calls[1]?.url, "https://b.example/v1/chat/completions");
  const sent = JSON.parse(Buffer.from(calls[1]?.init?.body as Uint8Array).toString("utf8"));
  assert.equal(sent.model, "backup-model", "备用路由拿到的还是主力的模型名");
  // everything but `model` is the client's
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.messages, request.messages);
  assert.equal(fallbacks, 1, "fb= 记的是「第几跳答的」，不是「打了几次」");
});

test("a route that answers is the only one asked", async () => {
  const root = chainRoot();
  const p = chain(root, { primary: "https://a.example/v1", backup: "https://b.example/v1" }, [
    "primary/primary-model",
    "backup/backup-model",
  ]);
  const { fetchImpl, calls } = scripted([answer(200)]);
  const fallbacks = await proxyModel(
    p,
    post("/model/chat/completions"),
    fakeResponse(),
    Buffer.from(JSON.stringify({ model: "primary-model" })),
    fetchImpl,
  );
  assert.equal(calls.length, 1, "主力好了还顺手打了一遍备用");
  assert.equal(fallbacks, 0);
});

test("an entry may name a different vendor's key", async () => {
  const root = chainRoot();
  const p = chain(
    root,
    { primary: "https://a.example/v1", other: { url: "https://c.example/v1", key: "DEEPSEEK_API_KEY" } },
    ["primary/primary-model", "other/other-model"],
    [["DEEPSEEK_API_KEY", "other-key-not-real"].join("=")],
  );
  const { fetchImpl, calls } = scripted([answer(503), answer(200)]);
  await proxyModel(
    p,
    post("/model/chat/completions"),
    fakeResponse(),
    Buffer.from(JSON.stringify({ model: "primary-model" })),
    fetchImpl,
  );
  const second = calls[1]?.init?.headers as Record<string, string>;
  assert.equal(second.authorization, ["Bearer", "other-key-not-real"].join(" "));
  const first = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(first.authorization, ["Bearer", "primary-key-not-real"].join(" "));
});

test("when every route fails the client gets the primary's answer, not the last one", async () => {
  const root = chainRoot();
  const p = chain(root, { primary: "https://a.example/v1", backup: "https://b.example/v1" }, [
    "primary/primary-model",
    "backup/backup-model",
  ]);
  const body = (text: string): Response =>
    ({
      status: 429,
      headers: { get: () => "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: text })));
          controller.close();
        },
      }),
    }) as unknown as Response;
  const { fetchImpl, calls } = scripted([
    body("FreeUsageLimitError"),
    { ...body("internal"), status: 500 } as Response,
  ]);
  const { res, seen } = recordingResponse();
  await proxyModel(
    p,
    post("/model/chat/completions"),
    res,
    Buffer.from(JSON.stringify({ model: "primary-model" })),
    fetchImpl,
  );
  assert.equal(calls.length, 2);
  assert.equal(seen.status, 429, "客户端问的是主力，答案也该是主力的");
  assert.match(String(seen.body), /FreeUsageLimitError/);
});

test("a model the chain does not name is forwarded untouched", async () => {
  const root = chainRoot();
  const p = chain(root, { primary: "https://a.example/v1", backup: "https://b.example/v1" }, [
    "primary/primary-model",
    "backup/backup-model",
  ]);
  const { fetchImpl, calls } = scripted([answer(200)]);
  // an extension's own model, or a listing: not ours to replace
  const raw = JSON.stringify({ model: "some-other-model", stream: true });
  await proxyModel(p, post("/model/chat/completions"), fakeResponse(), Buffer.from(raw), fetchImpl);
  assert.equal(calls.length, 1, "别人的模型也被塞进了回退链");
  assert.equal(calls[0]?.url, "https://a.example/v1/chat/completions");
  assert.deepEqual([...(calls[0]?.init?.body as Uint8Array)], [...Buffer.from(raw)]);
});

test("a chain file that does not parse leaves the one upstream it already had", async () => {
  const root = chainRoot();
  mkdirSync(join(root, "deploy"), { recursive: true });
  mkdirSync(join(root, "secrets"), { recursive: true });
  const line = (name: string, value: string): string => [name, value].join("=");
  writeFileSync(
    join(root, "secrets", "alice.model.env"),
    `${line("OPENCODE_API_KEY", "primary-key-not-real")}\n${line("GENG_MODEL_UPSTREAM", "https://legacy.example/v1")}\n`,
  );
  writeFileSync(join(root, "secrets", "alice.model.json"), "{ not json");
  const p = makePaths(root, "alice");
  const { fetchImpl, calls } = scripted([answer(200)]);
  await proxyModel(
    p,
    post("/model/chat/completions"),
    fakeResponse(),
    Buffer.from(JSON.stringify({ model: "whatever" })),
    fetchImpl,
  );
  assert.equal(calls.length, 1, "坏文件不该变成 503，也不该丢上游");
  assert.equal(calls[0]?.url, "https://legacy.example/v1/chat/completions");
});

test("a provider that never answers is dropped for the next one", async () => {
  const root = chainRoot();
  const p = chain(root, { primary: "https://a.example/v1", backup: "https://b.example/v1" }, [
    "primary/primary-model",
    "backup/backup-model",
  ]);
  const { fetchImpl, calls } = scripted([() => new Promise<Response>(() => undefined), answer(200)]);
  const fallbacks = await proxyModel(
    p,
    post("/model/chat/completions"),
    fakeResponse(),
    Buffer.from(JSON.stringify({ model: "primary-model" })),
    fetchImpl,
    { headerTimeoutMs: 20 },
  );
  assert.equal(calls.length, 2, "挂住的主力没有让位");
  assert.equal(fallbacks, 1);
});

// ---- per-route reasoning effort ----

test("a chain entry may set its own reasoning effort, and a missing one keeps the client's", async () => {
  const root = chainRoot();
  const p = chain(root, { primary: "https://a.example/v1", backup: "https://b.example/v1" }, [
    "primary/primary-model",
    { provider: "backup", model: "backup-model", reasoningEffort: "high" },
  ]);
  const { fetchImpl, calls } = scripted([answer(429), answer(200)]);
  const request = { model: "primary-model", reasoning_effort: "low", stream: true };
  await proxyModel(p, post("/model/chat/completions"), fakeResponse(), Buffer.from(JSON.stringify(request)), fetchImpl);

  const first = JSON.parse(Buffer.from(calls[0]?.init?.body as Uint8Array).toString("utf8"));
  const second = JSON.parse(Buffer.from(calls[1]?.init?.body as Uint8Array).toString("utf8"));
  assert.equal(first.reasoning_effort, "low", "没写 reasoningEffort 的那一跳不该动 pi 的选择");
  assert.equal(second.reasoning_effort, "high");
  assert.equal(second.stream, true, "换档不该捎走别的字段");
});

test("the primary entry's reasoning effort replaces the one pi sent", async () => {
  const root = chainRoot();
  const p = chain(root, { primary: "https://a.example/v1" }, [
    { provider: "primary", model: "primary-model", reasoningEffort: "minimal" },
  ]);
  const { fetchImpl, calls } = scripted([answer(200)]);
  await proxyModel(
    p,
    post("/model/chat/completions"),
    fakeResponse(),
    Buffer.from(JSON.stringify({ model: "primary-model", reasoning_effort: "low" })),
    fetchImpl,
  );
  const sent = JSON.parse(Buffer.from(calls[0]?.init?.body as Uint8Array).toString("utf8"));
  assert.equal(sent.reasoning_effort, "minimal");
});

test("a reasoning effort that is not a wire value is reported, not read as an absence", () => {
  const root = chainRoot();
  const p = chain(root, { primary: "https://a.example/v1", backup: "https://b.example/v1" }, [
    "primary/primary-model",
    { provider: "backup", model: "backup-model", reasoningEffort: "off" },
  ]);
  const parsed = readChain(p);
  assert.equal(parsed.chain.length, 1, "前一条是好的，仍然该留下");
  assert.match(String(parsed.error), /reasoningEffort/);
});

test("a misspelled key in a chain entry is an error, not a field nothing reads", () => {
  const root = chainRoot();
  const p = chain(root, { primary: "https://a.example/v1", backup: "https://b.example/v1" }, [
    "primary/primary-model",
    { provider: "backup", model: "backup-model", reasoning_effort: "high" },
  ]);
  const parsed = readChain(p);
  assert.equal(parsed.chain.length, 1);
  assert.match(String(parsed.error), /不认识的键/);
});
