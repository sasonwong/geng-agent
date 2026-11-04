import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookHandler, startBookServer } from "../internal/book.ts";
import { countLoops } from "../internal/packet.ts";
import { makePaths, requiredDirs } from "../internal/paths.ts";
import { ensureDirs, readText } from "../internal/state.ts";
import { postJson } from "../image/extensions/lib/uds.ts";

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
