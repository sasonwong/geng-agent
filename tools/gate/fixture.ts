/**
 * The repository the gate's tests run against: a fixture, not this machine's repo.
 *
 * Global and system git config used to leak in. `commit.gpgsign` and `user.signingkey`
 * made `git commit` fail outright, `core.hooksPath` added hooks, `commit.template` rewrote
 * the message, `core.autocrlf` rewrote file contents. Which shape the gate saw therefore
 * depended on who was running the tests — worse than having no test, because green stopped
 * meaning anything.
 *
 * It deletes a **prefix**, not a list of names. git reads configuration through at least
 * four channels: the global and system files, the file `GIT_CONFIG` points at, the
 * `GIT_CONFIG_COUNT/KEY_n/VALUE_n` group (equivalent to `-c`), and `GIT_CONFIG_PARAMETERS`
 * — what `git -c key=val <cmd>` really writes into the child environment, which `git commit`
 * passes on. Enumerating names missed the last one once already, so every `GIT_*` goes:
 * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` name a person and `GIT_DIR` / `GIT_WORK_TREE` name a
 * repository, and neither belongs to a fixture either. The two we want are set back after.
 *
 * They can only be **deleted**, never pointed at /dev/null under the original name: once
 * `GIT_CONFIG` is set, `git config --local` refuses with "only one config file at a time".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function cleanGitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k.startsWith("GIT_")) env[k] = v;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

export const CLEAN_GIT = cleanGitEnv(process.env);

export const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: CLEAN_GIT });

// Every fixture is a real repository on disk, so it has to be swept up: a few of them per
// run is small, but a few hundred runs of the suite is a hundred megabytes of dust.
const made: string[] = [];

export function cleanupRepos(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function repo(prefix = "geng-gate-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  gitIn(dir, "init", "-q");
  gitIn(dir, "config", "--local", "user.email", "dev@example.invalid");
  gitIn(dir, "config", "--local", "user.name", "dev");
  return dir;
}

export function commit(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "fixture");
}

export const SCAN = fileURLToPath(new URL("scan.mjs", import.meta.url));

/** Run the gate in `dir` the way CI does: same node, same env, no host git config. */
export function scan(dir: string): { code: number; out: string } {
  const r = spawnSync(process.execPath, [SCAN], { cwd: dir, encoding: "utf8", env: CLEAN_GIT });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
