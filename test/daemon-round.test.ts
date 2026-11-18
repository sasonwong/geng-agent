import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDaemon } from "../internal/daemon.ts";
import { socketPath } from "../internal/book.ts";
import { digestLedger, readLedger } from "../internal/ledger.ts";
import { makePaths, type Paths } from "../internal/paths.ts";
import { defaultPolicy } from "../internal/policy.ts";
import { writeJson, writeText } from "../internal/fs.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CHAT = -1001234567890;

/**
 * Stands in for pi: answers the RPC the daemon speaks, and does the one thing a waking can
 * do to the world that leaves nothing on disk — a `/say` over the book socket, the way the
 * `say` extension does it. Without this the only way to see the ledger's `said`/`saidTo`
 * was a real container.
 */
const PI = `
import { createInterface } from "node:readline";
import { request } from "node:http";
const [sock, chat] = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const say = (text) => new Promise((resolve) => {
  const body = JSON.stringify({ messages: [text], to: Number(chat) });
  const req = request(
    { socketPath: sock, path: "/say", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
    (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); },
  );
  req.on("error", () => resolve(0));
  req.end(body);
});
createInterface({ input: process.stdin }).on("line", async (line) => {
  const m = JSON.parse(line);
  if (m.type === "prompt") {
    out({ id: m.id, type: "response", data: { disposition: "started" } });
    const code = await say("在");
    if (code === 200) {
      out({ type: "tool_execution_start", toolName: "say", args: { to: Number(chat), messages: ["在"] } });
      out({ type: "tool_execution_end", toolName: "say" });
    }
    out({ type: "turn_start" });
    out({ type: "agent_settled" });
    return;
  }
  if (m.type === "get_last_assistant_text") out({ id: m.id, type: "response", data: { text: "在" } });
  if (m.type === "get_session_stats") {
    out({ id: m.id, type: "response", data: { cost: 0.001, tokens: { total: 10 }, contextUsage: { percent: 1 } } });
  }
});
`;

function fixture(root: string): Paths {
  const p = makePaths(root, "alice");
  // the daemon refuses to wake without the constant half of the prompt
  writeText(join(root, "deploy", "SYSTEM.md"), readFileSync(join(REPO, "deploy", "SYSTEM.md"), "utf8"));
  writeJson(p.policy, defaultPolicy());
  // one chat it may speak into: the book refuses a place it does not know
  mkdirSync(join(root, "data", "_gateway"), { recursive: true });
  writeJson(join(root, "data", "_gateway", "chats.json"), {
    alice: { home: CHAT, known: { [String(CHAT)]: { kind: "private", who: "@someone" } } },
  });
  return p;
}

/** A `docker` that is not docker: `run` becomes this script, everything else says nothing. */
function fakeDocker(root: string, p: Paths, missingImage = false): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(root, "pi.mjs"), PI);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\ncase "$1" in\n  run) exec "${process.execPath}" "${join(root, "pi.mjs")}" "${socketPath(p)}" "${CHAT}" ;;\n${missingImage ? "  image) exit 1 ;;\n" : ""}  *) exit 0 ;;\nesac\n`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  return bin;
}

test("a finished round writes one ledger line, with the /say it queued", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-round-"));
  const oldPath = process.env.PATH;
  try {
    const p = fixture(root);
    process.env.PATH = `${fakeDocker(root, p)}${delimiter}${oldPath ?? ""}`;
    await runDaemon({ root, instance: "alice", once: true, log: () => {} });

    const records = readLedger(p);
    assert.equal(records.length, 1, "一轮一条，不多不少");
    const rec = records[0]!;
    assert.equal(rec.wake, 1);
    assert.equal(rec.reason, "timer");
    assert.equal(rec.sym, "ok");
    // the queue write is the act: counted where the round made it, not where the gateway
    // would deliver it two seconds after the round is over
    assert.equal(rec.said, 1);
    // and the name comes off the chat when nobody has a line in people/ yet
    assert.deepEqual(rec.saidTo, [`chat ${CHAT}`]);
    // the `say` really went through the book, not around it
    assert.equal(readdirSync(p.outbox).length, 1);
    // one unasked-for round that spoke is what the digest exists to count
    assert.equal(digestLedger(records).unpromptedActed, 1);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

// The daemon deletes this file once it has acted on it, so reading bad bytes as an empty
// list threw the requests away and deleted nothing: the files stayed and the list that asked
// for them was gone. A list it cannot read is left where it is, and so are the files.
test("a forget list it cannot read is left alone, and so are the files", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-forget-"));
  const oldPath = process.env.PATH;
  try {
    const p = fixture(root);
    process.env.PATH = `${fakeDocker(root, p)}${delimiter}${oldPath ?? ""}`;
    writeText(join(p.filesDir, "F1.txt"), "forget me");
    const bad = Buffer.from([0x7b, 0x22, 0x66, 0xff, 0x22, 0x7d]);
    mkdirSync(dirname(p.filesForget), { recursive: true });
    writeFileSync(p.filesForget, bad);
    const said: string[] = [];
    await runDaemon({
      root,
      instance: "alice",
      once: true,
      log: (line) => { said.push(line); },
    });

    assert.deepEqual(readFileSync(p.filesForget), bad, "读不出的单子不能被删掉");
    assert.equal(existsSync(join(p.filesDir, "F1.txt")), true, "单子读不出，就别按它删");
    assert.match(said.join("\n"), /files\.forget\.json 读不出来/, "一句话也不说，就没人知道要修");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a preview of the same instance writes no ledger line", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-dry-ledger-"));
  try {
    const p = fixture(root);
    await runDaemon({ root, instance: "alice", once: true, dry: true, log: () => {} });
    assert.equal(existsSync(p.ledger), false, "预览不是一轮，账本上不能有它");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing image is rebuilt before the round, and a preview does not build", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-round-build-"));
  const oldPath = process.env.PATH;
  try {
    const p = fixture(root);
    process.env.PATH = `${fakeDocker(root, p, true)}${delimiter}${oldPath ?? ""}`;
    const marker = join(root, "built");
    writeFileSync(join(root, "deploy", "build.sh"), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(join(root, "deploy", "build.sh"), 0o755);

    // the preview reads the same "no such image" and must not spend a build on it
    await runDaemon({ root, instance: "alice", once: true, dry: true, log: () => {} });
    assert.equal(existsSync(marker), false, "预览不是一轮，不能构建");

    await runDaemon({ root, instance: "alice", once: true, log: () => {} });
    assert.equal(existsSync(marker), true, "镜像不在时，醒来之前先重建");
    assert.match(readFileSync(join(p.data, "build.log"), "utf8"), /镜像不在，重建 geng-agent:latest/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
