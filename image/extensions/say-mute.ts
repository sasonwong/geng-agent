/**
 * say / mute — the two things the agent can do to a person instead of to a file.
 *
 * Both write into /state, which the gateway reads. They never talk to Telegram
 * themselves: the container has no bot token, and must not have one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE = process.env.GENG_STATE ?? "/state";
// mounted at the top level on purpose: a mount nested under /state makes docker create
// its mountpoint inside the bind, which lands in the agent's own book as a root-owned dir
const OUTBOX = process.env.GENG_OUTBOX ?? "/outbox";
const MUTE = join(STATE, "mute.json");

function writeAtomic(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

function nextId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const sayTool = defineTool({
  name: "say",
  label: "Say",
  description:
    "说话。一次调用里的几句会一起送到；分几次调用就是隔一阵说一句。没人问你的时候也可以说。不写 to 就是私聊。",
  parameters: Type.Object({
    messages: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 20,
      description: "要说的话，一句一个元素。",
    }),
    to: Type.Optional(
      Type.String({
        description: "发给哪个 chat 的 id（见纸上的「能说话的地方」）。不写就是私聊。",
      }),
    ),
    files: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 10,
        description: "一起发出去的文件，写 /work 里的绝对路径（例如 /work/report.html）。",
      }),
    ),
  }),
  async execute(_toolCallId, params) {
    const messages = params.messages.filter((m) => m.trim() !== "");
    if (messages.length === 0) {
      return { content: [{ type: "text", text: "没说什么。" }], details: undefined };
    }
    const chat = params.to === undefined ? undefined : Number(params.to);
    if (params.to !== undefined && !Number.isFinite(chat)) {
      return { content: [{ type: "text", text: `to 要写 chat 的 id：${params.to} 不是。` }], details: undefined };
    }
    const files = (params.files ?? []).filter((f) => f.trim() !== "");
    const id = nextId();
    writeAtomic(
      join(OUTBOX, `${id}.json`),
      JSON.stringify({
        id,
        messages,
        ...(chat === undefined ? {} : { chat }),
        ...(files.length === 0 ? {} : { files }),
      }) + "\n",
    );
    return {
      content: [
        {
          type: "text",
          text: `说了 ${messages.length} 句${files.length === 0 ? "" : `，带 ${files.length} 个文件`}。`,
        },
      ],
      details: { id, count: messages.length },
    };
  },
});

const muteTool = defineTool({
  name: "mute",
  label: "Mute",
  description:
    "安静一段时间：把某个来源从「会叫醒你」降成「等你下次醒来再看」。消息一条都不会丢。直接对你说话的人（@你、回复你、私聊你）不受影响。",
  parameters: Type.Object({
    target: Type.String({
      description: '要安静的来源："*"（全部环境噪音）、"dm"（私聊）、或 "chat:<id>"。',
    }),
    minutes: Type.Integer({ minimum: 1, maximum: 10080, description: "安静多少分钟。" }),
    why: Type.String({ description: "为什么。会写进你下次醒来的纸上。" }),
  }),
  async execute(_toolCallId, params) {
    const until = new Date(Date.now() + params.minutes * 60_000).toISOString();
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(readFileSync(MUTE, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    current[params.target] = { until, why: params.why };
    writeAtomic(MUTE, JSON.stringify(current, null, 2) + "\n");
    return {
      content: [{ type: "text", text: `安静到 ${until}。` }],
      details: { target: params.target, until },
    };
  },
});

export default function (pi: ExtensionAPI) {
  if (!existsSync(STATE)) return;
  pi.registerTool(sayTool);
  pi.registerTool(muteTool);
}
