import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePaths } from "../internal/paths.ts";
import { clearCut, DAY_MS, readCut, readMeta, readWakes, recordWake, writeCut, writeMeta } from "../internal/meta.ts";

function fixture(): ReturnType<typeof makePaths> {
  const root = mkdtempSync(join(tmpdir(), "geng-test-"));
  const paths = makePaths(root, "alice");
  mkdirSync(paths.meta, { recursive: true });
  return paths;
}

test("meta reads what the daemon wrote, not an older layout", () => {
  const paths = fixture();
  assert.deepEqual(readMeta(paths), {});
  writeMeta(paths, { lastWakeMs: 1_000, wakings: 3, lastSaid: "先去看 cgroup" });
  // the schema stamp is added by the writer, so no call site can forget it
  assert.deepEqual(readMeta(paths), {
    lastWakeMs: 1_000,
    wakings: 3,
    lastSaid: "先去看 cgroup",
    stateSchema: 1,
  });
});

test("wake history keeps only the last 24 hours", () => {
  const paths = fixture();
  const now = Date.parse("2026-03-02T12:00:00Z");
  recordWake(paths, now - DAY_MS - 60_000); // too old to count
  recordWake(paths, now - 60_000);
  const count = recordWake(paths, now);
  assert.equal(count, 2);
  assert.equal(readWakes(paths, now).length, 2);
});

test("a cut note is written, read back whole, and cleared", () => {
  const paths = fixture();
  assert.equal(readCut(paths), null, "nothing was written yet");

  const rec = {
    kind: "timeout" as const,
    at: "2026-03-02T08:30:00Z",
    waking: 212,
    reason: "knock",
    tools: ["bash md5sum v8.md"],
    openMs: 720_000,
  };
  writeCut(paths, rec);
  // read back through the real reader: a field the reader drops is a field that never
  // reached the page, which is how attachments once went missing
  assert.deepEqual(readCut(paths), rec);

  clearCut(paths);
  assert.equal(readCut(paths), null);
});

test("a cut note that nothing can read is worth less than a waking that starts", () => {
  const paths = fixture();
  writeCut(paths, { kind: "timeout", at: "x", waking: 1, reason: "timer" });
  // someone hand-edited it into something that is not a note
  writeFileSync(join(paths.meta, "cut.json"), '{"kind":"nonsense"}');
  assert.equal(readCut(paths), null);
});

test("a hand-written cut note cannot break the page that reads it", () => {
  const paths = fixture();
  // meta/ is host-owned now, but it is still a file a hand edit or an old restore can get
  // wrong, so every field is an input, not a promise: `tools` used to arrive as a string and
  // throw on `.join` while a waking was being assembled
  writeFileSync(
    join(paths.meta, "cut.json"),
    JSON.stringify({ kind: "timeout", tools: "bash ls", capMinutes: "20", openMs: null, waking: "7" }),
  );
  const rec = readCut(paths);
  assert.equal(rec?.kind, "timeout");
  assert.equal(rec?.tools, undefined, "a string is not a list of actions");
  assert.equal(rec?.capMinutes, undefined);
  assert.equal(rec?.openMs, undefined);
  assert.equal(rec?.waking, 0, "nothing to claim it was the seventh waking");
  // and the page still renders
  assert.equal(typeof rec?.kind, "string");
});

test("手写的字符串 / 非有限计数不会流进 daemon 的算术", () => {
  const paths = fixture();
  writeFileSync(join(paths.meta, "state.json"), JSON.stringify({
    wakings: "3", lastWakeMs: "很久以前", lastSaid: 42, stateSchema: "1",
  }));
  const meta = readMeta(paths);
  assert.equal(meta.wakings, undefined, "字符串不是计数");
  assert.equal(meta.lastWakeMs, undefined);
  assert.equal(meta.lastSaid, undefined, "数字不是它上一轮说的话");
  assert.equal(meta.stateSchema, undefined);
  // daemon 里的 (wakings ?? 0) + 1 绝不能变成 "31"
  assert.equal((meta.wakings ?? 0) + 1, 1);
  // 1e999 解析成 Infinity，也不是有限数
  writeFileSync(join(paths.meta, "state.json"), '{"lastWakeMs":1e999}');
  assert.equal(readMeta(paths).lastWakeMs, undefined);
});

test("合法数值、lastSaid 与嵌套形状按原样保留", () => {
  const paths = fixture();
  const env = { imageId: "sha256:abc", search: true };
  const knockHold = { files: ["chat-1.json"], untilMs: 1_234 };
  writeFileSync(join(paths.meta, "state.json"), JSON.stringify({
    wakings: 7, lastWakeMs: 1_000, lastSaid: "上回说到", stateSchema: 1,
    lastCycle: { at: "x", wake: "knock", tools: "9", inbox: 1, talkedTo: ["a"], touched: 2 },
    env, knockHold,
  }));
  const meta = readMeta(paths);
  assert.equal(meta.wakings, 7);
  assert.equal(meta.lastWakeMs, 1_000);
  assert.equal(meta.lastSaid, "上回说到");
  assert.equal(meta.lastCycle?.touched, 2);
  assert.equal(meta.lastCycle?.inbox, 1);
  assert.equal(meta.lastCycle?.tools, undefined, "字符串计数被丢掉");
  assert.deepEqual(meta.env, env, "env 按 unknown 原样带过");
  assert.deepEqual(meta.knockHold, knockHold, "knockHold 按 unknown 原样带过");
});

test("lastSaid 是 null 时保留，别的值丢掉", () => {
  const paths = fixture();
  writeFileSync(join(paths.meta, "state.json"), JSON.stringify({ lastSaid: null }));
  assert.equal(readMeta(paths).lastSaid, null);
  writeFileSync(join(paths.meta, "state.json"), JSON.stringify({ lastSaid: { text: "x" } }));
  assert.equal(readMeta(paths).lastSaid, undefined);
});

test("非法形状的 wakes.json 不会让 daemon 崩在 .filter 上", () => {
  const paths = fixture();
  const now = Date.parse("2026-03-02T12:00:00Z");
  for (const garbage of ["null", "{}", '"oops"', "42", "[1,2]"]) {
    writeFileSync(join(paths.meta, "wakes.json"), garbage);
    assert.deepEqual(readWakes(paths, now), [], `${garbage} 不是数组`);
  }
  // 数组里混入非数 / 未来时刻也该被滤掉
  writeFileSync(join(paths.meta, "wakes.json"), JSON.stringify([now - 1000, "x", now + 1000, null]));
  assert.deepEqual(readWakes(paths, now), [now - 1000]);
});

test("state.json 字面是 null / 标量 / 数组时返回空 meta", () => {
  const paths = fixture();
  for (const garbage of ["null", "42", '"oops"', "[1,2]", "true"]) {
    writeFileSync(join(paths.meta, "state.json"), garbage);
    assert.deepEqual(readMeta(paths), {}, `${garbage} 不是 meta`);
  }
});
