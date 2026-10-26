import { readdirSync } from "node:fs";
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
  /** Where the read-only auxiliary mounts appear inside the container. */
  inboxPath: string;
  peoplePath: string;
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
  /** Searches left today; null when no search endpoint is configured. */
  searchLeft: number | null;
  /** Set when the image or the program changed since the last waking. */
  envChanged: string | null;
  /** The last thing it said, when there is no transcript to read it from. */
  lastSaid: string | null;
  /** Why the previous waking happened and what it left behind, in counts. */
  lastCycle: {
    at: string;
    wake: WakeReason;
    tools: number;
    inbox: number;
    talkedTo: string[];
    touched: number;
  } | null;
  /** The last thing said on the address that last spoke, whoever said it. */
  lastWords: { dir: "in" | "out"; text: string; at: string; who: string } | null;
  /** What was last said to and by it on the address that knocked, if any. */
  thread: ThreadInput | null;
  /** Conversations whose last word was theirs. */
  waiting: { who: string; at: string }[];
  /** More time passed than any alarm explains — the machine was probably suspended. */
  longGap: boolean;
}

/**
 * How many, not what. The count comes from the filesystem, so no shape it invents can
 * make the number wrong — one file per unfinished thing.
 */
function countLoops(paths: Paths): number {
  try {
    return readdirSync(paths.openLoops).filter((f) => !f.startsWith(".")).length;
  } catch {
    return 0;
  }
}

export interface ThreadInput {
  who: string;
  chat: number;
  total: number;
  bytes: number;
  lines: { dir: "in" | "out"; text: string; at: string }[];
}

function renderThread(t: ThreadInput, peoplePath: string): string[] {
  const oldest = t.lines[0]?.at ? Date.parse(t.lines[0].at) : NaN;
  const age = Number.isNaN(oldest) ? "" : `，最早的一句在 ${formatDuration(Date.now() - oldest)}前`;
  const out = [`你和 ${t.who} 说过 ${t.total} 句，下面是最新的 ${t.lines.length} 句${age}：`];
  for (const line of t.lines) {
    out.push(`  ${line.dir === "out" ? "你" : "对方"}：${excerpt(line.text, 200)}`);
  }
  out.push(`全部在 ${peoplePath}/${t.chat}.jsonl（${t.total} 句，${Math.round(t.bytes / 1024)} KB）。`);
  return out;
}

function renderMutes(mutes: Record<string, { until?: string | null }>): string | null {
  const entries = Object.entries(mutes);
  if (entries.length === 0) return null;
  const parts = entries.map(([key, m]) => (m.until ? `${key}（到 ${m.until}）` : key));
  return `你静音了 ${parts.join("、")}。这不改变投递：私聊和点名照样叫醒你。`;
}

const LAST_WAKE: Record<WakeReason, string> = {
  timer: "你自己的闹钟",
  knock: "有人敲门",
  nudge: "你没留闹钟（按默认间隔）",
};

const REASON_LINE: Record<WakeReason, string> = {
  timer: "你是被自己定的闹钟叫醒的",
  knock: "有人敲门，所以你现在醒了",
  nudge: "你上次没有留下下次什么时候醒，所以被按默认间隔叫醒了",
};

/** Whether anyone is on the other end — the same fact from the other side. */
function whoLine(inboxCount: number): string {
  return inboxCount > 0 ? "，现在有人在跟你说话。" : "，现在没人在跟你说话。";
}

/** The rare-changing half of the picture: where it may speak, and its own knobs. */
export function systemFacts(
  places: { id: number; label: string; home: boolean }[],
  policyLine: string,
): string {
  const out: string[] = [];
  if (places.length > 1) {
    const list = places
      .map((p) => `${p.label}（${p.id}${p.home ? "，默认" : ""}）`)
      .join("、");
    out.push(
      `能说话的地方：${list}。say 不写 to 就发到${places.find((p) => p.home)?.label ?? "默认那个"}。`,
    );
  }
  out.push(`可以调的运行参数：${policyLine}。`);
  return out.join("\n");
}

/** One line, so a multi-paragraph sign-off does not take over the page. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildPacket(input: PacketInput): string {
  const { paths, nowMs, reason, waitWhy, lastWakeMs, waking, statePath, inboxPath, peoplePath } = input;
  const { inbox, mutes, crashed, longGap, hint, wakes24h, parked, lowPending, searchLeft, envChanged, lastSaid, lastCycle, lastWords, thread, waiting } = input;

  const out: string[] = [];

  // Only what changed since last time: the constants live in the system prompt, and the
  // identity it wrote is its last section there.
  const since =
    lastWakeMs === null ? "第一次醒来" : `距上次醒来 ${formatDuration(nowMs - lastWakeMs)}`;
  out.push(`现在：${new Date(nowMs).toISOString()} · ${since}`);
  if (longGap) out.push("（这次空档比闹钟长得多，机器可能停过。）");
  if (envChanged) out.push(envChanged);
  if (lastCycle) {
    const people = (lastCycle.talkedTo ?? []).filter((w) => typeof w === "string" && w !== "");
    const did =
      people.length === 0
        ? ""
        : people.length === 1
          ? `，和 ${people[0]} 说了话`
          : `，和 ${people.length} 个人说了话`;
    // state on disk is untrusted: an older record may carry a null here
    const wrote = Number.isFinite(lastCycle.touched) ? lastCycle.touched : 0;
    // 0 is stated as 0: "wrote 0 files" is a fact, "did nothing" would be a verdict
    out.push(`上一轮：${LAST_WAKE[lastCycle.wake]}${did}，写了 ${wrote} 个文件。`);
  }

  if (waitWhy) out.push("", `你上次说在等：${excerpt(waitWhy, 300)}`);
  if (lastWords) {
    const age = lastWords.at ? formatDuration(nowMs - Date.parse(lastWords.at)) : "";
    const said = excerpt(flatten(lastWords.text), 120);
    out.push(
      lastWords.dir === "out"
        ? `你最后跟 ${lastWords.who} 说的是 ${age}前：「${said}」`
        : `${lastWords.who} 在 ${age}前说了最后一句：「${said}」，你之后没说话。`,
    );
  } else if (lastSaid) {
    out.push(`你上次说完这句就没再说话了：「${excerpt(flatten(lastSaid), 120)}」`);
  }

  // the first page must not contradict itself: on birth there is no counting yet
  if (waking > 1) out.push("", `最近 24 小时醒了 ${wakes24h} 次。`);
  if (parked) {
    out.push("定时唤醒已经停了：只有有人敲门才叫得醒你。");
  }

  const loops = countLoops(paths);
  out.push(
    "",
    loops > 0
      ? `未闭合的事：${loops} 件，在 ${statePath}/open-loops/。`
      : "未闭合的事：（没有未闭合的事）",
  );

  if (waiting.length > 0) {
    const shown = waiting.slice(0, 3).map((w) => `${w.who}（${formatDuration(nowMs - Date.parse(w.at))}前）`);
    const more = waiting.length > 3 ? `，还有 ${waiting.length - 3} 个` : "";
    out.push("", `还没回的：${shown.join("、")}${more}。`);
  }
  if (thread) out.push("", ...renderThread(thread, peoplePath));
  if (inbox.length > 0) {
    // the thread block above shows one conversation; say how many people are actually
    // waiting, or the page quietly privileges whoever spoke last
    const people = new Set(inbox.map((m) => m.chat).filter((c) => typeof c === "number"));
    const who = people.size > 1 ? `（${people.size} 个人）` : "";
    out.push("", `有人在跟你说话：${inbox.length} 条${who}，在 ${inboxPath}/。`);
  }
  if (lowPending > 0) {
    out.push(`还有 ${lowPending} 条群里的消息在 ${inboxPath}/low/，它们没有叫醒你。`);
  }
  const muteLine = renderMutes(mutes);
  if (muteLine) out.push(muteLine);

  if (hint) {
    out.push("", "[观察]", hint);
  }

  if (crashed) {
    out.push("", "上一轮没过完就断了（进程被杀或宿主机重启）。你自己看一眼 /work 停在哪。");
  }

  // one sentence: why it is awake, and whether anyone is on the other end. Then the
  // standing permission, alone, because it is the only line that is always true.
  out.push("", `${waking <= 1 ? "这是你第一次醒来" : REASON_LINE[reason]}${whoLine(inbox.length)}`);
  out.push("你可以什么都不做，那不算失败。");

  if (searchLeft !== null) {
    out.push("", searchLeft === 0 ? "今天的搜索用完了。" : `今天还能搜 ${searchLeft} 次。`);
  }



  // No truncation: nothing that grows with the outside world is pasted any more,
  // so the page is bounded by construction rather than by cutting it in half.
  return out.join("\n");
}
