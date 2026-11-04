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
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

const recallTool = defineTool({
  name: "recall",
  label: "Recall",
  description:
    "翻自己的书：日记、没闭合和已闭合的事、邮件、说过话的人、收件箱、醒过的每一轮。" +
    "不给 query 就按时间列出最近的；给了 query 就只回出现它的那几行。要看全文用 open(id)。",
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "要找的词。不给就是最近的东西。" })),
    sources: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("journal"),
          Type.Literal("loops"),
          Type.Literal("mail"),
          Type.Literal("people"),
          Type.Literal("inbox"),
          Type.Literal("sessions"),
        ]),
        { description: "只翻这几处，默认全翻。" },
      ),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "最多几条，默认 20。" })),
  }),
  async execute(_toolCallId, params) {
    const text = await call("/recall", { query: params.query, sources: params.sources, limit: params.limit });
    return { content: [{ type: "text", text }], details: undefined };
  },
});

const openTool = defineTool({
  name: "open",
  label: "Open",
  description:
    "读一件东西的全文：日记、没闭合的事、一封邮件、一个人说过的所有话、一条收到的消息、醒过的一轮。" +
    "id 来自 recall。长的一页读不完，会告诉你用哪个 offset 接着读。打开邮件就算处理过了。",
  parameters: Type.Object({
    id: Type.String({ description: "要读的那一件，形如 J20260303-2、L12、chat:-1001、S2026-11-04T03:34。" }),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "从第几个字开始，接着上次读。" })),
  }),
  async execute(_toolCallId, params) {
    const text = await call("/open", { id: params.id, offset: params.offset });
    return { content: [{ type: "text", text }], details: undefined };
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(recallTool);
  pi.registerTool(openTool);
}
