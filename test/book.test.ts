import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookHandler, socketPath, startBookServer } from "../internal/book.ts";
import { knownPlaces } from "../internal/gateway.ts";
import { countLoops } from "../internal/packet.ts";
import { makePaths, requiredDirs } from "../internal/paths.ts";
import { readWaiting } from "../internal/schedule.ts";
import { ensureDirs, readText } from "../internal/fs.ts";
import { getToFile, postJson } from "../image/extensions/lib/uds.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  const handle = bookHandler(paths);
  const call = async (url: string, body: unknown) =>
    handle({ url, method: "POST" } as never, typeof body === "string" ? body : JSON.stringify(body));
  return { root, paths, call };
}

test("a journal entry is a file whose name is its id, and the body is its own", async () => {
  const f = fixture();
  const r = await f.call("/journal", { texts: ["第一件", "第二件"] });
  assert.equal(r.status, 200);
  const ids = (r.body as { ids: string[] }).ids;
  assert.equal(ids.length, 2);
  assert.match(ids[0] as string, /^J\d{8}-1$/);
  assert.equal(readText(join(f.paths.journal, `${ids[0]}.md`)), "第一件\n");
  // the next call continues the series instead of starting over
  const again = await f.call("/journal", { texts: ["第三件"] });
  assert.match((again.body as { ids: string[] }).ids[0] as string, /-3$/);
});

test("an id is never handed out twice, even after the newest file is deleted", async () => {
  const f = fixture();
  const first = await f.call("/journal", { texts: ["一", "二"] });
  const ids = (first.body as { ids: string[] }).ids;
  rmSync(join(f.paths.journal, `${ids[1]}.md`));
  const next = await f.call("/journal", { texts: ["三"] });
  // counting files would reuse `-2` and give an old entry's name to a new one
  assert.match((next.body as { ids: string[] }).ids[0] as string, /-3$/);
});

test("a closed loop moves aside instead of disappearing, and the count follows", async () => {
  const f = fixture();
  const opened = await f.call("/loop/open", { text: "等一个回信" });
  const id = (opened.body as { id: string }).id;
  assert.equal(id, "L1");
  assert.equal(countLoops(f.paths), 1);

  const closed = await f.call("/loop/close", { id, note: "回信来了" });
  assert.equal(closed.status, 200);
  assert.equal(countLoops(f.paths), 0, "闭合之后纸上的条数要减一");
  const moved = join(f.paths.openLoops, "closed", `${id}.md`);
  assert.ok(existsSync(moved), "内容要还在，只是换了个地方");
  assert.match(readText(moved) ?? "", /等一个回信[\s\S]*回信来了/);
  // the subdirectory must not be counted as an unfinished thing
  assert.deepEqual(
    readdirSync(join(f.paths.openLoops, "closed")).length,
    1,
    "closed/ 里应该只有一个文件",
  );
});

test("a refusal says what to fix, and never looks like success", async () => {
  const f = fixture();
  const unknown = await f.call("/loop/close", { id: "L99" });
  assert.equal(unknown.status, 404);
  assert.match(String((unknown.body as { error: string }).error), /没有 L99/);
  const shape = await f.call("/loop/close", { id: "第12件" });
  assert.equal(shape.status, 400);
  assert.match(String((shape.body as { error: string }).error), /L12/);
  const route = await f.call("/nope", {});
  assert.equal(route.status, 404);
  const empty = await f.call("/journal", { texts: [] });
  assert.equal(empty.status, 400);
  const junk = await f.call("/journal", "{not json");
  assert.equal(junk.status, 400);
});

test("the socket carries the same answers as the handler", async () => {
  const f = fixture();
  const server = await startBookServer({ paths: f.paths, log: () => {} });
  try {
    const sock = join(f.paths.run, "book.sock");
    const reply = await postJson(sock, "/loop/open", { text: "从 socket 进来" });
    assert.equal(reply.status, 200);
    assert.equal((JSON.parse(reply.body) as { id: string }).id, "L1");
    // 0600: the directory keeps others out, the mode is the reminder
    assert.equal((await import("node:fs")).statSync(sock).mode & 0o777, 0o600);
  } finally {
    server.close();
  }
});

test("a second start removes the corpse of the first", async () => {
  const f = fixture();
  mkdirSync(f.paths.run, { recursive: true });
  // a socket file nobody is listening on: connect fails, and the error reads as
  // "the service is down" even though the path is right and the daemon is fine
  writeFileSync(join(f.paths.run, "book.sock"), "");
  const server = await startBookServer({ paths: f.paths, log: () => {} });
  try {
    const reply = await postJson(join(f.paths.run, "book.sock"), "/nope", {});
    assert.equal(reply.status, 404);
  } finally {
    server.close();
  }
});

test("an alarm is written as an absolute moment, and is the one that fires", async () => {
  const f = fixture();
  const before = Date.now();
  const r = await f.call("/wait", { when: "20m", why: "等回信" });
  assert.equal(r.status, 200);
  const at = Date.parse((r.body as { at: string }).at);
  assert.ok(at >= before + 19 * 60_000 && at <= Date.now() + 20 * 60_000);
  // the file is the alarm: what it said is exactly what `readWaiting` will act on, so a
  // daemon restart between the write and the sleep cannot postpone it
  const spec = readWaiting(f.paths.waiting);
  assert.equal(spec?.dueAtMs, at);
  assert.equal(spec?.why, "等回信");
});

test("an absolute moment is left alone, and one already gone is refused", async () => {
  const f = fixture();
  const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const r = await f.call("/wait", { when: at });
  assert.equal(r.status, 200);
  assert.equal((r.body as { at: string }).at, at);

  // a timezone mistake, not an instruction: waking every minute until it notices costs a night
  const past = await f.call("/wait", { when: "2020-01-01T00:00:00Z" });
  assert.equal(past.status, 400);
  assert.match(String((past.body as { error: string }).error), /已经过去/);
  // and it did not overwrite the alarm that was already set
  assert.equal(readWaiting(f.paths.waiting)?.dueAtMs, Date.parse(at));
});

test("a duration it cannot read is refused with the forms it does read", async () => {
  const f = fixture();
  for (const when of ["", "soon", "20", "20 minutes from now"]) {
    const r = await f.call("/wait", { when });
    assert.equal(r.status, 400, `should have refused ${JSON.stringify(when)}`);
  }
  assert.equal(readWaiting(f.paths.waiting), null);
});

test("an alarm nearer than the shortest allowed wait is raised, and says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  const handle = bookHandler(paths, { minWakeMs: 5 * 60_000 });
  const r = await handle({ url: "/wait", method: "POST" } as never, JSON.stringify({ when: "10s" }));
  assert.equal(r.status, 200);
  // the answer is what will happen, not what was asked for: a tool that reports the
  // request would be a page that lies about the next time it wakes
  const at = Date.parse((r.body as { at: string }).at);
  assert.ok(at >= Date.now() + 4 * 60_000);
  assert.equal(readWaiting(paths.waiting)?.dueAtMs, at);
});


test("mute, listen, forget and propose are written by the host, in the shape it reads", async () => {
  const f = fixture();
  const mute = await f.call("/mute/set", { target: "chat:-1001234567890", minutes: 30, why: "群里的闲话" });
  assert.equal(mute.status, 200);
  const muted = JSON.parse(readText(f.paths.mute) ?? "{}") as Record<string, { until: string; why: string }>;
  assert.equal(muted["chat:-1001234567890"]?.why, "群里的闲话");
  assert.ok(Date.parse(muted["chat:-1001234567890"]?.until ?? "") > Date.now());
  // the person who was silenced is the one reader of this line, and the ops queue is how it
  // reaches them: the page (where the reason lives) is not theirs
  const ops = readdirSync(join(f.root, "data", "_ops", "outbox")).filter((n) => n.endsWith(".json"));
  assert.equal(ops.length, 1, "静音没有写进 ops");
  const line = JSON.stringify(JSON.parse(readText(join(f.root, "data", "_ops", "outbox", ops[0] as string)) ?? "{}"));
  assert.match(line, /mute@alice/);
  assert.match(line, /群里的闲话/);
  // a key the gateway never consults would be a silence in name only
  assert.equal((await f.call("/mute/set", { target: "dm", minutes: 5, why: "x" })).status, 400);

  const listening = await f.call("/attention/set", { chats: ["*"], why: "等人回话" });
  assert.equal(listening.status, 200);
  const attention = JSON.parse(readText(f.paths.attention) ?? "{}") as { chats: unknown[]; until: string };
  assert.deepEqual(attention.chats, ["*"]);
  // four hours is the cap, and the file says the capped time rather than the asked one
  assert.ok(Date.parse(attention.until) <= Date.now() + 4 * 3_600_000 + 1_000);
  const capped = await f.call("/attention/set", { chats: [12345], until: new Date(Date.now() + 9 * 3_600_000).toISOString() });
  assert.ok(
    Date.parse((capped.body as { until: string }).until) <= Date.now() + 4 * 3_600_000 + 1_000,
    "asked for nine hours, and four is the most attention can be",
  );
  assert.equal((capped.body as { until: string }).until, (JSON.parse(readText(f.paths.attention) ?? "{}") as { until: string }).until);
  // an empty list is not "listen to nothing", it is "stop"
  await f.call("/attention/set", { chats: [] });
  assert.deepEqual(JSON.parse(readText(f.paths.attention) ?? "null"), {});

  await f.call("/files/forget", { files: ["/files/a.jpg"] });
  await f.call("/files/forget", { files: ["/files/b.jpg", "/files/a.jpg"] });
  const forget = JSON.parse(readText(f.paths.filesForget) ?? "{}") as { files: string[] };
  assert.deepEqual(forget.files, ["/files/a.jpg", "/files/b.jpg"]);

  const proposal = await f.call("/proposal", { value: { cycle: { defaultWakeMinutes: 45 }, container: { timeoutSec: 9 } } });
  assert.equal(proposal.status, 200);
  const body = proposal.body as { willApply: string[]; ignored: string[] };
  // named before the next waking tells it, so a proposal for the frame does not look obeyed
  assert.deepEqual(body.willApply, ["cycle.defaultWakeMinutes"]);
  assert.deepEqual(body.ignored, ["container.timeoutSec"]);
  assert.deepEqual(JSON.parse(readText(f.paths.proposal) ?? "{}"), {
    cycle: { defaultWakeMinutes: 45 },
    container: { timeoutSec: 9 },
  });
});

test("saying something is a queue entry the host writes, and a chat it cannot reach is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  const handle = bookHandler(paths, { places: [-1001] });

  const r = await handle(
    { url: "/say", method: "POST" } as never,
    JSON.stringify({ messages: ["在吗", "我看了"], replyTo: { chat: -1001, messageId: 151 } }),
  );
  assert.equal(r.status, 200);
  const id = (r.body as { id: string }).id;
  const written = JSON.parse(readText(join(paths.outbox, `${id}.json`)) ?? "{}");
  // the file is exactly what the gateway already read: same shape, one fewer writer
  // the quote names its conversation, so the item carries it too: the gateway sends
  // where `chat` says, and a quote that only lived inside replyTo would go home instead
  assert.deepEqual(written, { id, chat: -1001, messages: ["在吗", "我看了"], replyTo: { chat: -1001, messageId: 151 } });

  // a chat the daemon does not know is refused before anything is queued
  const bad = await handle({ url: "/say", method: "POST" } as never, JSON.stringify({ messages: ["x"], to: -999 }));
  assert.equal(bad.status, 400);
  assert.equal(readdirSync(paths.outbox).length, 1);
  // and a quote it cannot parse is a refusal, not a message without one
  const quote = await handle({ url: "/say", method: "POST" } as never, JSON.stringify({ messages: ["x"], replyTo: "151" }));
  assert.equal(quote.status, 400);
  // an empty `to` is a blank, not chat 0: the number it used to become passed every check
  const blank = await handle({ url: "/say", method: "POST" } as never, JSON.stringify({ messages: ["x"], to: "" }));
  assert.equal(blank.status, 200);
  const blankId = (blank.body as { id: string }).id;
  const blankWritten = JSON.parse(readText(join(paths.outbox, `${blankId}.json`)) ?? "{}");
  assert.equal("chat" in blankWritten, false, "空 to 被当成 chat 0 写进了队列");
});

test("a chat the gateway learned after the daemon started can be spoken into", async () => {
  // The endpoint is built once and the daemon lives for days. Taking the list of places at
  // listen time meant the page (built fresh every cycle) offered a group the tool then
  // refused: being added to a group made the bot deaf to nothing and mute to everyone.
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  const file = join(root, "data", "_gateway", "chats.json");
  mkdirSync(join(root, "data", "_gateway"), { recursive: true });
  const chats = (known: Record<string, unknown>): string => JSON.stringify({ alice: { known } });
  const owner = { kind: "private", who: "telegram:@owner" };
  writeFileSync(file, chats({ "111": owner }));

  const server = await startBookServer({
    paths,
    log: () => {},
    places: () => knownPlaces(root, "alice").map((p) => p.id),
  });
  try {
    const sock = socketPath(paths);
    assert.equal((await postJson(sock, "/say", { messages: ["hi"], to: -1009 })).status, 400);

    // exactly what handleUpdate writes when the bot is added to a new group
    writeFileSync(file, chats({ "111": owner, "-1009": { kind: "group", title: "新群" } }));
    const sent = await postJson(sock, "/say", { messages: ["hi"], to: -1009 });
    assert.equal(sent.status, 200, sent.body);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a quote is the id the listing printed, and it says which conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  const handle = bookHandler(paths, { places: [-1001, -2002] });
  const say = async (body: unknown) =>
    handle({ url: "/say", method: "POST" } as never, JSON.stringify(body));

  // the shape `recall` prints: an inbox id, with or without its M
  for (const id of ["M-1001-151", "-1001-151", "#-1001-151"]) {
    const r = await say({ messages: ["看到了"], replyTo: id });
    assert.equal(r.status, 200, `${id} 应该能引用`);
    const queued = JSON.parse(readText(join(paths.outbox, `${(r.body as { id: string }).id}.json`)) ?? "{}");
    assert.deepEqual(queued.replyTo, { chat: -1001, messageId: 151 });
    // the quote names the conversation, so `to` may be left out — and the gateway needs
    // the chat on the item, not only inside the quote
    assert.equal(queued.chat, -1001);
  }

  // two places and neither a quote nor a `to`: the home chat is a guess, so it is refused
  const nowhere = await say({ messages: ["喂"] });
  assert.equal(nowhere.status, 400);
  assert.match(String((nowhere.body as { error: string }).error), /要写 to/);
});

test("a file leaves the book as bytes over the same socket, and only by id", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  mkdirSync(paths.filesDir, { recursive: true });
  writeFileSync(join(paths.filesDir, "F1-0-report.pdf"), Buffer.from([0, 1, 2, 255]));
  const server = await startBookServer({ paths, log: () => {} });
  try {
    const sock = socketPath(paths);
    const dest = join(root, "out.bin");
    // the bytes arrive unchanged: this is the one route that is not JSON
    await getToFile(sock, "/files/F1", dest);
    assert.deepEqual([...readFileSync(dest)], [0, 1, 2, 255]);
    // an id nothing has is a refusal, not an empty file
    await assert.rejects(() => getToFile(sock, "/files/F9", join(root, "nope.bin")), /没有这个文件/);
    // and the id cannot be a path: `F1-0-report.pdf` is a file, `../alice/book` is not
    await assert.rejects(() => getToFile(sock, "/files/..%2Fbook%2Fidentity.md", join(root, "x")), /没有这个文件/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("saying a file by id hands the gateway the original, not a copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  mkdirSync(paths.filesDir, { recursive: true });
  const original = join(paths.filesDir, "F1-0-report.pdf");
  writeFileSync(original, "hello");
  const handle = bookHandler(paths, { places: [-1001] });

  const r = await handle(
    { url: "/say", method: "POST" } as never,
    JSON.stringify({ messages: ["给你"], to: -1001, files: ["F1", "/work/in/made.txt"] }),
  );
  assert.equal(r.status, 200);
  const queued = JSON.parse(readText(join(paths.outbox, `${(r.body as { id: string }).id}.json`)) ?? "{}");
  // two shapes, kept apart: one is a path inside the container, the other is on the host
  assert.deepEqual(queued.files, ["/work/in/made.txt"]);
  assert.deepEqual(queued.attachments, [{ id: "F1", path: original, name: "F1-0-report.pdf" }]);
  // an id nothing has is refused before anything is queued
  const bad = await handle({ url: "/say", method: "POST" } as never, JSON.stringify({ messages: ["x"], files: ["F9"] }));
  assert.equal(bad.status, 404);

  // and a path outside /work is refused here, not silently dropped by the gateway: the
  // tool used to answer "带 1 个文件" over a file that never left the container
  for (const escape of ["/etc/passwd", "/work/../policy.json", "/state/identity.md"]) {
    const r = await handle(
      { url: "/say", method: "POST" } as never,
      JSON.stringify({ messages: ["x"], to: -1001, files: [escape] }),
    );
    assert.equal(r.status, 400, escape);
  }
  assert.equal(readdirSync(paths.outbox).length, 1, "被拒的那几次不该入队");
});

test("a wrong journal entry can be taken back without losing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  const handle = bookHandler(paths, { places: [] });
  const written = await handle({ url: "/journal", method: "POST" } as never, JSON.stringify({ texts: ["记错了"] }));
  const id = (written.body as { ids: string[] }).ids[0] as string;

  const dropped = await handle(
    { url: "/discard", method: "POST" } as never,
    JSON.stringify({ id, why: "那天其实做了两件事" }),
  );
  assert.equal(dropped.status, 200);
  // moved, not deleted: the reason is readable afterwards, which is the point of keeping it
  const kept = readText(join(paths.journalDiscarded, `${id}.md`)) ?? "";
  assert.match(kept, /记错了/);
  assert.match(kept, /\[丢弃 .*\] 那天其实做了两件事/);
  assert.equal(existsSync(join(paths.journal, `${id}.md`)), false);
  // and it drops out of the count, which is what the waking page reads
  assert.equal(readdirSync(paths.journal).filter((f) => f.endsWith(".md")).length, 0);

  // a second attempt is a no-op, not an error: a round may retry after a timeout
  const again = await handle({ url: "/discard", method: "POST" } as never, JSON.stringify({ id }));
  assert.equal(again.status, 200);
  // an id that never existed is a refusal, and says where it looked
  const missing = await handle({ url: "/discard", method: "POST" } as never, JSON.stringify({ id: "J20260101-99" }));
  assert.equal(missing.status, 404);
  assert.match(String((missing.body as { error: string }).error), /journal\//);
});

test("a discarded entry keeps its number out of circulation", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  const handle = bookHandler(paths, { places: [] });
  const first = await handle({ url: "/journal", method: "POST" } as never, JSON.stringify({ texts: ["a"] }));
  const id = (first.body as { ids: string[] }).ids[0] as string;
  await handle({ url: "/discard", method: "POST" } as never, JSON.stringify({ id }));
  // the counter file is gone: only the files on disk remember, and the discarded one still does
  rmSync(paths.ids, { force: true });
  const next = await handle({ url: "/journal", method: "POST" } as never, JSON.stringify({ texts: ["b"] }));
  assert.notEqual((next.body as { ids: string[] }).ids[0], id);
});

test("git's credential question is answered by the host, or not at all", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  const server = await startBookServer({ paths, log: () => {} });
  try {
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ socketPath: socketPath(paths), path: "/gh/token", method: "GET" }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    // not configured is a refusal that names what is missing, not an empty credential
    assert.equal(reply.status, 503);
    assert.match(reply.body, /GENG_GH_APP_ID/);
    assert.match(reply.body, /gh-app\.pem/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("model traffic is proxied: the key goes upstream, never to the container", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-book-"));
  const paths = makePaths(root, "alice");
  ensureDirs(requiredDirs(paths));
  mkdirSync(join(root, "secrets"), { recursive: true });
  const got: { path: string; auth: string; body: string }[] = [];
  const upstream = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ path: req.url ?? "", auth: String(req.headers.authorization ?? ""), body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const port = (upstream.address() as { port: number }).port;
  const server = await startBookServer({ paths, log: () => {} });
  const ask = (): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: socketPath(paths),
          path: "/model/chat/completions",
          method: "POST",
          // a kept-alive socket would outlive the test and hold `server.close()` open
          agent: false,
          headers: { "content-type": "application/json", authorization: "Bearer mine" },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ model: "m", messages: [] }));
    });
  try {
    // nothing configured is a refusal that names the file, so a round can say why
    const none = await ask();
    assert.equal(none.status, 503);
    assert.match(none.body, /model\.env/);
    writeFileSync(
      join(root, "secrets", "alice.model.env"),
      `OPENCODE_API_KEY=sk-test-123\nGENG_MODEL_UPSTREAM=http://127.0.0.1:${port}/go/v1\n`,
    );
    const reply = await ask();
    assert.equal(reply.status, 200);
    // the stream arrives as a stream, not as a buffered body
    assert.match(reply.body, /data: \[DONE\]/);
    assert.equal(got.length, 1);
    // the path is the provider's, the credential is the host's, and the container's
    // Authorization header did not survive the trip
    assert.equal(got[0]?.path, "/go/v1/chat/completions");
    assert.equal(got[0]?.auth, "Bearer sk-test-123");
    assert.equal(got[0]?.body, JSON.stringify({ model: "m", messages: [] }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});
