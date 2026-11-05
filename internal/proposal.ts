import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Paths } from "./paths.ts";
import { loadPolicy, type Policy } from "./policy.ts";
import { readJson } from "./fs.ts";

/**
 * What the agent may change about its own running conditions — and nothing else.
 * Container limits, network and the cycle timeout are not on the table: those are the
 * frame, not the settings.
 */
export const NEGOTIABLE: Record<string, { min: number; max: number; integer: boolean }> = {
  "cycle.defaultWakeMinutes": { min: 1, max: 720, integer: true },
  "cycle.minWakeMinutes": { min: 1, max: 120, integer: true },
  "cycle.repeatThreshold": { min: 2, max: 20, integer: true },
};

export interface ProposalResult {
  applied: Array<{ key: string; from: unknown; to: number }>;
  rejected: Array<{ key: string; reason: string }>;
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== "object") cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = value;
}

/**
 * Read a proposal the agent wrote, apply only the negotiable parts, keep the old
 * policy next to it. Anything it wrote that is not up for negotiation is dropped
 * and reported, not silently obeyed.
 */
export function applyProposal(paths: Paths): ProposalResult | null {
  const file = paths.proposal;
  if (!existsSync(file)) return null;
  const proposal = readJson<Record<string, unknown> | null>(file, null);

  const current = loadPolicy(paths.policy);
  // The base is the file as it stands, not `current`: `loadPolicy` returns only the keys
  // this build knows, so writing that back would delete a field a newer build had added —
  // and adding a field is the one change the interface promises is safe. A missing file
  // still falls back to the defaults, because then there is nothing to preserve.
  const raw = readJson<unknown>(paths.policy, null);
  const base = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : current;
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const applied: ProposalResult["applied"] = [];
  const rejected: ProposalResult["rejected"] = [];

  if (!proposal) {
    rejected.push({ key: "*", reason: "不是合法的 JSON" });
  } else {
    for (const [key, rule] of Object.entries(NEGOTIABLE)) {
      const proposed = getPath(proposal, key);
      if (proposed === undefined) continue;
      if (typeof proposed !== "number" || !Number.isFinite(proposed)) {
        rejected.push({ key, reason: "不是数字" });
        continue;
      }
      const value = rule.integer ? Math.round(proposed) : proposed;
      if (value < rule.min || value > rule.max) {
        rejected.push({ key, reason: `超出范围 ${rule.min}~${rule.max}` });
        continue;
      }
      const from = getPath(current, key);
      if (from === value) continue;
      setPath(draft, key, value);
      applied.push({ key, from, to: value });
    }
    for (const key of Object.keys(flatten(proposal))) {
      if (!(key in NEGOTIABLE)) {
        rejected.push({ key, reason: "这一项不由你自己决定" });
      }
    }
  }

  const historyDir = join(paths.meta, "policy.history");
  mkdirSync(historyDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(paths.policy, join(historyDir, `${stamp}.json`));

  if (applied.length > 0) {
    // validate before writing: a malformed result must never replace a working policy
    writeFileSync(`${paths.policy}.tmp-${process.pid}`, JSON.stringify(draft, null, 2) + "\n");
    loadPolicy(`${paths.policy}.tmp-${process.pid}`);
    renameSync(`${paths.policy}.tmp-${process.pid}`, paths.policy);
  }

  renameSync(file, join(paths.meta, `proposal.applied.${stamp}.json`));
  return { applied, rejected };
}

function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null || typeof obj !== "object") {
    if (prefix) out[prefix] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, key));
    else out[key] = v;
  }
  return out;
}

export function policySummary(p: Policy): string {
  return [
    `defaultWakeMinutes=${p.cycle.defaultWakeMinutes}`,
    `minWakeMinutes=${p.cycle.minWakeMinutes}`,
    `repeatThreshold=${p.cycle.repeatThreshold}`,
  ].join(" ");
}
