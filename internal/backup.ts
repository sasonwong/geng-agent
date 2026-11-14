import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import type { Policy } from "./policy.ts";
import { readJson, readText, writeJson } from "./fs.ts";

/**
 * Snapshot the whole life, cheaply, by dumping the directory and letting rustic's
 * content-defined chunking find the sameness. No incremental logic of our own.
 */

const RETENTION = [
  "--keep-last",
  "2000",
  "--keep-daily",
  "90",
  "--keep-weekly",
  "52",
  "--keep-monthly",
  "24",
];

const EXCLUDES = [
  "node_modules",
  "dist",
  "build",
  "target",
  ".venv",
  "__pycache__",
  ".next",
  "*.tmp-*",
  // The agent's own scratch. Tests run inside it — `mkdtemp` honours `TMPDIR`, and a round
  // that gets killed never runs their cleanup: 539 directories, 33MB, `secrets/*.env`
  // fixtures among them. Nothing there is worth a snapshot, and it was enough to make
  // `doctor` report a key file under `data/`.
  "workspace/tmp",
];

/** What rustic is told to leave out, as argv: a `--glob` and an every-directory glob per entry. */
export function excludeArgs(): string[] {
  return EXCLUDES.flatMap((g) => ["--glob", `!**/${g}`]);
}

const BACKUP_TIMEOUT_MS = 120_000;
const FORGET_TIMEOUT_MS = 120_000;

export interface BackupOutcome {
  status: "ok" | "skip" | "fail";
  detail: string;
  snapshotId?: string;
  ms?: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("rustic", args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => {
      if (stderr.length < 8192) stderr += c;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: "rustic 不在 PATH 上" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? -2 : (code ?? -1),
        stdout,
        stderr: timedOut ? "超时" : stderr,
      });
    });
  });
}

export async function rusticAvailable(): Promise<boolean> {
  const result = await run(["--version"], {}, 10_000);
  return result.code === 0;
}

/**
 * The password never goes on a command line: /proc is world-readable.
 *
 * `null` is "nothing configured"; `"unreadable"` is "the file is there and its bytes are
 * not text". Only one of those is answered by filling the file in, so reporting the second
 * as the first turns a broken secret into a quiet "backup is off".
 */
function readPassword(root: string): string | null | "unreadable" {
  const file = join(root, "secrets", "rustic.env");
  const text = readText(file);
  if (text === null && existsSync(file)) return "unreadable";
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("RUSTIC_PASSWORD=")) continue;
    const value = trimmed.slice("RUSTIC_PASSWORD=".length).trim();
    if (value !== "") return value;
  }
  return process.env.RUSTIC_PASSWORD ?? null;
}

export function backupRepo(paths: Paths): string {
  return join(paths.root, "backup", paths.instance);
}

function repoReady(repo: string): boolean {
  return existsSync(join(repo, "config"));
}

async function ensureRepo(repo: string, env: Record<string, string>): Promise<RunResult> {
  if (repoReady(repo)) return { code: 0, stdout: "", stderr: "" };
  mkdirSync(repo, { recursive: true });
  return run(["-r", repo, "init"], env, 60_000);
}

function baseArgs(repo: string): string[] {
  return ["-r", repo, "--no-progress"];
}

function parseSnapshotId(stdout: string): string | undefined {
  const match = stdout.match(/snapshot\s+([0-9a-f]{6,})/i);
  if (match?.[1]) return match[1];
  const line = stdout.trim().split("\n").filter((l) => l.includes("snapshot")).pop();
  return line?.split(/\s+/).pop() ?? undefined;
}

export interface Snapshot {
  id: string;
  time: string;
  files: number;
}

/** rustic emits two different group shapes across releases; flatten both. Null: the
 *  output is not a snapshot list at all — a different fact from an empty one. */
export function parseSnapshots(text: string): Snapshot[] | null {
  type Entry = {
    id?: string;
    time?: string;
    summary?: { files_new?: number; total_files_processed?: number };
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const flat = parsed.flatMap((g: unknown): Entry[] => {
    if (Array.isArray(g)) return (g[1] as Entry[]) ?? []; // rustic 0.7: [[group, [snaps]]]
    const grouped = (g as { snapshots?: Entry[] }).snapshots; // rustic 0.11: [{group_key, snapshots}]
    return grouped ?? [g as Entry];
  });
  return flat
    .filter((s) => typeof s.id === "string")
    .map((s) => ({
      id: s.id as string,
      time: s.time ?? "",
      files: s.summary?.total_files_processed ?? s.summary?.files_new ?? 0,
    }));
}

export interface SnapshotList {
  /**
   * False means the list could not be read — a wrong password, an unreachable repo, a
   * rustic that answered something else. It used to come back as an empty list, so
   * `restore` said 「没有快照」 over a repo that simply was not reachable, and the
   * operator was told to believe their backups were gone.
   */
  ok: boolean;
  snapshots: Snapshot[];
  detail?: string;
}

export async function listSnapshots(paths: Paths): Promise<SnapshotList> {
  const password = readPassword(paths.root);
  if (password === "unreadable") {
    return { ok: false, snapshots: [], detail: "secrets/rustic.env 在，但字节不是 UTF-8" };
  }
  if (!password) {
    return { ok: false, snapshots: [], detail: "没有密码：secrets/rustic.env 里没有 RUSTIC_PASSWORD" };
  }
  const result = await run(
    [...baseArgs(backupRepo(paths)), "snapshots", "--json"],
    { RUSTIC_PASSWORD: password },
    60_000,
  );
  if (result.code !== 0) {
    return {
      ok: false,
      snapshots: [],
      detail: result.stderr.trim().slice(0, 200) || `rustic 退出 ${result.code}`,
    };
  }
  const parsed = parseSnapshots(result.stdout);
  if (parsed === null) {
    return { ok: false, snapshots: [], detail: "rustic 的输出不是快照列表" };
  }
  return { ok: true, snapshots: parsed };
}

export interface BackupOptions {
  paths: Paths;
  policy: Policy;
  nowMs: number;
}

export async function maybeBackup(o: BackupOptions): Promise<BackupOutcome> {
  const { paths, policy, nowMs } = o;
  if (!policy.backup.enabled) return { status: "skip", detail: "off" };

  const password = readPassword(paths.root);
  if (password === "unreadable") return { status: "fail", detail: "password-unreadable" };
  if (!password) {
    return { status: "skip", detail: "no-password" };
  }
  if (!(await rusticAvailable())) {
    return { status: "skip", detail: "no-rustic" };
  }

  const repo = backupRepo(paths);
  const env = { RUSTIC_PASSWORD: password };
  const started = Date.now();

  const init = await ensureRepo(repo, env);
  if (init.code !== 0) {
    return { status: "fail", detail: `init: ${init.stderr.trim().slice(0, 120)}` };
  }

  writeDeployMeta(paths);

  const globs = excludeArgs();
  const result = await run(
    [...baseArgs(repo), "backup", paths.data, ...globs],
    env,
    BACKUP_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    if (result.code === -1) return { status: "skip", detail: "no-rustic" };
    return { status: "fail", detail: result.stderr.trim().slice(0, 160) || `exit ${result.code}` };
  }

  await maybeForget(paths, repo, env, nowMs);

  const id = parseSnapshotId(result.stdout + result.stderr);
  return { status: "ok", detail: id ?? "", snapshotId: id, ms: Date.now() - started };
}

async function maybeForget(
  paths: Paths,
  repo: string,
  env: Record<string, string>,
  nowMs: number,
): Promise<void> {
  // outside data/: bookkeeping inside the snapshot would dirty every other one
  const file = join(paths.root, "backup", `${paths.instance}.prune.json`);
  const last = readJson<{ atMs?: number }>(file, {}).atMs ?? 0;
  if (nowMs - last < 24 * 60 * 60 * 1000) return;
  const result = await run(
    [...baseArgs(repo), "forget", ...RETENTION, "--prune"],
    env,
    FORGET_TIMEOUT_MS,
  );
  if (result.code === 0) writeJson(file, { atMs: nowMs });
}

/**
 * Which build wrote a snapshot. Restoring a life against a newer binary has to be
 * visible, not mysterious — and that is the only thing this file is for. The image id
 * lives in `meta/state.json` (`env.imageId`, compared every cycle) and the policy's shape
 * lives in the policy file itself; copies here would be fields nobody reads.
 */
export function writeDeployMeta(paths: Paths): void {
  const file = join(paths.meta, "deploy.json");
  const pkg = readJson<{ version?: string }>(join(paths.root, "package.json"), {});
  const next = { daemonVersion: pkg.version ?? null };
  // No timestamp: this file describes the build, not the cycle. Rewriting identical
  // bytes every waking is pure waste.
  if (JSON.stringify(readJson<unknown>(file, null)) === JSON.stringify(next)) return;
  writeJson(file, next);
}

export interface RestoreOptions {
  paths: Paths;
  snapshot?: string;
  target: string;
}

export async function restore(o: RestoreOptions): Promise<{ ok: boolean; detail: string }> {
  const password = readPassword(o.paths.root);
  if (password === "unreadable") return { ok: false, detail: "secrets/rustic.env 在，但字节不是 UTF-8" };
  if (!password) return { ok: false, detail: "没有密码：secrets/rustic.env 里没有 RUSTIC_PASSWORD" };
  const repo = backupRepo(o.paths);
  if (!repoReady(repo)) return { ok: false, detail: `没有仓库：${repo}` };

  let id = o.snapshot;
  if (!id) {
    const list = await listSnapshots(o.paths);
    if (!list.ok) {
      // an unreachable repo is not an empty one: saying 「没有快照」 here told the
      // operator their backups were gone when they were merely not readable
      return { ok: false, detail: `读不出快照列表：${list.detail ?? "?"}` };
    }
    id = list.snapshots[list.snapshots.length - 1]?.id;
    if (!id) return { ok: false, detail: "没有快照" };
  }

  mkdirSync(o.target, { recursive: true });
  const result = await run(
    [...baseArgs(repo), "restore", id, o.target],
    { RUSTIC_PASSWORD: password },
    30 * 60_000,
  );
  return {
    ok: result.code === 0,
    detail: result.code === 0 ? id : result.stderr.trim().slice(0, 200),
  };
}

/**
 * rustic restores absolute paths under the target, so look for the instance root.
 *
 * `palimpsest/` is the book's old name: a snapshot taken before the rename contains that
 * directory instead, and it is still a whole snapshot.
 */
function findInstanceRoot(dir: string, depth = 0): string | null {
  if (existsSync(join(dir, "book")) || existsSync(join(dir, "palimpsest"))) return dir;
  if (depth >= 8) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
  for (const name of entries) {
    const found = findInstanceRoot(join(dir, name), depth + 1);
    if (found) return found;
  }
  return null;
}

/** The one check that proves a backup exists: it can be read back. */
export function restoredLooksWhole(dir: string): { ok: boolean; missing: string[] } {
  const instanceDir = findInstanceRoot(dir);
  if (!instanceDir) return { ok: false, missing: ["book/"] };
  const missing: string[] = [];
  if (!existsSync(join(instanceDir, "meta", "deploy.json"))) missing.push("meta/deploy.json");
  // `session/` is what a snapshot taken before the rename contains. A restore is judged by
  // the shape of the day it was taken, not by today's names: refusing those would say "your
  // backups are broken" exactly when someone reaches for one.
  if (!existsSync(join(instanceDir, "sessions")) && !existsSync(join(instanceDir, "session"))) {
    missing.push("sessions");
  }
  const book = existsSync(join(instanceDir, "book")) ? join(instanceDir, "book") : join(instanceDir, "palimpsest");
  try {
    if (readdirSync(book).length === 0) missing.push("book/ 是空的");
  } catch {
    missing.push("book/");
  }
  return { ok: missing.length === 0, missing };
}
