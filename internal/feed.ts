import { spawn } from "node:child_process";
import { join } from "node:path";
import { ExpectedError } from "./errors.ts";
import type { Paths } from "./paths.ts";
import { readJson, writeJson } from "./state.ts";

/**
 * The part of the world that changed state without anyone saying a word.
 *
 * A pull request gets approved, or its checks turn red, and nobody tells the agent:
 * the only moment it used to learn about it was when a human got tired of waiting and
 * wrote something. So this is a **feeder**, not a part of the daemon — it runs as its
 * own oneshot timer, makes one `gh` call, writes what changed into the inbox, and
 * exits. The daemon (and its cycle) still never touches the network.
 *
 * It is deliberately narrow: only its own pull requests, and only transitions in
 * fields GitHub itself decides. No reading of comment text, no scoring, no summary —
 * if a rule here needed to understand a sentence, the signal would be wrong.
 */

export type Ci = "none" | "pending" | "green" | "red";

export interface PrFacts {
  number: number;
  title: string;
  url: string;
  /** OPEN / MERGED / CLOSED, as GitHub spells it. */
  state: string;
  draft: boolean;
  /** GitHub's `reviewDecision`: APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED / "". */
  review: string;
  head: string;
  ci: Ci;
}

/** What was true at the previous run. Events are differences from this. */
export type Seen = Record<string, { state: string; review: string; ci: Ci }>;

export type FeedKind =
  | "can-merge"
  | "changes-requested"
  | "ci-red"
  | "ci-green"
  | "merged"
  | "closed";

export interface FeedEvent {
  kind: FeedKind;
  pr: PrFacts;
  /** Calls it: the two states where somebody is waiting on it, plus its own red build. */
  knock: boolean;
}

const RED = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);
const FINE = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * One verdict for the whole rollup. Red beats pending: a finished job that failed is a
 * fact, while "one more is still running" is only the absence of one.
 * CheckRun carries `conclusion`/`status`, StatusContext carries `state`.
 */
export function ciOf(rollup: unknown): Ci {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let pending = false;
  for (const raw of rollup) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as { conclusion?: unknown; state?: unknown; status?: unknown };
    const verdict = String(c.conclusion ?? c.state ?? "").toUpperCase();
    if (FINE.has(verdict)) continue;
    if (RED.has(verdict)) return "red";
    // QUEUED / IN_PROGRESS / PENDING / EXPECTED / anything unknown is still "not yet"
    pending = true;
  }
  return pending ? "pending" : "green";
}

/** Whatever `gh` printed, or nothing. A shape it does not recognise is not a message. */
export function parsePrs(raw: unknown): PrFacts[] {
  if (!Array.isArray(raw)) return [];
  const out: PrFacts[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const number = typeof o.number === "number" ? o.number : Number(o.number);
    const state = typeof o.state === "string" ? o.state.toUpperCase() : "";
    if (!Number.isFinite(number) || state === "") continue;
    out.push({
      number,
      title: typeof o.title === "string" ? o.title : "",
      url: typeof o.url === "string" ? o.url : "",
      state,
      draft: o.isDraft === true,
      review: typeof o.reviewDecision === "string" ? o.reviewDecision : "",
      head: typeof o.headRefOid === "string" ? o.headRefOid : "",
      ci: ciOf(o.statusCheckRollup),
    });
  }
  return out;
}

export function seenOf(prs: PrFacts[]): Seen {
  const out: Seen = {};
  for (const pr of prs) out[String(pr.number)] = { state: pr.state, review: pr.review, ci: pr.ci };
  return out;
}

/**
 * Differences only. The first sight of a pull request is the baseline, not news — it
 * opened it itself, and a fresh feed must not hand over the whole history on install.
 */
export function eventsOf(before: Seen, prs: PrFacts[]): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const pr of prs) {
    const prev = before[String(pr.number)];
    // A draft is not a thing to look at yet; it will be seen for the first time when it
    // is ready, and that is still the agent's own doing.
    if (pr.draft || prev === undefined) continue;
    if (prev.state === "OPEN" && pr.state !== "OPEN") {
      out.push({ kind: pr.state === "MERGED" ? "merged" : "closed", pr, knock: false });
      continue; // a finished pull request has no review or checks left to report
    }
    if (pr.state !== "OPEN") continue;
    if (prev.review !== pr.review) {
      // Only the two decisions GitHub makes about *its* work. Losing an approval after
      // its own push (APPROVED → REVIEW_REQUIRED) is its own doing and stays quiet.
      if (pr.review === "APPROVED") out.push({ kind: "can-merge", pr, knock: true });
      else if (pr.review === "CHANGES_REQUESTED") out.push({ kind: "changes-requested", pr, knock: true });
    }
    if (prev.ci !== pr.ci) {
      if (pr.ci === "red") out.push({ kind: "ci-red", pr, knock: true });
      else if (pr.ci === "green" && prev.ci === "red") out.push({ kind: "ci-green", pr, knock: false });
    }
  }
  return out;
}

const CI_WORD: Record<Ci, string> = {
  none: "ci 没配",
  pending: "ci 在跑",
  green: "ci 绿",
  red: "ci 红",
};

const REVIEW_WORD: Record<string, string> = {
  APPROVED: "review APPROVED",
  CHANGES_REQUESTED: "review CHANGES_REQUESTED",
  REVIEW_REQUIRED: "review 等审批",
  "": "review 等审批",
};

const KIND_WORD: Record<FeedKind, string> = {
  "can-merge": "可以合了",
  "changes-requested": "有人要求改",
  "ci-red": "ci 红了",
  "ci-green": "ci 转绿",
  merged: "已经合入",
  closed: "被关掉了，没合",
};

/** Facts and a link. No advice: the agent decides what to do with them. */
export function textOf(e: FeedEvent): string {
  const p = e.pr;
  const head = `PR #${p.number} ${KIND_WORD[e.kind]} · ${REVIEW_WORD[p.review] ?? `review ${p.review}`} · ${CI_WORD[p.ci]}`;
  return [head, p.title, p.url].filter((line) => line !== "").join("\n");
}

export function fileNameOf(e: FeedEvent): string {
  // Not a timestamp: one file per pull request per kind means a repeat can only
  // overwrite, never pile up, and an unread one still reads as the newest state.
  return `github-${e.pr.number}-${e.kind}.json`;
}

/** Which of the two inboxes: a knock calls it, the rest waits for a waking anyway. */
export function writeEvents(p: Paths, events: FeedEvent[], now: Date = new Date()): string[] {
  const written: string[] = [];
  for (const e of events) {
    const dir = e.knock ? p.inbox : p.inboxLow;
    const id = fileNameOf(e).replace(/\.json$/, "");
    writeJson(join(dir, `${id}.json`), {
      id,
      text: textOf(e),
      from: "github",
      at: now.toISOString(),
    });
    written.push(join(dir, `${id}.json`));
  }
  return written;
}

export interface FeedEnv {
  /** `owner/name`. Nothing is guessed from a working directory: this runs from a timer. */
  repo: string;
  /** Empty means `gh` falls back to its own credential store (GH_CONFIG_DIR). */
  token: string;
}

/** Read from the unit's EnvironmentFile, so the values never live in the repository. */
export function readFeedEnv(env: NodeJS.ProcessEnv = process.env): FeedEnv | null {
  const repo = (env.GENG_GITHUB_REPO ?? "").trim();
  if (repo === "") return null;
  return { repo, token: (env.GH_TOKEN ?? "").trim() };
}

const FIELDS = "number,title,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGh(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("gh", args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
      resolve({ code: -1, stdout: "", stderr: "gh 不在 PATH 上" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -2 : (code ?? -1), stdout, stderr: timedOut ? "超时" : stderr });
    });
  });
}

/**
 * `--limit` bounds how many PRs one pass can see. A PR that falls off the window keeps
 * its snapshot entry (see `mergeSeen`), so coming back later is a comparison, not a
 * first sight: otherwise the approve that pushed it back into view is the silent one.
 */
export async function listOwnPrs(
  o: { repo: string; token: string; limit?: number; timeoutMs?: number },
): Promise<PrFacts[]> {
  const args = [
    "pr",
    "list",
    "--repo",
    o.repo,
    "--author",
    "@me",
    "--state",
    "all",
    "--limit",
    String(o.limit ?? 30),
    "--json",
    FIELDS,
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1" };
  // The token goes through the environment, never a command line: /proc is readable.
  if (o.token !== "") env.GH_TOKEN = o.token;
  const result = await runGh(args, env, o.timeoutMs ?? 30_000);
  if (result.code !== 0) {
    const why = result.stderr.trim().split("\n").slice(-3).join(" / ");
    throw new ExpectedError(`gh pr list 失败（${result.code}）：${why === "" ? "没有输出" : why}`);
  }
  try {
    return parsePrs(JSON.parse(result.stdout));
  } catch {
    throw new ExpectedError("gh 的输出不是 JSON，什么都没写");
  }
}

/**
 * Union, never replacement. Two ways a pass can show fewer PRs than it knows about:
 * one falls outside `--limit` after the window shifts, or the call resolves to nobody
 * at all (a token that is not the account's own, an installation token, `@me` with no
 * answer). Overwriting would treat every one of them as first sight, and a first sight
 * is not news — that is the silence this feeder exists to remove. Only `undefined` is a
 * real baseline. Cost: an entry per PR ever seen (~50 bytes) that is never pruned.
 */
export function mergeSeen(before: Seen, prs: PrFacts[]): Seen {
  return { ...before, ...seenOf(prs) };
}

export interface FeedRun {
  paths: Paths;
  repo: string;
  token: string;
  log?: (line: string) => void;
}

/**
 * One pass. Knocks are written before the snapshot: a crash in between repeats one
 * message, while the other order would lose it for good.
 */
export async function runGithubFeed(o: FeedRun): Promise<FeedEvent[]> {
  const log = o.log ?? (() => {});
  const prs = await listOwnPrs({ repo: o.repo, token: o.token });
  const seenFile = join(o.paths.feedDir, "github.seen.json");
  const before = readJson<Seen>(seenFile, {});
  const events = eventsOf(before, prs);
  writeEvents(o.paths, events);
  writeJson(seenFile, mergeSeen(before, prs));
  // "no PR at all" and "nothing moved" read the same from the outside; say which.
  if (prs.length === 0) log("一条 PR 都没取到——token 是不是自己账号的？");
  for (const e of events) log(`${e.knock ? "敲门" : "记下"}  PR #${e.pr.number} ${e.kind}`);
  return events;
}
