import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { TgMessage } from "./telegram.ts";

/**
 * What came with a message. Only text is free; everything else is a file that has to be
 * fetched, and one kind we cannot use at all.
 */
export interface Attachment {
  kind: "photo" | "document" | "audio" | "video" | "animation" | "video_note" | "sticker" | "voice";
  fileId?: string;
  name?: string;
  mime?: string;
  bytes?: number;
  /** the file id once it is on disk (`F12`); absent when we chose not to fetch it */
  id?: string;
  /** why it is not here, when it is not */
  note?: string;
}

/**
 * Voice is not fetched on purpose: there is nothing here that turns sound into text, so a
 * downloaded file would be dead weight pretending to be content.
 */
export function attachmentOf(m: TgMessage): Attachment | null {
  if (m.voice) return { kind: "voice", note: "没有转写" };
  const biggest = m.photo?.[m.photo.length - 1];
  if (biggest) {
    return { kind: "photo", fileId: biggest.file_id, bytes: biggest.file_size, name: "photo.jpg" };
  }
  const one = m.document ?? m.audio ?? m.video ?? m.animation ?? m.video_note ?? m.sticker;
  if (!one) return null;
  const kind = m.document
    ? "document"
    : m.audio
      ? "audio"
      : m.video
        ? "video"
        : m.animation
          ? "animation"
          : m.video_note
            ? "video_note"
            : "sticker";
  return {
    kind,
    fileId: one.file_id,
    name: one.file_name ?? `${kind}`,
    mime: one.mime_type,
    bytes: one.file_size,
  };
}

/** How each kind is named on the page: counts, never contents. */
export const KIND_WORD: Record<Attachment["kind"], string> = {
  photo: "张图片",
  document: "个文件",
  audio: "段音频",
  video: "段视频",
  animation: "张动图",
  video_note: "段圆形视频",
  sticker: "张表情",
  voice: "条语音",
};

/**
 * One attachment said in words. A bare count cannot tell the reader that a voice note here
 * can never be listened to, and the note is the only place that fact lives. Unknown kinds
 * fall back instead of printing `undefined`.
 */
export function attachmentWords(a: { kind: string; note?: string }): string {
  const word = KIND_WORD[a.kind as Attachment["kind"]] ?? "个文件";
  return `1${word}${a.note ? `（${a.note}）` : ""}`;
}

/** The transcript's stand-in for a message that arrived with no words at all. */
export function placeholderFor(atts: { kind: string; note?: string }[]): string {
  return atts.length === 0 ? "[空消息]" : `[${attachmentWords(atts[0]!)}]`;
}

/** `/work/report.html` from inside the container is `data/<inst>/workspace/report.html`. */
export function hostPathForWorkPath(workRoot: string, given: string): string | null {
  if (!given.startsWith("/work/")) return null;
  const rel = given.slice("/work/".length);
  if (rel === "" || rel.startsWith("/") || rel.includes("\0")) return null;
  // Resolve against the host's own root, with the host's own separator: a hard-coded
  // `${workRoot}/${rel}` produced a mixed path on Windows. Checking the resolved path
  // (not the raw string) is what makes `/work/a/../b` and `/work/../secrets` fail, while
  // an ordinary name like `report..v2.pdf` still works.
  const base = resolve(workRoot);
  const abs = resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  try {
    // A symlink inside /work is a pointer the container created. On the host it may
    // resolve outside the workspace (…/secrets/bots.json), and `say` would then send a
    // credential as if it were a file it had made. Refuse the link itself, and double
    // check the real path against the real workspace root.
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const real = realpathSync(abs);
    const realBase = realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + sep)) return null;
    return abs;
  } catch {
    return null;
  }
}
