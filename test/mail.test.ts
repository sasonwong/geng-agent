import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { accept, htmlToText, loadMailConfig, mailId, type MailConfig } from "../internal/mail.ts";
import { writeJson } from "../internal/state.ts";

const FROM = "someone@example.org";

function fixture(cfg: MailConfig = { "bot@example.com": { instance: "alice", allow: [FROM] } }): {
  root: string;
  paths: ReturnType<typeof makePaths>;
  log: string[];
  mail: (over: Record<string, unknown>) => Record<string, unknown>;
} {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(join(root, "secrets"), { recursive: true });
  for (const d of [paths.mail, paths.filesDir]) mkdirSync(d, { recursive: true });
  writeJson(join(root, "secrets", "mail.json"), cfg);
  const log: string[] = [];
  return {
    root,
    paths,
    log,
    mail: (over) => ({
      to: "bot@example.com",
      from: FROM,
      subject: "接口文档",
      messageId: "<abc@example.org>",
      date: "2026-03-02T09:00:00Z",
      text: "正文在这。",
      attachments: [],
      ...over,
    }),
  };
}

test("html bodies keep their paragraph breaks and lose their tags", () => {
  const text = htmlToText(
    "<html><head><style>p{color:red}</style></head><body>" +
      "<p>第一段</p><p>第二段 &amp; 更多</p>" +
      "<div>见 <a href='x'>链接</a><br>换行</div>" +
      "<script>alert('坏的')</script>" +
      "<p>他说 &#8220;行&#8221;</p></body></html>",
  );
  assert.match(text, /第一段\n第二段 & 更多/);
  assert.match(text, /见 链接\n换行/);
  assert.match(text, /他说 “行”/);
  assert.doesNotMatch(text, /color:red|alert|&amp;/);
});

test("the same Message-ID always lands on the same file", () => {
  assert.equal(mailId("<a@b>", "x"), mailId("<a@b>", "y"));
  assert.notEqual(mailId("<a@b>", "x"), mailId("<c@d>", "x"));
  assert.match(mailId("<a@b>", "x"), /^mail-[0-9a-f]{12}$/);
  // no Message-ID at all still has to be stable for a redelivery of the same mail
  assert.equal(mailId("", "from|date|subject"), mailId("  ", "from|date|subject"));
});

test("a mail from a stranger is dropped before anything is written", () => {
  const f = fixture();
  const result = accept(f.mail({ from: "stranger@example.net" }), loadMailConfig(f.root)!, f.root, (l) => f.log.push(l));
  assert.deepEqual(result, { ok: false, reason: "guest" });
  assert.equal(readdirSync(f.paths.mail).length, 0, "名单外的人不该在盘上留下任何东西");
  // the address is printed because that line is the only way to learn it
  assert.match(f.log.join("\n"), /guest stranger@example\.net/);
});

test("an address nobody configured accepts nothing", () => {
  const f = fixture();
  const result = accept(
    f.mail({ to: "nobody@example.com" }),
    loadMailConfig(f.root)!,
    f.root,
    (l) => f.log.push(l),
  );
  assert.deepEqual(result, { ok: false, reason: "unknown" });
  assert.equal(readdirSync(f.paths.mail).length, 0);
});

test("an empty allow list means nobody, not everybody", () => {
  const f = fixture({ "bot@example.com": { instance: "alice", allow: [] } });
  const result = accept(f.mail({}), loadMailConfig(f.root)!, f.root, () => {});
  assert.deepEqual(result, { ok: false, reason: "guest" });
  // absent is the same as empty: an unconfigured mailbox must not be an open one
  const g = fixture({ "bot@example.com": { instance: "alice" } });
  assert.deepEqual(
    accept(g.mail({}), loadMailConfig(g.root)!, g.root, () => {}),
    { ok: false, reason: "guest" },
  );
});

test("an allowed mail becomes one file that the inbox parser can read", () => {
  const f = fixture();
  const result = accept(
    f.mail({ text: "", html: "<p>只有 HTML 的正文</p>", messageId: "<m1@example.org>" }),
    loadMailConfig(f.root)!,
    f.root,
    () => {},
  );
  assert.equal(result.ok, true);
  const id = (result as { id: string }).id;
  const written = JSON.parse(readFileSync(join(f.paths.mail, `${id}.json`), "utf8"));
  assert.equal(written.id, id);
  assert.equal(written.from, FROM);
  assert.equal(written.subject, "接口文档");
  // the subject is always there, so a body that is only HTML can never be an empty file
  assert.match(written.text, /^接口文档\n\n只有 HTML 的正文$/);
});

test("a redelivered mail overwrites instead of arriving twice", () => {
  const f = fixture();
  accept(f.mail({}), loadMailConfig(f.root)!, f.root, () => {});
  accept(f.mail({}), loadMailConfig(f.root)!, f.root, () => {});
  assert.equal(readdirSync(f.paths.mail).filter((x) => x.endsWith(".json")).length, 1);
});

test("attachments land in /files and oversized ones are named, not fetched", () => {
  const f = fixture();
  const small = Buffer.from("hello").toString("base64");
  const result = accept(
    f.mail({
      attachments: [
        { name: "../../etc/passwd", mime: "text/plain", bytes: 5, content: small },
        { name: "huge.zip", bytes: 99 * 1024 * 1024 },
      ],
    }),
    loadMailConfig(f.root)!,
    f.root,
    () => {},
  );
  const id = (result as { id: string }).id;
  const files = readdirSync(f.paths.filesDir);
  assert.equal(files.length, 1, "只有那一个能取");
  // basename first, so a name that walked up the tree cannot name the file
  assert.equal(files[0], `${id}-passwd`);
  const written = JSON.parse(readFileSync(join(f.paths.mail, `${id}.json`), "utf8"));
  assert.deepEqual(
    written.attachments.map((a: { path?: string; note?: string }) => a.path ?? a.note),
    [`/files/${id}-passwd`, "太大没取"],
  );
});

test("a mail with no subject and no body still says something", () => {
  const f = fixture();
  const result = accept(
    f.mail({ subject: "  ", text: "", html: "" }),
    loadMailConfig(f.root)!,
    f.root,
    () => {},
  );
  const written = JSON.parse(
    readFileSync(join(f.paths.mail, `${(result as { id: string }).id}.json`), "utf8"),
  );
  assert.equal(written.text, "（无主题）\n\n（没有正文）");
});

test("secrets/mail.json is the whitelist, and a broken one is no whitelist", () => {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  assert.equal(loadMailConfig(root), null, "没有文件就没有信箱");
  writeFileSync(join(root, "secrets", "mail.json"), "{ broken");
  assert.equal(loadMailConfig(root), null);
  writeJson(join(root, "secrets", "mail.json"), { "Bot@Example.com": { instance: "alice", allow: ["A@B.c"] } });
  const cfg = loadMailConfig(root)!;
  // addresses are compared case-insensitively on both sides, or a whitelist entry that
  // looks right silently blocks a person
  assert.equal(cfg["bot@example.com"]?.instance, "alice");
  assert.deepEqual(cfg["bot@example.com"]?.allow, ["a@b.c"]);
});
