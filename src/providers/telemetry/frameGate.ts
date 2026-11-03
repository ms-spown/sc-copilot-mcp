/**
 * A rate limit that never loses the newest item. The game sends about 17 frames a second; a local program that
 * pretends to be the game could send tens of thousands. Items that arrive less than `minIntervalMs` after the last
 * one that was handled wait; a newer item replaces the waiting one, and the survivor is handled when the interval
 * is over. So a burst costs one handling, and its last item is the one that counts.
 *
 * The clock is injected and the timer is unref'd: it never keeps the process alive.
 */
export class FrameGate<T> {
  private lastRun = Number.NEGATIVE_INFINITY;
  private pending: { item: T; t: number } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    /** 0 (or less) turns the limit off. */
    private readonly minIntervalMs: number,
    private readonly now: () => number,
    /** `deferred` is true when the item waited for its slot. `t` is the time it arrived. */
    private readonly run: (item: T, t: number, deferred: boolean) => void,
  ) {}

  /** True when the item was handled at once; false when it waits (and may be replaced by a newer one). */
  offer(item: T, t: number): boolean {
    if (
      this.minIntervalMs <= 0 ||
      (this.pending === null && t - this.lastRun >= this.minIntervalMs)
    ) {
      this.lastRun = t;
      this.run(item, t, false);
      return true;
    }
    this.pending = { item, t };
    if (this.timer === null) {
      // Clamped: a clock that jumped backwards must not schedule a wait of hours.
      const wait = Math.min(
        this.minIntervalMs,
        Math.max(1, this.minIntervalMs - (this.now() - this.lastRun)),
      );
      this.timer = setTimeout(() => this.flush(), wait);
      this.timer.unref();
    }
    return false;
  }

  private flush(): void {
    this.timer = null;
    const waiting = this.pending;
    this.pending = null;
    if (!waiting) return;
    this.lastRun = this.now();
    this.run(waiting.item, waiting.t, true);
  }

  /** Forgets the waiting item (the stream it came from is over). */
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
