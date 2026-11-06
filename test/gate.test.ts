import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
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
const TOKEN = ["gh", "p_", "A".repeat(24)].join("");

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
  // 说哪一类、哪一处就够。门自己的输出会进公开 CI 日志，把刚抓到的邮箱再抄一遍
  // 等于多留一份拷贝——和文件头写着的「never the matched value」正好相反。
  assert.match(r.out, /提交身份: /);
  assert.match(r.out, /gate: 1 处/);
  assert.equal(r.out.includes("dev@corp.example"), false, "公开日志里不能印身份值");
});

test("a bare login noreply is the legacy form: it credits whoever owns that login", () => {
  const dir = repo();
  commit(dir, { "README.md": "ok\n" });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...CLEAN_GIT,
      GIT_AUTHOR_EMAIL: "someone@users.noreply.github.com",
      GIT_COMMITTER_EMAIL: "someone@users.noreply.github.com",
    },
  });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /提交身份: /);
});

test("the modern noreply — digits, a plus, and an App's [bot] — is the one that passes", () => {
  const dir = repo();
  commit(dir, { "README.md": "ok\n" });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "x"], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...CLEAN_GIT,
      GIT_AUTHOR_EMAIL: "5640022+geng-agent-bots[bot]@users.noreply.github.com",
      GIT_COMMITTER_EMAIL: "5640022+geng-agent-bots[bot]@users.noreply.github.com",
    },
  });
  assert.equal(scan(dir).code, 0);
});

// 下面几条钉的是「门没看见」和「门说干净」长得一模一样的那几种形状。旧实现把
// `git show :<path>` 的失败一律 `catch { continue }`，于是非 ASCII 文件名、读不到的
// blob、二进制内容都能换来一行 gate: ok；从子目录跑则干脆只扫那一个目录。

test("a non-ASCII filename is scanned, not silently skipped", () => {
  const dir = repo();
  const name = ["笔", "记.md"].join("");
  commit(dir, { "README.md": "ok\n" });
  writeFileSync(join(dir, name), `调用时带上 ${TOKEN}\n`);
  gitIn(dir, "add", "-A"); // 门读的是 index，`git add` 就是它该看的那一刻
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /GitHub 令牌: /);
  assert.equal(r.out.includes(TOKEN), false);
});

test("running the gate from a subdirectory still checks the whole tree", () => {
  const dir = repo();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "README.md"), `调用时带上 ${TOKEN}\n`);
  commit(dir, { "sub/ok.md": "ok\n" }); // add -A 会把上面那份 README 一起收进去
  const r = scan(dir, join(dir, "sub"));
  assert.equal(r.code, 1);
  assert.match(r.out, /GitHub 令牌: README\.md:1/);
  assert.equal(r.out.includes(TOKEN), false);
});

test("an index entry whose blob cannot be read is a failure, not a clean file", () => {
  const dir = repo();
  commit(dir, { "README.md": "ok\n" });
  // 索引里能挂住一个不存在的 sha，cat-file 读不出来。旧写法把报错吞成「这个文件很干净」。
  gitIn(dir, "update-index", "--add", "--cacheinfo", `100644,${"a".repeat(39)}1,ghost.txt`);
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /读不到索引内容: ghost\.txt/);
});

test("a credential saved as UTF-16 is still a credential", () => {
  const dir = repo();
  const line = `GENG_MAIL_TOKEN=${["Zm9vYmFy", "YmF6cXV4MTIzNDU2Nzg5MA"].join("")}\n`;
  writeFileSync(join(dir, "u16.env"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, "utf16le")]));
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "fixture");
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /(?:密钥赋值|口令赋值): u16\.env:1/);
});

test("a blob the gate cannot decode is named, not waved through", () => {
  const dir = repo();
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "fixture");
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /无法检查: blob\.bin/);
});

test("an annotated tag's tagger is an identity the gate has to see", () => {
  const dir = repo();
  commit(dir, { "README.md": "ok\n" });
  execFileSync("git", ["tag", "-a", "v1", "-m", "tag"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...CLEAN_GIT, GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "tag@corp.example" },
  });
  const r = scan(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /refs\/tags\/v1 的 tagger/);
  assert.equal(r.out.includes("tag@corp.example"), false);
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
