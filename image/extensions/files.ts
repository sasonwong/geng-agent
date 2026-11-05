/**
 * download — the only way a file leaves the book.
 *
 * `/files` is not mounted: a received attachment is an id (`F12`), and getting the bytes
 * means asking for them. The model chooses where they land, because choosing a path is
 * its business; where it may *not* land is not, and that check is the host's.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tool } from "./lib/tool.ts";
import { resolveUnder } from "./lib/under.ts";
import { getToFile } from "./lib/uds.ts";

const SOCKET = process.env.GENG_BOOK_SOCK ?? "";
/** The container's working directory, mounted from the instance's `workspace/`. */
const WORK = "/work";

const downloadTool = tool({
  name: "download",
  label: "Download",
  description:
    "把别人发来的一个文件取到手上。id 来自 recall(sources:[\"files\"]) 或者一封邮件的附件，形如 F12。" +
    "to 是你自己定的落地路径，必须在 /work 下，例如 /work/in/photo.jpg；目录会自己建。" +
    "返回 {path, bytes}。取到的文件是副本，改它不影响原件。" +
    "要发出去不必先取——say 可以直接写 F12。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: '文件 id，形如 "F12"。' },
      to: { type: "string", description: '落到哪里，必须写 /work 下的路径，形如 "/work/in/report.pdf"。' },
    },
    required: ["id", "to"],
  },
  async execute(_toolCallId, params) {
    const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
    if (SOCKET === "") return say("没有配置记忆端点：GENG_BOOK_SOCK 是空的。");
    const dest = resolveUnder(WORK, params.to);
    if (dest === null) return say(`只能取到 /work 里面：${params.to} 不在那儿。`);
    try {
      mkdirSync(dirname(dest), { recursive: true });
    } catch (err) {
      return say(`建不了目录：${(err as Error).message}`);
    }
    try {
      const r = await getToFile(SOCKET, `/files/${encodeURIComponent(params.id.trim())}`, dest);
      return {
        content: [{ type: "text" as const, text: `取到了：${params.to}（${r.bytes} 字节）。` }],
        // the description promises {path, bytes}; saying it in prose and nowhere else made
        // that a promise the tool did not keep
        details: { path: params.to, bytes: r.bytes },
      };
    } catch (err) {
      return say((err as Error).message);
    }
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(downloadTool);
}
