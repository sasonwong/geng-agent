import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markSeen, newestKnock, peekInbox, quarantine } from "../internal/inbox.ts";
import { writeJson } from "../internal/fs.ts";

function inbox(): { dir: string; seen: string } {
  const base = mkdtempSync(join(tmpdir(), "geng-test-"));
  const dir = join(base, "inbox");
  const seen = join(dir, "seen");
  mkdirSync(seen, { recursive: true });
  return { dir, seen };
}

test("peekInbox does not consume anything", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "001.json"), JSON.stringify({ text: "在吗" }));
  writeFileSync(join(dir, "002.json"), JSON.stringify({ text: "还在吗" }));

  const peeked = peekInbox(dir);
  assert.equal(peeked.length, 2);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 2);
  assert.equal(readdirSync(seen).length, 0);
});

test("peekInbox reads in filename order and leaves the files alone", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "002.json"), JSON.stringify({ text: "第二条" }));
  writeFileSync(join(dir, "001.json"), JSON.stringify({ text: "第一条" }));

  const peeked = peekInbox(dir);
  assert.deepEqual(peeked.map((m) => m.text), ["第一条", "第二条"]);
  assert.deepEqual(peeked.map((m) => m.file), ["001.json", "002.json"]);
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 2);
  assert.equal(readdirSync(seen).length, 0);
});

test("markSeen moves only what this wake handed over", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "001.json"), JSON.stringify({ text: "第一条" }));
  writeFileSync(join(dir, "002.json"), JSON.stringify({ text: "第二轮才看" }));

  markSeen([dir], seen, ["001.json"]);
  assert.deepEqual(readdirSync(seen), ["001.json"]);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".json")), ["002.json"]);
});

test("two inbox halves holding one filename do not lose or redeliver a message", () => {
  const base = mkdtempSync(join(tmpdir(), "geng-test-"));
  const high = join(base, "inbox");
  const low = join(base, "inbox-low");
  const seen = join(base, "seen");
  for (const d of [high, low, seen]) mkdirSync(d, { recursive: true });
  const name = "111-42.json";
  writeFileSync(join(high, name), JSON.stringify({ text: "高优先级那一半" }));
  writeFileSync(join(low, name), JSON.stringify({ text: "低优先级那一半" }));

  const both = [...peekInbox(high), ...peekInbox(low)];
  assert.equal(both.length, 2, "两半各自读到了自己的文件");
  assert.notEqual(both[0]?.dir, both[1]?.dir);

  markSeen([high, low], seen, both.map((m) => ({ dir: m.dir, file: m.file })));
  // 两份都离开了 inbox，seen/ 里也留下了两份可读记录，没有互相覆盖。
  assert.equal(readdirSync(high).filter((f) => f.endsWith(".json")).length, 0);
  assert.equal(readdirSync(low).filter((f) => f.endsWith(".json")).length, 0);
  assert.equal(readdirSync(seen).filter((f) => f.endsWith(".json")).length, 2);
  assert.equal(peekInbox(high).length + peekInbox(low).length, 0, "下一轮不再重复递送");
});

test("markSeen quarantines an unparseable message instead of dying", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "001.json"), "{not json");
  writeFileSync(join(dir, "002.json"), JSON.stringify({ text: "好的" }));

  markSeen([dir], seen, ["001.json", "002.json"]);
  assert.ok(readdirSync(seen).some((f) => f.endsWith(".bad")));
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".json")), []);
});

test("an empty-text message is not handed over, and is quarantined instead of knocking", () => {
  const { dir, seen } = inbox();
  writeFileSync(join(dir, "001.json"), JSON.stringify({ text: "   " }));
  assert.equal(peekInbox(dir).length, 0);
  markSeen([dir], seen, ["001.json"]);
  assert.ok(readdirSync(seen).some((f) => f.endsWith(".bad")));
});

test("the typing indicator follows the newest knock, in its own chat", () => {
  const msgs = [
    { id: "1", at: "2026-03-02T08:00:00Z", chat: 111 },
    { id: "2", at: "2026-03-02T08:05:00Z", chat: -222 },
    { id: "3", at: "2026-03-02T08:01:00Z" },
  ];
  assert.equal(newestKnock(msgs)?.id, "2");
  assert.equal(newestKnock([{ id: "4", at: "2026-03-02T08:00:00Z" }]), null);
});

test("a picture with no caption is a message, not a broken file", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const inbox = join(root, "inbox");
  const seen = join(root, "seen");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(seen, { recursive: true });
  // exactly what the gateway writes for a document sent without words
  writeJson(join(inbox, "-100-9.json"), {
    id: "-100-9",
    text: "",
    from: "telegram:@you",
    at: "2026-03-02T09:00:00Z",
    chat: -100,
    attachments: [{ kind: "document", id: "F9", name: "-100-9-a.md", bytes: 12 }],
  });
  const msgs = peekInbox(inbox);
  assert.equal(msgs.length, 1);
  // the id, because that is what `download` and `say` take; `path` is not a field any more
  assert.deepEqual(msgs[0]?.attachments, [{ kind: "document", id: "F9", name: "-100-9-a.md", bytes: 12 }]);
});

test("a file with neither words nor attachments is set aside, and never knocks", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const inbox = join(root, "inbox");
  const seen = join(root, "seen");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(seen, { recursive: true });
  writeFileSync(join(inbox, "-100-10.json"), JSON.stringify({ id: "-100-10", text: "" }));
  // the knock count is the parser's, not a directory listing: this is the loop that cost
  // around sixty cycles in an hour
  assert.equal(peekInbox(inbox).length, 0);
  assert.deepEqual(quarantine(inbox, seen), ["-100-10.json"]);
  assert.equal(existsSync(join(seen, "-100-10.json.bad")), true);
  assert.equal(existsSync(join(inbox, "-100-10.json")), false);
});
