import { describe, expect, it } from 'vitest';
import { parseChromaUrl } from './chroma-vector-store.js';
import { fnv1a } from './embeddings.js';

describe('parseChromaUrl', () => {
  it.each([
    ['http://localhost:8000', { host: 'localhost', port: 8000, ssl: false }],
    ['http://127.0.0.1:9000', { host: '127.0.0.1', port: 9000, ssl: false }],
    // No port: 8000 over http, 443 over https — chromadb 3 takes host/port/ssl,
    // not a URL, so this mapping is the whole contract.
    ['http://chroma.internal', { host: 'chroma.internal', port: 8000, ssl: false }],
    ['https://chroma.example.com', { host: 'chroma.example.com', port: 443, ssl: true }],
    ['https://chroma.example.com:8443', { host: 'chroma.example.com', port: 8443, ssl: true }],
  ])('maps %s', (url, expected) => {
    expect(parseChromaUrl(url)).toEqual(expected);
  });

  it.each(['localhost:8000', 'not a url', 'ftp://chroma:8000', ''])(
    'rejects %s instead of connecting to nowhere',
    (url) => {
      // `new URL('localhost:8000')` succeeds — protocol `localhost:`, empty host.
      expect(() => parseChromaUrl(url)).toThrow(/CHROMA_URL/);
    },
  );
});

describe('fnv1a', () => {
  it('is deterministic, so a persisted index stays valid across restarts', () => {
    expect(fnv1a('authenticate')).toBe(fnv1a('authenticate'));
  });

  it('produces an unsigned 32-bit value', () => {
    for (const input of ['', 'a', 'authenticate', '🎉 unicode']) {
      const hash = fnv1a(input);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xff_ff_ff_ff);
    }
  });

  it('separates similar inputs', () => {
    expect(fnv1a('user')).not.toBe(fnv1a('users'));
    expect(fnv1a('ab')).not.toBe(fnv1a('ba'));
  });

  it('changes with the seed, which is what makes the sign bit independent', () => {
    expect(fnv1a('token')).not.toBe(fnv1a('token', 0x9d_c5_81_1c));
  });
});
