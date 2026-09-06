import { describe, expect, it } from 'vitest';
import {
  connectSources,
  contentSecurityPolicy,
  DEFAULT_BACKEND_URL,
  TAURI_IPC_SOURCES,
} from './backend-origin';
import { BACKEND_URL } from './config';

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

describe('contentSecurityPolicy', () => {
  it('names the configured backend and nothing else', () => {
    const csp = contentSecurityPolicy('http://127.0.0.1:4000');

    expect(csp).toContain("connect-src 'self' http://127.0.0.1:4000 ws://127.0.0.1:4000");
    // The old policy hard-coded 3001; a header that still allows it after the URL
    // moved is exactly the drift this exists to prevent.
    expect(csp).not.toContain('3001');
  });

  it('includes the Tauri IPC origins only when asked for them', () => {
    expect(contentSecurityPolicy(DEFAULT_BACKEND_URL, TAURI_IPC_SOURCES)).toContain('ipc:');
    expect(contentSecurityPolicy(DEFAULT_BACKEND_URL)).not.toContain('ipc:');
  });

  it('keeps the directives the app actually needs', () => {
    const csp = contentSecurityPolicy(DEFAULT_BACKEND_URL);

    // Emotion writes real <style> elements at runtime, so MUI cannot render at all
    // without `unsafe-inline`, and data: URIs are how the icons arrive.
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data:");
  });
});

describe('BACKEND_URL', () => {
  it('is the default when nothing overrides it', () => {
    // The tests run without VITE_BACKEND_URL, so this also proves the fallback is
    // the same constant the CSP is generated from.
    expect(BACKEND_URL).toBe(DEFAULT_BACKEND_URL);
  });
});
