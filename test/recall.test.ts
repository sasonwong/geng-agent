import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths, requiredDirs } from "../internal/paths.ts";
import { bookHandler } from "../internal/book.ts";
import { lastJournalLine, openText, recallText } from "../internal/recall.ts";
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

test("a query answers with the newest matches, with dates, not the oldest", () => {
  const p = fixture();
  mkdirSync(p.people, { recursive: true });
  const day = (d: number, hour: number) =>
    JSON.stringify({
      at: `2026-01-0${d}T0${hour}:00:00Z`,
      dir: "in",
      text: `第 ${d} 天的苹果问题`,
      from: "@someone",
    });
  writeFileSync(join(p.people, "-1001.jsonl"), [1, 2, 3, 4].map((d) => day(d, d)).join("\n") + "\n");

  const text = recallText(p, { sources: ["people"], query: "苹果" });
  // three newest matches, oldest-to-newest inside the answer
  assert.match(text, /2026-01-02 02:00/);
  assert.match(text, /2026-01-03 03:00/);
  assert.match(text, /2026-01-04 04:00/);
  assert.doesNotMatch(text, /2026-01-01 01:00/);
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

test("mail 的 attachments 里有 null 元素，recall 与 open 都不崩", () => {
  const p = fixture();
  mkdirSync(p.mail, { recursive: true });
  // 别的进程写进来的数组元素是 unknown：null 以前被送到 a.id 上抛 TypeError，
  // 整次 recall / open 查询（模型每轮都调）就这么没了。
  writeFileSync(
    join(p.mail, "m1.json"),
    JSON.stringify({
      id: "E1",
      at: "2026-03-02T07:00:00Z",
      from: "a@example.invalid",
      subject: "带附件",
      text: "正文",
      attachments: [null, 42, "坏数据"],
    }),
  );
  assert.match(recallText(p, { sources: ["mail"] }), /E1/);
  assert.match(openText(p, "E1", 0).text, /正文/);
});

test("session 里 content 为 null 或数组含 null 元素，recall 都不崩", () => {
  const p = fixture();
  const dir = join(p.sessionDir, "--proj-x");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "session-1.jsonl"),
    [
      // 某个 pi 版本会给 content 写 null：整条 JSONL 字段不能是 iterable
      JSON.stringify({ message: { role: "user", content: null } }),
      // 数组里混进一个 null 元素，旧的 for…of 会读它 .type 而抛
      JSON.stringify({
        message: { role: "assistant", content: [null, { type: "text", text: "你好" }] },
      }),
    ].join("\n") + "\n",
  );
  assert.match(recallText(p, { sources: ["sessions"], query: "你好" }), /R1[\s\S]*你好/);
});

test("session 视图里留着工具说了什么，不是只有 [tool] 这个名字", () => {
  const p = fixture();
  const dir = join(p.sessionDir, "--proj-x");
  mkdirSync(dir, { recursive: true });
  const long = "x".repeat(5_000);
  writeFileSync(
    join(dir, "session-1.jsonl"),
    [
      JSON.stringify({ type: "message", message: { role: "user", content: "跑一下" } }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "a.txt\nb.txt" }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read",
          isError: true,
          content: [{ type: "text", text: long }],
        },
      }),
    ].join("\n") + "\n",
  );
  const body = openText(p, "R1", 0).text;
  // 压缩之后指回 session 才读得到工具的回答；只有 [bash] 的话，指过去也是空的
  assert.match(body, /\[bash\] a\.txt\nb\.txt/);
  // 失败也是一条事实：不写出来的话，失败的输出和成功的长得一样
  assert.match(body, /\[read 出错\]/);
  // 一条 5000 字的输出不能把一页撑满，截断处要说清原长
  assert.match(body, /…（截断，原 5000 字）/);
  assert.doesNotMatch(body, new RegExp("x{2500}"));
  // 搜索和 open 走同一条渲染
  assert.match(recallText(p, { sources: ["sessions"], query: "a.txt" }), /R1[\s\S]*a\.txt/);
});

test("the page quotes the newest live journal line, not the name that sorts last", () => {
  const p = fixture();
  const first = join(p.journal, "J20260302-1.md");
  const tenth = join(p.journal, "J20260302-10.md");
  const discarded = join(p.journalDiscarded, "J20260302-2.md");
  const stray = join(p.journal, "notes.md");
  writeFileSync(first, "钟表上更新的那条\n");
  writeFileSync(tenth, "名字排在后面的那条\n");
  writeFileSync(discarded, "丢掉的一条\n");
  writeFileSync(stray, "不是一条日记\n");
  const at = (s: string) => new Date(s);
  utimesSync(first, at("2026-03-02T09:00:00Z"), at("2026-03-02T09:00:00Z"));
  utimesSync(tenth, at("2026-03-02T08:00:00Z"), at("2026-03-02T08:00:00Z"));
  // a discarded entry is not the last thing it wrote, and a stray note is not an entry
  utimesSync(discarded, at("2026-03-02T10:00:00Z"), at("2026-03-02T10:00:00Z"));
  utimesSync(stray, at("2026-03-02T11:00:00Z"), at("2026-03-02T11:00:00Z"));
  assert.equal(lastJournalLine(p), "钟表上更新的那条");
  // the helper keeps the whole line; the page cuts it and marks the cut
  const long = join(p.journal, "J20260302-3.md");
  writeFileSync(long, "长".repeat(300) + "\n");
  utimesSync(long, at("2026-03-02T09:30:00Z"), at("2026-03-02T09:30:00Z"));
  assert.equal(lastJournalLine(p), "长".repeat(300));
  assert.equal(lastJournalLine(fixture()), null);
});

test("offset 越过末尾时说清有多长，而不是给一页空白", () => {
  const p = fixture();
  mkdirSync(p.journal, { recursive: true });
  writeFileSync(join(p.journal, "J20260302-1.md"), "今天很安静"); // 5 字
  const r = openText(p, "J20260302-1", 9_999);
  assert.equal(r.found, true);
  // 旧代码给空页还说「这一件没有正文」，读的人以为它是空的
  assert.match(r.text, /正文共 5 字/);
  assert.match(r.text, /末尾之后/);
  assert.doesNotMatch(r.text, /这一件没有正文/);
});
