import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveredFiles, freshForSteer, INJECT_CAP, injectionText } from "../internal/inject.ts";
import { peekInbox } from "../internal/inbox.ts";
import { writeJson } from "../internal/state.ts";

const msg = (id: string) => ({ id, file: `${id}.json`, text: `话 ${id}`, from: "telegram:@x" });

test("only what was not already on the page is pushed in", () => {
  const shown = new Set(["1"]);
  assert.deepEqual(
    freshForSteer([msg("1"), msg("2"), msg("3")], shown, 5).map((m) => m.id),
    ["2", "3"],
  );
});

test("the cap holds, and a full cycle gets nothing more", () => {
  const six = Array.from({ length: 10 }, (_, i) => msg(String(i)));
  assert.equal(freshForSteer(six, new Set(), INJECT_CAP).length, INJECT_CAP);
  assert.deepEqual(freshForSteer(six, new Set(), 0), []);
});

test("an injected line says who and what, with no advice attached", () => {
  assert.equal(injectionText({ id: "1", file: "1.json", text: " 还在吗 \n", from: "telegram:@x" }), "[刚收到] telegram:@x：还在吗");
  assert.equal(injectionText({ id: "1", file: "1.json", text: "x".repeat(500) }).length < 430, true);
});

test("an injection no turn followed is not counted as delivered", () => {
  const injected = [{ file: "a.json" }, { file: "b.json" }];
  assert.deepEqual(deliveredFiles(injected, [{ read: true }, { read: false }]), ["a.json"]);
  assert.deepEqual(deliveredFiles(injected, []), []);
  assert.deepEqual(deliveredFiles([], [{ read: true }]), []);
});

test("a message that is only a file still says something", () => {
  const said = injectionText({
    id: "9",
    file: "9.json",
    text: "",
    from: "telegram:@x",
    attachments: [{ kind: "document", path: "/files/9.md" }],
  });
  assert.equal(said, "[刚收到] telegram:@x：没写字，只带了 1个文件。");
});

test("an inbox message reaches the injected line with its attachment intact", () => {
  // the shape the drain really hands over: a record read back from an inbox file, pushed
  // in whole. Hand-building the object here is what let `attachments` disappear once.
  const dir = mkdtempSync(join(tmpdir(), "geng-test-"));
  writeJson(join(dir, "1-9.json"), {
    id: "1-9",
    text: "",
    from: "telegram:@x",
    attachments: [{ kind: "document", path: "/files/1-9.md" }],
  });
  const handed = freshForSteer(peekInbox(dir), new Set(), INJECT_CAP);
  assert.equal(handed.length, 1);
  assert.deepEqual(handed[0]?.attachments, [{ kind: "document", path: "/files/1-9.md" }]);
  assert.equal(injectionText(handed[0]!), "[刚收到] telegram:@x：没写字，只带了 1个文件。");
});

test("a voice note says it cannot be listened to, because it never lands in /files", () => {
  // the only attachment that is deliberately not fetched: a bare count would send it
  // looking for a file that does not exist
  const said = injectionText({ id: "9", file: "9.json", text: "", from: "telegram:@x", attachments: [{ kind: "voice", note: "没有转写" }] });
  assert.equal(said, "[刚收到] telegram:@x：没写字，只带了 1条语音（没有转写）。");
});
