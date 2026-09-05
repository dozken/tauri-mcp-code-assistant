import { EventEmitter } from 'node:events';
import type * as NodeFs from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * An ESM namespace is not configurable, so `fs.watch` cannot be spied on — it has
 * to be replaced at module level. Left as the real thing unless a test sets
 * `stub.current`, so every other case still watches a real directory.
 */
const stub = vi.hoisted(() => ({ current: undefined as (() => FSWatcher) | undefined }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) =>
      stub.current === undefined ? actual.watch(...args) : stub.current(),
  };
});
import type { AppConfig } from '../config/configuration.js';
import { recordingLogger, silentLogger, testConfig } from '../../test/helpers.js';
import type { PinoLogger } from 'nestjs-pino';
import { IndexWatcherService, isInteresting } from './index-watcher.service.js';
import type { IndexingService } from './indexing.service.js';

const DEBOUNCE_MS = 30;
/** Long enough for the OS to deliver an inotify event and the debounce to fire. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, DEBOUNCE_MS * 6));

const build = async (
  overrides: {
    watch?: boolean;
    roots?: string[];
    startIndexing?: () => Promise<unknown>;
    logger?: PinoLogger;
  } = {},
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

  const watcher = new IndexWatcherService(config, indexing, overrides.logger ?? silentLogger());
  return { watcher, root, startIndexing };
};

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const done of cleanup.splice(0)) await done();
  stub.current = undefined;
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

  it('re-indexes a change in a subdirectory, not only at the top level', async () => {
    // Watching only the top level would miss `src/`, which is where the code is.
    const { watcher, root, startIndexing } = await build();
    cleanup.push(async () => {
      watcher.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    });
    await mkdir(join(root, 'src', 'deep'), { recursive: true });

    watcher.onModuleInit();
    await writeFile(join(root, 'src', 'deep', 'a.ts'), 'export const a = 1;');
    await settle();

    expect(startIndexing).toHaveBeenCalledWith(root);
  });

  it('carries on indexing on demand when the platform cannot watch', async () => {
    // Recursive watching is unsupported on some platforms and filesystems. A
    // missing feature must not stop the app from starting.
    const logger = recordingLogger();
    const { watcher, root, startIndexing } = await build({ logger });
    cleanup.push(async () => {
      watcher.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    });
    stub.current = () => {
      throw new Error('ENOSYS: recursive watching is not supported');
    };

    expect(() => {
      watcher.onModuleInit();
    }).not.toThrow();
    expect(watcher.isWatching(root)).toBe(false);
    expect(startIndexing).not.toHaveBeenCalled();
    // Silence would leave the user wondering why nothing re-indexes; this is the
    // line they grep for.
    expect(logger.lines.map((line) => line.message)).toContain('Could not watch this folder');
  });

  it('gives up on a folder whose watch errors, rather than dying with it', async () => {
    // A watched folder can be unmounted or deleted underneath us. Unhandled, that
    // error takes the whole process down.
    const { watcher, root } = await build();
    cleanup.push(async () => {
      watcher.onModuleDestroy();
      await rm(root, { recursive: true, force: true });
    });

    // `FSWatcher` is an EventEmitter and the code under test calls `.on`, so an
    // EventTarget would not stand in for it.
    // eslint-disable-next-line unicorn/prefer-event-target -- see above
    const fake = Object.assign(new EventEmitter(), { close: vi.fn() });
    stub.current = () => fake as unknown as FSWatcher;

    watcher.onModuleInit();
    expect(watcher.isWatching(root)).toBe(true);

    fake.emit('error', new Error('EPERM'));

    expect(watcher.isWatching(root)).toBe(false);
    expect(fake.close).toHaveBeenCalled();
  });

  it('refuses to start watching again once it has shut down', async () => {
    // A late `POST /index` can land between `onModuleDestroy` and the process
    // actually exiting, and must not open a handle nothing will ever close.
    const { watcher, root } = await build();
    cleanup.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    watcher.onModuleInit();
    watcher.onModuleDestroy();
    watcher.watchRoot(root);

    expect(watcher.isWatching(root)).toBe(false);
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
