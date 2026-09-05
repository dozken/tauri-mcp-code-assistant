import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { AppConfig } from '../config/configuration.js';
import { testConfig } from '../../test/helpers.js';
import { RateLimitGuard } from './rate-limit.guard.js';

const configWith = (overrides: Partial<AppConfig['rateLimit']> = {}): AppConfig => {
  const base = testConfig();
  return {
    ...base,
    rateLimit: {
      enabled: true,
      windowMs: 60_000,
      chatPerWindow: 1,
      indexPerWindow: 1,
      ...overrides,
    },
  };
};

/** Only the two things the guard reads off a request. */
const httpContext = (method: string, path: string): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ method, path }) }),
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

  it('does not charge a DELETE for the POST that shares its path', () => {
    // `DELETE /index` drops a folder from the index; it is cheap, and the fuse is
    // for the walk that `POST /index` starts.
    const guard = new RateLimitGuard(configWith());
    guard.canActivate(httpContext('POST', '/index'));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(guard.canActivate(httpContext('DELETE', '/index'))).toBe(true);
    }
  });

  it('leaves the socket transport to the gateway', () => {
    // The gateway runs one turn per socket and aborts the previous one, so a loop
    // there cannot stack work the way a loop of posts can.
    const guard = new RateLimitGuard(configWith());

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(guard.canActivate(wsContext())).toBe(true);
    }
  });

  it('names the setting that would let the caller through', () => {
    const guard = new RateLimitGuard(configWith());
    guard.canActivate(httpContext('POST', '/index'));

    expect(() => guard.canActivate(httpContext('POST', '/index'))).toThrow(/RATE_LIMIT_INDEX/);
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
