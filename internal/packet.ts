import { readdirSync } from "node:fs";
import type { CutRecord } from "./meta.ts";
import type { InboxMsg } from "./inbox.ts";
import type { Paths } from "./paths.ts";
import { excerpt, readJson, readText } from "./state.ts";
import { KIND_WORD } from "./attach.ts";
import { localClock } from "./time.ts";
import { formatDuration } from "./schedule.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type WakeReason = "timer" | "knock" | "nudge";

export interface PacketInput {
  paths: Paths;
  nowMs: number;
  reason: WakeReason;
  /** What it said it was waiting for, from the waiting.json still on disk (a knock does not consume it). */
  waitWhy: string | null;
  lastWakeMs: number | null;
  /** 1-based: how many times this instance has woken. */
  waking: number;
  /** Where the agent sees the palimpsest: /state in docker, an absolute path for the local runner. */
  statePath: string;
  /** What arrived by mail and was never marked read. Mail never knocks: it waits. */
  mailPending: { count: number; senders: string[]; oldestMs: number | null };
  /** Where the mailbox appears inside the container. */
  mailPath: string;
  /** Where the read-only auxiliary mounts appear inside the container. */
  inboxPath: string;
  peoplePath: string;
  inbox: InboxMsg[];
  /** Mutes that are still in force, shown as state — they do not change delivery. */
  mutes: Record<string, { until?: string | null }>;
  /** The previous waking died mid-flight. */
  /** How the round before this one ended, when it did not end on its own. */
  cut: CutRecord | null;
  /** A [观察] block explaining how the last waking ended, if it did not end well. */
  hint: string | null;
  /** Wakings in the last 24 hours, including this one. */
  wakes24h: number;
  /** Timer wakes are off; only a knock gets through. */
  parked: boolean;
  /** Ambient messages waiting in inbox/low, which did not wake it. */
  lowPending: number;
  /** The timezone its container runs in, so the page and its own `date` agree. */
  timezone: string;
  /** Where it may speak, so a window can be rendered with the names it knows. */
  places: { id: number; label: string; home: boolean }[];
  /** A window it opened itself with `listen`; past its end it is not shown at all. */
  attention: { chats: (number | "*")[]; untilMs: number; why?: string } | null;
  /** Where files people sent it live; injected so neither runner hardcodes a path. */
  filesPath: string;
  /** Applied before this waking: what it asked to forget, and what the cap took. */
  filesForgotten: number;
  filesPruned: number;
  filesOldestPrunedMs: number | null;
  filesUsedBytes: number;
  filesCapMb: number;
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
  /** What it wrote about itself; pasted verbatim, because a read it skips is a waking
   * with no self at all. */
  identity: string | null;
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
  lines: {
    dir: "in" | "out";
    text: string;
    at: string;
    /** The line this one answered, when the person replied to a specific message. */
    quote?: { id: string; from?: string; text?: string };
  }[];
}

function renderThread(t: ThreadInput, peoplePath: string): string[] {
  const oldest = t.lines[0]?.at ? Date.parse(t.lines[0].at) : NaN;
  const age = Number.isNaN(oldest) ? "" : `，最早的一句在 ${formatDuration(Date.now() - oldest)}前`;
  const out = [`你和 ${t.who} 说过 ${t.total} 句，下面是最新的 ${t.lines.length} 句${age}：`];
  for (const line of t.lines) {
    const back = line.quote?.text ? `（回：${excerpt(line.quote.text, 60)}）` : "";
    out.push(`  ${line.dir === "out" ? "你" : "对方"}：${excerpt(line.text, 200)}${back}`);
  }
  out.push(`全部在 ${peoplePath}/${t.chat}.jsonl（${t.total} 句，${Math.round(t.bytes / 1024)} KB）。`);
  return out;
}

function renderAttention(
  a: { chats: (number | "*")[]; untilMs: number; why?: string } | null,
  places: { id: number; label: string }[],
  timezone: string,
  nowMs: number,
): string | null {
  if (!a || nowMs >= a.untilMs) return null;
  const names = a.chats.map((c) =>
    c === "*" ? "所有会话" : (places.find((p) => p.id === c)?.label ?? `chat ${c}`),
  );
  return `你在听：${names.join("、")} 的全部消息，到 ${localClock(a.untilMs, timezone)} 为止。`;
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

/**
 * Whether anyone is on the other end — the same fact from the other side.
 */
function whoLine(inbox: InboxMsg[]): string {
  return inbox.length === 0 ? "，现在没人在跟你说话。" : "，现在有人在跟你说话。";
}

/** The rare-changing half of the picture: where it may speak, and its own knobs. */
export function systemFacts(
  places: { id: number; label: string; home: boolean }[],
  policyLine: string,
  capMinutes: number,
): string {
  const out: string[] = [];
  if (places.length > 0) {
    // The id is printed even when there is only one place: `say` writes a quote as
    // "<chat id>-<message id>", and a page that names the person but not the number left
    // a waking inventing one — the gateway dropped the message and the tool still said
    // "说了 N 句". One place needs no `to`, so that sentence stays for two and up.
    const list = places
      .map((p) => `${p.label}（${p.id}${p.home ? "，默认" : ""}）`)
      .join("、");
    out.push(`能说话的地方：${list}。${places.length > 1 ? "say 要指明 to。" : ""}`);
  }
  out.push(`可以调的运行参数：${policyLine}。`);
  // The wall, not a knob: it is the operator's frame, so it is stated as a fact. A model
  // cannot see a clock any more than it can see its own token count.
  out.push(`每一轮最多 ${capMinutes} 分钟，到点会被杀掉。`);
  return out.join("\n");
}

/** Which waking it was, and what woke it, in the words the awake line already uses. */
const WAKE_WORD: Record<string, string> = {
  timer: "被自己的闹钟叫醒",
  knock: "被消息叫醒",
  nudge: "没人叫它，按默认间隔醒的",
};

/**
 * How the round before this one ended. Three facts, no advice: what killed it, which
 * waking it was, and — when the daemon outlived it — what it was doing at the moment.
 */
function cutLine(cut: CutRecord): string {
  const which = cut.waking > 0 ? `（第 ${cut.waking} 次醒来，${WAKE_WORD[cut.reason] ?? cut.reason}）` : "";
  if (cut.kind === "interrupted") return `上一轮是被重启打断的，不是出错${which}。`;
  if (cut.kind === "crashed") return `上一轮没过完就断了${which}。不知道它停在哪。`;
  const acts = (cut.tools ?? []).join("、");
  const open =
    cut.openMs !== undefined && cut.openMs >= 60_000
      ? `，最后一个已经跑了 ${formatDuration(cut.openMs)}`
      : "";
  // the cap that was in force when it was killed, not the one in force now
  const head =
    cut.capMinutes === undefined
      ? `上一轮跑到时间上限被杀了${which}。`
      : `上一轮跑到 ${cut.capMinutes} 分钟的上限被杀了${which}。`;
  return acts === "" ? head : `${head}最后的动作：${acts}${open}。`;
}

/** One line, so a multi-paragraph sign-off does not take over the page. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildPacket(input: PacketInput): string {
  const { paths, nowMs, reason, waitWhy, lastWakeMs, waking, statePath, inboxPath, peoplePath } = input;
  const { inbox, mutes, cut, longGap, hint, wakes24h, parked, lowPending, timezone, attention, places, filesPath, filesForgotten, filesPruned, filesOldestPrunedMs, filesUsedBytes, filesCapMb, searchLeft, envChanged, lastSaid, lastCycle, lastWords, thread, waiting, identity, mailPending, mailPath } = input;

  const out: string[] = [];

  // Only what changed since last time: the constants live in the system prompt, and the
  // identity it wrote is its last section there.
  const since =
    lastWakeMs === null ? "第一次醒来" : `距上次醒来 ${formatDuration(nowMs - lastWakeMs)}`;
  out.push(`现在：${new Date(nowMs).toISOString()} · ${localClock(nowMs, timezone)} · ${since}`);
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
  // Files are counted, never described: what is in them is the agent's business to look at.
  const kinds = new Map<string, number>();
  for (const m of inbox) {
    for (const a of m.attachments ?? []) kinds.set(a.kind, (kinds.get(a.kind) ?? 0) + 1);
  }
  const files = [...kinds]
    .filter(([kind]) => kind !== "voice")
    .map(([kind, n]) => `${n}${KIND_WORD[kind as keyof typeof KIND_WORD] ?? "个文件"}`);
  if (files.length > 0) out.push(`一起发来的还有 ${files.join("、")}，在 ${filesPath}/。`);
  if (filesForgotten > 0) {
    out.push(`按你说的删了 ${filesForgotten} 个文件。`);
  }
  if (filesPruned > 0) {
    const age =
      filesOldestPrunedMs === null
        ? ""
        : `（最老的一个 ${Math.max(1, Math.round((nowMs - filesOldestPrunedMs) / DAY_MS))} 天前）`;
    out.push(`地方不够了，清掉 ${filesPruned} 个最老的${age}。`);
  } else if (filesCapMb > 0 && filesUsedBytes > filesCapMb * 1024 * 1024 * 0.85) {
    out.push(`${filesPath} 里 ${Math.round(filesUsedBytes / 1024 / 1024)} MB，上限 ${filesCapMb} MB。`);
  }
  const voice = kinds.get("voice") ?? 0;
  if (voice > 0) {
    // no transcription exists here, so the honest thing is that the words are not
    // available — not that it failed at something
    out.push(`还有 ${voice} 条语音：这里没有能把声音变成字的东西，话是听不到的。`);
  }

  if (lowPending > 0) {
    out.push(`还有 ${lowPending} 条不叫醒你的在 ${inboxPath}/low/（群里的闲话）。`);
  }
  if (mailPending.count > 0) {
    // counted, never summarised: the senders and how long the oldest has waited are the
    // only two things it needs to decide whether to open any of them
    const waited = mailPending.oldestMs === null ? null : nowMs - mailPending.oldestMs;
    const first =
      waited === null
        ? ""
        : `，最早一封 ${waited >= DAY_MS ? `${Math.round(waited / DAY_MS)} 天` : formatDuration(waited)}前`;
    const who =
      mailPending.senders.length === 0 ? "" : `，来自 ${mailPending.senders.join("、")}`;
    out.push(`邮件：${mailPending.count} 封没处理${first}${who}，在 ${mailPath}/。`);
  }
  const muteLine = renderMutes(mutes);
  const attentionLine = renderAttention(attention, places, timezone, nowMs);
  if (muteLine) out.push(muteLine);
  if (attentionLine) out.push(attentionLine);

  if (hint) {
    out.push("", "[观察]", hint);
  }

  if (cut) out.push("", cutLine(cut));

  // Its own words, verbatim, right before the reason it is awake: the last two things it
  // reads are who it decided it is and what it is supposed to be doing right now.
  if (identity !== null && identity.trim() !== "") {
    out.push("", `你写下的自己（${statePath}/identity.md）：`);
    out.push("", identity.trim());
  } else {
    // A fact, not an instruction, and not the same line as the map in SYSTEM.md: the map
    // says what the file is for, this says it is still missing. Without it a new instance
    // never learns the file exists — `ls /state` shows two empty directories, because the
    // only way identity.md comes to exist is that it writes one.
    out.push("", `你还没写下过自己：${statePath}/identity.md 不存在。`);
  }

  // one sentence: why it is awake, and whether anyone is on the other end. Then the
  // standing permission, alone, because it is the only line that is always true.
  out.push("", `${waking <= 1 ? "这是你第一次醒来" : REASON_LINE[reason]}${whoLine(inbox)}`);
  out.push("你可以什么都不做，那不算失败。");

  if (searchLeft !== null) {
    out.push("", searchLeft === 0 ? "今天的搜索用完了。" : `今天还能搜 ${searchLeft} 次。`);
  }



  // No truncation: nothing that grows with the outside world is pasted any more,
  // so the page is bounded by construction rather than by cutting it in half.
  return out.join("\n");
}
