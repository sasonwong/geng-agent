import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 门是脚本，不是函数：它读的是「当前目录里的 git」，所以这里造真的 git 仓库，用真的
// node 去跑它。测的是门看见什么，不是门里面的实现。
//
// 只测这台机器和 GitHub runner 上真会发生的形状（Linux）。mac / Windows 的主机路径
// 不在这个仓库的历史里，也就不在这里。
//
// 机器名一律拼出来、不照抄：这个测试文件本身也在门的扫描范围里，写死一个真的
// /home/<谁>/ 会被门抓住——那说明门在工作，但也说明测试素材得运行时造。
const ACCOUNT = ["hostname", "alice"].join("-");
const HOST_HOME = ["", "home", ACCOUNT, "proj", "geng"].join("/");
const SCAN = fileURLToPath(new URL("../tools/gate/scan.mjs", import.meta.url));

// Every fixture is a real repository on disk, so it has to be swept up: six of them
// per run is small, but a few hundred runs of the suite is a hundred megabytes of dust.
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "geng-gate-"));
  made.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "dev@example.invalid");
  git("config", "user.name", "dev");
  return dir;
}

function commit(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
}

function scan(dir: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCAN], { cwd: dir, encoding: "utf8" });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

test("a clean tree passes, and the gate says what it counted", () => {
  const dir = repo();
  commit(dir, { "README.md": "示例：/home/you/geng-agent，还有 ~/.pi\n" });
  const r = scan(dir);
  assert.equal(r.code, 0);
  assert.match(r.out, /gate: ok（1 个文件，1 个提交身份）/);
});

test("an absolute Linux home path is caught, and the log never repeats it", () => {
  const dir = repo();
  commit(dir, { "notes.md": `跑起来是这样：${HOST_HOME}/work\n` });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /主机路径: notes\.md:1/);
  // 门自己的输出会进公开的 CI 日志，所以只给位置，不给值
  assert.equal(r.out.includes(ACCOUNT), false);
});

test("the placeholder accounts stay legal — that is what the docs are written with", () => {
  const dir = repo();
  commit(dir, { "doc.md": "/home/agent/.pi，/home/you/x，/home/someone/y\n" });
  assert.equal(scan(dir).code, 0);
});

test("an absolute path in a file the tree does not track is none of the gate's business", () => {
  const dir = repo();
  commit(dir, { "README.md": "ok\n" });
  writeFileSync(join(dir, "scratch.md"), `${HOST_HOME}/secret\n`);
  assert.equal(scan(dir).code, 0);
});

test("a symlink is caught even though .gitignore matches directories, not links", () => {
  const dir = repo();
  commit(dir, { "README.md": "ok\n" });
  symlinkSync("/tmp/somewhere", join(dir, "node_modules"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("add", "-A");
  git("commit", "-q", "-m", "link");
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /符号链接: node_modules/);
});

test("a commit identity that is not a noreply address is caught", () => {
  const dir = repo();
  commit(dir, { "README.md": "ok\n" });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_EMAIL: "dev@corp.example", GIT_COMMITTER_EMAIL: "dev@corp.example" },
  });
  const r = scan(dir);
  assert.equal(r.code, 1);
  // 只断言「说了是哪一类、给了一处」，不断言那句话里印了什么：门要不要把身份值
  // 打进公开日志，是门的事，不该被一条测试钉死。
  assert.match(r.out, /提交身份: /);
  assert.match(r.out, /gate: 1 处/);
});
