import type { InboxMsg } from "./inbox.ts";
import type { Paths } from "./paths.ts";
import { excerpt, readJson, readText } from "./state.ts";
import { formatDuration } from "./schedule.ts";

export type WakeReason = "timer" | "knock" | "nudge";

export interface PacketInput {
  paths: Paths;
  nowMs: number;
  reason: WakeReason;
  /** What it said it was waiting for, carried over from the consumed waiting.json. */
  waitWhy: string | null;
  lastWakeMs: number | null;
  /** 1-based: how many times this instance has woken. */
  waking: number;
  /** Where the agent sees the palimpsest: /state in docker, an absolute path for the local runner. */
  statePath: string;
  workPath: string;
  inbox: InboxMsg[];
  /** Mutes that are still in force, shown as state — they do not change delivery. */
  mutes: Record<string, { until?: string | null }>;
  /** The previous waking died mid-flight. */
  crashed: boolean;
  /** A [观察] block explaining how the last waking ended, if it did not end well. */
  hint: string | null;
  /** Wakings in the last 24 hours, including this one. */
  wakes24h: number;
  /** Timer wakes are off; only a knock gets through. */
  parked: boolean;
  /** Ambient messages waiting in inbox/low, which did not wake it. */
  lowPending: number;
  /** The settings it is allowed to renegotiate, shown so it can renegotiate them. */
  policyLine: string;
  /** Searches left today; null when no search endpoint is configured. */
  searchLeft: number | null;
  /** Set when the image or the program changed since the last waking. */
  envChanged: string | null;
  /** The last thing it said, because nothing else carries over between wakings. */
  lastSaid: string | null;
  /** More time passed than any alarm explains — the machine was probably suspended. */
  longGap: boolean;
}

interface OpenLoop {
  title?: string;
  since?: string;
  state?: string;
}

/** How many, not what — the page points, the agent reads. */
function countLoops(paths: Paths): number {
  const loops = readJson<OpenLoop[]>(paths.openLoops, []);
  return Array.isArray(loops) ? loops.length : 0;
}

function renderMutes(mutes: Record<string, { until?: string | null }>): string | null {
  const entries = Object.entries(mutes);
  if (entries.length === 0) return null;
  const parts = entries.map(([key, m]) => (m.until ? `${key}（到 ${m.until}）` : key));
  return `你静音了 ${parts.join("、")}。这不改变投递：私聊和点名照样叫醒你。`;
}

const REASON_LINE: Record<WakeReason, string> = {
  timer: "你是被自己定的闹钟叫醒的。",
  knock: "有人敲门，所以你现在醒了。",
  nudge: "你上次没有留下下次什么时候醒，所以被按默认间隔叫醒了。",
};

export function buildPacket(input: PacketInput): string {
  const { paths, nowMs, reason, waitWhy, lastWakeMs, waking, statePath, workPath } = input;
  const { inbox, mutes, crashed, longGap, hint, wakes24h, parked, lowPending, policyLine, searchLeft, envChanged, lastSaid } = input;

  const identity = readText(paths.identity);
  const hasIdentity = identity !== null && identity.trim() !== "";

  const out: string[] = [];

  if (hasIdentity) {
    out.push(excerpt(identity, 2000));
  } else if (waking <= 1) {
    out.push("这是你第一次醒来。");
  } else {
    out.push(`这是你第 ${waking} 次醒来，你还没有写过你是谁。`);
  }

  const since =
    lastWakeMs === null ? "第一次醒来" : `距上次醒来 ${formatDuration(nowMs - lastWakeMs)}`;
  out.push(`现在：${new Date(nowMs).toISOString()} · ${since}`);
  if (longGap) out.push("（这次空档比闹钟长得多，机器可能停过。）");
  if (envChanged) out.push(envChanged);

  out.push(
    "",
    "你的东西：",
    `  ${statePath}/identity.md      你是谁`,
    `  ${statePath}/open-loops.json  没闭合的事`,
    `  ${statePath}/waiting.json     下次什么时候醒`,
    `  ${statePath}/journal/         日记`,
    `  ${statePath}/inbox/           别人跟你说的话`,
    `  ${statePath}/daemon.log       每轮一行`,
    `  ${workPath}                   你干活的地方`,
  );

  if (waitWhy) out.push("", `你上次说在等：${excerpt(waitWhy, 300)}`);
  if (lastSaid) out.push(`你上次说完这句就没再说话了：「${excerpt(lastSaid, 200)}」`);

  // the first page must not contradict itself: on birth there is no counting yet
  if (waking > 1) out.push("", `最近 24 小时醒了 ${wakes24h} 次。`);
  if (parked) {
    out.push("定时唤醒已经停了：只有有人敲门才叫得醒你。");
  }

  const loops = countLoops(paths);
  out.push(
    "",
    loops > 0
      ? `未闭合的事：${loops} 条，在 ${statePath}/open-loops.json。`
      : "未闭合的事：（没有未闭合的事）",
  );
  out.push(`最近几轮：${statePath}/daemon.log 的最后几行。`);

  if (inbox.length > 0) {
    out.push("", `有人在跟你说话：${inbox.length} 条，在 ${statePath}/inbox/。`);
  }
  if (lowPending > 0) {
    out.push(`还有 ${lowPending} 条群里的消息在 ${statePath}/inbox/low/，它们没有叫醒你。`);
  }
  const muteLine = renderMutes(mutes);
  if (muteLine) out.push(muteLine);

  if (hint) {
    out.push("", "[观察]", hint);
  }

  if (crashed) {
    out.push("", "上一轮没过完就断了（进程被杀或宿主机重启）。你自己看一眼 /work 停在哪。");
  }

  // nobody set an alarm yet on the first waking
  if (waking > 1) out.push("", REASON_LINE[reason]);
  out.push(inbox.length > 0 ? "说句话回去，或者做你的事。" : "现在没人在跟你说话。");
  out.push("你可以什么都不做，那不算失败。");
  if (!hasIdentity) {
    out.push("如果你决定做点什么，先写下你是谁，以及你为什么想做这件事。");
  }

  if (searchLeft !== null) {
    out.push("", searchLeft === 0 ? "今天的搜索用完了。" : `今天还能搜 ${searchLeft} 次。`);
  }

  out.push("", `你现在的运行参数：${policyLine}`);
  out.push(`想改的话，把 {"cycle":{"defaultWakeMinutes":30}} 这样的文件写到 ${statePath}/policy.proposal.json，下次醒来前会被检查。`);
  out.push("");

  out.push(`走之前，在 ${statePath}/waiting.json 写下你下次什么时候醒、为什么：`);
  out.push('  { "wake": { "after": "20m" }, "why": "为什么" }');
  out.push('  { "wake": { "at": "2026-03-02T09:15:00Z" }, "why": "为什么" }');
  out.push("如果你不想再醒来，写 null —— 但先说清为什么。");

  // No truncation: nothing that grows with the outside world is pasted any more,
  // so the page is bounded by construction rather than by cutting it in half.
  return out.join("\n");
}
