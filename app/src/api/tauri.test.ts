import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const open = vi.fn<(options: unknown) => Promise<unknown>>();
const invoke = vi.fn<(command: string) => Promise<unknown>>();

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: (options: unknown) => open(options) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string) => invoke(command) }));

const { getAppInfo, pickFolder } = await import('./tauri');

/** Presence of this global is how the Tauri webview identifies itself. */
const pretendTauri = (enabled: boolean): void => {
  if (enabled)
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
  else Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
};

describe('tauri bridge', () => {
  beforeEach(() => {
    open.mockReset();
    invoke.mockReset();
    pretendTauri(false);
  });

  afterEach(() => {
    pretendTauri(false);
  });

  describe('in a plain browser', () => {
    it('reports no native picker, so the caller can offer a text field', async () => {
      await expect(pickFolder()).resolves.toBeUndefined();
      expect(open).not.toHaveBeenCalled();
    });

    it('has no app info, so the build footer stays hidden', async () => {
      await expect(getAppInfo()).resolves.toBeUndefined();
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe('inside the desktop shell', () => {
    beforeEach(() => {
      pretendTauri(true);
    });

    it('opens a directory-only picker', async () => {
      open.mockResolvedValue('/home/dev/projects/api');

      await expect(pickFolder()).resolves.toBe('/home/dev/projects/api');
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ directory: true, multiple: false }),
      );
    });

    it('titles the picker, so the OS dialog is not an unlabelled window', async () => {
      open.mockResolvedValue('/home/dev/projects/api');

      await pickFolder();

      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/\S/) as unknown as string }),
      );
    });

    it('maps a cancelled picker to null, not undefined', async () => {
      open.mockResolvedValue(null);

      // `undefined` means "no picker available"; the two must not be confused.
      await expect(pickFolder()).resolves.toBeNull();
    });

    it('maps a multi-selection result to null rather than guessing', async () => {
      open.mockResolvedValue(['/a', '/b']);

      await expect(pickFolder()).resolves.toBeNull();
    });

    it('converts the snake_case command result to the app shape', async () => {
      invoke.mockResolvedValue({
        version: '0.1.0',
        platform: 'linux',
        backend_url: 'http://127.0.0.1:3001',
      });

      await expect(getAppInfo()).resolves.toEqual({
        version: '0.1.0',
        platform: 'linux',
        backendUrl: 'http://127.0.0.1:3001',
      });
      expect(invoke).toHaveBeenCalledWith('app_info');
    });
  });
});
