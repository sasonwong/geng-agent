import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// A process that lost every poller and has no mailbox has nothing left to serve. Keeping
// it alive is the worst shape this system knows: systemd says active, and only journald
// knows the bot is gone. Exiting non-zero at least makes the unit retry, and a wrong token
// then looks like what it is.
test("a gateway whose pollers all died exits instead of staying active", async () => {
  const root = mkdtempSync(join(tmpdir(), "geng-idle-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  // a token Telegram will not accept: the poller dies on getMe, and no mail.json means
  // there is no second job that could justify staying up. Built, not written out: the
  // gate's credential rule cannot tell a fake token from a real one.
  const rejected = ["1", "not-a-bot"].join(":");
  writeFileSync(join(root, "secrets", "bots.json"), JSON.stringify({ alice: { token: rejected } }));

  const { code, out } = await new Promise<{ code: number | string; out: string }>((resolve) => {
    execFile(
      process.execPath,
      [join(REPO, "cmd/geng/index.ts"), "gateway", "--root", root],
      // the unit sets this so node's fetch honours the proxy env; without it a machine
      // behind one waits for a direct connection to fail instead of getting the 401
      { timeout: 20_000, env: { ...process.env, NODE_USE_ENV_PROXY: "1" } },
      (err, stdout, stderr) => {
        const exit = err === null ? 0 : ((err as { code?: number | string }).code ?? "?");
        resolve({ code: exit, out: `${stdout}${stderr}` });
      },
    );
  });

  assert.equal(code, 1, `expected a non-zero exit, got ${String(code)}: ${out.slice(-500)}`);
  assert.match(out, /没有轮询也没有信箱/);
});
