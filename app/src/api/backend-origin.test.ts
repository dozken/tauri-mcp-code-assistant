import { describe, expect, it } from 'vitest';
import {
  browserPolicy,
  connectSources,
  desktopPolicy,
  DEFAULT_BACKEND_URL,
} from './backend-origin';
import { backendUrl, resolveBackendUrl } from './config';

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

  it('keeps the directives the app actually needs', () => {
    const csp = browserPolicy(DEFAULT_BACKEND_URL);

    // Emotion writes real <style> elements at runtime, so MUI cannot render at all
    // without `unsafe-inline`, and data: URIs are how the icons arrive.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
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

  it('is still confined to loopback', () => {
    // A wildcard port is not a wildcard host. Anything else on the machine, and
    // anything off it, is still refused.
    expect(desktopPolicy()).not.toContain('*://');
    expect(desktopPolicy()).not.toContain('localhost:*');
  });
});

describe('backendUrl', () => {
  it('is the configured default before anything asks the shell', () => {
    // The tests run without VITE_BACKEND_URL, so this also proves the fallback is
    // the same constant the CSP is generated from.
    expect(backendUrl()).toBe(DEFAULT_BACKEND_URL);
  });

  it('stays the configured default in a browser, which has no shell to ask', async () => {
    await resolveBackendUrl();

    expect(backendUrl()).toBe(DEFAULT_BACKEND_URL);
  });
});
