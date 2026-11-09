/**
 * Split one text into chunks of at most `limit` code points.
 *
 * Code points, not UTF-16 units: cutting an emoji in half makes an invalid string. The
 * boundary preference (paragraph, line, space, hard cut) is the client convention used
 * by the channels. Callers pass the channel's own limit; there is no universal number.
 */
export function splitText(text: string, limit: number): string[] {
  const max = Math.max(1, Math.floor(limit));
  const chars = Array.from(text);
  if (chars.length <= max) return chars.length === 0 ? [] : [text];
  const out: string[] = [];
  let start = 0;
  while (start < chars.length) {
    if (chars.length - start <= max) {
      out.push(chars.slice(start).join(""));
      break;
    }
    const head = chars.slice(start, start + max).join("");
    const floor = Math.floor(max / 2);
    const paragraph = head.lastIndexOf("\n\n");
    const line = head.lastIndexOf("\n");
    const space = head.lastIndexOf(" ");
    let cut = head.length;
    if (paragraph >= floor) cut = paragraph + 2;
    else if (line >= floor) cut = line + 1;
    else if (space >= floor) cut = space + 1;
    const part = head.slice(0, cut);
    out.push(part);
    start += Array.from(part).length;
  }
  return out;
}
