import { appendLine, readText } from "./fs.ts";
import type { Paths } from "./paths.ts";
import { formatDuration } from "./schedule.ts";

/**
 * 1: the shape below. A record is never rewritten, so an old reader that meets a newer
 * version can skip it instead of guessing — the file is append-only, which is what makes
 * that safe. (state.json cannot afford this: an old writer overwrites it.)
 */
export const LEDGER_SCHEMA = 1;

/** Why this waking happened. `nudge` is the daemon's fallback when no alarm was left. */
export type WakeKind = "timer" | "knock" | "nudge";

/**
 * One finished waking, as acts.
 *
 * Deliberately not money. `tokens`/`cost` are already on the `daemon.log` line and
 * `spendSince` reads them there; a second copy of the same number is how two readers start
 * disagreeing on the night it matters, and money is the one number a person always checks.
 *
 * `talkedTo` and `touched` are the same counts `meta/state.json` keeps for the page — one
 * object, rendered twice — but meta keeps only the last cycle, and this file is the part
 * that keeps them. It is also why the four fields the page never shows (`inj`, `net`,
 * `tools`, `sym`) live here: the page states what the next waking needs, the ledger keeps
 * what an operator needs a week later.
 */
export interface LedgerRecord {
  v: 1;
  /** Which waking: the session file is named after it, so this is the audit pointer. */
  wake: number;
  /** ISO instant the round finished. */
  at: string;
  durMs: number;
  reason: WakeKind;
  /** One of the seven symptoms (`internal/symptoms.ts`). */
  sym: string;
  /** Escalation rung after this round. */
  lvl: number;
  /** Tool calls it made. */
  tools: number;
  /** Messages handed over while it ran (the clock notice does not count). */
  inj: number;
  /** Outbound connections through the proxy. */
  net: number;
  talkedTo: string[];
  /**
   * Wakes it queued a message in: one per `/say`, counted where the round wrote it, not
   * where the gateway delivered it.
   *
   * Delivery is another process on a two-second sweep, and the round is over before that,
   * so a `say` counted on the outbound transcript would land in no round's window at all —
   * exactly the round a person is looking for. Bubbles are not counted: one call is one act.
   */
  said: number;
  /**
   * People those calls named, when the place was known. Outbound only.
   *
   * `talkedTo` counts both directions, which is right for the page ("和谁有往来") and wrong
   * for this file: a message that only arrived is somebody else's act, and counting it here
   * is exactly how a quiet round gets recorded as if it had done something.
   */
  saidTo: string[];
  /** Files written in /work and in the book. */
  touched: number;
}

const REASONS: ReadonlySet<string> = new Set(["timer", "knock", "nudge"]);

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Forgiving on purpose: this file is written by an append + fsync, so a full disk or a
 * power cut can leave a torn last line. One torn line costs one record; refusing the whole
 * file would cost the history, and throwing would cost the command that only wanted to read.
 */
function parseLine(line: string): LedgerRecord | null {
  const text = line.trim();
  if (text === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== LEDGER_SCHEMA) return null;
  const wake = numOrNull(r.wake);
  const durMs = numOrNull(r.durMs);
  const lvl = numOrNull(r.lvl);
  const tools = numOrNull(r.tools);
  const inj = numOrNull(r.inj);
  const net = numOrNull(r.net);
  const said = numOrNull(r.said);
  const touched = numOrNull(r.touched);
  const at = typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? r.at : null;
  const reason = typeof r.reason === "string" && REASONS.has(r.reason) ? (r.reason as WakeKind) : null;
  if (
    wake === null ||
    durMs === null ||
    lvl === null ||
    tools === null ||
    inj === null ||
    net === null ||
    said === null ||
    touched === null ||
    at === null ||
    reason === null ||
    typeof r.sym !== "string"
  ) {
    return null;
  }
  const talkedTo = Array.isArray(r.talkedTo)
    ? r.talkedTo.filter((x): x is string => typeof x === "string")
    : [];
  const saidTo = Array.isArray(r.saidTo) ? r.saidTo.filter((x): x is string => typeof x === "string") : [];
  return {
    v: LEDGER_SCHEMA,
    wake,
    at,
    durMs,
    reason,
    sym: r.sym,
    lvl,
    tools,
    inj,
    net,
    said,
    talkedTo,
    saidTo,
    touched,
  };
}

/**
 * Oldest first, across one rotation. `appendLine` rotates at 20 000 lines, so a ledger
 * that reads only the live file would report a shorter history than happened — the same
 * hole `spendSince` had to close for `daemon.log`.
 */
export function readLedger(paths: Paths, opts: { sinceMs?: number; limit?: number } = {}): LedgerRecord[] {
  const text = [readText(`${paths.ledger}.1`) ?? "", readText(paths.ledger) ?? ""].join("\n");
  const out: LedgerRecord[] = [];
  for (const line of text.split("\n")) {
    const rec = parseLine(line);
    if (rec === null) continue;
    if (opts.sinceMs !== undefined && Date.parse(rec.at) < opts.sinceMs) continue;
    out.push(rec);
  }
  return opts.limit !== undefined && out.length > opts.limit ? out.slice(-opts.limit) : out;
}

/** One write per finished waking, from the same values the page and the log line got. */
export function appendLedger(paths: Paths, rec: LedgerRecord): void {
  appendLine(paths.ledger, JSON.stringify(rec));
}

export interface LedgerDigest {
  cycles: number;
  byWake: Record<WakeKind, number>;
  bySym: Record<string, number>;
  /** Wakes nobody asked for: timer and nudge both mean the clock, not a person. */
  unprompted: number;
  /** Of those, the ones that left something behind: wrote a file or said a word. */
  unpromptedActed: number;
  /** Any waking that wrote or spoke, whoever started it. */
  acted: number;
  /** File writes, counted per waking: one file touched in three rounds counts three. */
  touched: number;
  /** Wakes in which it said something of its own (outbound only). */
  spoke: number;
  /** Wakes in which it exchanged words with somebody, whoever spoke first. */
  talkedTo: string[];
  /** The subset of those it queued a message to (names only where the place was known). */
  saidTo: string[];
  /** Wakes that did not end with `sym=ok`. */
  notOk: number;
  worstLvl: number;
}

/**
 * The one number this file exists for is `unpromptedActed`: it removes the person from the
 * cycle and asks whether anything happened anyway. Everything else here is context for it.
 */
export function digestLedger(records: LedgerRecord[]): LedgerDigest {
  const byWake: Record<WakeKind, number> = { timer: 0, knock: 0, nudge: 0 };
  const bySym: Record<string, number> = {};
  const who = new Set<string>();
  const spokeTo = new Set<string>();
  let unprompted = 0;
  let unpromptedActed = 0;
  let acted = 0;
  let touched = 0;
  let spoke = 0;
  let notOk = 0;
  let worstLvl = 0;
  for (const r of records) {
    byWake[r.reason] += 1;
    bySym[r.sym] = (bySym[r.sym] ?? 0) + 1;
    // Outbound only: what this round queued, not what arrived (see `said`).
    const did = r.touched > 0 || r.said > 0;
    if (did) acted += 1;
    if (r.reason !== "knock") {
      unprompted += 1;
      if (did) unpromptedActed += 1;
    }
    touched += r.touched;
    if (r.said > 0) spoke += 1;
    for (const name of r.talkedTo) who.add(name);
    for (const name of r.saidTo) spokeTo.add(name);
    if (r.sym !== "ok") notOk += 1;
    if (r.lvl > worstLvl) worstLvl = r.lvl;
  }
  return {
    cycles: records.length,
    byWake,
    bySym,
    unprompted,
    unpromptedActed,
    acted,
    touched,
    spoke,
    talkedTo: [...who],
    saidTo: [...spokeTo],
    notOk,
    worstLvl,
  };
}

/** Lines for a person, no conclusion drawn: same facts as the digest, phrased as counts. */
export function formatLedgerDigest(instance: string, records: LedgerRecord[], window: string): string[] {
  const d = digestLedger(records);
  const bad = Object.entries(d.bySym)
    .filter(([sym]) => sym !== "ok")
    .sort((a, b) => b[1] - a[1])
    .map(([sym, n]) => `${sym} ${n}`);
  const lines = [
    `${instance}  账本：${window} · ${d.cycles} 轮`,
    `  醒来      ${d.byWake.timer} 定时 · ${d.byWake.knock} 敲门 · ${d.byWake.nudge} 兜底`,
    `  自己动的  ${d.unpromptedActed} / ${d.unprompted} 轮（不是被敲门叫醒，且写了东西或说了话）`,
    `  说过话    ${d.spoke} 轮 · ${d.saidTo.length} 个人`,
    `  写文件    共 ${d.touched} 次（同一文件跨轮重复计）`,
    ...(d.worstLvl > 0 ? [`  最高档    第 ${d.worstLvl} 档`] : []),
    `  非 ok     ${d.notOk} 轮${bad.length > 0 ? `（${bad.join(" · ")}）` : ""}`,
  ];
  const last = records[records.length - 1];
  if (last !== undefined) {
    lines.push(`  最近      ${last.at} #${last.wake} ${last.reason}/${last.sym} ${formatDuration(last.durMs)}`);
  }
  return lines;
}

const SINCE_UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * `30m` / `24h` / `7d` / `all`, a date, or an ISO instant. A bare number is not accepted:
 * `--since 7` reads as seven of something, and "seven seconds" and "seven days" are both
 * plausible.
 */
export function parseSince(text: string, nowMs: number): number | undefined {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (lower === "all") return undefined;
  const m = /^(\d+)\s*([mhd])$/.exec(lower);
  if (m !== null) {
    const n = Number(m[1]);
    const unit = SINCE_UNIT[m[2] as string];
    if (unit !== undefined && Number.isFinite(n)) return nowMs - n * unit;
  }
  // A bare date means local midnight. `Date.parse("2026-03-02")` is UTC midnight, which in
  // +08 is the evening before: `--since 2026-03-02` would silently skip eight hours of the
  // day the person named.
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const parts = t.split("-").map(Number);
    const y = parts[0] ?? 0;
    const mo = parts[1] ?? 1;
    const d = parts[2] ?? 1;
    return new Date(y, mo - 1, d).getTime();
  }
  // Date.parse is lenient in V8 — `"7"` is July 2001, `"2026"` is a year — and a bare
  // number is exactly the ambiguity this function refuses: seven of what? So an instant
  // has to look like one before it is handed over.
  if (!/^\d{4}-\d{2}-\d{2}([t ].+)$/.test(lower)) {
    throw new Error(`--since 只认 30m / 24h / 7d / all 或一个 ISO 时刻（收到 ${text}）`);
  }
  const at = Date.parse(t);
  if (Number.isNaN(at)) {
    throw new Error(`--since 只认 30m / 24h / 7d / all 或一个 ISO 时刻（收到 ${text}）`);
  }
  return at;
}
