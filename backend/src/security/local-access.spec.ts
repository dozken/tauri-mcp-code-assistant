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

  it('does not let an empty configured token turn a bare scheme into a credential', () => {
    // `Authorization: Bearer` — with or without a trailing space — presents no
    // credential, and must not parse to the empty string. `loadConfig` cannot
    // produce an empty token today, and this is what keeps the parse from quietly
    // depending on that: an empty secret would otherwise match an empty header.
    const empty = configWith({ token: '' });

    expect(allow({ host, authorization: 'Bearer' }, empty)).toBe(false);
    expect(allow({ host, authorization: 'Bearer ' }, empty)).toBe(false);
  });

  it('takes everything after the scheme as the token, spaces and all', () => {
    // One split on the first space, not on every space: the credential is whatever
    // follows the scheme, and silently truncating it at the next space would reject
    // a perfectly valid token.
    const spaced = configWith({ token: 'two words' });

    expect(allow({ host, authorization: 'Bearer two words' }, spaced)).toBe(true);
    expect(allow({ host, authorization: 'Bearer twowords' }, spaced)).toBe(false);
  });

  it('lets a client that sends no Host prove itself with the token', () => {
    // Rebinding needs a browser to put the attacker's hostname in `Host`; a request
    // with none cannot be that attack, and HTTP/1.0 clients still exist. It gets no
    // free pass either — without the token it is refused like anything else.
    expect(allow({ authorization: `Bearer ${TOKEN}` })).toBe(true);
    expect(allow({})).toBe(false);
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

  it('gives a refused caller no identity, however it asks for one', () => {
    // A request that was turned away must not earn its own budget by claiming an
    // id: the fuse is for callers we let in, and minting buckets is what a runaway
    // script would do if it could.
    expect(caller({ host, origin: 'https://evil.test', clientId: 'evil' })).toBe(ANONYMOUS_CALLER);
  });

  it('does not invent an origin bucket for a decision that carries none', () => {
    // `decideAccess` only says `via: 'origin'` when there is one, and this is what
    // keeps that true: the alternative is every such caller sharing one bucket
    // literally named `origin:undefined`.
    expect(callerOf({ host }, { allowed: true, via: 'origin' })).toBe(ANONYMOUS_CALLER);
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
