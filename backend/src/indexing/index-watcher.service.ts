import { watch, type FSWatcher } from 'node:fs';
import { extname, sep } from 'node:path';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { DEFAULT_EXTENSIONS, DEFAULT_IGNORED_DIRECTORIES } from './file-walker.js';
import { IndexingService } from './indexing.service.js';

/**
 * Keeps an index honest while the user edits.
 *
 * An index is a snapshot, and a stale snapshot is worse than an empty one: it
 * answers confidently about code that no longer exists. Re-indexing is already
 * incremental, so a change only costs the files that actually changed — which is
 * what makes watching affordable at all.
 *
 * Deliberately not clever. `fs.watch` is coalesced by a quiet period rather than
 * per-file bookkeeping: editors write temp files, rename over the original and
 * touch three paths for one save, and the incremental indexer already decides
 * what is really new by hash.
 */
@Injectable()
export class IndexWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly indexing: IndexingService,
    @InjectPinoLogger(IndexWatcherService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    if (!this.config.indexing.watch) return;
    for (const root of this.indexing.indexedRoots()) this.watchRoot(root);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  /** Whether this root is being watched — the only thing `/status` could report. */
  isWatching(root: string): boolean {
    return this.watchers.has(root);
  }

  /**
   * Starts watching a root that has just been indexed. Idempotent, because
   * re-indexing an existing root is the common case and must not stack watchers.
   */
  watchRoot(root: string): void {
    if (!this.config.indexing.watch || this.stopped || this.watchers.has(root)) return;

    try {
      const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
        if (typeof filename === 'string' && isInteresting(filename)) this.schedule(root);
      });
      // A watch on a directory that later disappears surfaces here rather than as
      // an uncaught exception that takes the process with it.
      watcher.on('error', (error) => {
        this.logger.warn({ err: error, root }, 'Stopped watching a folder');
        this.unwatchRoot(root);
      });
      this.watchers.set(root, watcher);
      this.logger.info({ root }, 'Watching for changes');
    } catch (error) {
      // Recursive watching is unsupported on some platforms and filesystems, and
      // a missing feature must not stop the app from indexing on demand.
      this.logger.warn({ err: error, root }, 'Could not watch this folder');
    }
  }

  unwatchRoot(root: string): void {
    const timer = this.timers.get(root);
    if (timer) clearTimeout(timer);
    this.timers.delete(root);
    this.watchers.get(root)?.close();
    this.watchers.delete(root);
  }

  /** Restarts the quiet period; a burst of saves costs one re-index, not twenty. */
  private schedule(root: string): void {
    const existing = this.timers.get(root);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(root);
      void this.reindex(root);
    }, this.config.indexing.watchDebounceMs);
    // The watcher must never be the reason a `docker stop` hangs.
    timer.unref();
    this.timers.set(root, timer);
  }

  private async reindex(root: string): Promise<void> {
    if (this.stopped || !this.watchers.has(root)) return;

    try {
      await this.indexing.startIndexing(root);
    } catch (error) {
      // A job is already running — very likely this same root. Wait it out rather
      // than dropping the change, or an edit made mid-index is never picked up.
      this.schedule(root);
      this.logger.debug({ err: error, root }, 'Re-index deferred; another job is running');
    }
  }
}

/**
 * Cheap filter for a raw watch event, so a `node_modules` install does not wake
 * the indexer once per file. The walk applies the real rules; this only avoids
 * scheduling work that would find nothing to do.
 */
export const isInteresting = (filename: string): boolean => {
  const segments = filename.split(sep);
  if (segments.some((segment) => DEFAULT_IGNORED_DIRECTORIES.has(segment))) return false;

  const last = segments.at(-1) ?? '';
  // A rename event can name a directory, which has no extension and may well
  // contain files worth indexing.
  const extension = extname(last).slice(1).toLowerCase();
  return extension === '' || DEFAULT_EXTENSIONS.has(extension);
};
