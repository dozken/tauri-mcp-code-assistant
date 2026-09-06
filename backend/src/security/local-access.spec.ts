import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WsException } from '@nestjs/websockets';
import { loadConfig, type AppConfig } from '../config/configuration.js';
import {
  ANONYMOUS_CALLER,
  callerOf,
  decideAccess,
  tokenMatches,
  type AccessRequest,
} from './local-access.js';
import { LocalAccessGuard } from './local-access.guard.js';

const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaa';

const configWith = (overrides: Partial<AppConfig['auth']> = {}): AppConfig => ({
  ...loadConfig({ CHROMA_ENABLED: 'false', LLM_PROVIDER: 'stub', LOG_LEVEL: 'silent' }),
  corsOrigins: ['http://localhost:1420', 'tauri://localhost'],
  auth: { enabled: true, token: TOKEN, tokenFile: join(tmpdir(), 'unused-token'), ...overrides },
});

const allow = (request: AccessRequest, config = configWith()): boolean =>
  decideAccess(request, config).allowed;

describe('tokenMatches', () => {
  it('accepts the exact token', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
  });

  it.each([
    ['a different token of the same length', TOKEN.slice(0, -1) + 'X'],
    ['a prefix of the token', TOKEN.slice(0, 10)],
    ['a longer string starting with the token', `${TOKEN}extra`],
    ['an empty string', ''],
  ])('rejects %s', (_label, presented) => {
    expect(tokenMatches(presented, TOKEN)).toBe(false);
  });
});

describe('decideAccess', () => {
  const host = '127.0.0.1:3001';

  it('lets a browser in on an allowed Origin, with no token', () => {
    expect(decideAccess({ host, origin: 'tauri://localhost' }, configWith())).toEqual({
      allowed: true,
      via: 'origin',
    });
  });

  it('turns a browser away on an Origin we do not serve', () => {
    const decision = decideAccess({ host, origin: 'https://evil.example' }, configWith());

    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ reason: expect.stringContaining('evil.example') });
  });

  it('lets a non-browser in on the bearer token', () => {
    expect(decideAccess({ host, authorization: `Bearer ${TOKEN}` }, configWith())).toEqual({
      allowed: true,
      via: 'token',
    });
  });

  it('accepts the scheme case-insensitively, as RFC 7235 requires', () => {
    expect(allow({ host, authorization: `bearer ${TOKEN}` })).toBe(true);
  });

  it('turns away a request with neither Origin nor token, and says what to send', () => {
    const decision = decideAccess({ host }, configWith());

    expect(decision).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Authorization: Bearer'),
    });
  });

  it.each([
    ['no scheme', TOKEN],
    ['the wrong scheme', `Basic ${TOKEN}`],
    ['a scheme with no credentials', 'Bearer'],
    ['the wrong token', 'Bearer nope'],
  ])('turns away %s', (_label, authorization) => {
    expect(allow({ host, authorization })).toBe(false);
  });

  it('prefers the token when a bad Origin rides along with a good token', () => {
    expect(allow({ host, origin: 'https://evil.example', authorization: `Bearer ${TOKEN}` })).toBe(
      true,
    );
  });

  it('falls back to the Origin when a bad token rides along with a good Origin', () => {
    expect(allow({ host, origin: 'tauri://localhost', authorization: 'Bearer nope' })).toBe(true);
  });

  it.each([
    ['a bare hostname', 'localhost'],
    ['a hostname with a port', 'localhost:3001'],
    ['IPv4 loopback', '127.0.0.1:3001'],
    ['bracketed IPv6 loopback', '[::1]:3001'],
    ['bare IPv6 loopback', '::1'],
    ['odd casing', 'LocalHost:3001'],
    ['surrounding whitespace', ' 127.0.0.1:3001 '],
  ])('treats %s as loopback', (_label, value) => {
    expect(allow({ host: value, authorization: `Bearer ${TOKEN}` })).toBe(true);
  });

  it.each([
    ['a rebound attacker domain', 'attacker.example:3001'],
    ['a LAN address', '192.168.1.5:3001'],
    ['a lookalike hostname', 'localhost.evil.example'],
  ])('rejects %s even with a valid token, because of DNS rebinding', (_label, value) => {
    const decision = decideAccess({ host: value, authorization: `Bearer ${TOKEN}` }, configWith());

    expect(decision).toMatchObject({ allowed: false, reason: expect.stringContaining('loopback') });
  });

  it('lets everything through when auth is switched off', () => {
    const open = configWith({ enabled: false });

    expect(decideAccess({ host: 'attacker.example' }, open)).toEqual({
      allowed: true,
      via: 'disabled',
    });
  });
});

describe('callerOf', () => {
  const host = '127.0.0.1:3001';
  const caller = (request: AccessRequest, config = configWith()): string =>
    callerOf(request, decideAccess(request, config));

  it('separates browsers by the Origin they cannot forge', () => {
    // The desktop window and a dev browser are different callers, for free.
    expect(caller({ host, origin: 'tauri://localhost' })).toBe('origin:tauri://localhost');
    expect(caller({ host, origin: 'http://localhost:1420' })).toBe('origin:http://localhost:1420');
  });

  it('takes a token caller at its word when it offers an identity', () => {
    expect(caller({ host, authorization: `Bearer ${TOKEN}`, clientId: 'editor' })).toBe(
      'client:editor',
    );
  });

  it('puts every anonymous token caller in one bucket', () => {
    // Two scripts with no identity are indistinguishable on loopback, and a fresh
    // bucket per request would be no fuse at all.
    expect(caller({ host, authorization: `Bearer ${TOKEN}` })).toBe('token');
    expect(caller({ host, authorization: `Bearer ${TOKEN}`, clientId: '   ' })).toBe('token');
  });

  it('bounds a client id, because the caller chose it', () => {
    const long = 'x'.repeat(200);

    expect(caller({ host, authorization: `Bearer ${TOKEN}`, clientId: long })).toBe(
      `client:${'x'.repeat(64)}`,
    );
  });

  it('gives a refused request no identity to spend', () => {
    expect(caller({ host, origin: 'https://evil.test' })).toBe(ANONYMOUS_CALLER);
  });

  it('lumps everyone together when auth is off', () => {
    // Nothing has been proved about anyone, so nothing may be claimed.
    const open = configWith({ enabled: false });

    expect(caller({ host, origin: 'tauri://localhost' }, open)).toBe(ANONYMOUS_CALLER);
    expect(caller({ host, clientId: 'editor' }, open)).toBe('client:editor');
  });
});

describe('LocalAccessGuard', () => {
  const guard = (config = configWith()): LocalAccessGuard =>
    new LocalAccessGuard(config, new Reflector());

  const httpContext = (headers: Record<string, string>, isPublic = false): ExecutionContext =>
    ({
      getType: () => 'http',
      getHandler: () => (isPublic ? publicHandler : plainHandler),
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    }) as unknown as ExecutionContext;

  const plainHandler = (): void => {};
  const publicHandler = (): void => {};
  Reflect.defineMetadata('local-access:public', true, publicHandler);

  it('lets an authorised request through', () => {
    const context = httpContext({ host: '127.0.0.1:3001', authorization: `Bearer ${TOKEN}` });

    expect(guard().canActivate(context)).toBe(true);
  });

  it('throws a 401 carrying the reason', () => {
    const context = httpContext({ host: '127.0.0.1:3001' });

    expect(() => guard().canActivate(context)).toThrow(UnauthorizedException);
  });

  it('waves through a handler marked @Public()', () => {
    const context = httpContext({ host: '127.0.0.1:3001' }, true);

    expect(guard().canActivate(context)).toBe(true);
  });

  it('reads the handshake headers of a socket, and fails it as a WsException', () => {
    const socketContext = (headers: Record<string, string>): ExecutionContext =>
      ({
        getType: () => 'ws',
        getHandler: () => plainHandler,
        getClass: () => class {},
        switchToWs: () => ({ getClient: () => ({ handshake: { headers } }) }),
      }) as unknown as ExecutionContext;

    expect(
      guard().canActivate(
        socketContext({ host: '127.0.0.1:3001', authorization: `Bearer ${TOKEN}` }),
      ),
    ).toBe(true);
    expect(() => guard().canActivate(socketContext({ host: '127.0.0.1:3001' }))).toThrow(
      WsException,
    );
  });

  it('falls back to the raw request when a client exposes no handshake', () => {
    const context = {
      getType: () => 'ws',
      getHandler: () => plainHandler,
      getClass: () => class {},
      switchToWs: () => ({
        getClient: () => ({
          request: { headers: { host: 'localhost', origin: 'tauri://localhost' } },
        }),
      }),
    } as unknown as ExecutionContext;

    expect(guard().canActivate(context)).toBe(true);
  });
});
