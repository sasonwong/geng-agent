import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDirs } from "../internal/fs.ts";
import { makePaths, requiredDirs, type Paths } from "../internal/paths.ts";
import { fileById } from "../internal/ids.ts";
import { readSaid } from "../internal/people.ts";
import { handleInbound, readChats, type InboundHost } from "../internal/channels/core.ts";
import type { Chats, Inbound, RemoteAttachment } from "../internal/channels/channel.ts";

function fixture(): {
  root: string;
  paths: Paths;
  host: InboundHost;
  lines: string[];
} {
  const root = mkdtempSync(join(tmpdir(), "geng-channel-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  const lines: string[] = [];
  const chats: Record<string, Chats> = {};
  const host: InboundHost = {
    root,
    chats,
    chatsFile: join(root, "data", "_gateway", "chats.json"),
    ops: join(root, "data", "_ops"),
    log: (line) => lines.push(line),
    instanceData: (key) => (key === "alice" ? paths : null),
  };
  return { root, paths, host, lines };
}

function message(over: Partial<Inbound> = {}): Inbound {
  return {
    channel: "telegram",
    nativeId: "42",
    chat: 111,
    chatKind: "private",
    who: "tester",
    fromId: "1",
    text: "你好",
    at: "2026-11-09T08:00:00.000Z",
    allowed: true,
    isDm: true,
    isMention: false,
    isReply: false,
    listen: "all",
    homeRank: 2,
    attachments: [],
    ...over,
  };
}

function inboxFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

test("a normalized message lands in the inbox and the transcript, whichever channel carried it", async () => {
  const f = fixture();
  await handleInbound(f.host, "alice", message());

  assert.deepEqual(inboxFiles(f.paths.inbox), ["111-42.json"]);
  const record = JSON.parse(readFileSync(join(f.paths.inbox, "111-42.json"), "utf8")) as {
    id: string;
    text: string;
    chat: number;
    from: string;
  };
  assert.equal(record.id, "111-42");
  assert.equal(record.text, "你好");
  assert.equal(record.chat, 111);
  assert.equal(record.from, "tester");

  const transcript = readSaid(f.paths.data, 111, 10);
  assert.equal(transcript?.total, 1);
  assert.equal(transcript?.tail[0]?.text, "你好");

  const chats = readChats(f.host.chatsFile).alice;
  assert.equal(chats?.home, 111);
  assert.equal(chats?.known?.["111"]?.channel, "telegram");
});

test("a guest never reaches the inbox, and its id is printed for the allow list", async () => {
  const f = fixture();
  await handleInbound(f.host, "alice", message({ allowed: false, fromId: "999" }));
  assert.deepEqual(inboxFiles(f.paths.inbox), []);
  assert.match(f.lines.join("\n"), /guest 999/);
});

test("a redelivery writes one inbox file and one transcript line", async () => {
  const f = fixture();
  await handleInbound(f.host, "alice", message());
  await handleInbound(f.host, "alice", message());
  assert.deepEqual(inboxFiles(f.paths.inbox), ["111-42.json"]);
  assert.equal(readSaid(f.paths.data, 111, 10)?.total, 1);
});

test("a reply-only channel can be home, but a channel that can open a conversation takes it", async () => {
  const f = fixture();
  const weixin = -9_000_000_000_000_001;
  // no Telegram place yet: the only place it has is where unprompted words must go
  await handleInbound(
    f.host,
    "alice",
    message({ channel: "weixin", channelLabel: "微信", chat: weixin, homeRank: 1 }),
  );
  assert.equal(readChats(f.host.chatsFile).alice?.home, weixin);

  // Telegram appears later and can actually open a conversation: it takes home
  await handleInbound(f.host, "alice", message({ chat: 222, homeRank: 2 }));
  assert.equal(readChats(f.host.chatsFile).alice?.home, 222);

  // a second reply-only chat must not steal it back
  await handleInbound(
    f.host,
    "alice",
    message({ channel: "weixin", chat: weixin - 1, homeRank: 1 }),
  );
  assert.equal(readChats(f.host.chatsFile).alice?.home, 222);
});

test("ambient group talk goes to the low inbox and does not wake", async () => {
  const f = fixture();
  await handleInbound(
    f.host,
    "alice",
    message({
      chat: -1001234567890,
      chatKind: "group",
      chatTitle: "测试群",
      isDm: false,
      homeRank: 0,
    }),
  );
  assert.deepEqual(inboxFiles(f.paths.inbox), []);
  assert.deepEqual(inboxFiles(f.paths.inboxLow), ["-1001234567890-42.json"]);
  assert.doesNotMatch(f.lines.join("\n"), /唤醒/);
});

test("an attachment is fetched once; a channel that chose not to fetch keeps its note", async () => {
  const f = fixture();
  const photo: RemoteAttachment = {
    kind: "photo",
    name: "pic.jpg",
    download: async (dest: string): Promise<number> => {
      writeFileSync(dest, new Uint8Array([1, 2, 3]));
      return 3;
    },
  };
  await handleInbound(f.host, "alice", message({ text: "", attachments: [photo] }));
  const record = JSON.parse(readFileSync(join(f.paths.inbox, "111-42.json"), "utf8")) as {
    attachments: { id?: string; kind: string }[];
  };
  assert.equal(record.attachments[0]?.id, "F1");
  assert.equal(fileById(f.paths, "F1")?.name, "F1-0-pic.jpg");
  assert.match(readSaid(f.paths.data, 111, 10)?.tail[0]?.text ?? "", /图片/);

  const g = fixture();
  await handleInbound(
    g.host,
    "alice",
    message({ text: "", attachments: [{ kind: "voice", note: "没有转写" }] }),
  );
  const voice = JSON.parse(readFileSync(join(g.paths.inbox, "111-42.json"), "utf8")) as {
    attachments: { id?: string; kind: string; note?: string }[];
  };
  assert.equal(voice.attachments[0]?.id, undefined);
  assert.equal(voice.attachments[0]?.note, "没有转写");
});
