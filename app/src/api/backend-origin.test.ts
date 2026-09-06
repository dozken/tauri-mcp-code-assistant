import { describe, expect, it } from 'vitest';
import {
  browserPolicy,
  connectSources,
  desktopPolicy,
  DEFAULT_BACKEND_URL,
} from './backend-origin';

describe('connectSources', () => {
  it('allows the backend over HTTP and the same host over WebSocket', () => {
    // Socket.IO upgrades, so allowing only the HTTP origin gets the app as far as
    // the first poll and no further.
    expect(connectSources('http://127.0.0.1:3001')).toEqual([
      'http://127.0.0.1:3001',
      'ws://127.0.0.1:3001',
    ]);
  });

  it('follows the scheme up to TLS rather than mixing them', () => {
    expect(connectSources('https://api.example.test:8443')).toEqual([
      'https://api.example.test:8443',
      'wss://api.example.test:8443',
    ]);
  });

  it('keeps the host it was given, port and all', () => {
    expect(connectSources('http://localhost:4000')).toEqual([
      'http://localhost:4000',
      'ws://localhost:4000',
    ]);
  });

  it('drops a path, because a CSP source is an origin', () => {
    expect(connectSources('http://127.0.0.1:3001/api/')).toEqual([
      'http://127.0.0.1:3001',
      'ws://127.0.0.1:3001',
    ]);
  });
});

describe('browserPolicy', () => {
  it('names the configured backend and nothing else', () => {
    const csp = browserPolicy('http://127.0.0.1:4000');

    expect(csp).toContain("connect-src 'self' http://127.0.0.1:4000 ws://127.0.0.1:4000");
    // The old policy hard-coded 3001; a header that still allows it after the URL
    // moved is exactly the drift this exists to prevent.
    expect(csp).not.toContain('3001');
  });

  it('does not offer a browser the IPC origins it has no way to use', () => {
    expect(browserPolicy(DEFAULT_BACKEND_URL)).not.toContain('ipc:');
  });

  it('keeps the directives the app actually needs, separated', () => {
    // The whole string, not three `toContain`s: directives run together are one
    // malformed directive, and emotion writes real <style> elements at runtime so
    // MUI cannot render at all without `unsafe-inline`.
    expect(browserPolicy(DEFAULT_BACKEND_URL)).toBe(
      "default-src 'self'; " +
        "connect-src 'self' http://127.0.0.1:3001 ws://127.0.0.1:3001; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:",
    );
  });
});

describe('desktopPolicy', () => {
  it('allows loopback on any port, because the shell picks one at launch', () => {
    const csp = desktopPolicy();

    expect(csp).toContain('http://127.0.0.1:*');
    expect(csp).toContain('ws://127.0.0.1:*');
  });

  it('allows the IPC origins a Tauri window needs to reach its own shell', () => {
    expect(desktopPolicy()).toContain('ipc:');
    expect(desktopPolicy()).toContain('http://ipc.localhost');
  });

  it('is exactly what `tauri.conf.json` has to carry', () => {
    // Both policies are enforced in the desktop window and the build asserts they
    // match, so this string is a contract with a file rather than a restatement.
    expect(desktopPolicy()).toBe(
      "default-src 'self'; " +
        "connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* ws://127.0.0.1:*; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:",
    );
  });

  it('is still confined to loopback', () => {
    // A wildcard port is not a wildcard host. Anything else on the machine, and
    // anything off it, is still refused.
    expect(desktopPolicy()).not.toContain('*://');
    expect(desktopPolicy()).not.toContain('localhost:*');
  });
});
