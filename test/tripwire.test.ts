import { test } from "node:test";
import assert from "node:assert/strict";
import { Tripwire } from "../internal/tripwire.ts";

const opts = { windowMs: 60_000, rate: 5, repeat: 3, pauseMs: 600_000 };

test("talking at a normal pace trips nothing", () => {
  const t = new Tripwire(opts);
  const now = 1_000_000;
  for (let i = 0; i < 4; i++) assert.equal(t.check([`第 ${i} 句`], now + i * 2000), null);
});

test("too fast trips, and the pause holds for its whole length", () => {
  const t = new Tripwire({ ...opts, repeat: 999 });
  const now = 1_000_000;
  let tripped: string | null = null;
  for (let i = 0; i < 8 && tripped === null; i++) tripped = t.check([`第 ${i} 句`], now + i * 500);
  assert.equal(tripped, "rate");
  assert.equal(t.check(["再说一句"], now + 10_000), "paused");
});

test("retrying while paused never inflates the window — that was the lockup", () => {
  // the sweep retries an undelivered item every two seconds; if those retries counted,
  // the window stayed over the limit and the queue never drained
  const t = new Tripwire({ ...opts, repeat: 999 });
  const start = 1_000_000;
  for (let i = 0; i < 8; i++) t.check(["hi"], start + i * 500);
  const attemptsAtTrip = t.attempts;
  for (let i = 0; i < 300; i++) assert.equal(t.check(["hi"], start + 1000 + i * 2000), "paused");
  assert.equal(t.attempts, attemptsAtTrip);
  // once the pause is over a single attempt is allowed through again
  assert.equal(t.check(["hi"], start + 700_000), null);
});

test("the same sentence too many times trips the wire", () => {
  const t = new Tripwire({ ...opts, rate: 999 });
  const now = 1_000_000;
  const verdicts = [0, 1, 2, 3].map((i) => t.check(["同一句"], now + i * 1000));
  assert.deepEqual(verdicts, [null, null, "repeat", "paused"]);
});

test("the same sentence ages out with the window, like the rate", () => {
  // What it said is a window, not a buffer: "the same sentence again, right after" is a
  // loop, the same sentence an hour apart is a person coming back to a topic.
  const t = new Tripwire({ ...opts, rate: 999, repeat: 3 });
  const start = 1_000_000;
  assert.equal(t.check(["同一句"], start), null);
  assert.equal(t.check(["同一句"], start + 40_000), null);
  assert.equal(t.check(["同一句"], start + 80_000), null);
});

test("a batch that trips by itself lands once the pause is over", () => {
  // The sweep hands the same undelivered words back every two seconds. A batch long
  // enough to trip the wire on its own tripped it again on every retry: those words never
  // landed, and because the wire is per bot, the instance never spoke again either.
  const t = new Tripwire({ ...opts, rate: 999, repeat: 3 });
  const start = 1_000_000;
  const batch = ["同一句", "同一句", "同一句"];
  assert.equal(t.check(batch, start), "repeat");
  assert.equal(t.check(batch, start + 1000), "paused");
  assert.equal(t.check(batch, start + opts.pauseMs + 1), null);
  // the wire is armed again once that one message is through
  assert.equal(t.check(batch, start + opts.pauseMs + 2000), "repeat");
});
