import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand } from "../internal/command.ts";
import { startBookServer } from "../internal/book.ts";
import { makePaths } from "../internal/paths.ts";
import { defaultPolicy } from "../internal/policy.ts";

/** The checkout's tool directory, as the daemon sees it before the mount. */
function tools(root: string, names: string[]): void {
  mkdirSync(join(root, "image", "extensions"), { recursive: true });
  for (const n of names) writeFileSync(join(root, "image", "extensions", n), "// tool\n");
}

test("the container writes nothing but the page it calls its own", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  const argv = buildCommand(paths, { ...defaultPolicy(), runner: "docker" }, "geng-alice", "你是…", []).args.join(" ");
  // say queues through the daemon now, so the outbox is not something it can write
  assert.equal(argv.includes(":/outbox"), false, "outbox 不该挂进容器");
  assert.match(argv, new RegExp(`-v ${paths.identity}:/state/identity.md`));
});

test("the tools are loaded from outside the agent's home", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  tools(root, ["mail.ts", "say-mute.ts", "websearch.ts"]);
  const { args } = buildCommand(makePaths(root, "alice"), { ...defaultPolicy(), runner: "docker" }, "geng-alice", "你是…", []);
  const joined = args.join(" ");
  assert.match(joined, /-e \/opt\/geng\/extensions\/say-mute\.ts/);
  assert.match(joined, /-e \/opt\/geng\/extensions\/websearch\.ts/);
  assert.match(joined, /-e \/opt\/geng\/extensions\/mail\.ts/);
});

test("a tool dropped into image/extensions/ is loaded, with no other edit", () => {
  // the page and the docs promise "add a tool, save it": three hardcoded -e paths meant
  // the fourth file was mounted into the container and never loaded, and nothing said so
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  tools(root, ["say-mute.ts", "websearch.ts", "mail.ts", "calendar.ts", "README.md", "helper.js"]);
  const { args } = buildCommand(makePaths(root, "alice"), { ...defaultPolicy(), runner: "docker" }, "geng-alice", "P", []);
  const loaded = args.filter((a) => a.startsWith("/opt/geng/extensions/"));
  assert.deepEqual(loaded, [
    "/opt/geng/extensions/calendar.ts",
    "/opt/geng/extensions/mail.ts",
    "/opt/geng/extensions/say-mute.ts",
    "/opt/geng/extensions/websearch.ts",
  ]);
  for (const a of loaded) assert.equal(args[args.indexOf(a) - 1], "-e", `${a} 少了 -e`);
});
test("the tools are mounted, not baked, so editing one needs no rebuild", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  const { args } = buildCommand(paths, { ...defaultPolicy(), runner: "docker" }, "geng-alice", "你是…", []);
  // without :ro the agent could rewrite the tool that decides how it speaks to people
  assert.notEqual(
    args.indexOf(`${paths.extensions}:/opt/geng/extensions:ro`),
    -1,
    "扩展没有以只读挂载进容器：改一个工具又得重建镜像，或者它能改自己的嘴",
  );
});

test("every -e value is really passed to docker as an env var", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const p = defaultPolicy();
  p.runner = "docker";
  const args = buildCommand(makePaths(root, "alice"), p, "geng-x-0001", "P", []).args;
  // TZ once shipped without its flag: docker read "TZ=Asia/Shanghai" as the image name,
  // the container never started, and the daemon died with no log line at all.
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (/^[A-Z_]+=/.test(a)) assert.equal(args[i - 1], "-e", `${a} 少了 -e`);
  }
  assert.ok(args.includes("TZ=Asia/Shanghai"));
});


test("the search socket is mounted only when it exists, and at the same path", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  const sock = join(root, "run", "search.sock");
  mkdirSync(join(root, "secrets"), { recursive: true });
  const env = (p: string) => `GENG_SEARCH_TOKEN=t\nDEEPSEEK_API_KEY=sk-x\nGENG_SEARCH_SOCKET=${p}\n`;
  const argv = (): string =>
    buildCommand(paths, { ...defaultPolicy(), runner: "docker" }, "geng-alice", "你是…", []).args.join(" ");

  writeFileSync(join(root, "secrets", "search.env"), env(sock));
  // nothing listens yet: docker would materialise the missing host path as a directory,
  // and the container would then fail to connect with a shape nobody recognises
  assert.equal(argv().includes("GENG_SEARCH_SOCKET"), false, "socket 不在的时候还是注入了路径");
  assert.equal(argv().includes(sock), false, "socket 不在的时候还是挂了它");

  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(sock, "");
  assert.match(argv(), new RegExp(`-v ${sock}:${sock}:ro`), "socket 在的时候要挂进来");
  assert.match(argv(), new RegExp(`-e GENG_SEARCH_SOCKET=${sock}`), "路径要和挂载点一致");
  // no port anywhere: the whole point is that the network has no special address
  assert.equal(argv().includes("8787"), false, "还在用端口");
});

test("the book socket is mounted read-only, and only when something is listening", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  const argv = (): string =>
    buildCommand(paths, { ...defaultPolicy(), runner: "docker" }, "geng-alice", "你是…", []).args.join(" ");

  assert.equal(argv().includes("GENG_BOOK_SOCK"), false, "socket 不在的时候还是注入了路径");

  // a plain file at that path is not a channel: mounting it would hand the container a
  // path that fails to connect, and the failure reads as "the daemon is down"
  mkdirSync(paths.run, { recursive: true });
  writeFileSync(join(paths.run, "book.sock"), "");
  assert.equal(argv().includes("GENG_BOOK_SOCK"), false, "文件名对但没人听的时候也挂了");

  const server = await startBookServer({ paths, log: () => {} });
  try {
    assert.match(argv(), new RegExp(`-v ${paths.run}:/run/geng:ro`), "书端点没挂进去");
    assert.match(argv(), /-e GENG_BOOK_SOCK=\/run\/geng\/book\.sock/, "容器里的路径要和挂载点一致");
  } finally {
    server.close();
  }
});
