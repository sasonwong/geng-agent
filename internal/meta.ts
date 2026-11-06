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
  /** What the previous waking turned out to be, in the three counts the page prints. */
  lastCycle?: {
    wake: "timer" | "knock" | "nudge";
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
 * The state file on disk is input, not a promise: the daemon does `wakings + 1`, subtracts
 * `lastWakeMs`, and pastes `lastSaid` into the wake packet. A hand edit or an older writer
 * left `"wakings": "3"`, and `3 + 1` became `"31"`; a string timestamp reached
 * formatDuration as NaN. Fields that feed arithmetic are narrowed to finite numbers (and
 * dropped otherwise), `lastSaid` to a string or null; nested shapes are passed through.
 */
export function readMeta(paths: Paths): Meta {
  const raw = readJson<unknown>(join(paths.meta, "state.json"), {});
  // A file that literally holds `null`, an array or a scalar comes back as-is (the
  // fallback only covers missing or unparseable), and reading `.env`/`.wakings` throws.
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
  // readJson's fallback only applies to a missing or unparseable file; a file whose
  // content is legal JSON of the wrong shape (`null`, `{}`, `"oops"`, `42`) comes back
  // as-is, and `.filter` is not a function — that is a crash on every waking.
  const arr = readJson<unknown>(join(paths.meta, "wakes.json"), []);
  if (!Array.isArray(arr)) return [];
  // A timestamp in the future (a restored snapshot, a clock that jumped back) is not a
  // waking inside the window, and NaN never compares true.
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
