import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { AppConfig } from '../config/configuration.js';
import { testConfig } from '../../test/helpers.js';
import { CALLER } from './local-access.guard.js';
import { RateLimitGuard } from './rate-limit.guard.js';

const configWith = (overrides: Partial<AppConfig['rateLimit']> = {}): AppConfig => {
  const base = testConfig();
  return {
    ...base,
    rateLimit: {
      enabled: true,
      windowMs: 60_000,
      // Different on purpose: equal budgets would make "which route is this?"
      // unobservable, and the wrong one could be applied for good.
      chatPerWindow: 1,
      indexPerWindow: 2,
      ...overrides,
    },
  };
};

/** What the guard reads off a request: the route, and who the access guard said is calling. */
const httpContext = (method: string, path: string, caller?: string): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, path, [CALLER]: caller }) }),
  }) as unknown as ExecutionContext;

const wsContext = (): ExecutionContext => ({ getType: () => 'ws' }) as unknown as ExecutionContext;

describe('RateLimitGuard', () => {
  it('lets the first request through and refuses the next', () => {
    const guard = new RateLimitGuard(configWith());

    expect(guard.canActivate(httpContext('POST', '/chat'))).toBe(true);
    expect(() => guard.canActivate(httpContext('POST', '/chat'))).toThrow(/Too many requests/);
  });

  it('does nothing at all when it is switched off', () => {
    const guard = new RateLimitGuard(configWith({ enabled: false }));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(guard.canActivate(httpContext('POST', '/chat'))).toBe(true);
    }
  });

  it('leaves reads alone, however many there are', () => {
    const guard = new RateLimitGuard(configWith());

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(guard.canActivate(httpContext('GET', '/status'))).toBe(true);
    }
  });

  it('gives each route the budget configured for it', () => {
    const guard = new RateLimitGuard(configWith());

    expect(guard.canActivate(httpContext('POST', '/index'))).toBe(true);
    expect(guard.canActivate(httpContext('POST', '/index'))).toBe(true);
    expect(() => guard.canActivate(httpContext('POST', '/index'))).toThrow(/RATE_LIMIT_INDEX/);

    // /chat's budget is one, and spending /index's did not spend it.
    expect(guard.canActivate(httpContext('POST', '/chat'))).toBe(true);
    expect(() => guard.canActivate(httpContext('POST', '/chat'))).toThrow(/RATE_LIMIT_CHAT/);
  });

  it('does not charge a DELETE for the POST that shares its path', () => {
    // `DELETE /index` drops a folder from the index; it is cheap, and the fuse is
    // for the walk that `POST /index` starts.
    const guard = new RateLimitGuard(configWith());
    guard.canActivate(httpContext('POST', '/index'));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(guard.canActivate(httpContext('DELETE', '/index'))).toBe(true);
    }
  });

  it('gives each caller its own fuse', () => {
    // The point of the whole thing: a script in a loop blows its own budget and
    // the desktop window keeps working.
    const guard = new RateLimitGuard(configWith());
    const script = 'client:some-script';
    const app = 'origin:tauri://localhost';

    expect(guard.canActivate(httpContext('POST', '/chat', script))).toBe(true);
    expect(() => guard.canActivate(httpContext('POST', '/chat', script))).toThrow(/Too many/);

    expect(guard.canActivate(httpContext('POST', '/chat', app))).toBe(true);
  });

  it('shares one fuse among callers that gave no identity', () => {
    // Two anonymous scripts are indistinguishable on loopback, and pretending
    // otherwise would hand a runaway one a fresh budget per request.
    const guard = new RateLimitGuard(configWith());

    expect(guard.canActivate(httpContext('POST', '/chat'))).toBe(true);
    expect(() => guard.canActivate(httpContext('POST', '/chat'))).toThrow(/Too many/);
  });

  it('still counts each route separately within one caller', () => {
    const guard = new RateLimitGuard(configWith());
    const app = 'origin:tauri://localhost';

    expect(guard.canActivate(httpContext('POST', '/chat', app))).toBe(true);
    expect(() => guard.canActivate(httpContext('POST', '/chat', app))).toThrow(/RATE_LIMIT_CHAT/);
    expect(guard.canActivate(httpContext('POST', '/index', app))).toBe(true);
  });

  it('leaves the socket transport to the gateway', () => {
    // The gateway runs one turn per socket and aborts the previous one, so a loop
    // there cannot stack work the way a loop of posts can.
    const guard = new RateLimitGuard(configWith());

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(guard.canActivate(wsContext())).toBe(true);
    }
  });

  it('reports how long to wait, so a client can back off rather than spin', () => {
    const guard = new RateLimitGuard(configWith());
    guard.canActivate(httpContext('POST', '/chat'));

    try {
      guard.canActivate(httpContext('POST', '/chat'));
      expect.unreachable('the second request should have been refused');
    } catch (error) {
      const body = (error as { getResponse: () => { retryAfterSeconds: number } }).getResponse();
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
    }
  });
});
