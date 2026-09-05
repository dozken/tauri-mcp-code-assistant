import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { silentLogger, testConfig } from '../../test/helpers.js';
import { IndexWatcherService, isInteresting } from './index-watcher.service.js';
import type { IndexingService } from './indexing.service.js';

const DEBOUNCE_MS = 30;
/** Long enough for the OS to deliver an inotify event and the debounce to fire. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, DEBOUNCE_MS * 6));

const build = async (
  overrides: { watch?: boolean; roots?: string[]; startIndexing?: () => Promise<unknown> } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), 'companion-watch-'));
  const base = testConfig();
  const config: AppConfig = {
    ...base,
    indexing: {
      ...base.indexing,
      allowedRoots: [root],
      watch: overrides.watch ?? true,
      watchDebounceMs: DEBOUNCE_MS,
    },
  };

  const startIndexing = vi.fn(overrides.startIndexing ?? (() => Promise.resolve({ root })));
  const indexing = {
    indexedRoots: () => overrides.roots ?? [root],
    startIndexing,
  } as unknown as IndexingService;

  const watcher = new IndexWatcherService(config, indexing, silentLogger());
  return { watcher, root, startIndexing };
};

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const done of cleanup.splice(0)) await done();
  vi.restoreAllMocks();
});

describe('IndexWatcherService', () => {
  it('re-indexes a root when one of its files changes', async () => {
    const { watcher, root, startIndexing } = await build();
    cleanup.push(async () => {
      watcher.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    });

    watcher.onModuleInit();
    await writeFile(join(root, 'a.ts'), 'export const a = 1;');
    await settle();

    expect(startIndexing).toHaveBeenCalledWith(root);
  });

  it('costs one re-index for a burst of saves, not one per file', async () => {
    // An editor writes a temp file, renames over the original and touches the
    // directory: three events for one save, and a formatter run is twenty.
    const { watcher, root, startIndexing } = await build();
    cleanup.push(async () => {
      watcher.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    });

    watcher.onModuleInit();
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(root, `f${String(index)}.ts`), 'export const a = 1;');
    }
    await settle();

    expect(startIndexing).toHaveBeenCalledOnce();
  });

  it('stays out of the way entirely when watching is off', async () => {
    const { watcher, root, startIndexing } = await build({ watch: false });
    cleanup.push(async () => {
      watcher.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    });

    watcher.onModuleInit();
    watcher.watchRoot(root);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;');
    await settle();

    expect(watcher.isWatching(root)).toBe(false);
    expect(startIndexing).not.toHaveBeenCalled();
  });

  it('ignores a change under a directory the walk would skip anyway', async () => {
    const { watcher, root, startIndexing } = await build();
    cleanup.push(async () => {
      watcher.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    });

    watcher.onModuleInit();
    await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;');
    await settle();

    expect(startIndexing).not.toHaveBeenCalled();
  });

  it('stops watching a root that has been removed', async () => {
    const { watcher, root, startIndexing } = await build();
    cleanup.push(async () => {
      watcher.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    });

    watcher.onModuleInit();
    expect(watcher.isWatching(root)).toBe(true);

    watcher.unwatchRoot(root);
    await writeFile(join(root, 'a.ts'), 'export const a = 1;');
    await settle();

    expect(watcher.isWatching(root)).toBe(false);
    expect(startIndexing).not.toHaveBeenCalled();
  });

  it('does not stack a second watcher on a root it already watches', async () => {
    const { watcher, root } = await build();
    cleanup.push(async () => {
      watcher.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    });

    watcher.watchRoot(root);
    watcher.watchRoot(root);

    // One handle, so `unwatchRoot` really stops it rather than leaking the other.
    watcher.unwatchRoot(root);
    expect(watcher.isWatching(root)).toBe(false);
  });

  it('waits out a job that is already running rather than dropping the change', async () => {
    // Re-indexing is exclusive. A change that arrives mid-index used to be lost,
    // which is precisely the change most likely to matter.
    let attempts = 0;
    const { watcher, root, startIndexing } = await build({
      startIndexing: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('Indexing already running'))
          : Promise.resolve({ root });
      },
    });
    cleanup.push(async () => {
      watcher.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    });

    watcher.onModuleInit();
    await writeFile(join(root, 'a.ts'), 'export const a = 1;');
    await vi.waitFor(() => {
      expect(startIndexing).toHaveBeenCalledTimes(2);
    }, 4000);
  });

  it('lets go of every handle and timer on shutdown', async () => {
    const { watcher, root, startIndexing } = await build();
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    watcher.onModuleInit();
    await writeFile(join(root, 'a.ts'), 'export const a = 1;');
    watcher.onModuleDestroy();
    await settle();

    expect(watcher.isWatching(root)).toBe(false);
    // The pending debounce must not fire into a service that is shutting down.
    expect(startIndexing).not.toHaveBeenCalled();
  });
});

describe('isInteresting', () => {
  it('accepts a source file', () => {
    expect(isInteresting('src/app.ts')).toBe(true);
  });

  it('rejects anything inside a directory the walk skips', () => {
    expect(isInteresting('node_modules/left-pad/index.js')).toBe(false);
    expect(isInteresting('dist/main.js')).toBe(false);
    expect(isInteresting('.git/HEAD')).toBe(false);
  });

  it('rejects a file the indexer would not read', () => {
    expect(isInteresting('assets/logo.png')).toBe(false);
    expect(isInteresting('notes.docx')).toBe(false);
  });

  it('accepts an extensionless path, because it may be a directory of sources', () => {
    // A rename event names the directory, and refusing it would miss every file
    // moved into the tree in one go.
    expect(isInteresting('src/newfolder')).toBe(true);
  });
});
