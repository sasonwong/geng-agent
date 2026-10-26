import { test } from "node:test";
import assert from "node:assert/strict";
import { localClock } from "../internal/time.ts";

test("the page names the same clock the container will print", () => {
  const ms = Date.parse("2026-10-26T13:33:16Z");
  assert.equal(localClock(ms, "Asia/Shanghai"), "21:33 +08");
  assert.equal(localClock(ms, "UTC"), "13:33 +00");
  // a half-hour zone must not be flattened into a whole one
  assert.equal(localClock(ms, "Asia/Kolkata"), "19:03 +05:30");
});
