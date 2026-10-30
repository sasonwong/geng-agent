import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import {
  accept,
  htmlToText,
  loadMailConfig,
  mailId,
  pendingMail,
  startMailServer,
  type MailConfig,
} from "../internal/mail.ts";
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
  assert.equal(files[0], `${id}-0-passwd`);
  const written = JSON.parse(readFileSync(join(f.paths.mail, `${id}.json`), "utf8"));
  assert.deepEqual(
    written.attachments.map((a: { path?: string; note?: string }) => a.path ?? a.note),
    [`/files/${id}-0-passwd`, "太大没取"],
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

test("waiting time is when the mail arrived, not what its Date header claims", () => {
  const f = fixture();
  // a mail that says 1970 must not pin "the oldest one has waited" to fifty years
  accept(
    f.mail({ messageId: "<old@example.org>", date: "1970-01-01T00:00:00Z" }),
    loadMailConfig(f.root)!,
    f.root,
    () => {},
  );
  const pending = pendingMail(f.paths);
  assert.equal(pending.count, 1);
  assert.deepEqual(pending.senders, [FROM]);
  assert.ok(
    Math.abs(Date.now() - (pending.oldestMs ?? 0)) < 60_000,
    `oldest 用的是 date 头：${new Date(pending.oldestMs ?? 0).toISOString()}`,
  );
  // marked read, it stops counting
  writeJson(f.paths.mailRead, [readdirSync(f.paths.mail)[0]!.replace(/\.json$/, "")]);
  assert.equal(pendingMail(f.paths).count, 0);
});

test("two attachments with the same name both survive", () => {
  const f = fixture();
  const content = Buffer.from("x").toString("base64");
  accept(
    f.mail({
      attachments: [
        { name: "screenshot.png", bytes: 1, content },
        { name: "screenshot.png", bytes: 1, content },
      ],
    }),
    loadMailConfig(f.root)!,
    f.root,
    () => {},
  );
  assert.equal(readdirSync(f.paths.filesDir).length, 2);
});

test("the endpoint answers 401, 413 and accepts a wanted mail", async () => {
  const f = fixture();
  const cfg = loadMailConfig(f.root)!;
  const env = { token: "tok", bind: { host: "127.0.0.1", port: 0 } };
  const server = await startMailServer({ root: f.root, getCfg: () => cfg, env, log: () => {}, maxBytes: 4_000 });
  const port = (server.address() as { port: number }).port;
  const post = (body: string, token = "tok") =>
    fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-geng-token": token },
      body,
    });
  try {
    // the only door facing the internet: a wrong token must not store anything
    assert.equal((await post(JSON.stringify(f.mail({})), "wrong")).status, 401);
    assert.equal(readdirSync(f.paths.mail).length, 0);
    // bigger than the guard: rejected rather than read into memory
    assert.equal((await post("x".repeat(5_000))).status, 413);
    // a stranger is answered 200 and dropped, so Cloudflare does not bounce the sender
    const guest = await post(JSON.stringify(f.mail({ from: "stranger@example.net" })));
    assert.equal(guest.status, 200);
    assert.equal(((await guest.json()) as { skipped?: string }).skipped, "guest");
    assert.equal(readdirSync(f.paths.mail).length, 0, "名单外的人不该在盘上留下任何东西");
    // and a wanted one lands
    const ok = await post(JSON.stringify(f.mail({})));
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { ok?: boolean }).ok, true);
    assert.equal(readdirSync(f.paths.mail).filter((x) => x.endsWith(".json")).length, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("an entity that is not a code point stays text instead of throwing", () => {
  // one bogus character used to become a 500, a bounce, and a mail that could never arrive
  for (const bogus of ["&#1114112;", "&#x110000;", "&#99999999999999999999;", "&#xD800;"]) {
    assert.equal(htmlToText(`<p>${bogus}</p>`), bogus);
  }
  assert.equal(htmlToText("<p>&#8220;行&#8221;</p>"), "“行”");
});
