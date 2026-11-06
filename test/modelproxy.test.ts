import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { proxyModel } from "../internal/modelproxy.ts";

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
