import { readJson } from "./state.ts";

export interface WaitSpec {
  dueAtMs: number;
  why: string | null;
}

interface RawWaiting {
  wake?: { after?: string | number; at?: string };
  why?: unknown;
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseAfter(v: string | number): number | null {
  if (typeof v === "number") return v * 60_000;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = UNIT_MS[m[2] as string];
  return unit ? n * unit : null;
}

/** Returns null when waiting.json is absent or unparseable — the daemon treats that as "no alarm set". */
export function readWaiting(file: string, nowMs: number): WaitSpec | null {
  const raw = readJson<RawWaiting | null>(file, null);
  if (!raw || typeof raw !== "object") return null;
  const why = typeof raw.why === "string" ? raw.why : null;
  const wake = raw.wake;
  if (!wake || typeof wake !== "object") return null;

  if (typeof wake.at === "string") {
    const t = Date.parse(wake.at);
    if (Number.isNaN(t)) return null;
    return { dueAtMs: t, why };
  }
  if (wake.after !== undefined) {
    const delta = parseAfter(wake.after);
    if (delta === null) return null;
    return { dueAtMs: nowMs + delta, why };
  }
  return null;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
