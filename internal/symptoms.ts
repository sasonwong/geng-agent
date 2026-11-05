import type { RpcResult } from "./rpc.ts";

export type Symptom =
  | "ok"
  | "start-failed"
  | "timeout"
  | "aborted"
  | "unsettled"
  | "repeat"
  | "empty"
  | "model-error";

/**
 * Only symptoms a machine can count. Anything that would need reading the output
 * for meaning is deliberately not here.
 */
export function classify(r: RpcResult): Symptom {
  if (r.startFailed) return "start-failed";
  if (r.timedOut) return "timeout";
  if (r.aborted) return "aborted";
  if (!r.settled) return "unsettled";
  // Any repeat the watcher reported is a repeat: it only reports at
  // `cycle.repeatThreshold`, and a second copy of that number here made a policy of 2
  // steer the round while the symptom said nothing happened.
  if (r.repeat !== null) return "repeat";
  // Before "empty": a round whose request failed also has nothing to show for it, and
  // "什么都没做" would be the wrong explanation for the same silence.
  if (r.endedOnModelError === true) return "model-error";
  if (r.finalText.trim() === "" && r.toolCalls.length === 0) return "empty";
  return "ok";
}

export const SYMPTOM_LABEL: Record<Symptom, string> = {
  ok: "正常",
  "start-failed": "没起来",
  timeout: "超时",
  aborted: "被中止",
  unsettled: "没跑完",
  repeat: "在同一处打转",
  empty: "什么都没做",
  "model-error": "模型请求报错",
};
