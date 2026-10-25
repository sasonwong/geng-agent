import type { InboxMsg } from "./inbox.ts";
import type { Paths } from "./paths.ts";
import { excerpt, readJson, readText } from "./state.ts";
import { formatDuration } from "./schedule.ts";

export type WakeReason = "timer" | "knock" | "nudge";

export interface PacketInput {
  paths: Paths;
  nowMs: number;
  reason: WakeReason;
  waitWhy: string | null;
  lastWakeMs: number | null;
  /** Where the agent sees the palimpsest: /state in docker, an absolute path for the local runner. */
  statePath: string;
  inbox: InboxMsg[];
  maxBytes: number;
}

interface OpenLoop {
  title?: string;
  since?: string;
  state?: string;
}

function renderOpenLoops(paths: Paths, nowMs: number): string[] {
  const loops = readJson<OpenLoop[]>(paths.openLoops, []);
  if (!Array.isArray(loops) || loops.length === 0) return ["（没有未闭合的事）"];
  const lines: string[] = [];
  for (const l of loops.slice(0, 12)) {
    const title = typeof l.title === "string" ? l.title : JSON.stringify(l);
    const since = typeof l.since === "string" ? Date.parse(l.since) : NaN;
    const age = Number.isNaN(since) ? "" : ` · 搁了 ${formatDuration(nowMs - since)}`;
    const state = typeof l.state === "string" ? ` · ${l.state}` : "";
    lines.push(`- ${title}${age}${state}`);
  }
  return lines;
}

function renderIndex(paths: Paths): string[] {
  const text = readText(paths.journalIndex);
  if (!text || text.trim() === "") return ["（还没有日记）"];
  const lines = text.trim().split("\n");
  return lines.slice(-8);
}

function renderInbox(inbox: InboxMsg[]): string[] {
  if (inbox.length === 0) return [];
  const lines = ["有人在跟你说话："];
  for (const m of inbox.slice(0, 12)) {
    const who = m.from ? `${m.from}` : "对方";
    lines.push(`- ${who}：${excerpt(m.text, 400)}`);
  }
  if (inbox.length > 12) lines.push(`- …还有 ${inbox.length - 12} 条`);
  return lines;
}

const REASON_LINE: Record<WakeReason, string> = {
  timer: "你是被自己定的闹钟叫醒的。",
  knock: "有人敲门，所以你现在醒了。",
  nudge: "你没有留下下次什么时候醒，所以被按默认间隔叫醒了。",
};

export function buildPacket(input: PacketInput): string {
  const { paths, nowMs, reason, waitWhy, lastWakeMs, statePath, inbox, maxBytes } = input;

  const head: string[] = [];
  const identity = readText(paths.identity);
  head.push(identity && identity.trim() !== "" ? excerpt(identity, 2000) : "（你还没有写过你是谁）");

  const nowIso = new Date(nowMs).toISOString();
  const since =
    lastWakeMs === null ? "第一次醒来" : `距上次醒来 ${formatDuration(nowMs - lastWakeMs)}`;
  head.push(`现在：${nowIso} · ${since}`);

  const body: string[] = [];
  if (waitWhy) body.push(`你上次说在等：${waitWhy}`);
  body.push("", "未闭合的事：", ...renderOpenLoops(paths, nowMs));
  body.push("", "最近几天：", ...renderIndex(paths));

  const inboxLines = renderInbox(inbox);
  if (inboxLines.length > 0) body.push("", ...inboxLines);

  body.push("", REASON_LINE[reason]);
  body.push(
    inbox.length > 0
      ? "说句话回去，或者做你的事。"
      : "现在没人在跟你说话。",
  );
  body.push("", `走之前，在 ${statePath}/waiting.json 写下你下次什么时候醒、为什么：`);
  body.push('  { "wake": { "after": "20m" }, "why": "为什么" }');
  body.push('  { "wake": { "at": "2026-03-02T09:15:00Z" }, "why": "为什么" }');
  body.push("如果你不想再醒来，写 null —— 但先说清为什么。");

  let out = head.join("\n") + "\n\n" + body.join("\n");
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = out.slice(0, maxBytes) + "\n…(唤醒纸被截断)";
  }
  return out;
}
