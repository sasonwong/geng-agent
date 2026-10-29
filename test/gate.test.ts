import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLEAN_GIT, cleanupRepos, cleanGitEnv, commit, gitIn, repo, scan } from "../tools/gate/fixture.ts";

// 门是脚本，不是函数：它读的是「当前目录里的 git」，所以这里造真的 git 仓库，用真的
// node 去跑它。测的是门看见什么，不是门里面的实现。夹具本身（以及它为什么必须不继承
// 这台机器的 git 配置）在 tools/gate/fixture.ts。
//
// 只测这台机器和 GitHub runner 上真会发生的形状（Linux）。mac / Windows 的主机路径
// 不在这个仓库的历史里，也就不在这里。
//
// 机器名一律拼出来、不照抄：这个测试文件本身也在门的扫描范围里，写死一个真的
// /home/<谁>/ 会被门抓住——那说明门在工作，但也说明测试素材得运行时造。
const ACCOUNT = ["hostname", "alice"].join("-");
const HOST_HOME = ["", "home", ACCOUNT, "proj", "geng"].join("/");

after(cleanupRepos);

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

// 下面四条钉的是同一件事的另一半：门「没看见」不等于「没有」。
//
// 一个路径如果正好是行尾（符号链接的 target、笔记里的最后一个词就是这样），旧正则
// 要求尾随斜杠，于是整条漏掉；`~<account>/` 这种短写法根本没被找过。这两种「看不见」
// 和「干净」在输出上长得一模一样，所以只能靠测试区分。

test("a home path that ends the line is still a host path", () => {
  const dir = repo();
  commit(dir, { "notes.md": `家目录是 ${["", "home", ACCOUNT].join("/")}\n` });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /主机路径: notes\.md:1/);
  assert.equal(r.out.includes(ACCOUNT), false);
});

test("the short spelling of a home path is the same fact", () => {
  const dir = repo();
  commit(dir, { "notes.md": `别名指向 ~${ACCOUNT}/geng\n` });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /主机路径: notes\.md:1/);
  assert.equal(r.out.includes(ACCOUNT), false);
});

test("a bare tilde plus an account ends the line the same way", () => {
  const dir = repo();
  commit(dir, { "notes.md": `链接指向 ~${ACCOUNT}\n` });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /主机路径: notes\.md:1/);
  assert.equal(r.out.includes(ACCOUNT), false);
});

test("a tilde with no account is not a host — it is how the docs say it", () => {
  const dir = repo();
  commit(dir, { "doc.md": "配置在 ~/.pi，备份到 ~/backup，另见 ~/geng-agent，版本 ~1.2.3，删除线 ~~旧写法~~ 也不是路径\n" });
  assert.equal(scan(dir).code, 0);
});

test("a repository with no commits is not a clean repository", () => {
  // 空的 `git init` 是最容易误读成绿灯的形状：文件 0 个、身份 0 个，两条检查都
  // 「通过」，而实际上什么都没检查。`git log` 在这里还会非零退出。
  const dir = repo();
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /提交身份: 0 个/);
  assert.match(r.out, /空树: 0 个文件/);
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
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "link");
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
    env: { ...CLEAN_GIT, GIT_AUTHOR_EMAIL: "dev@corp.example", GIT_COMMITTER_EMAIL: "dev@corp.example" },
  });
  const r = scan(dir);
  assert.equal(r.code, 1);
  // 只断言「说了是哪一类、给了一处」，不断言那句话里印了什么：门要不要把身份值
  // 打进公开日志，是门的事，不该被一条测试钉死。
  assert.match(r.out, /提交身份: /);
  assert.match(r.out, /gate: 1 处/);
});

test("the fixture does not inherit the machine's git config", () => {
  // `%G?` 是「这个提交有没有签名」：`N` = 没有。签名是环境的事，不是夹具的事；一条
  // 全局的 gpgsign 不该决定门能不能被测。反过来说，这条测试在没配签名的机器上
  // 永远绿——它只在配置了签名的机器上才有区分力，而那正是它会坏的地方。
  const dir = repo();
  commit(dir, { "README.md": "ok\n" });
  assert.equal(gitIn(dir, "log", "-1", "--format=%G?").trim(), "N");
});

test("every channel git reads configuration from is closed", () => {
  // 这不是测 git，是测上面那个函数有没有把四类通道全关掉。敌意配置从三个方向来：
  // 两个文件、`GIT_CONFIG` 指的文件、以及 `-c` 等价的那组变量。少关一类，夹具的
  // 形状就又会由谁来跑决定。`GIT_DIR` 和 `GIT_AUTHOR_*` 不是配置，但同属「这台机器
  // 的状态」：一个指仓库、一个指人，夹具两样都不该继承。
  const env = cleanGitEnv({
    PATH: "/usr/bin",
    GIT_CONFIG: "/tmp/hostile.gitconfig",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "commit.gpgsign",
    GIT_CONFIG_VALUE_0: "true",
    GIT_CONFIG_PARAMETERS: "'commit.gpgsign'='true'",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/tmp/hostile.gitconfig",
    GIT_CONFIG_SYSTEM: "/tmp/hostile.gitconfig",
    GIT_DIR: "/tmp/hostile.git",
    GIT_AUTHOR_EMAIL: "dev@corp.example",
  });
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, undefined);
  assert.equal(env.GIT_CONFIG, undefined);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_AUTHOR_EMAIL, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(env.PATH, "/usr/bin", "其他环境变量原样保留");
});
