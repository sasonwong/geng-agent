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
 * `~`-prefixed home paths are generic; an absolute one names a machine. The documented
 * examples use a placeholder account, so those are the only ones allowed through.
 *
 * Three shapes, because the leak comes from whichever machine the contributor was on:
 * `/home/<account>/` on Linux, `/Users/<account>/` on macOS, `C:\Users\<account>\` on
 * Windows. Backslashes may be written doubled (a JSON string), hence `\\+`.
 */
const HOME_ABS = [
  /\/(?:home|Users)\/([A-Za-z0-9._-]+)\//g,
  /[A-Za-z]:\\+Users\\+([A-Za-z0-9._-]+)/g,
];
const GENERIC_ACCOUNTS = new Set(["agent", "you", "user", "someone"]);

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
  for (const re of HOME_ABS) {
    for (const m of text.matchAll(re)) {
      if (GENERIC_ACCOUNTS.has(m[1])) continue;
      const line = text.slice(0, m.index).split("\n").length;
      problems.push(`主机路径: ${f}:${line}`);
    }
  }
}

// 3. Commit identity appears in no diff, so no content scan can see it.
const emails = new Set(git(["log", "--all", "--format=%ae%n%ce"]).split("\n").filter(Boolean));
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
