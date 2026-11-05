/**
 * The brake on a talking loop: rate, repetition, shape only — never meaning.
 *
 * Extracted because the timing is where it went wrong. The sweep retries an undelivered
 * item every two seconds, and the old check recorded the attempt *before* looking at the
 * pause — so a paused key kept inflating its own rate window, and when the pause expired
 * the window was already over the limit. It re-tripped immediately with a bigger number
 * every time, and the ops queue never drained again.
 */
export type Trip = "paused" | "rate" | "repeat" | null;

export interface TripwireOptions {
  windowMs?: number;
  rate?: number;
  repeat?: number;
  pauseMs?: number;
}

export class Tripwire {
  private times: number[] = [];
  /** What it said, and when: the count is a window, not a buffer that keeps old words. */
  private said: { text: string; at: number }[] = [];
  private pausedUntil = 0;
  /** One message is let through as a pause ends; see `check`. */
  private free = false;
  private readonly windowMs: number;
  private readonly rate: number;
  private readonly repeat: number;
  private readonly pauseMs: number;

  constructor(o: TripwireOptions = {}) {
    this.windowMs = o.windowMs ?? 60_000;
    this.rate = o.rate ?? 30;
    this.repeat = o.repeat ?? 10;
    this.pauseMs = o.pauseMs ?? 10 * 60_000;
  }

  /** `null` means go ahead. Nothing is recorded while paused. */
  check(texts: string[], now: number): Trip {
    if (now < this.pausedUntil) return "paused";
    if (this.free) {
      // A pause ends by letting one message through. The rate window empties itself while
      // the pause runs, but the sweep hands an undelivered message back with its own
      // texts: a batch already long enough to trip the repeat wire would trip it on every
      // retry, that message would never land, and — the wire being per bot — the instance
      // would never speak again. The words are not destroyed; they wait for this one pass.
      this.free = false;
      return null;
    }
    this.times = this.times.filter((t) => now - t < this.windowMs);
    this.times.push(now);
    this.said = this.said.filter((s) => now - s.at < this.windowMs);
    // The window is the bound. A fixed cap of 40 used to make a configured `repeat`
    // above 40 unreachable — the buffer could never hold enough identical lines to
    // reach the threshold, so that wire was silently dead. Entries are dropped by age
    // above, and while paused nothing is recorded, so this list cannot grow without
    // bound in a running gateway.
    for (const t of texts) this.said.push({ text: t, at: now });
    if (this.times.length > this.rate) {
      this.pausedUntil = now + this.pauseMs;
      this.free = true;
      return "rate";
    }
    const last = this.said[this.said.length - 1]?.text;
    if (last !== undefined && this.said.filter((s) => s.text === last).length >= this.repeat) {
      this.pausedUntil = now + this.pauseMs;
      this.free = true;
      return "repeat";
    }
    return null;
  }

  /** For the ops message: how many were attempted in the window that tripped. */
  get attempts(): number {
    return this.times.length;
  }
}
