/**
 * web_search / web_fetch — the container has no search credential. It has a socket
 * path and a token that can only search, plus whatever quota the host endpoint allows.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { postJson } from "./lib/uds.ts";

const SOCKET = process.env.GENG_SEARCH_SOCKET ?? "";
const TOKEN = process.env.GENG_SEARCH_TOKEN ?? "";

async function call(path: string, body: Record<string, unknown>): Promise<string> {
  if (SOCKET === "") {
    throw new Error("没有配置搜索端点：GENG_SEARCH_SOCKET 是空的。");
  }
  const reply = await postJson(SOCKET, path, body, { "x-geng-token": TOKEN });
  let payload: { data?: unknown; error?: string; remaining?: number };
  try {
    payload = JSON.parse(reply.body) as typeof payload;
  } catch {
    return `搜索端点答了 ${reply.status}，但不是 JSON：${reply.body.slice(0, 200)}`;
  }
  const left = typeof payload.remaining === "number" ? `（今天还剩 ${payload.remaining} 次）` : "";
  if (payload.error) return `${payload.error}${left}`;
  return JSON.stringify(payload.data) + left;
}

const searchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description: '搜网。query 写要搜的东西。返回标题、链接和摘要；搜不了会明说为什么。',
  parameters: Type.Object({
    query: Type.String({ description: "查询，1-128 字符。" }),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    need_content: Type.Optional(Type.Boolean({ description: "也把正文取回来，会大很多。" })),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: await call("/search", params) }],
      details: undefined,
    };
  },
});

const fetchTool = defineTool({
  name: "web_fetch",
  label: "Web Fetch",
  description: '取一个网页的正文。url 写完整地址。返回正文（太长会截断）；取不到会明说原因。',
  parameters: Type.Object({
    url: Type.String({ description: "http(s) URL。" }),
  }),
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: await call("/fetch", params) }],
      details: undefined,
    };
  },
});

export default function (pi: ExtensionAPI) {
  if (SOCKET === "") return;
  pi.registerTool(searchTool);
  pi.registerTool(fetchTool);
}
