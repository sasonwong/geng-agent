import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths, requiredDirs } from "../internal/paths.ts";
import { bookHandler } from "../internal/book.ts";
import { openText, recallText } from "../internal/recall.ts";
import { ensureDirs } from "../internal/fs.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "geng-recall-"));
  const p = makePaths(root, "alice");
  ensureDirs(requiredDirs(p));
  return p;
}

test("one question over every place, and the ids it answers with are the ones open takes", () => {
  const p = fixture();
  mkdirSync(p.journal, { recursive: true });
  writeFileSync(join(p.journal, "J20260302-1.md"), "今天学会了闭嘴\n");
  mkdirSync(p.openLoops, { recursive: true });
  writeFileSync(join(p.openLoops, "L3.md"), "把那封信回掉\n");
  mkdirSync(join(p.openLoops, "closed"), { recursive: true });
  writeFileSync(join(p.openLoops, "closed", "L2.md"), "旧的\n[闭合 x] 完了\n");
  mkdirSync(p.mail, { recursive: true });
  writeFileSync(join(p.mail, "m1.json"), JSON.stringify({ id: "abc", at: "2026-03-02T07:00:00Z", from: "a@example.invalid", subject: "问候", text: "信里说了闭嘴" }));
  mkdirSync(p.people, { recursive: true });
  writeFileSync(join(p.people, "-1001.jsonl"), [JSON.stringify({ at: "2026-03-02T08:00:00Z", dir: "in", text: "在吗", from: "@someone" }), JSON.stringify({ at: "2026-03-02T08:01:00Z", dir: "out", text: "在" })].join("\n") + "\n");
  mkdirSync(p.inbox, { recursive: true });
  writeFileSync(join(p.inbox, "-1001-77.json"), JSON.stringify({ id: "M-1001-77", at: "2026-03-02T08:00:00Z", from: "telegram:@someone", text: "敲你一下" }));

  const listing = recallText(p, {});
  // closed loops are still listed: "how did that end" is the same question as "what is left"
  for (const id of ["J20260302-1", "L3", "L2", "abc", "P-1001", "M-1001-77"]) {
    assert.match(listing, new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}  `, "m"), `${id} 应该在列表里`);
  }

  // and the id from the listing is what open resolves — the two must not disagree
  for (const id of ["J20260302-1", "L3", "L2", "abc", "P-1001", "M-1001-77"]) {
    const r = openText(p, id, 0);
    assert.equal(r.found, true, `${id} 打不开`);
    assert.match(r.text, new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}  `));
  }
});

test("a query answers with the lines, and an empty answer says so", () => {
  const p = fixture();
  mkdirSync(p.journal, { recursive: true });
  writeFileSync(join(p.journal, "J20260302-1.md"), "第一行\n今天学会了闭嘴\n");
  assert.match(recallText(p, { query: "闭嘴" }), /J20260302-1[\s\S]*今天学会了闭嘴/);
  assert.equal(recallText(p, { query: "没出现过的东西" }), "没有哪一处提到「没出现过的东西」。");
  // sources narrows it: a journal term must not be found when only mail is asked for
  assert.equal(recallText(p, { query: "闭嘴", sources: ["mail"] }), "没有哪一处提到「闭嘴」。");
});

test("opening a mail is what makes it no longer new, in the same call", () => {
  const p = fixture();
  mkdirSync(p.mail, { recursive: true });
  for (const [n, id] of [["1", "aaa"], ["2", "bbb"]] as const) {
    writeFileSync(join(p.mail, `m${n}.json`), JSON.stringify({ id, at: "2026-03-02T07:00:00Z", text: "正文", subject: "s" }));
  }
  const first = openText(p, "aaa", 0);
  assert.match(first.text, /还剩 1 封没打开/);
  // opening it twice is not two reads of an unread mail
  assert.match(openText(p, "aaa", 0).text, /还剩 1 封没打开/);
  assert.match(openText(p, "bbb", 0).text, /还剩 0 封没打开/);
});

test("a long thing is paged, and says how to carry on", () => {
  const p = fixture();
  mkdirSync(p.journal, { recursive: true });
  writeFileSync(join(p.journal, "J20260302-1.md"), "甲".repeat(9_000));
  const first = openText(p, "J20260302-1", 0);
  assert.match(first.text, /还有 1000 字，offset=8000 接着读/);
  assert.match(openText(p, "J20260302-1", 8_000).text, /甲$/);
  // an id nothing has is a refusal, not an empty page
  assert.equal(openText(p, "J00000000-9", 0).found, false);
});

test("every line it can quote carries the id it has to quote with, all the way to the outbox", async () => {
  const p = fixture();
  mkdirSync(p.people, { recursive: true });
  writeFileSync(
    join(p.people, "-1001.jsonl"),
    [
      JSON.stringify({ at: "2026-03-02T08:00:00Z", dir: "in", text: "在吗", from: "@someone", id: "-1001-151" }),
      JSON.stringify({ at: "2026-03-02T08:01:00Z", dir: "out", text: "在" }),
    ].join("\n") + "\n",
  );
  mkdirSync(p.inbox, { recursive: true });
  writeFileSync(join(p.inbox, "-1001-152.json"), JSON.stringify({ id: "-1001-152", at: "2026-03-02T08:02:00Z", from: "telegram:@someone", text: "看这个" }));

  // the transcript shows the id next to the line it belongs to, not only on the listing
  const said = openText(p, "P-1001", 0).text;
  assert.match(said, /← @someone #-1001-151 在吗/);
  // a line it sent itself has no id to quote with, and printing a fake one would be worse
  assert.match(said, /→ 在$/m);

  // the inbox body carries its own file name, which is the id `open` and `say` both take
  const mail = openText(p, "M-1001-152", 0).text;
  assert.match(mail, /id=-1001-152/);

  // and the quote travels: a replyTo built from that id lands in the outbox unchanged
  const handle = bookHandler(p, { places: [-1001] });
  const r = await handle(
    { url: "/say", method: "POST" } as never,
    JSON.stringify({ messages: ["看到了"], replyTo: { chat: -1001, messageId: 151 } }),
  );
  assert.equal(r.status, 200);
  const queued = JSON.parse(readFileSync(join(p.outbox, `${(r.body as { id: string }).id}.json`), "utf8"));
  assert.deepEqual(queued.replyTo, { chat: -1001, messageId: 151 });
});

test("a file in the listing keeps its original name, and its size is what it is", () => {
  const p = fixture();
  mkdirSync(p.filesDir, { recursive: true });
  writeFileSync(join(p.filesDir, "F1-0-report.txt"), "hello");
  writeFileSync(join(p.filesDir, "F2-1-report.txt"), "x".repeat(3000));
  const listing = recallText(p, { sources: ["files"] });
  // the index in the file name is an implementation detail of the mail that carried it
  assert.match(listing, /F1 {2}files .*report\.txt（5 字节）/);
  assert.match(listing, /F2 {2}files .*report\.txt（3 KB）/);
  // and the body says how to get it and how to send it, because a file has no text to show
  assert.match(openText(p, "F1", 0).text, /download\("F1", "\/work\/\.\.\."\)/);
});

// 时间那一列是它判断「这是刚收到的还是上周的」的唯一依据，而它现在来自 `listFiles` 顺手
// 做的那一次 stat。以前是照着 id 和名字拼一个猜测的名字回目录里再找一个——同一件事两个
// 读者、每个文件一次全目录扫描，找不到时还会留 0（1970）。这条钉住日期仍然是对的。
test("a listed file carries the date it arrived, never 1970", () => {
  const p = fixture();
  mkdirSync(p.filesDir, { recursive: true });
  const file = join(p.filesDir, "F1-0-report.txt");
  writeFileSync(file, "hello");
  const when = new Date("2026-03-02T09:30:00Z");
  utimesSync(file, when, when);
  const listing = recallText(p, { sources: ["files"] });
  assert.match(listing, /^F1 {2}files {2}2026-03-02 09:30/m);
  assert.equal(listing.includes("1970"), false);
});

test("a discarded entry is still listed, and says it no longer counts", () => {
  const p = fixture();
  mkdirSync(p.journalDiscarded, { recursive: true });
  writeFileSync(join(p.journalDiscarded, "J20260303-1.md"), "记错了\n\n[丢弃 2026-03-03T10:00:00Z] 不算\n");
  const listing = recallText(p, { sources: ["journal"] });
  // the word for it is on the line, otherwise a taken-back entry reads like a live one
  assert.match(listing, /已丢弃 记错了/);
  // and `open` still reaches it, so "what did I say and why did I take it back" is answerable
  assert.match(openText(p, "J20260303-1", 0).text, /不算/);
});

test("an offset past the end is not the same thing as having no body", () => {
  const p = fixture();
  mkdirSync(p.journal, { recursive: true });
  writeFileSync(join(p.journal, "J20260302-1.md"), "只有这一句\n");
  const past = openText(p, "J20260302-1", 999);
  assert.equal(past.found, true);
  // reading past the end used to answer "这一件没有正文", which is a claim about the
  // thing, not about the offset — the reader then believes the entry is empty
  assert.doesNotMatch(past.text, /没有正文/);
  assert.match(past.text, /末尾/);
  // an item that really is empty still says so
  writeFileSync(join(p.journal, "J20260302-2.md"), "");
  assert.match(openText(p, "J20260302-2", 0).text, /没有正文/);
});

test("limit counts the things it shows, not the lines, and never cuts one in half", () => {
  const p = fixture();
  mkdirSync(p.journal, { recursive: true });
  // three entries that all match, each matching on two lines
  for (const n of [1, 2, 3]) {
    writeFileSync(join(p.journal, `J2026030${n}-1.md`), `有这个词 ${n} 上面\n中间\n下面还有这个词 ${n}\n`);
  }
  const one = recallText(p, { query: "这个词", limit: 1 });
  // one item: its id line and both hit lines; a header with no hits is not an answer
  assert.equal(one.split("\n").filter((l) => /^J/.test(l)).length, 1);
  assert.match(one, /有这个词/);
  assert.equal((one.match(/有这个词|下面还有这个词/g) ?? []).length, 2);
  // two asked for means two things, even though each brings its own lines along
  assert.equal(recallText(p, { query: "这个词", limit: 2 }).split("\n").filter((l) => /^J/.test(l)).length, 2);
  // limit bigger than the matches shows all of them, and no-query still means items
  assert.equal(recallText(p, { query: "这个词", limit: 50 }).split("\n").filter((l) => /^J/.test(l)).length, 3);
  assert.equal(recallText(p, { limit: 2 }).split("\n").filter((l) => /^J/.test(l)).length, 2);
});

test("two projects that both number a session 5 give two ids, and both open", () => {
  const p = fixture();
  for (const [project, text] of [["--home-work", "第一棵树说的话"], ["--other", "第二棵树说的话"]] as const) {
    mkdirSync(join(p.sessionDir, project), { recursive: true });
    writeFileSync(
      join(p.sessionDir, project, "2026-03-02T07-00-00-5.jsonl"),
      JSON.stringify({ message: { role: "user", content: text } }) + "\n",
    );
  }
  const listing = recallText(p, { sources: ["sessions"] });
  const ids = listing
    .split("\n")
    .map((l) => l.split("  ")[0] ?? "")
    .filter((id) => id.startsWith("R"));
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, `两个项目撞号了：${ids.join("、")}`);
  const texts = ids.map((id) => openText(p, id, 0).text);
  assert.ok(texts.some((t) => t.includes("第一棵树说的话")), texts.join("\n---\n"));
  assert.ok(texts.some((t) => t.includes("第二棵树说的话")), texts.join("\n---\n"));
  // one project keeps plain R5 — the suffix is only for a clash
  const one = fixture();
  mkdirSync(join(one.sessionDir, "--solo"), { recursive: true });
  writeFileSync(join(one.sessionDir, "--solo", "2026-03-02T07-00-00-5.jsonl"), JSON.stringify({ message: { role: "user", content: "只有一棵" } }) + "\n");
  assert.match(recallText(one, { sources: ["sessions"] }), /^R5  /m);
});
