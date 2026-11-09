import { telegramChannel } from "./telegram.ts";
import { weixinChannel } from "./weixin/channel.ts";
import type { Channel } from "./channel.ts";

/**
 * One list, compiled in. Adding a channel is a module plus a line here — not a directory
 * of user code the gateway would have to trust. The next transport writes its own module;
 * core never learns its name.
 */
export const CHANNELS: Channel[] = [telegramChannel, weixinChannel];

export const CHANNEL_BY_ID: Record<string, Channel> = Object.fromEntries(
  CHANNELS.map((channel) => [channel.id, channel]),
);
