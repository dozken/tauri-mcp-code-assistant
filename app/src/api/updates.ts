/**
 * Checking for, and applying, a signed update.
 *
 * Every call is guarded twice over, because there are two ways for the updater to
 * be absent and only one of them is a browser. A desktop build whose config has no
 * `plugins.updater` never registers the plugin — that is what keeps the feature
 * off until `npm run updater:enable` has been run — so `check()` there rejects with
 * a missing-plugin error rather than answering "no update". Both mean the same
 * thing to a caller: there is nothing to offer.
 */

import { isTauri } from './tauri';

export interface AvailableUpdate {
  readonly version: string;
  /** Release notes, when the manifest carries them. */
  readonly notes?: string;
  /** Downloads, installs, and restarts into the new version. */
  readonly install: () => Promise<void>;
}

/**
 * `undefined` when there is nothing to install — no updater, no network, or
 * already current. A failed check is not worth surfacing: it is background work
 * the user did not ask for, and an error about it is noise in front of the thing
 * they did.
 */
export const checkForUpdate = async (): Promise<AvailableUpdate | undefined> => {
  if (!isTauri()) return undefined;

  // Imported lazily so a browser build never loads a module that touches Tauri
  // internals, exactly as the folder picker does. The catch covers the import and
  // the check and nothing else: a failure of ours further down should surface, not
  // be swallowed as "no update".
  // Stryker disable all: `null` and `undefined` are both "nothing to install" to
  // the check below, so swapping one for the other is a change with no behaviour.
  const update = await import('@tauri-apps/plugin-updater')
    .then(({ check }) => check())
    .catch(() => null);
  // Stryker restore all
  if (!update) return undefined;

  return {
    version: update.version,
    notes: update.body,
    install: async () => {
      await update.downloadAndInstall();
      // Windows' installer stops the app itself; everywhere else this is what
      // makes "install" mean the running window, not the next launch.
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
};
