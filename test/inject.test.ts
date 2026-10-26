import { test } from "node:test";
import assert from "node:assert/strict";
import { freshForSteer, INJECT_CAP, injectionText } from "../internal/inject.ts";

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
