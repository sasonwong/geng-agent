import type { RpcResult } from "./rpc.ts";

export type Symptom =
  | "ok"
  | "start-failed"
  | "timeout"
  | "aborted"
  | "unsettled"
  | "repeat"
  | "empty";

/**
 * Only symptoms a machine can count. Anything that would need reading the output
 * for meaning is deliberately not here.
 */
export function classify(r: RpcResult): Symptom {
  if (r.startFailed) return "start-failed";
  if (r.timedOut) return "timeout";
  if (r.aborted) return "aborted";
  if (!r.settled) return "unsettled";
  if (r.repeat !== null && r.repeat.count >= 3) return "repeat";
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
};
