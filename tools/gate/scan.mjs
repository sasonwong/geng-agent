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
 */
import { execFileSync } from "node:child_process";

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 });

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

// 1. A symlink in the tree can point anywhere, including off the machine.
for (const line of git(["ls-files", "-s"]).split("\n").filter(Boolean)) {
  if (!line.startsWith("120000")) continue;
  const path = line.split("\t")[1] ?? "?";
  problems.push(`符号链接: ${path}`);
}

// 2. An absolute host path names a machine that is not the reader's.
const files = git(["ls-files"]).split("\n").filter(Boolean);
for (const f of files) {
  let text;
  try {
    text = git(["show", `:${f}`]);
  } catch {
    continue; // binary or gone
  }
  for (const m of text.matchAll(HOME_ABS)) {
    if (GENERIC_ACCOUNTS.has(m[1])) continue;
    problems.push(`主机路径: ${f}:${lineOf(text, m.index)}`);
  }
  for (const m of text.matchAll(HOME_TILDE)) {
    if (GENERIC_ACCOUNTS.has(m[1])) continue;
    problems.push(`主机路径: ${f}:${lineOf(text, m.index)}`);
  }
}

// 3. Commit identity appears in no diff, so no content scan can see it.
//
// A repository with nothing in it is not a clean repository: this gate's whole value is
// that a green line means "these checks ran and found nothing", and zero files or zero
// commits makes the same green line mean "there was nothing to check". `git log` exits
// non-zero when there is no commit yet, so that case is caught rather than thrown.
let emails = new Set();
try {
  emails = new Set(git(["log", "--all", "--format=%ae%n%ce"]).split("\n").filter(Boolean));
} catch {
  emails = new Set();
}
if (files.length === 0) problems.push("空树: 0 个文件");
if (emails.size === 0) problems.push("提交身份: 0 个（读不到任何提交）");
for (const e of emails) {
  if (e.endsWith("@users.noreply.github.com") || e === "noreply@github.com") continue;
  if (e.endsWith(".invalid")) continue;
  problems.push(`提交身份: ${e}`);
}

if (problems.length === 0) {
  console.log(`gate: ok（${files.length} 个文件，${emails.size} 个提交身份）`);
  process.exit(0);
}
console.error(`gate: ${problems.length} 处`);
for (const p of problems) console.error(`  ${p}`);
process.exit(1);
