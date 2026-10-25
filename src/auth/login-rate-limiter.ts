/**
 * Login attempt limit. In memory for the MVP (one instance on Render); a
 * shared store (e.g. Postgres) can implement the same interface later.
 */
export interface LoginRateLimiter {
  /**
   * Records one attempt for every key (e.g. "ip:1.2.3.4", "email:a@b.c")
   * and returns true, or returns false (recording nothing) when any key
   * already used its attempts in the current window.
   */
  attempt(keys: readonly string[]): boolean;
}

export const LOGIN_RATE_LIMITER = Symbol('LOGIN_RATE_LIMITER');

/** Fixed window per key: `max` attempts every `windowMs`. */
export class InMemoryLoginRateLimiter implements LoginRateLimiter {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();

  constructor(
    private readonly options: {
      max: number;
      windowMs: number;
      clock?: () => number;
    },
  ) {}

  attempt(keys: readonly string[]): boolean {
    const now = this.options.clock?.() ?? Date.now();
    this.sweep(now);
    const current = keys.map((key) => {
      const window = this.windows.get(key);
      return window && now - window.start < this.options.windowMs
        ? window
        : undefined;
    });
    if (current.some((w) => w && w.count >= this.options.max)) {
      return false;
    }
    keys.forEach((key, i) => {
      const window = current[i];
      if (window) {
        window.count += 1;
      } else {
        this.windows.set(key, { start: now, count: 1 });
      }
    });
    return true;
  }

  /** Drops expired windows so the map does not grow without bound. */
  private sweep(now: number): void {
    if (this.windows.size < 10_000) {
      return;
    }
    for (const [key, window] of this.windows) {
      if (now - window.start >= this.options.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}
