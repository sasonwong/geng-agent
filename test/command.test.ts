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
  const argv = buildCommand(paths, { ...defaultPolicy() }, "geng-alice", "你是…").args.join(" ");
  // say queues through the daemon now, so the outbox is not something it can write
  assert.equal(argv.includes(":/outbox"), false, "outbox 不该挂进容器");
  assert.match(argv, new RegExp(`-v ${paths.identity}:/state/identity.md`));
});

test("the tools are loaded from outside the agent's home", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  tools(root, ["ledger.ts", "say-mute.ts", "websearch.ts"]);
  const { args } = buildCommand(makePaths(root, "alice"), { ...defaultPolicy() }, "geng-alice", "你是…");
  const joined = args.join(" ");
  assert.match(joined, /-e \/opt\/geng\/extensions\/say-mute\.ts/);
  assert.match(joined, /-e \/opt\/geng\/extensions\/websearch\.ts/);
  assert.match(joined, /-e \/opt\/geng\/extensions\/ledger\.ts/);
});

test("a tool dropped into image/extensions/ is loaded, with no other edit", () => {
  // the page and the docs promise "add a tool, save it": three hardcoded -e paths meant
  // the fourth file was mounted into the container and never loaded, and nothing said so
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  tools(root, ["say-mute.ts", "websearch.ts", "ledger.ts", "calendar.ts", "README.md", "helper.js"]);
  const { args } = buildCommand(makePaths(root, "alice"), { ...defaultPolicy() }, "geng-alice", "P");
  const loaded = args.filter((a) => a.startsWith("/opt/geng/extensions/"));
  assert.deepEqual(loaded, [
    "/opt/geng/extensions/calendar.ts",
    "/opt/geng/extensions/ledger.ts",
    "/opt/geng/extensions/say-mute.ts",
    "/opt/geng/extensions/websearch.ts",
  ]);
  for (const a of loaded) assert.equal(args[args.indexOf(a) - 1], "-e", `${a} 少了 -e`);
});
test("the tools are mounted, not baked, so editing one needs no rebuild", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  const { args } = buildCommand(paths, { ...defaultPolicy() }, "geng-alice", "你是…");
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
  const args = buildCommand(makePaths(root, "alice"), p, "geng-x-0001", "P").args;
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
  const env = (p: string) => `DEEPSEEK_API_KEY=sk-x\nGENG_SEARCH_SOCKET=${p}\n`;
  const argv = (): string =>
    buildCommand(paths, { ...defaultPolicy() }, "geng-alice", "你是…").args.join(" ");

  writeFileSync(join(root, "secrets", "search.env"), env(sock));
  // nothing listens yet: docker would materialise the missing host path as a directory,
  // and the container would then fail to connect with a shape nobody recognises
  assert.equal(argv().includes("GENG_SEARCH_SOCKET"), false, "socket 不在的时候还是注入了路径");
  assert.equal(argv().includes(sock), false, "socket 不在的时候还是挂了它");

  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(sock, "");
  // The host path carries a uid (`/run/user/1002/…`); a container that names it is a
  // naming leak even though the inode is the same. Asserting "mount point == env" let
  // both sides be wrong together, which is exactly what it was doing.
  assert.match(argv(), /-v \S+:\/run\/search\.sock:ro/, "socket 在的时候要挂进来");
  assert.match(argv(), /-e GENG_SEARCH_SOCKET=\/run\/search\.sock/, "容器里只认这个名字");
  // the bind source is the host path — that is how a mount works. What must not appear is
  // a *container* path equal to it: the mount destination, or an -e value.
  const args = buildCommand(paths, { ...defaultPolicy() }, "geng-alice", "你是…").args;
  assert.equal(args.some((a) => a === `GENG_SEARCH_SOCKET=${sock}`), false, "env 给的是容器路径");
  assert.equal(args.some((a) => a.endsWith(`:${sock}`)), false, "挂载点是容器路径，不是宿主路径");
});

test("the search socket is not mounted inside the read-only directory mount", () => {
  // Docker cannot create a mountpoint inside a read-only bind, and `/run/geng` is one
  // (mounted `:ro` so the agent cannot unlink the book socket). Mounting the file before
  // the directory is not a way out either: the later directory mount shadows it. Both
  // failures are at container start, where the daemon only sees "docker run exited 125".
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(join(root, "secrets"), { recursive: true });
  mkdirSync(paths.run, { recursive: true });
  const sock = join(paths.run, "search.sock");
  writeFileSync(sock, "");
  writeFileSync(join(root, "secrets", "search.env"), `DEEPSEEK_API_KEY=sk-x\nGENG_SEARCH_SOCKET=${sock}\n`);
  const args = buildCommand(paths, { ...defaultPolicy() }, "geng-alice", "你是…").args;
  const dest = args.find((a) => a.includes(":") && a.startsWith(sock + ":"));
  assert.ok(dest !== undefined, "socket 没挂进来");
  const from = dest.slice(sock.length + 1).replace(/:ro$/, "");
  assert.equal(from.startsWith("/run/geng/"), false, "挂在只读目录里，容器起不来");
});

test("only the per-instance env file crosses into the container", () => {
  // The whole reason the model key, the search key, the GitHub App private key and the
  // bot tokens live in *other* files is that `docker run --env-file` hands its contents
  // to `env` inside the container. Nothing here checked that the split actually held:
  // a stray -e or -v would have been invisible to every existing mount assertion.
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(join(root, "secrets"), { recursive: true });
  // split so the repo's secret scanner does not read a fixture as a credential
  const line = (name: string): string => [name, "not-a-real-value"].join("=");
  writeFileSync(paths.secrets, `${line("GENG_GH_APP_ID")}\n${line("GENG_GH_INSTALLATION_ID")}\n`);
  for (const [name, key] of [
    ["alice.model.env", "OPENCODE_API_KEY"],
    ["search.env", "DEEPSEEK_API_KEY"],
    ["rustic.env", "RUSTIC_PASSWORD"],
    ["mail.env", "GENG_MAIL_TOKEN"],
  ] as const) {
    writeFileSync(join(root, "secrets", name), `${line(key)}\n`);
  }
  writeFileSync(join(root, "secrets", "bots.json"), "{}");
  writeFileSync(join(root, "secrets", "gh-app.pem"), "not-a-key");
  mkdirSync(join(root, "data", "alice"), { recursive: true });
  writeFileSync(paths.policy, "{}");

  const { args } = buildCommand(paths, defaultPolicy(), "geng-alice-0001", "P");
  const joined = args.join(" ");
  const envFiles = args.filter((_, i) => i > 0 && args[i - 1] === "--env-file");
  assert.deepEqual(envFiles, [paths.secrets], "只有 alice.env 该作为 --env-file 进容器");
  for (const forbidden of [
    "alice.model.env", "search.env", "rustic.env", "bots.json", "gh-app.pem",
    "mail.env", "policy.json",
  ]) {
    assert.equal(joined.includes(forbidden), false, `${forbidden} 不该出现在 docker run 里`);
  }
  for (const keyVar of [
    "OPENCODE_API_KEY", "DEEPSEEK_API_KEY", "GENG_MAIL_TOKEN", "RUSTIC_PASSWORD",
  ]) {
    assert.equal(args.some((a) => a.includes(keyVar)), false, `${keyVar} 不能进容器环境`);
  }
  const network = args.indexOf("--network");
  assert.ok(network !== -1 && args[network + 1] === "none", "容器没有直连网络");
});

test("the book socket is mounted read-only, and only when something is listening", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  const argv = (): string =>
    buildCommand(paths, { ...defaultPolicy() }, "geng-alice", "你是…").args.join(" ");

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
