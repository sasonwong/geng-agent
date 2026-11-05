import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 这个 Worker 不在根 package 里，`npm run check` 和 `tsc` 都看不到它；语法错了要等
// 部署到 Cloudflare、第一封信被退回来才知道。这里让 `npm test`（CI 也跑）替它兜住。
const REPO = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(REPO, "deploy", "mail-worker");
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

test("the worker and its deploy script parse", () => {
  for (const [cmd, args] of [
    ["node", ["--check", join(DIR, "worker.js")]],
    ["bash", ["-n", join(DIR, "deploy.sh")]],
  ] as const) {
    const r = spawnSync(cmd, [...args], { encoding: "utf8" });
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
  }
  // 没有注释的 jsonc 就是 JSON；写错一个逗号的 wrangler deploy 才报错。
  assert.equal(JSON.parse(read("wrangler.jsonc")).name, "geng-mail");
});

test("an explicit token wins over the file, and the README says the same", () => {
  const script = read("deploy.sh");
  const readme = read("README.md");
  const envFirst = script.indexOf('TOKEN="${GENG_MAIL_TOKEN:-}"');
  const fileFallback = script.indexOf("[ -f ../../secrets/mail.env ]");
  assert.ok(envFirst >= 0 && fileFallback > envFirst, "环境变量要先读，文件是兜底");
  assert.match(readme, /优先用环境变量 `GENG_MAIL_TOKEN`/, "文档不能反过来说文件优先");
});

test("a skipped mail is logged, not bounced", () => {
  const worker = read("worker.js");
  assert.match(worker, /body\.skipped/, "宿主有意跳过的 200 要看得见");
  assert.match(worker, /if \(!response\.ok\) throw/, "投递失败仍然退信");
  assert.match(read("README.md"), /POST 失败就 `throw`/);
});

test("the tunnel points at the address the endpoint actually binds", () => {
  // 端点只绑 127.0.0.1；`localhost` 先解析到 ::1 时 cloudflared 连不上，表现是 502。
  assert.match(read("README.md"), /Service `http:\/\/127\.0\.0\.1:8788`/);
  assert.equal(/Service `http:\/\/localhost:8788`/.test(read("README.md")), false);
  const install = readFileSync(join(REPO, "docs", "install.md"), "utf8");
  assert.match(install, /指向 `http:\/\/127\.0\.0\.1:8788` 的 hostname/);
});
