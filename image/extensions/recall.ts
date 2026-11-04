/**
 * recall / open — the reading half of the book.
 *
 * Writes are one verb per object (`journal`, `loop_open`, `loop_close`, `wait`); reads are
 * generalised, because asking one question of six places is the same question.
 *
 * The book is not mounted in this container: /state, /mail, /people and /inbox are gone,
 * so this is the only way in. That is the point — a `cat` used to count as a read the
 * daemon could not name, and now every read is a call it can.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tool } from "./lib/tool.ts";
import { postJson } from "./lib/uds.ts";

const SOCKET = process.env.GENG_BOOK_SOCK ?? "";

async function call(route: string, body: Record<string, unknown>): Promise<string> {
  if (SOCKET === "") throw new Error("没有配置记忆端点：GENG_BOOK_SOCK 是空的。");
  const reply = await postJson(SOCKET, route, body);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(reply.body) as Record<string, unknown>;
  } catch {
    return `记忆端点答了 ${reply.status}，但不是 JSON：${reply.body.slice(0, 200)}`;
  }
  if (typeof parsed.error === "string") return parsed.error;
  return typeof parsed.text === "string" ? parsed.text : "记忆端点答了空。";
}

const recallTool = tool({
  name: "recall",
  label: "Recall",
  description: '翻自己的书。query 可选：给了就只回出现它的那几行，不给就按时间列最近的。sources 可选，取值 journal（日记）/ loops（没闭合的事，含已闭合）/ mail（邮件）/ people（和谁说过什么）/ inbox（收到的消息）/ sessions（醒过的每一轮）/ files（别人发来的文件），默认全翻。limit 默认 20，最多 50。每条回 id、来源、时间、一行摘要；要看全文用 open(id)。',
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "要找的词。不给就是最近的东西。" },
      sources: {
        type: "array",
        items: { type: "string", enum: ["journal", "loops", "mail", "people", "inbox", "sessions", "files"] },
        description: "只翻这几处，默认全翻。",
      },
      limit: { type: "integer", minimum: 1, maximum: 50, description: "最多几条，默认 20。" },
    },
  },
  async execute(_toolCallId, params) {
    const text = await call("/recall", { query: params.query, sources: params.sources, limit: params.limit });
    return { content: [{ type: "text", text }], details: undefined };
  },
});

const openTool = tool({
  name: "open",
  label: "Open",
  description: '读一件东西的全文。id 的形状：日记 J20260302-2；没闭合的事 L12（已闭合的也打得开）；一个人 P-1001（他说过的全部话）；醒过的一轮 R5；一封邮件 E12；一条收到的消息 M-1001-77。offset 可选，接着上次读。返回正文；超过 8000 字会告诉你下一个 offset。打开一封邮件就算处理过了。',
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "要读的那一件，形如 J20260303-2、L12、P-1001、R5、E12、M-1001-77；字母决定是哪一类。" },
      offset: { type: "integer", minimum: 0, description: "从第几个字开始，接着上次读。" },
    },
    required: ["id"],
  },
  async execute(_toolCallId, params) {
    const text = await call("/open", { id: params.id, offset: params.offset });
    return { content: [{ type: "text", text }], details: undefined };
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(recallTool);
  pi.registerTool(openTool);
}
