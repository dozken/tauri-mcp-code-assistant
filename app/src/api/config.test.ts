import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BACKEND_URL } from './backend-origin';
import type { AppInfo } from './tauri';
import type * as ConfigModule from './config';

const getAppInfo = vi.fn<() => Promise<AppInfo | undefined>>();

vi.mock('./tauri', () => ({ getAppInfo: () => getAppInfo() }));

/**
 * A fresh module for every test: the resolved URL is module state, so a test that
 * inherited it from the one before would pass whether or not the code under test
 * ever wrote to it.
 */
const loadConfig = async (): Promise<typeof ConfigModule> => {
  vi.resetModules();
  return import('./config');
};

describe('resolveBackendUrl', () => {
  beforeEach(() => {
    getAppInfo.mockReset();
  });

  it('adopts the port the desktop shell actually started the backend on', async () => {
    // The packaged app picks a free port at launch, so this is the only value that
    // reaches a real backend — the build-time default is whatever the developer's
    // machine happened to use, and in a packaged window it is simply wrong.
    getAppInfo.mockResolvedValue({
      version: '0.1.0',
      platform: 'linux',
      backendUrl: 'http://127.0.0.1:51763',
    });
    const { backendUrl, resolveBackendUrl } = await loadConfig();

    await expect(resolveBackendUrl()).resolves.toBe('http://127.0.0.1:51763');
    expect(backendUrl()).toBe('http://127.0.0.1:51763');
  });

  it('keeps the build-time URL in a browser, which has no shell to ask', async () => {
    getAppInfo.mockResolvedValue(undefined);
    const { backendUrl, resolveBackendUrl } = await loadConfig();

    await resolveBackendUrl();

    expect(backendUrl()).toBe(DEFAULT_BACKEND_URL);
  });

  it('falls back instead of leaving the app with nowhere to connect', async () => {
    // An older shell without the `app_info` command rejects rather than returning
    // nothing; the app should still come up against the default.
    getAppInfo.mockRejectedValue(new Error('app_info is not registered'));
    const { backendUrl, resolveBackendUrl } = await loadConfig();

    await expect(resolveBackendUrl()).resolves.toBe(DEFAULT_BACKEND_URL);
    expect(backendUrl()).toBe(DEFAULT_BACKEND_URL);
  });
});

describe('backendUrl', () => {
  it('is the configured default before anything asks the shell', async () => {
    // The tests run without VITE_BACKEND_URL, so this also proves the fallback is
    // the same constant the CSP is generated from.
    const { backendUrl } = await loadConfig();

    expect(backendUrl()).toBe(DEFAULT_BACKEND_URL);
  });
});
