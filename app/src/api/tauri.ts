/**
 * Tauri capabilities, guarded so the same bundle runs in a plain browser
 * (`npm run dev`) and inside the desktop shell.
 */

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Opens the OS folder picker. Returns `null` when the user cancels, and
 * `undefined` when there is no native dialog available (browser mode) so the
 * caller can fall back to a manual path entry.
 */
export const pickFolder = async (): Promise<string | null | undefined> => {
  if (!isTauri()) return undefined;

  // Imported lazily: the plugin touches Tauri internals that do not exist in a
  // browser, and a static import would break `vite dev`.
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false, title: 'Choose a folder to index' });
  return typeof selected === 'string' ? selected : null;
};

export interface AppInfo {
  version: string;
  platform: string;
  backendUrl: string;
}

/**
 * Calls the `app_info` Tauri command. Returns `undefined` in browser mode, which
 * is how the sidebar decides whether to show the build footer.
 */
export const getAppInfo = async (): Promise<AppInfo | undefined> => {
  if (!isTauri()) return undefined;

  const { invoke } = await import('@tauri-apps/api/core');
  const info = await invoke<{ version: string; platform: string; backend_url: string }>('app_info');
  return { version: info.version, platform: info.platform, backendUrl: info.backend_url };
};
