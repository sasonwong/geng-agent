/**
 * The container runs in one timezone and the daemon logs in UTC; the page has to show both
 * or it will disagree with the `date` it can run itself.
 */
export function localClock(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(ms));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "??";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "??";
  const zone = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  // "GMT+08:00" → "+08"; a whole-hour zone is the common case and reads better short
  const offset = zone.replace("GMT", "").replace(":00", "");
  return `${hour}:${minute} ${offset === "" ? "+00" : offset}`;
}
