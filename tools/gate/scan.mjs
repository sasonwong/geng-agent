#!/usr/bin/env node
/**
 * The gate that is not self-reported: three properties a diff scan cannot see.
 *
 * It exists because a symlink to a developer's own node_modules was committed with
 * `git add -A` and reached a public branch: `.gitignore` said `/node_modules/`, which
 * matches a directory, and a symlink is a file. CI ran the two gates that existed —
 * typecheck and tests — and both pass on a tree with a host path in it.
 *
 * It prints counts and locations only, never the matched value: this output goes to a
 * public CI log, and a log that repeats a leaked value is another copy of it.
 *
 * Everything it reads comes from the **index**, not the worktree: `git add -A` is the
 * moment a value becomes public, so that is the moment the gate has to look.
 */
import { execFileSync } from "node:child_process";
import { scanLine, splitLines } from "./patterns.mjs";

// 所有 git 命令都锚在仓库根。从子目录跑时 `git ls-files` 只列当前目录（实测只剩
// tools/gate 下的 3 个文件），门会认认真真扫完那 3 个然后报 ok——最安静的假绿。
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  maxBuffer: 1 << 20,
}).trim();

// stderr 收进管道而不是继承：坏对象会让 git 在 stderr 上写一行 fatal，那行既不是
// 门自己的结论，也不该混进「门报了什么」里。错误由下面的 problems 统一说出来。
const git = (args, maxBuffer = 64 << 20) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
const gitBuffer = (args, maxBuffer = 256 << 20) =>
  execFileSync("git", args, { cwd: ROOT, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });

/**
 * `~`-prefixed home paths are generic; one that names an account is not. The documented
 * examples use a placeholder account, so those are the only ones allowed through.
 *
 * Both shapes below used to be missed: `HOME_ABS` required a trailing slash, so a path
 * that ends the line (`…/home/<account>`, which is how a symlink target or the last word
 * of a note looks) went unseen, and the `~<account>/` form was not looked for at all.
 * This gate covers the machines this project runs on — Linux — and a `~<account>/` path
 * is the same fact in a shorter spelling. Other platforms' home directories are out of
 * scope on purpose: nothing here runs there, so there is no machine to name.
 *
 * Neither shape needs anything after it: `~<account>` alone is still a home directory. What
 * keeps `~1.2.3` out is the account having to start with a letter, not the slash — npm's
 * range syntax is the only tilde this repository writes on purpose.
 *
 * A second tilde is never a home directory: markdown writes `~~struck~~`, and matching the
 * second one would report `主机路径` for a line that names nothing but a deleted sentence.
 */
const HOME_ABS = /\/home\/([A-Za-z0-9._-]+)(?![A-Za-z0-9._-])/g;
const HOME_TILDE = /(?<![A-Za-z0-9._-~])~([A-Za-z][A-Za-z0-9._-]*)(?![A-Za-z0-9._-])/g;
const GENERIC_ACCOUNTS = new Set([
  "agent", "node", "runner", "app", "you", "user", "me", "someone", "example",
]);

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const problems = [];
const warnings = [];

/**
 * 索引是唯一的事实来源，一次 `ls-files -s -z` 就够：
 *
 * - `-s` 直接给出 mode / blob sha / stage，内容按 sha 走 `cat-file blob`，路径不再
 *   参与 `git show :<path>` 的解析。旧写法碰到非 ASCII 文件名时，git 默认会把它
 *   引号转义成 `"\344\270\255..."`，`:` 语法读不到，于是 `catch { continue }`
 *   把整个文件当成「干净」跳过。
 * - `-z` 关掉路径引号与换行分隔，含空格、制表符、换行的文件名也不会被切碎。
 * - stage != 0 是未合并的索引：那不是一棵能判断的树，直接拦。
 */
const entries = gitBuffer(["ls-files", "-s", "-z"]);
const files = [];
for (const record of entries.toString("utf8").split("\0")) {
  if (!record) continue;
  const tab = record.indexOf("\t");
  if (tab === -1) {
    problems.push("索引条目: 解析不了");
    continue;
  }
  const [mode, sha, stage] = record.slice(0, tab).split(" ");
  const path = record.slice(tab + 1);
  if (stage !== "0") {
    problems.push(`索引未合并: ${path}`);
    continue;
  }
  // 符号链接本身要拦，但它的 blob 里写的目标路径同样要扫（那正是主机路径常藏的地方）。
  if (mode === "120000") problems.push(`符号链接: ${path}`);
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") continue; // gitlink
  files.push({ path, sha });
}

/**
 * 索引里的 blob 要么是可读文本，要么门得承认自己没看进去。
 * UTF-16（带 BOM）是文本：不解码就等于给「另存为 Unicode」出来的 .env 开后门。
 * 其余含 NUL / 非法 UTF-8 的一律拦下——旧写法把 `execFileSync(..., encoding: "utf8")`
 * 的替换字符当正文扫，等于什么都没看，还报 ok。
 */
function blobText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const text = buf.subarray(2).toString("utf16le");
    return text.includes("\uFFFD") ? null : text;
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const a = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = a;
    }
    const text = swapped.toString("utf16le");
    return text.includes("\uFFFD") ? null : text;
  }
  if (buf.includes(0)) return null;
  const text = buf.toString("utf8");
  return text.includes("\uFFFD") ? null : text;
}

const contents = new Map();
for (const { path, sha } of files) {
  let buf;
  try {
    buf = gitBuffer(["cat-file", "blob", sha]);
  } catch {
    // 读不到就是读不到。旧写法 `catch { continue; // binary or gone }` 把坏对象、
    // 超过 maxBuffer 的大文件、以及任何 git 报错都翻译成「这个文件很干净」。
    problems.push(`读不到索引内容: ${path}`);
    continue;
  }
  const text = blobText(buf);
  if (text === null) {
    problems.push(`无法检查: ${path}（二进制或非 UTF-8/UTF-16 文本）`);
    continue;
  }
  contents.set(path, text);
}

// 2. An absolute host path names a machine that is not the reader's.
// 2b. 凭据与机器指纹。表在 patterns.mjs，这里只负责读、判、只印位置。
//
// 分级沿用表里的 severity：只有 low 不拦（唯一一条 low 是「9-11 位数字，可能是 IM
// 用户 id」——文档里出现一个数字不该挡住合并）；其余一律拦。打印出来的一律是
// `规则: 文件:行`，没有值。
for (const [f, text] of contents) {
  for (const m of text.matchAll(HOME_ABS)) {
    if (GENERIC_ACCOUNTS.has(m[1])) continue;
    problems.push(`主机路径: ${f}:${lineOf(text, m.index)}`);
  }
  for (const m of text.matchAll(HOME_TILDE)) {
    if (GENERIC_ACCOUNTS.has(m[1])) continue;
    problems.push(`主机路径: ${f}:${lineOf(text, m.index)}`);
  }
  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    for (const hit of scanLine(f, lines[i])) {
      const where = `${hit.name}: ${f}:${i + 1}`;
      if (hit.sev === "low") warnings.push(where);
      else problems.push(where);
    }
  }
}

// 3. Commit identity appears in no diff, so no content scan can see it.
//
// A repository with nothing in it is not a clean repository: this gate's whole value is
// that a green line means "these checks ran and found nothing", and zero files or zero
// commits makes the same green line mean "there was nothing to check". `git log` exits
// non-zero when there is no commit yet, so that case is caught rather than thrown.
const noreply = (email) =>
  email === "noreply@github.com" ||
  email.endsWith("@users.noreply.github.com") ||
  email.endsWith(".invalid");

let emails = new Set();
try {
  const rows = git(["log", "--all", "--format=%H%x09%ae%x09%ce"]).split("\n").filter(Boolean);
  for (const row of rows) {
    const [hash, author, committer] = row.split("\t");
    for (const e of [author, committer]) if (e) emails.add(e);
    const roles = [];
    if (author && !noreply(author)) roles.push("author");
    if (committer && !noreply(committer)) roles.push("committer");
    // 只给提交号和角色。旧写法把邮箱原样打进 `提交身份: ${e}`，而这份输出会进
    // 公开 CI 日志——门一边说「绝不印命中值」，一边把刚抓到的身份又抄了一遍。
    if (roles.length) problems.push(`提交身份: ${hash.slice(0, 8)} 的 ${roles.join(" / ")} 邮箱不是 noreply 地址`);
  }
} catch {
  emails = new Set();
}

// 附注 tag 的 tagger 不在 `git log` 里，但同样会进公开历史。轻量 tag 没有 tagger。
try {
  const tags = git(["for-each-ref", "refs/tags", "--format=%(objecttype)%09%(refname)%09%(taggeremail)"]);
  for (const row of tags.split("\n").filter(Boolean)) {
    const [type, ref, raw] = row.split("\t");
    if (type !== "tag") continue;
    const email = (raw ?? "").replace(/^<|>$/g, "");
    if (!email) continue;
    emails.add(email);
    if (!noreply(email)) problems.push(`提交身份: ${ref} 的 tagger 邮箱不是 noreply 地址`);
  }
} catch {
  problems.push("提交身份: 读不到附注 tag 的 tagger");
}

if (files.length === 0) problems.push("空树: 0 个文件");
if (emails.size === 0) problems.push("提交身份: 0 个（读不到任何提交）");

if (problems.length === 0) {
  const tail = warnings.length === 0 ? "" : `，${warnings.length} 条低级别警告`;
  console.log(`gate: ok（${files.length} 个文件，${emails.size} 个提交身份${tail}）`);
  for (const w of warnings) console.error(`  警告 ${w}`);
  process.exit(0);
}
console.error(`gate: ${problems.length} 处`);
for (const w of warnings) console.error(`  警告 ${w}`);
for (const p of problems) console.error(`  ${p}`);
process.exit(1);
