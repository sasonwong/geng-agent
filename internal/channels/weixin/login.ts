import { getQrCode, getQrStatus } from "./client.ts";
import { DEFAULT_BASE_URL, readWeixin, saveWeixin, type WeixinConfig } from "./state.ts";
import type { LoginContext } from "../channel.ts";

const LOGIN_TIMEOUT_MS = 8 * 60_000;
const QR_REFRESHES = 3;
const POLL_MS = 2_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("已取消"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("已取消"));
      },
      { once: true },
    );
  });
}

function redirectBase(host: string): string {
  const raw = host.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

function printQr(ctx: LoginContext, url: string): void {
  ctx.log("");
  ctx.log("用手机微信扫下面这串生成的二维码：");
  ctx.log(url);
  ctx.log("二维码约 2 分钟过期；过期会自动换一张，最多换 3 次。");
}

/**
 * Manual QR login. There is no token refresh: the only way back from `-14` is a person
 * scanning a new code, so this never runs automatically and never sends another
 * instance's token — `local_token_list` carries this instance's old token at most.
 */
export async function loginWeixin(ctx: LoginContext): Promise<void> {
  const existing = readWeixin(ctx.root).configs[ctx.instance];
  const startBase = ctx.baseUrl ?? DEFAULT_BASE_URL;
  const oldTokens = existing?.token ? [existing.token] : [];
  let base = startBase;
  let qr = await getQrCode(base, oldTokens, ctx.signal);
  printQr(ctx, qr.url);
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let refreshes = 0;
  let verify: string | undefined;

  for (;;) {
    if (Date.now() > deadline) throw new Error("扫码登录超时（8 分钟）：重新跑一次 geng channels login weixin");
    const status = await getQrStatus(base, qr.qrcode, verify, ctx.signal);
    switch (status.status) {
      case "wait":
      case "scaned":
        await sleep(POLL_MS, ctx.signal);
        continue;

      case "scaned_but_redirect":
        if (status.redirect_host !== undefined) {
          base = redirectBase(status.redirect_host);
          ctx.log(`服务端要求换节点：${base}`);
        }
        continue;

      case "need_verifycode":
        if (ctx.ask === undefined) {
          throw new Error("微信要求配对码，但当前没有可以输入的地方；在终端里重跑这条命令");
        }
        verify = (await ctx.ask("手机微信上显示的配对码：")).trim();
        if (verify === "") throw new Error("没有输入配对码");
        continue;

      case "verify_code_blocked":
        ctx.log("配对码错太多次，这张二维码作废了。");
        break;

      case "expired":
        ctx.log("二维码过期了。");
        break;

      case "binded_redirect": {
        if (existing?.token !== undefined && existing.token !== "") {
          // The token is unchanged, so the fingerprint has to change some other way or
          // the gateway's reload would leave the old (possibly parked) poller in place.
          saveWeixin(ctx.root, ctx.instance, { ...existing, savedAt: new Date().toISOString() });
          ctx.log(`这个微信已经绑过这台机器（${existing.botId ?? "已有的 bot"}），沿用现有凭据；reload 会从新会话开始。`);
          return;
        }
        throw new Error("这个微信已经绑定了另一个客户端；先在那台机器上解绑，再重新扫码");
      }

      case "confirmed": {
        const token = status.bot_token?.trim() ?? "";
        const userId = status.ilink_user_id?.trim() ?? "";
        if (token === "" || userId === "") {
          throw new Error("扫码成功，但服务端没有给 token 或 userId；重试一次");
        }
        const name = ctx.name ?? existing?.name;
        const baseUrl = status.baseurl?.trim() === undefined || status.baseurl.trim() === "" ? base : status.baseurl;
        const cfg: WeixinConfig = {
          token,
          baseUrl,
          ...(status.ilink_bot_id === undefined ? {} : { botId: status.ilink_bot_id }),
          userId,
          ...(name === undefined ? {} : { name }),
          savedAt: new Date().toISOString(),
        };
        saveWeixin(ctx.root, ctx.instance, cfg);
        ctx.log(`登录成功：${cfg.botId ?? "bot"}，主人 ${userId}`);
        ctx.log("凭据写在 secrets/weixin.json（600）。接着跑 geng gateway --check；网关在跑就 reload 一次。");
        return;
      }

      default:
        ctx.log(`扫码状态 ${status.status}：继续等。`);
        await sleep(POLL_MS, ctx.signal);
        continue;
    }

    refreshes += 1;
    if (refreshes > QR_REFRESHES) {
      throw new Error(`二维码连续失效 ${refreshes} 次，先确认手机微信能正常扫码，再重试`);
    }
    qr = await getQrCode(base, oldTokens, ctx.signal);
    verify = undefined;
    printQr(ctx, qr.url);
  }
}
