import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { SYMPTOM_LABEL, type Symptom } from "./symptoms.ts";
import { readJson, writeJson } from "./state.ts";

export interface Escalation {
  /** 0 = fine. 1..4 are the repair levels. */
  level: number;
  /** Consecutive failed wakings. */
  streak: number;
  symptom: Symptom | null;
  detail: string;
  updatedAt: string | null;
}

export interface Plan {
  /** A [观察] block for the wake packet, or null. */
  hint: string | null;
  /** Extra sleep multiplier applied to the next alarm. */
  backoff: number;
  /** Stop waking on a timer; only a knock gets through. */
  parked: boolean;
}

const FRESH: Escalation = { level: 0, streak: 0, symptom: null, detail: "", updatedAt: null };

export function loadEscalation(paths: Paths): Escalation {
  const raw = readJson<Partial<Escalation>>(join(paths.meta, "escalation.json"), {});
  return {
    level: typeof raw.level === "number" ? raw.level : 0,
    streak: typeof raw.streak === "number" ? raw.streak : 0,
    symptom: (raw.symptom as Symptom) ?? null,
    detail: typeof raw.detail === "string" ? raw.detail : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

export function saveEscalation(paths: Paths, e: Escalation): void {
  writeJson(join(paths.meta, "escalation.json"), e);
}

/**
 * The next waking's conditions. Every waking already starts from a clean context, so
 * "start over" is not a repair any more — what is left is: tell it what happened, then
 * wait longer, then give up, then stop waking it on a timer at all.
 */
export function planFor(e: Escalation): Plan {
  const label = e.symptom ? SYMPTOM_LABEL[e.symptom] : "上一轮";
  const hint = `上一轮${label}：${e.detail}`;
  switch (e.level) {
    case 1:
      return { hint, backoff: 1, parked: false };
    case 2:
      return { hint, backoff: 2, parked: false };
    case 3:
      return { hint, backoff: 3, parked: false };
    case 4:
      return {
        hint: `连着 ${e.streak} 轮没有结果，定时唤醒已经停了。`,
        backoff: 0,
        parked: true,
      };
    default:
      return { hint: null, backoff: 1, parked: false };
  }
}

function describe(symptom: Symptom, result?: { repeat?: { name: string; count: number } | null; durationMs?: number }): string {
  if (symptom === "repeat" && result?.repeat) {
    return `${result.repeat.name} 同样的参数重复了 ${result.repeat.count} 次`;
  }
  if (symptom === "timeout") return "超时被杀掉";
  if (symptom === "empty") return "没有动作，也没有话";
  return SYMPTOM_LABEL[symptom];
}

export function advance(
  e: Escalation,
  symptom: Symptom,
  result?: { repeat?: { name: string; count: number } | null; durationMs?: number },
): Escalation {
  if (symptom === "ok") return { ...FRESH, updatedAt: new Date().toISOString() };

  const streak = e.streak + 1;
  // 1 -> tell it what happened, 2 -> wait longer, 3 -> give up and back off,
  // 4+ -> stop waking it on a timer. Forcing a compaction mid-cycle is still level 2
  // of the repair ladder, but it happens inside a waking rather than between them.
  const level = Math.min(streak, 4);
  return {
    level,
    streak,
    symptom,
    detail: describe(symptom, result),
    updatedAt: new Date().toISOString(),
  };
}
