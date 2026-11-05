import { test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { installationToken, makeJwt, forgetCachedTokens } from "../internal/ghapp.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const app = { appId: "12345", installationId: "678", keyPem };

function claims(jwt: string): Record<string, unknown> {
  const [header, payload, signature] = jwt.split(".");
  // the point of the signature is that GitHub can check it; so can we
  const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature as string, "base64url"));
  assert.equal(ok, true, "签名验不过：GitHub 会回 401，而错误里不会说为什么");
  return JSON.parse(Buffer.from(payload as string, "base64url").toString());
}

test("the JWT says who we are and expires inside GitHub's limit", () => {
  const now = 1_800_000_000_000;
  const body = claims(makeJwt(app, now));
  assert.equal(body.iss, "12345");
  // a minute of clock skew backwards, because their clock is not our clock
  assert.equal(body.iat, Math.floor(now / 1000) - 60);
  // ten minutes is the hard limit; nine is the accepted maximum
  assert.ok((body.exp as number) - (body.iat as number) <= 600, "超过十分钟 GitHub 直接拒绝");
});

test("a token is reused while it has time left, and re-minted when it does not", async () => {
  forgetCachedTokens();
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: `ghs_${calls}`, expires_at: new Date(1_800_003_600_000).toISOString() }),
    };
  }) as unknown as typeof fetch;
  const now = 1_800_000_000_000;
  const first = await installationToken(app, now, fake);
  // a round runs dozens of git commands; each one must not cost a token request
  const second = await installationToken(app, now + 60_000, fake);
  assert.equal(calls, 1);
  assert.equal(second.token, first.token);
  // five minutes before expiry is too close to hand out
  const third = await installationToken(app, 1_800_003_600_000 - 60_000, fake);
  assert.equal(calls, 2);
  assert.equal(third.token, "ghs_2");
});

test("an unparseable expires_at still leaves a reusable hour of token", async () => {
  forgetCachedTokens();
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: `ghs_${calls}`, expires_at: "not-a-date" }),
    };
  }) as unknown as typeof fetch;
  const now = 1_800_000_000_000;
  const first = await installationToken(app, now, fake);
  assert.equal(Number.isNaN(first.expiresAt), false, "NaN 的过期时刻等于永远过期");
  await installationToken(app, now + 60_000, fake);
  assert.equal(calls, 1, "缓存命中不了的话，一条 git 命令就要换一次 token");
});

test("a refused exchange names the status instead of returning an empty token", async () => {
  forgetCachedTokens();
  const fake = (async () => ({
    ok: false,
    status: 401,
    json: async () => ({ message: "A JSON web token could not be decoded" }),
  })) as unknown as typeof fetch;
  await assert.rejects(() => installationToken(app, 1_800_000_000_000, fake), /401.*decoded/);
});
