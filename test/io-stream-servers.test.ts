import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { startMailServer, type MailConfig } from "../internal/mail.ts";
import { startSearchServer } from "../internal/search.ts";
import { postJson } from "../image/extensions/lib/uds.ts";

// Windows 不能把 server 绑到普通文件路径（EACCES），命名管道可以；POSIX 用临时目录里的
// .sock。startSearchServer 的 mkdirSync(dirname(socket)) 在两种情形下都是 no-op。
function newSocket(tag: string): { sock: string; clean: () => void } {
  if (process.platform === "win32") {
    const sock = `\\\\.\\pipe\\geng-io-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}`;
    return { sock, clean: () => {} };
  }
  const dir = mkdtempSync(join(tmpdir(), `geng-io-${tag}-`));
  return { sock: join(dir, "s.sock"), clean: () => rmSync(dir, { recursive: true, force: true }) };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("等超时了");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 一个上传跑到一半就把 TCP 连接掐掉的客户端：服务端 req 会收到 aborted + error。 */
function abortTcp(port: number, headers: Record<string, string>, partial: string): Promise<void> {
  return new Promise((resolve) => {
    const c = connect(port, "127.0.0.1", () => {
      // HTTP/1.1 没有 Host 会被 llhttp 直接挡在请求处理器之外，测不到 req 的 error。
      const head =
        "POST / HTTP/1.1\r\nHost: x\r\n" +
        Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
        "\r\n\r\n";
      c.write(head + partial);
      setTimeout(() => {
        c.destroy();
        resolve();
      }, 40);
    });
    c.on("error", () => resolve());
  });
}

/** 同上，但走 socketPath（命名管道 / unix socket）。 */
function abortSocket(sock: string, path: string): Promise<void> {
  return new Promise((resolve) => {
    const req = request(
      { socketPath: sock, path, method: "POST", headers: { "content-type": "application/json", "content-length": "100000" } },
      () => {},
    );
    req.on("error", () => {});
    req.write('{"query":');
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 40);
  });
}

const CFG: MailConfig = {
  "bot@example.invalid": { instance: "alice", allow: ["someone@example.invalid"] },
};
const MAIL = {
  to: "bot@example.invalid",
  from: "someone@example.invalid",
  subject: "一封正常的信",
  messageId: "<io@example.invalid>",
  text: "正文",
};

test("mail：上传中途断开不会带垮信箱，413 之后也不收截断的 body", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-io-mail-"));
  const paths = makePaths(root, "alice");
  mkdirSync(join(root, "secrets"), { recursive: true });
  for (const d of [paths.mail, paths.filesDir]) mkdirSync(d, { recursive: true });
  const log: string[] = [];
  const server = await startMailServer({
    root,
    getCfg: () => CFG,
    env: { token: "tok", bind: { host: "127.0.0.1", port: 0 } },
    log: (l) => log.push(l),
    maxBytes: 4000,
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/`;
  const post = (body: string) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-geng-token": "tok" }, body });
  try {
    // 一个 Content-Length 很大、却只发几个字节就断掉的上传：没有 req.on("error") 时，
    // 这个 error 是长驻网关里的未捕获异常，一封掉队的信就能把所有 bot 的信箱一起带走。
    await abortTcp(port, { "x-geng-token": "tok", "content-type": "application/json", "content-length": "100000" }, "half");
    await waitFor(() => log.some((l) => /请求流断了/.test(l)));
    assert.ok(log.some((l) => /请求流断了/.test(l)), "req 的 error 要被记下来，而不是变成未捕获异常");
    assert.equal(readdirSync(paths.mail).filter((f) => f.endsWith(".json")).length, 0, "半封信不能落盘");

    // 超限的 body 回 413 之后，end 不该再把截断的内容交给 accept()。
    assert.equal((await post("x".repeat(5000))).status, 413);
    assert.equal(readdirSync(paths.mail).filter((f) => f.endsWith(".json")).length, 0, "413 之后不该落盘");

    // 请求流的 error 被处理掉之后，服务还活着：一封完整的信照常收下。
    const ok = await post(JSON.stringify(MAIL));
    assert.equal(ok.status, 200);
    assert.equal(readdirSync(paths.mail).filter((f) => f.endsWith(".json")).length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("search：上传中途断开不会带垮端点，413 之后也不碰上游", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-io-srch-"));
  const { sock, clean } = newSocket("srch");
  const log: string[] = [];
  const server = await startSearchServer({
    root,
    env: { apiKey: "x", socket: sock, dailyLimit: 200 },
    log: (l) => log.push(l),
  });
  const real = globalThis.fetch;
  let upstream = 0;
  globalThis.fetch = (async () => {
    upstream += 1;
    throw new Error("上游不该被调用");
  }) as typeof fetch;
  try {
    await abortSocket(sock, "/search");
    await waitFor(() => log.some((l) => /请求流断了/.test(l)));
    assert.ok(log.some((l) => /请求流断了/.test(l)), "req 的 error 要被记下来，而不是变成未捕获异常");

    // 超限的 body 回 413，end 不该再把它交给下游去 fetch。
    const over = await postJson(sock, "/search", { query: "x".repeat(70_000) });
    assert.equal(over.status, 413);
    assert.equal(upstream, 0, "413 之后不该走到上游");

    // 端点还活着：一个正常的请求照常被路由。
    assert.equal((await postJson(sock, "/nope", {})).status, 404);
  } finally {
    globalThis.fetch = real;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    clean();
    rmSync(root, { recursive: true, force: true });
  }
});
