/**
 * journal / discard / loop_open / loop_close / wait — the only way into the book.
 *
 * One verb per object on purpose: a single `remember(kind, …)` would carry four different
 * write semantics behind one name, and calling it wrong would put a diary entry where an
 * unfinished thing belongs. Reads are generalised (`recall`/`open`), writes are not.
 *
 * Nothing here decides anything. The host writes the file, allocates the id, and answers
 * with it; this file is a messenger that turns a refusal into a sentence a person can act
 * on. A missing socket is reported as itself, never as "failed".
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tool } from "./lib/tool.ts";
import { postJsonOrError } from "./lib/uds.ts";

const SOCKET = process.env.GENG_BOOK_SOCK ?? "";

type Reply = Record<string, unknown>;

async function call(path: string, body: Record<string, unknown>): Promise<Reply> {
  if (SOCKET === "") {
    return { error: "没有配置记忆端点：GENG_BOOK_SOCK 是空的。" };
  }
  // A host that is not listening is a sentence, not an exception: the answer goes to the
  // model either way, and one line is something it can act on.
  const reply = await postJsonOrError(SOCKET, path, body);
  try {
    return JSON.parse(reply.body) as Reply;
  } catch {
    return { error: `记忆端点答了 ${reply.status}，但不是 JSON：${reply.body.slice(0, 200)}` };
  }
}

/** Every tool answers the same way: a sentence, or the host's own refusal. */
function say(r: Reply, ok: string): string {
  if (typeof r.error === "string") return r.error;
  return ok;
}

const journalTool = tool({
  name: "journal",
  label: "Journal",
  description: '往日记里写。texts 是字符串数组（1–20 条，一条一个元素），一次调用写几条。返回 {ids}：每条拿到的 id，形如 J20260302-2，可以用 open(id) 读回来。内容格式你定，没人解析。',
  parameters: {
    type: "object",
    properties: {
      texts: {
        type: "array",
        items: { type: "string", description: "一条一个元素。" },
        minItems: 1,
        maxItems: 20,
        description: "要写下的东西，最多 20 条。",
      },
    },
    required: ["texts"],
  },
  async execute(_id, params) {
    const r = await call("/journal", { texts: params.texts });
    const ids = Array.isArray(r.ids) ? (r.ids as string[]) : [];
    return {
      content: [{ type: "text", text: say(r, `写了 ${ids.length} 条：${ids.join("、")}`) }],
      details: r,
    };
  },
});

const loopOpenTool = tool({
  name: "loop_open",
  label: "Open loop",
  description: '记一件没闭合的事。text 写清这件事是什么、怎么算做完——下一轮的你才认得出什么时候算完。返回 {id}，形如 L12。它会出现在每张唤醒纸的条数里，直到 loop_close。',
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "这件事是什么，以及怎么算闭合。" } },
    required: ["text"],
  },
  async execute(_id, params) {
    const r = await call("/loop/open", { text: params.text });
    return {
      content: [{ type: "text", text: say(r, `记下了：${String(r.id ?? "?")}。`) }],
      details: r,
    };
  },
});

const loopCloseTool = tool({
  name: "loop_close",
  label: "Close loop",
  description: '关掉一件没闭合的事。id 来自 loop_open 的返回（形如 L12，不是文件名）。note 可选，写一句为什么算完了，附在文件末尾。不删内容，只是移到 open-loops/closed/，所以纸上的条数减一。返回 {id, closed}。',
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: '要关的那件事，形如 "L12"。' },
      note: { type: "string", description: "为什么算完了，一句话。" },
    },
    required: ["id"],
  },
  async execute(_id, params) {
    const r = await call("/loop/close", { id: params.id, note: params.note });
    return {
      content: [{ type: "text", text: say(r, `${String(r.id ?? "?")} 关掉了。`) }],
      details: r,
    };
  },
});

const discardTool = tool({
  name: "discard",
  label: "Discard journal entry",
  description: '撤掉一条写错的日记。id 来自 journal 的返回（形如 J20261104-3）。why 可选，写一句为什么不算数，附在文末。不删文件，只是移到 journal/discarded/，recall 里标「已丢弃」，open 仍然读得到。返回 {id, discarded}。已经丢弃过的再调一次不算错。',
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: '要撤的那条，形如 "J20261104-3"。' },
      why: { type: "string", description: "为什么不算数，一句话。" },
    },
    required: ["id"],
  },
  async execute(_id, params) {
    const r = await call("/discard", { id: params.id, why: params.why });
    return {
      content: [{ type: "text", text: say(r, `${String(r.id ?? "?")} 不算数了。`) }],
      details: r,
    };
  },
});

const waitTool = tool({
  name: "wait",
  label: "Wait",
  description: '定下一次什么时候醒。when 写一段时长（"20m"、"2h"、"90s"、"1d"）或者一个带时区的时刻（2026-03-02T09:15:00Z）；why 可选，写一句到时候你还认得出为什么。返回 {at}：真正生效的时刻——比最短间隔更近的会被抬到最短，回复的是抬完的时间。不调就按默认间隔醒。',
  parameters: {
    type: "object",
    properties: {
      when: { type: "string", description: '还要等多久，形如 "20m"；或者时刻 2026-03-02T09:15:00Z。' },
      why: { type: "string", description: "为什么那时候醒，一句话。" },
    },
    required: ["when"],
  },
  async execute(_id, params) {
    const r = await call("/wait", { when: params.when, why: params.why });
    return {
      content: [{ type: "text", text: say(r, `下次醒来：${String(r.at ?? "?")}`) }],
      details: r,
    };
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(journalTool);
  pi.registerTool(loopOpenTool);
  pi.registerTool(loopCloseTool);
  pi.registerTool(discardTool);
  pi.registerTool(waitTool);
}
