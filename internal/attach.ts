import { basename } from "node:path";
import { existsSync, statSync } from "node:fs";
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
  /** container path once it is on disk; absent when we chose not to fetch it */
  path?: string;
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

/** A file name that cannot escape the directory, and stays recognisable. */
export function safeName(chatId: number, messageId: number, name: string): string {
  const base = basename(name).replace(/[^\w.\-]+/g, "_").slice(-80);
  return `${chatId}-${messageId}-${base === "" ? "file" : base}`;
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

/** `/work/report.html` from inside the container is `data/<inst>/workspace/report.html`. */
export function hostPathForWorkPath(workRoot: string, given: string): string | null {
  if (!given.startsWith("/work/")) return null;
  const rel = given.slice("/work/".length);
  if (rel === "" || rel.includes("..")) return null;
  const abs = `${workRoot}/${rel}`;
  return existsSync(abs) && statSync(abs).isFile() ? abs : null;
}
