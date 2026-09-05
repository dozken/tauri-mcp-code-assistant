import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter, type RateLimitPolicy } from './rate-limit.js';

const POLICY: RateLimitPolicy = { limit: 3, windowMs: 1000 };

/** A clock the test moves by hand, so a window test takes no wall time. */
const clock = (start = 0) => {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
};

describe('FixedWindowLimiter', () => {
  it('allows requests up to the limit', () => {
    const time = clock();
    const limiter = new FixedWindowLimiter(time.now);

    const decisions = [1, 2, 3].map(() => limiter.consume('/chat', POLICY));

    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true]);
  });

  it('refuses the one after, and says how long to wait', () => {
    const time = clock();
    const limiter = new FixedWindowLimiter(time.now);
    for (let index = 0; index < 3; index += 1) limiter.consume('/chat', POLICY);

    time.advance(400);
    const refused = limiter.consume('/chat', POLICY);

    expect(refused.allowed).toBe(false);
    // 600ms left, rounded up: "retry in 0 seconds" would be a lie.
    expect(refused.retryAfterSeconds).toBe(1);
  });

  it('opens again once the window has passed', () => {
    const time = clock();
    const limiter = new FixedWindowLimiter(time.now);
    for (let index = 0; index < 3; index += 1) limiter.consume('/chat', POLICY);
    expect(limiter.consume('/chat', POLICY).allowed).toBe(false);

    time.advance(1000);

    expect(limiter.consume('/chat', POLICY).allowed).toBe(true);
  });

  it('does not let a refused request extend its own window', () => {
    // A loop that keeps hammering must still get in when the window ends;
    // counting the refusals would keep it locked out for as long as it retried.
    const time = clock();
    const limiter = new FixedWindowLimiter(time.now);
    for (let index = 0; index < 3; index += 1) limiter.consume('/chat', POLICY);

    for (let index = 0; index < 50; index += 1) {
      time.advance(10);
      limiter.consume('/chat', POLICY);
    }
    time.advance(600);

    expect(limiter.consume('/chat', POLICY).allowed).toBe(true);
  });

  it('counts each key on its own', () => {
    const time = clock();
    const limiter = new FixedWindowLimiter(time.now);
    for (let index = 0; index < 3; index += 1) limiter.consume('/chat', POLICY);

    expect(limiter.consume('/chat', POLICY).allowed).toBe(false);
    expect(limiter.consume('/index', POLICY).allowed).toBe(true);
  });

  it('starts each key’s window at that key’s first request', () => {
    const time = clock();
    const limiter = new FixedWindowLimiter(time.now);
    limiter.consume('/chat', POLICY);

    time.advance(900);
    for (let index = 0; index < 3; index += 1) limiter.consume('/index', POLICY);

    // /chat's window has ended; /index's has 100ms to run.
    time.advance(150);
    expect(limiter.consume('/chat', POLICY).allowed).toBe(true);
    expect(limiter.consume('/index', POLICY).allowed).toBe(false);
  });

  it('uses the wall clock by default', () => {
    // The default argument is the one production runs on, and a limiter frozen at
    // zero would refuse everything forever after its first window.
    const limiter = new FixedWindowLimiter();

    expect(limiter.consume('/chat', { limit: 1, windowMs: 0 }).allowed).toBe(true);
    expect(limiter.consume('/chat', { limit: 1, windowMs: 0 }).allowed).toBe(true);
  });
});
