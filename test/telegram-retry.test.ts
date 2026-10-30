import { test } from "node:test";
import assert from "node:assert/strict";
import { getUpdates } from "../internal/telegram.ts";

/**
 * Every answer the Bot API can give, without a network. `fetch` is the only thing between
 * this module and Telegram, so one stub is the whole boundary.
 */
function answer(body: unknown, status = 200): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status });
  return () => {
    globalThis.fetch = real;
  };
}

function drop(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  return () => {
    globalThis.fetch = real;
  };
}

const conflict = {
  ok: false,
  error_code: 409,
  description: "Conflict: can't use getUpdates method while webhook is active",
};

// A refused long poll is not one thing. These two never fix themselves: the process used
// to keep the poller in its map and look healthy while the bot received nothing, which is
// exactly the shape #36 removed at startup (systemd active, only journald knew).
test("409 while a webhook is set is fatal, not an empty batch", async () => {
  const restore = answer(conflict, 409);
  try {
    await assert.rejects(getUpdates("1:fake-token", 0, 1), /Conflict/);
  } finally {
    restore();
  }
});

test("401 after the token was revoked is fatal, not an empty batch", async () => {
  const restore = answer({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
  try {
    await assert.rejects(getUpdates("1:fake-token", 0, 1), /Unauthorized/);
  } finally {
    restore();
  }
});

// The other half: what really is transient must stay quiet, or a flaky line turns into a
// restart loop.
test("429 is retried, not fatal", async () => {
  const restore = answer(
    { ok: false, error_code: 429, description: "Too Many Requests: retry after 3" },
    429,
  );
  try {
    assert.deepEqual(await getUpdates("1:fake-token", 0, 1), []);
  } finally {
    restore();
  }
});

test("a dropped connection is retried, not fatal", async () => {
  const restore = drop();
  try {
    assert.deepEqual(await getUpdates("1:fake-token", 0, 1), []);
  } finally {
    restore();
  }
});

test("a normal long poll still returns the updates", async () => {
  const updates = [{ update_id: 7, message: { message_id: 1, chat: { id: 2, type: "private" } } }];
  const restore = answer({ ok: true, result: updates });
  try {
    assert.deepEqual(await getUpdates("1:fake-token", 0, 1), updates);
  } finally {
    restore();
  }
});
