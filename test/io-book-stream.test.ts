import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileIdFromUrl, readBody, socketPath as bookSocketPath, startBookServer } from "../internal/book.ts";
import { makePaths, requiredDirs, type Paths } from "../internal/paths.ts";
import { ensureDirs } from "../internal/fs.ts";
import { postJson } from "../image/extensions/lib/uds.ts";

// startBookServer 把 socket 绑到 socketPath(paths) = join(paths.run, "book.sock")。
// Windows 不能绑普通文件路径（EACCES），但 \\.\pipe\ 这一层 mkdirSync 是 no-op，于是把
// run 指过去就能让它监听命名管道 \\.\pipe\book.sock；POSIX 仍用临时目录里的真实目录。
let server: Server;
let sock: string;
let paths: Paths;
let log: string[];

before(async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-io-book-"));
  const base = makePaths(root, "alice");
  paths = process.platform === "win32" ? { ...base, run: "\\\\.\\pipe\\" } : base;
  ensureDirs(requiredDirs(paths));
  mkdirSync(paths.filesDir, { recursive: true });
  log = [];
  server = await startBookServer({ paths, log: (l) => log.push(l) });
  sock = bookSocketPath(paths);
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

type RawReply = { status: number | null; outcome: string; bytes: number[] };

function rawGet(sockPath: string, path: string): Promise<RawReply> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: RawReply): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const req = request({ socketPath: sockPath, path, method: "GET", agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => finish({ status: res.statusCode ?? null, outcome: "end", bytes: [...Buffer.concat(chunks)] }));
      res.on("error", () => finish({ status: res.statusCode ?? null, outcome: "error", bytes: [] }));
      res.on("aborted", () => finish({ status: res.statusCode ?? null, outcome: "aborted", bytes: [] }));
    });
    req.on("error", () => finish({ status: null, outcome: "req-error", bytes: [] }));
    req.end();
    setTimeout(() => finish({ status: null, outcome: "timeout", bytes: [] }), 3000).unref();
  });
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error("等超时了");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("(a) 坏的百分号编码是 null，不是抛 URIError", () => {
  // decodeURIComponent 在同步的请求回调里抛 URIError 会把整个 daemon 带下去。
  assert.equal(fileIdFromUrl("/files/%"), null);
  assert.equal(fileIdFromUrl("/files/%ZZ"), null);
  assert.equal(fileIdFromUrl("/files/F12"), "F12");
  assert.equal(fileIdFromUrl("/files/%46%31%32"), "F12");
});

test("(a) 服务器对坏的百分号编码回 400，之后照常服务", async () => {
  const r = await rawGet(sock, "/files/%ZZ");
  assert.equal(r.status, 400, "坏 % 转义要回 400");
  assert.equal((await postJson(sock, "/nope", {})).status, 404, "daemon 不能被一次坏 GET 弄死");
});

test("正常文件照常按字节流出", async () => {
  const f = join(paths.filesDir, "F2-0-real.bin");
  writeFileSync(f, Buffer.from([7, 8, 9]));
  try {
    const r = await rawGet(sock, "/files/F2");
    assert.equal(r.status, 200);
    assert.equal(r.outcome, "end");
    assert.deepEqual(r.bytes, [7, 8, 9]);
  } finally {
    rmSync(f, { force: true });
  }
});

test("(b) 读流报错不会带垮 daemon：目录冒充文件 id", async () => {
  // fileById 只按名字前缀找，不检查是不是文件。一个和 id 同名的目录会让
  // createReadStream 在事件循环里抛 EISDIR；没有 error 监听就是未捕获异常，
  // 能把服务到一半的 daemon 带下去。
  const dir = join(paths.filesDir, "F1-0-notafile");
  mkdirSync(dir, { recursive: true });
  const from = log.length;
  try {
    await rawGet(sock, "/files/F1");
    await waitFor(() => log.slice(from).some((l) => /出错/.test(l)));
    assert.ok(log.slice(from).some((l) => /出错/.test(l)), "读流的 error 要被记下来，而不是变成未捕获异常");
    // daemon 还活着：后面的请求照常被路由。
    assert.equal((await postJson(sock, "/nope", {})).status, 404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("(c) readBody 超限只回 413，不把截断的 body 交给 handler", () => {
  const drive = (chunks: (string | Buffer)[], max: number, asText: boolean) => {
    const req = Object.assign(new EventEmitter(), { setEncoding: () => {}, destroy: () => {} });
    const statuses: number[] = [];
    const values: (string | Buffer)[] = [];
    readBody(req as never, max, asText, (s) => statuses.push(s), (v) => values.push(v));
    for (const c of chunks) req.emit("data", c);
    req.emit("end");
    return { statuses, values };
  };

  const small = drive(["ab", "cd"], 32, true);
  assert.deepEqual(small.values, ["abcd"], "完整的 body 要交给 handler");
  assert.deepEqual(small.statuses, []);

  const over = drive(["x".repeat(40), "more"], 32, true);
  assert.deepEqual(over.statuses, [413], "一个请求一个回答");
  assert.deepEqual(over.values, [], "413 之后 end 绝不能再调用 handler 去解析截断的 body");
});
