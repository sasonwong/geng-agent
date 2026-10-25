import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { SYMPTOM_LABEL, type Symptom } from "./symptoms.ts";
import { readJson, writeJson } from "./state.ts";

export interface Escalation {
  /** 0 = fine. 1..6 are the repair levels. */
  level: number;
  /** Consecutive failed wakings. */
  streak: number;
  symptom: Symptom | null;
  detail: string;
  updatedAt: string | null;
}

export interface Plan {
  /** Start a fresh session instead of continuing this one. */
  newSession: boolean;
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
 * The next waking's conditions. Levels 1 and 2 (feed it its footprints, force a
 * compaction) happen inside a waking and are not planned here; what is left is
 * how the *next* waking differs from this one.
 */
export function planFor(e: Escalation): Plan {
  const label = e.symptom ? SYMPTOM_LABEL[e.symptom] : "上一轮";
  switch (e.level) {
    case 1:
      return {
        newSession: false,
        hint: `上一轮${label}：${e.detail}\n这次换一个起点，别从停下的地方接着撞。`,
        backoff: 1,
        parked: false,
      };
    case 3:
      return {
        newSession: true,
        hint: `上一轮${label}：${e.detail}\n换了新的会话，之前的上下文不在这里了。`,
        backoff: 1,
        parked: false,
      };
    case 4:
      return {
        newSession: true,
        hint: `上一轮${label}：${e.detail}\n先写下两个不同的做法，挑一个再动手。`,
        backoff: 1,
        parked: false,
      };
    case 5:
      return {
        newSession: false,
        hint: `上一轮${label}：${e.detail}\n这件事先放下。把它写成一件未闭合的事，或者干脆不写。`,
        backoff: 3,
        parked: false,
      };
    case 6:
      return {
        newSession: false,
        hint: `连着 ${e.streak} 轮没有结果。定时唤醒已经停了，只有有人敲门才会醒。`,
        backoff: 0,
        parked: true,
      };
    default:
      return { newSession: false, hint: null, backoff: 1, parked: false };
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
  // 1 -> feed it footprints, 2 -> fresh session, 3 -> two options, 4 -> give up,
  // 5+ -> park. Level 2 never appears here: forcing a compaction happens in-cycle.
  const level = [1, 3, 4, 5, 6][Math.min(streak, 5) - 1] as number;
  return {
    level,
    streak,
    symptom,
    detail: describe(symptom, result),
    updatedAt: new Date().toISOString(),
  };
}
