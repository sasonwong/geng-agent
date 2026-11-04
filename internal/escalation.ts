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

/**
 * The one line here that is not for the agent: the rung where the timer stops.
 * `ops` is the only place a person looks, so it is said on the crossing into the
 * parked rung and not on every later failure — level 4 repeats for as long as the
 * streak lasts, and one line per failure would be noise for the only reader who
 * can act on it. A knock still gets through, which is the part worth saying.
 *
 * It has to be the crossing, not "level >= 5": advance() caps the level at 4, so a
 * test for a higher rung can never fire and the instance goes quiet unannounced.
 */
export function parkNotice(prev: Escalation, next: Escalation): string | null {
  if (planFor(prev).parked || !planFor(next).parked) return null;
  const label = next.symptom ? SYMPTOM_LABEL[next.symptom] : "上一轮";
  // ops tags the line with the mouth that said it ([daemon@alice]); repeating the
  // name here would be the same word twice in one sentence.
  return `连着 ${next.streak} 轮没有结果（${next.detail || label}），定时唤醒已经停了；再敲它一下还能醒。`;
}

/**
 * The other line a person needs: the first round cut at the wall in a run. Its cut record
 * only reaches the agent itself, on the next page (packet.ts cutLine) — from the outside,
 * a round killed mid-sentence looks exactly like one that finished and had nothing to say,
 * and the words it was writing never arrive.
 *
 * A cut counts toward the same streak as any other failure, so four in a row do park the
 * instance; this is the line the parked one cannot give on the way there, the first and
 * not the fourth. Once per run of timeouts, for the same reason parkNotice is once: if the
 * wall keeps being hit, the streak is the daemon's business until it parks, and four lines
 * saying "cut again" teach the reader to skip the one that matters.
 */
export function timeoutNotice(prev: Escalation, next: Escalation): string | null {
  if (next.symptom !== "timeout") return null;
  // advance() only leaves streak at 0 on the fresh state, so an earlier timeout in this run
  // is exactly "prev.symptom was timeout too" — this one is not the first
  if (prev.symptom === "timeout") return null;
  return "有一轮跑到时间上限被杀了：做到一半，话可能没说完。不是出错，也不是没事，下一轮会接着看。";
}

function describe(symptom: Symptom, result?: { repeat?: { name: string; count: number } | null; durationMs?: number }): string {
  if (symptom === "repeat" && result?.repeat) {
    return `${result.repeat.name} 同样的参数重复了 ${result.repeat.count} 次`;
  }
  if (symptom === "timeout") return "超时被杀掉";
  if (symptom === "empty") return "没有动作，也没有话";
  if (symptom === "model-error") return "最后一次模型请求报错回来（网络或额度），这一轮就此停下";
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
