/**
 * web_search / web_fetch — the container has no search credential, not even a search-only
 * one: it has a socket path, and the endpoint on the other side enforces the quota.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tool } from "./lib/tool.ts";
import { postJsonOrError } from "./lib/uds.ts";

const SOCKET = process.env.GENG_SEARCH_SOCKET ?? "";

async function call(path: string, body: Record<string, unknown>): Promise<string> {
  if (SOCKET === "") {
    return "没有配置搜索端点：GENG_SEARCH_SOCKET 是空的。";
  }
  const reply = await postJsonOrError(SOCKET, path, body);
  let payload: { data?: unknown; error?: string; remaining?: number };
  try {
    payload = JSON.parse(reply.body) as typeof payload;
  } catch {
    return `搜索端点答了 ${reply.status}，但不是 JSON：${reply.body.slice(0, 200)}`;
  }
  const left = typeof payload.remaining === "number" ? `（今天还剩 ${payload.remaining} 次）` : "";
  if (payload.error) return `${payload.error}${left}`;
  // JSON.stringify(undefined) returns undefined, not a string: a reply with no `data`
  // used to hand pi a tool result whose text was not a string at all.
  return `${payload.data === undefined ? "搜索端点没有回内容" : JSON.stringify(payload.data)}${left}`;
}

const searchTool = tool({
  name: "web_search",
  label: "Web Search",
  description: '搜网。query 写要搜的东西。返回标题、链接和摘要；搜不了会明说为什么。',
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "查询，1-128 字符。" },
      count: { type: "integer", minimum: 1, maximum: 20 },
      need_content: { type: "boolean", description: "也把正文取回来，会大很多。" },
    },
    required: ["query"],
  },
  async execute(_toolCallId, params) {
    return {
      content: [{ type: "text", text: await call("/search", params) }],
      details: undefined,
    };
  },
});

const fetchTool = tool({
  name: "web_fetch",
  label: "Web Fetch",
  description: '取一个网页的正文。url 写完整地址。返回正文（太长会截断）；取不到会明说原因。',
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "http(s) URL。" } },
    required: ["url"],
  },
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
