/**
 * The brake on a talking loop: rate, repetition, shape only — never meaning.
 *
 * Extracted because the timing is where it went wrong. The sweep retries an undelivered
 * item every two seconds, and the old check recorded the attempt *before* looking at the
 * pause — so a paused key kept inflating its own rate window, and when the pause expired
 * the window was already over the limit. It re-tripped immediately with a bigger number
 * every time (1001 → 1926 → 2147 → 2379), and the ops queue never drained again.
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
  private texts: string[] = [];
  private pausedUntil = 0;
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
    this.times = this.times.filter((t) => now - t < this.windowMs);
    this.times.push(now);
    for (const t of texts) {
      this.texts.push(t);
      if (this.texts.length > 40) this.texts.shift();
    }
    if (this.times.length > this.rate) {
      this.pausedUntil = now + this.pauseMs;
      return "rate";
    }
    const last = this.texts[this.texts.length - 1];
    if (last !== undefined && this.texts.filter((t) => t === last).length >= this.repeat) {
      this.pausedUntil = now + this.pauseMs;
      return "repeat";
    }
    return null;
  }

  /** For the ops message: how many were attempted in the window that tripped. */
  get attempts(): number {
    return this.times.length;
  }
}
