import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadOffsets, saveOffsets, telegramChannel } from "../internal/channels/telegram.ts";

function offsetsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "offsets-"));
  mkdirSync(join(dir, "data", "_gateway"), { recursive: true });
  return join(dir, "data", "_gateway", "offsets.json");
}

const rootOf = (file: string): string => dirname(dirname(dirname(file)));

const read = (file: string): Record<string, number> => JSON.parse(readFileSync(file, "utf8"));

test("a file with bytes that are not JSON is kept aside, not read as an empty table", () => {
  const file = offsetsFile();
  writeFileSync(file, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
  const notes: string[] = [];
  assert.deepEqual(loadOffsets(file, (line) => notes.push(line)), {});
  const asides = readdirSync(join(file, "..")).filter((name) => name.includes(".bad-"));
  assert.equal(asides.length, 1);
  const aside = asides[0];
  assert.ok(aside);
  // the pid is in the name: two pollers can meet the same bad file in the same
  // millisecond, and the aside must not be renamed over
  assert.match(aside, /^offsets\.json\.bad-\d+-\d+$/);
  assert.deepEqual([...readFileSync(join(file, "..", aside))], [0x7b, 0xff, 0xfe, 0x7d]);
  assert.equal(existsSync(file), false, "the unreadable copy is moved, never overwritten");
  assert.equal(notes.length, 1);
  assert.match(notes.join("\n"), /读不出/);
});

test("a file that is not there at all is an empty table, with no noise", () => {
  const file = offsetsFile();
  const notes: string[] = [];
  assert.deepEqual(loadOffsets(file, (line) => notes.push(line)), {});
  assert.deepEqual(notes, []);
});

test("JSON that is not a table (null, a number, an array) is kept aside too, not written into", () => {
  for (const body of ["null", "7", "[]", '"x"']) {
    const file = offsetsFile();
    writeFileSync(file, body);
    const notes: string[] = [];
    assert.deepEqual(loadOffsets(file, (line) => notes.push(line)), {}, body);
    assert.equal(existsSync(file), false, `${body}: the file is moved aside`);
    assert.equal(
      readdirSync(join(file, "..")).filter((name) => name.includes(".bad-")).length,
      1,
      body,
    );
    assert.equal(notes.length, 1, body);
  }
});

test("a poller started on such a file can still save its offset", () => {
  const file = offsetsFile();
  writeFileSync(file, "null");
  const offsets = loadOffsets(file, () => {});
  assert.doesNotThrow(() => saveOffsets(file, offsets, "alice", 5, () => {}));
  assert.deepEqual(read(file), { alice: 5 });
});

test("writing one bot's offset keeps the offsets another poller wrote since we read", () => {
  const file = offsetsFile();
  writeFileSync(file, JSON.stringify({ bob: 500, carol: 700 }));
  // this poller read the file when nobody else had written yet
  saveOffsets(file, {}, "alice", 42, () => {});
  assert.deepEqual(read(file), { bob: 500, carol: 700, alice: 42 });
});

test("writing does not put back the other bots' offsets from a stale copy", () => {
  const file = offsetsFile();
  writeFileSync(file, JSON.stringify({ bob: 900 }));
  saveOffsets(file, { bob: 100 }, "alice", 7, () => {});
  assert.deepEqual(read(file), { bob: 900, alice: 7 });
});

test("a file that goes bad while we are running is kept aside, and said out loud", () => {
  const file = offsetsFile();
  saveOffsets(file, {}, "alice", 1, () => {});
  writeFileSync(file, "{ not json");
  const notes: string[] = [];
  saveOffsets(file, {}, "alice", 2, (line) => notes.push(line));
  assert.equal(notes.length, 1, "the write that quarantines is the only place that can say so");
  assert.match(notes.join("\n"), /不是 JSON 对象/);
  assert.deepEqual(read(file), { alice: 2 });
});

test("doctor names the offsets files that were kept aside, and is quiet without any", () => {
  const file = offsetsFile();
  assert.deepEqual(telegramChannel.doctor?.(rootOf(file), "alice"), []);
  writeFileSync(file, "null");
  loadOffsets(file, () => {});
  const checks = telegramChannel.doctor?.(rootOf(file), "alice") ?? [];
  assert.equal(checks.length, 1);
  assert.match(checks[0]?.detail ?? "", /offsets\.json\.bad-/);
  assert.equal(checks[0]?.warnOnly, true);
});
