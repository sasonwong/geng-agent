import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { readJson, writeJson } from "./fs.ts";
import { STATE_SCHEMA } from "./schema.ts";
import type { KnockHold } from "./schedule.ts";

/** What the waking was run with, so a change of environment can be stated as fact. */
export interface Env {
  imageId?: string | null;
  /** Whether the search tool exists for this container, which the env file decides. */
  search?: boolean;
}

/**
 * Everything the daemon counts about itself. One reader, used by the daemon, by
 * status and by doctor: two readers is how "上次醒来" quietly goes stale.
 */
export interface Meta {
  /** Stamped by writeMeta: the shape the code expects to read back. */
  stateSchema?: number;
  lastWakeMs?: number;
  wakings?: number;
  /** The last thing it said, so a fresh-context waking knows how it left things. */
  lastSaid?: string | null;
  /** What the previous waking turned out to be, in counts and reasons only. */
  lastCycle?: {
    at: string;
    wake: "timer" | "knock" | "nudge";
    tools: number;
    inbox: number;
    /** Everybody it exchanged words with during that cycle, by their own name. */
    talkedTo: string[];
    /** Files written during that cycle, in /work and the book together. */
    touched: number;
  };
  env?: Env;
  /** Messages already delivered once; they may not knock again before this time. */
  knockHold?: KnockHold | null;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How the round before this one ended, when it did not end on its own.
 *
 * One record for all three kinds: a third and fourth boolean on the page would be one
 * field per kind of death, and each would need its own reader. This is written by the
 * daemon, read once by the next page, and cleared — a note about a round, not a log.
 */
export interface CutRecord {
  kind: "timeout" | "crashed" | "interrupted";
  at: string;
  /** Which waking was cut and what woke it: both were already in intent.json. */
  waking: number;
  reason: string;
  /** The last few actions, known only when the daemon outlived the round (a timeout). */
  tools?: string[];
  /** How long the still-running action had been going when the round was killed. */
  openMs?: number;
  /** The cap that was in force then, not the one in force when the note is read. */
  capMinutes?: number;
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 盘上的 state.json 是输入，不是承诺：daemon 拿 wakings 做 + 1、拿 lastWakeMs 做
 * 减法、把 lastSaid 直接拼进唤醒纸。老版本或一次手写留下的 "wakings": "3" 会让
 * 3 + 1 变成 "31"，让 formatDuration 吃到 NaN。读的一侧把会进算术的字段收敛成
 * 有限数（不是就丢掉）、lastSaid 收敛成字符串或 null；knockHold / env 这类嵌套
 * 形状按 unknown 原样带过，不在这里重建。
 */
export function readMeta(paths: Paths): Meta {
  const raw = readJson<unknown>(join(paths.meta, "state.json"), {});
  // 文件里若字面写着 null / 数组 / 标量，readJson 会原样返回（fallback 只在缺失或
  // 解析失败时生效），随后读 .env / .wakings 就抛。先确认它是个普通对象。
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };
  for (const key of ["stateSchema", "lastWakeMs", "wakings"] as const) {
    const v = finite(obj[key]);
    if (v === undefined) delete out[key];
    else out[key] = v;
  }
  if (typeof obj.lastSaid !== "string" && obj.lastSaid !== null) delete out.lastSaid;
  const cycle = obj.lastCycle;
  if (cycle !== null && typeof cycle === "object" && !Array.isArray(cycle)) {
    const c = { ...(cycle as Record<string, unknown>) };
    for (const key of ["tools", "inbox", "touched"] as const) {
      const v = finite(c[key]);
      if (v === undefined) delete c[key];
      else c[key] = v;
    }
    out.lastCycle = c;
  } else {
    delete out.lastCycle;
  }
  return out as unknown as Meta;
}

export function writeMeta(paths: Paths, meta: Meta): void {
  // stamped here rather than at every call site, so the file can never lack it
  writeJson(join(paths.meta, "state.json"), { ...meta, stateSchema: STATE_SCHEMA });
}

export function readWakes(paths: Paths, nowMs: number): number[] {
  // readJson 的 fallback 只在文件缺失 / 解析失败时生效；内容是合法 JSON 但形状不对
  // （null / {} / "oops" / 42）时会原样返回，.filter 不是函数，daemon 每轮醒来都崩。
  const arr = readJson<unknown>(join(paths.meta, "wakes.json"), []);
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (t): t is number =>
      typeof t === "number" && Number.isFinite(t) && nowMs - t >= 0 && nowMs - t < DAY_MS,
  );
}

/**
 * Forgiving on purpose: a broken note is worth less than a waking that cannot start.
 *
 * Every field the page reads is checked here, not at the page: a hand-edited file or a
 * restore that landed wrong is an ordinary input, and `tools: "bash ls"` used to pass this
 * check and then throw on `.join` while a waking was being assembled.
 */
export function readCut(paths: Paths): CutRecord | null {
  const rec = readJson<Partial<CutRecord> | null>(join(paths.meta, "cut.json"), null);
  if (rec === null || typeof rec !== "object") return null;
  if (rec.kind !== "timeout" && rec.kind !== "crashed" && rec.kind !== "interrupted") return null;
  const tools = Array.isArray(rec.tools) ? rec.tools.filter((t) => typeof t === "string") : [];
  const cap = typeof rec.capMinutes === "number" ? rec.capMinutes : undefined;
  const open = typeof rec.openMs === "number" ? rec.openMs : undefined;
  return {
    kind: rec.kind,
    at: typeof rec.at === "string" ? rec.at : "",
    waking: typeof rec.waking === "number" ? rec.waking : 0,
    reason: typeof rec.reason === "string" ? rec.reason : "timer",
    ...(tools.length === 0 ? {} : { tools }),
    ...(cap === undefined ? {} : { capMinutes: cap }),
    ...(open === undefined ? {} : { openMs: open }),
  };
}

export function writeCut(paths: Paths, rec: CutRecord): void {
  writeJson(join(paths.meta, "cut.json"), rec);
}

export function clearCut(paths: Paths): void {
  rmSync(join(paths.meta, "cut.json"), { force: true });
}

/** Record this waking and return how many there were in the last 24 hours. */
export function recordWake(paths: Paths, nowMs: number): number {
  const all = readWakes(paths, nowMs);
  all.push(nowMs);
  writeJson(join(paths.meta, "wakes.json"), all);
  return all.length;
}
