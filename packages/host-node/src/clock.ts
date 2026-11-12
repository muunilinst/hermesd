/**
 * A virtual clock. Time moves only when a test calls `advance`.
 * Timers fire in time order. Ties fire in the order they were set.
 */
export class VirtualClock {
  #now: number;
  #seq = 0;
  #timers: Array<{ at: number; seq: number; fn: () => void | Promise<void> }> = [];
  #settle: () => Promise<void> = () => new Promise<void>((r) => setImmediate(r));

  constructor(startMs: number = Date.UTC(2026, 0, 1)) {
    this.#now = startMs;
  }

  /** The current time in ms. */
  now(): number {
    return this.#now;
  }

  /** The current time as a Date. */
  date(): Date {
    return new Date(this.#now);
  }

  /** The platform sets this so that `advance` waits for background work. */
  setSettle(fn: () => Promise<void>): void {
    this.#settle = fn;
  }

  /** Run `fn` when the clock reaches `at`. Returns a function that cancels it. */
  schedule(at: number, fn: () => void | Promise<void>): () => void {
    const t = { at, seq: this.#seq++, fn };
    this.#timers.push(t);
    return () => {
      const i = this.#timers.indexOf(t);
      if (i >= 0) this.#timers.splice(i, 1);
    };
  }

  /** A promise that resolves when `ms` of virtual time have passed. */
  sleep(ms: number): Promise<void> {
    return new Promise<void>((res) => {
      this.schedule(this.#now + ms, res);
    });
  }

  /** Move time forward. Fire each due timer in order and wait for the work it starts. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      let next: { at: number; seq: number; fn: () => void | Promise<void> } | undefined;
      for (const t of this.#timers) {
        if (t.at > target) continue;
        if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) next = t;
      }
      if (!next) break;
      this.#timers.splice(this.#timers.indexOf(next), 1);
      if (next.at > this.#now) this.#now = next.at;
      await next.fn();
      await this.#settle();
    }
    this.#now = target;
    await this.#settle();
  }
}
