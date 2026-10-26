import { test } from "node:test";
import assert from "node:assert/strict";
import { countOutbox, deliveredFiles, freshForSteer, INJECT_CAP, injectionText, spokenOutbox } from "../internal/inject.ts";

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

test("an answer written without say still goes to whoever knocked", () => {
  const out = spokenOutbox("knock", " 醒了五十次 ", 111, false);
  assert.deepEqual(out?.messages, ["醒了五十次"]);
  assert.equal(out?.chat, 111);
  // it already spoke through say: the trailing text is a summary, not a message
  assert.equal(spokenOutbox("knock", "说完了", 111, true), null);
  // nobody is waiting on a timer wake
  assert.equal(spokenOutbox("timer", "今天想到一件事", 111, false), null);
  assert.equal(spokenOutbox("knock", "", 111, false), null);
  assert.equal(spokenOutbox("knock", "在", undefined, false), null);
});

test("an outbox count tolerates a missing directory", () => {
  assert.equal(countOutbox("/nonexistent-geng-outbox"), 0);
});
