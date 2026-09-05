/**
 * A fixed-window counter, and nothing more.
 *
 * The app binds to loopback and every caller is the same machine, so this is not
 * an anti-abuse measure — a request that gets this far already carried the token.
 * It is a fuse. `POST /chat` spends money against a real `OPENAI_API_KEY`, and
 * `POST /index` walks a filesystem; a script in a loop is a plausible accident,
 * and the cost of one lands on the user rather than on an attacker.
 *
 * Fixed window rather than a token bucket because the failure it guards against
 * is a runaway loop, not a burst: a loop trips any window, and the extra
 * precision would only make this harder to reason about.
 */
export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole seconds until the window resets, for a `Retry-After` header. */
  readonly retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class FixedWindowLimiter {
  // One entry per limited route, so it needs no eviction: a stale window is
  // overwritten by the next request that keys on it.
  private readonly windows = new Map<string, Window>();

  /** Injected so the tests can move time rather than wait for it. */
  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, policy: RateLimitPolicy): RateLimitDecision {
    const at = this.now();
    const window = this.windows.get(key);

    if (window === undefined || at >= window.resetAt) {
      this.windows.set(key, { count: 1, resetAt: at + policy.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (window.count >= policy.limit) {
      // Rounded up, so the advice is never "retry in 0 seconds" for a window
      // that has not actually reset.
      return { allowed: false, retryAfterSeconds: Math.ceil((window.resetAt - at) / 1000) };
    }

    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
