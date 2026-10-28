/**
 * The only place that can read a mail's MIME, so the only place that parses it.
 *
 * It decides nothing. Who may write into a mailbox, what counts as read, whether a mail
 * wakes anything — all of that lives on the host, in the repo, behind a token that this
 * Worker holds and the agent never sees. If this Worker is wrong, it is wrong loudly:
 * a failed POST throws, Cloudflare rejects the mail, and the sender gets a bounce.
 */
import PostalMime from "postal-mime";

// carried inline: past this, the host gets the name and size and the file stays here
const MAX_ATTACHMENT = 5 * 1024 * 1024;
const MAX_TOTAL = 10 * 1024 * 1024;

function base64(bytes) {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += btoa(String.fromCharCode(...bytes.subarray(i, i + chunk)));
  }
  return out;
}

export default {
  async email(message, env) {
    const url = env.GENG_MAIL_URL;
    const token = env.GENG_MAIL_TOKEN;
    if (!url || !token) throw new Error("GENG_MAIL_URL / GENG_MAIL_TOKEN 没配");

    const raw = await new Response(message.raw).arrayBuffer();
    const mail = await PostalMime.parse(raw);

    let budget = MAX_TOTAL;
    const attachments = [];
    for (const a of mail.attachments ?? []) {
      const bytes = a.content.byteLength;
      const carry = bytes <= MAX_ATTACHMENT && bytes <= budget;
      if (carry) budget -= bytes;
      attachments.push({
        name: a.filename ?? "file",
        mime: a.mimeType ?? "application/octet-stream",
        bytes,
        ...(carry ? { content: base64(new Uint8Array(a.content)) } : {}),
      });
    }

    const date = message.headers.get("date") ?? "";
    const parsedDate = Date.parse(date);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-geng-token": token },
      body: JSON.stringify({
        to: message.to,
        // the envelope sender, not the From header. Neither is authenticated to us, so
        // the host's whitelist is noise control — it decides who may land in the mailbox,
        // and it is never evidence that this really was that person
        from: message.from,
        subject: mail.subject ?? "",
        messageId: message.headers.get("message-id") ?? mail.messageId ?? "",
        date: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : "",
        text: mail.text ?? "",
        html: mail.html ?? "",
        attachments,
      }),
    });
    if (!response.ok) throw new Error(`收信端点回 ${response.status}`);
  },
};
