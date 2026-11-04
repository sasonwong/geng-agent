/**
 * journal / loop_open / loop_close / wait — the only way into the book.
 *
 * One verb per object on purpose: a single `remember(kind, …)` would carry four different
 * write semantics behind one name, and calling it wrong would put a diary entry where an
 * unfinished thing belongs. Reads are generalised (`recall`/`open`), writes are not.
 *
 * Nothing here decides anything. The host writes the file, allocates the id, and answers
 * with it; this file is a messenger that turns a refusal into a sentence a person can act
 * on. A missing socket is reported as itself, never as "failed".
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { postJson } from "./lib/uds.ts";

const SOCKET = process.env.GENG_BOOK_SOCK ?? "";

type Reply = Record<string, unknown>;

async function call(path: string, body: Record<string, unknown>): Promise<Reply> {
  if (SOCKET === "") {
    throw new Error("没有配置记忆端点：GENG_BOOK_SOCK 是空的。");
  }
  const reply = await postJson(SOCKET, path, body);
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

const journalTool = defineTool({
  name: "journal",
  label: "Journal",
  description:
    "往日记里写。一次调用写几条，每条一个元素；返回它们拿到的 id（形如 J20260303-2），" +
    "以后可以用 open(id) 读回来。内容格式你定，没人解析它。",
  parameters: Type.Object({
    texts: Type.Array(Type.String({ description: "一条一个元素。" }), {
      minItems: 1,
      maxItems: 20,
      description: "要写下的东西，最多 20 条。",
    }),
  }),
  async execute(_id, params) {
    const r = await call("/journal", { texts: params.texts });
    const ids = Array.isArray(r.ids) ? (r.ids as string[]) : [];
    return {
      content: [{ type: "text", text: say(r, `写了 ${ids.length} 条：${ids.join("、")}`) }],
      details: r,
    };
  },
});

const loopOpenTool = defineTool({
  name: "loop_open",
  label: "Open loop",
  description:
    "记一件没闭合的事。返回 id（形如 L12）。它会出现在每张唤醒纸的条数里，" +
    "直到你用 loop_close 关掉它。写清怎么算做完，下一轮的你才认得出什么时候算完。",
  parameters: Type.Object({
    text: Type.String({ description: "这件事是什么，以及怎么算闭合。" }),
  }),
  async execute(_id, params) {
    const r = await call("/loop/open", { text: params.text });
    return {
      content: [{ type: "text", text: say(r, `记下了：${String(r.id ?? "?")}。`) }],
      details: r,
    };
  },
});

const loopCloseTool = defineTool({
  name: "loop_close",
  label: "Close loop",
  description:
    "关掉一件没闭合的事。id 来自 loop_open 或者唤醒纸上那个数；不删内容，" +
    "只是把它移到 open-loops/closed/，所以纸上的条数会减一。note 写一句为什么关。",
  parameters: Type.Object({
    id: Type.String({ description: '要关的那件事，形如 "L12"。' }),
    note: Type.Optional(Type.String({ description: "为什么算完了，一句话。" })),
  }),
  async execute(_id, params) {
    const r = await call("/loop/close", { id: params.id, note: params.note });
    return {
      content: [{ type: "text", text: say(r, `${String(r.id ?? "?")} 关掉了。`) }],
      details: r,
    };
  },
});

const waitTool = defineTool({
  name: "wait",
  label: "Wait",
  description:
    "定下一次什么时候醒。when 写一段时长（\"20m\"、\"2h\"、\"90s\"）或者一个带时区的时刻；why 写一句到时候你还认得出为什么。" +
    "不调就按默认间隔醒。返回真正生效的时刻（太近的会被抬到最短间隔）。",
  parameters: Type.Object({
    when: Type.String({ description: '还要等多久，形如 "20m"；或者时刻 2026-03-02T09:15:00Z。' }),
    why: Type.Optional(Type.String({ description: "为什么那时候醒，一句话。" })),
  }),
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
  pi.registerTool(waitTool);
}
