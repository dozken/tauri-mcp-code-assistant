import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const check = vi.fn<() => Promise<unknown>>();
const relaunch = vi.fn<() => Promise<void>>();

vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => check() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: () => relaunch() }));

const { checkForUpdate } = await import('./updates');

/** Presence of this global is how the Tauri webview identifies itself. */
const pretendTauri = (enabled: boolean): void => {
  if (enabled)
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
};

describe('checkForUpdate', () => {
  beforeEach(() => {
    check.mockReset();
    relaunch.mockReset();
    pretendTauri(true);
  });

  afterEach(() => {
    pretendTauri(false);
  });

  it('does not reach for the plugin in a browser', async () => {
    pretendTauri(false);

    await expect(checkForUpdate()).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('offers nothing when the app is already current', async () => {
    check.mockResolvedValue(null);

    await expect(checkForUpdate()).resolves.toBeUndefined();
  });

  it('offers nothing when the updater was never enabled', async () => {
    // A desktop build with no `plugins.updater` does not register the plugin, so
    // this is a rejection rather than an answer — and it must read as "nothing to
    // install", not as a failure to put in front of the user.
    check.mockRejectedValue(new Error('updater not found'));

    await expect(checkForUpdate()).resolves.toBeUndefined();
  });

  it('reports the version and notes it was offered', async () => {
    check.mockResolvedValue({
      version: '0.2.0',
      body: 'Faster indexing.',
      downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    });

    await expect(checkForUpdate()).resolves.toMatchObject({
      version: '0.2.0',
      notes: 'Faster indexing.',
    });
  });

  it('installs and then restarts, because installing alone changes nothing visible', async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    check.mockResolvedValue({ version: '0.2.0', downloadAndInstall });

    const update = await checkForUpdate();
    await update?.install();

    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('does not restart into a version that failed to install', async () => {
    check.mockResolvedValue({
      version: '0.2.0',
      downloadAndInstall: vi.fn().mockRejectedValue(new Error('checksum mismatch')),
    });

    const update = await checkForUpdate();

    await expect(update?.install()).rejects.toThrow(/checksum/);
    expect(relaunch).not.toHaveBeenCalled();
  });
});
