import { randomUUID, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Subject, type Observable } from 'rxjs';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import {
  METADATA_STORE,
  type IndexedFileRecord,
  type MetadataStore,
} from '../common/metadata-store.js';
import { resolveWithinRoots } from '../security/path-guard.js';
import { VectorStoreService } from '../vector/vector-store.service.js';
import type { CodeChunk } from '../vector/vector-store.types.js';
import { chunkText, detectLanguage } from './chunker.js';
import { walkFiles, type WalkedFile } from './file-walker.js';
import { toProgressEvent } from './progress.js';
import type {
  IndexJob,
  IndexProgressEvent,
  IndexStatus,
  IndexedRoot,
} from '@ai-code-companion/contracts';

const PROGRESS_INTERVAL_MS = 100;
// eslint-disable-next-line unicorn/prefer-code-point -- a NUL is a code unit, not a code point.
const NUL_BYTE = String.fromCharCode(0);

@Injectable()
export class IndexingService implements OnModuleInit {
  private readonly progressSubject = new Subject<IndexProgressEvent>();
  private readonly roots = new Map<string, IndexedRoot>();
  private activeJob: IndexJob | null = null;
  /**
   * Claimed synchronously, before the first `await`. The `activeJob` guard alone
   * is a time-of-check/time-of-use race: `resolveRoot` yields, so two POSTs
   * arriving together both saw `activeJob === null` and both started a job. The
   * second then overwrote `abortController`, leaving the first uncancellable and
   * `/status` reporting no active job while one was still writing.
   */
  private starting = false;
  private abortController: AbortController | null = null;
  /** Roots deleted mid-run, so a finishing job cannot resurrect them. */
  private readonly removedDuringRun = new Set<string>();
  private lastEmit = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METADATA_STORE) private readonly metadata: MetadataStore,
    private readonly vectorStore: VectorStoreService,
    @InjectPinoLogger(IndexingService.name) private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const record of await this.metadata.listRoots()) {
      this.roots.set(record.path, {
        path: record.path,
        fileCount: record.fileCount,
        chunkCount: record.chunkCount,
        lastIndexedAt: record.lastIndexedAt,
        // Chunks written to the in-memory store died with the previous process.
        stale: record.store !== 'chroma',
      });
    }
    // Stryker disable next-line all: log payload — see docs/testing.md#logging
    this.logger.info({ roots: this.roots.size }, 'Restored indexed roots');
  }

  get progress(): Observable<IndexProgressEvent> {
    return this.progressSubject.asObservable();
  }

  /**
   * Resolves and authorises a user-supplied folder. The backend binds to loopback,
   * but any local process can still reach it, so indexing is confined to the
   * configured allow-list.
   */
  resolveRoot(inputPath: string): Promise<string> {
    return resolveWithinRoots(inputPath, this.config.indexing.allowedRoots, 'directory');
  }

  async startIndexing(inputPath: string): Promise<IndexJob> {
    if (this.activeJob ?? this.starting) {
      throw new ConflictException(
        `Indexing already running for ${this.activeJob?.root ?? 'another folder'}`,
      );
    }
    this.starting = true;

    try {
      const root = await this.resolveRoot(inputPath);
      const job: IndexJob = {
        id: randomUUID(),
        root,
        state: 'running',
        filesDiscovered: 0,
        filesIndexed: 0,
        filesSkipped: 0,
        chunksIndexed: 0,
        startedAt: new Date().toISOString(),
      };

      this.activeJob = job;
      this.abortController = new AbortController();
      this.emit(job, true);

      // Deliberately not awaited: POST /index returns as soon as the job is accepted
      // and the client follows progress over Socket.IO.
      void this.run(job, this.abortController.signal);
      return job;
    } finally {
      // Released only after `activeJob` is set, so the slot is never briefly free.
      this.starting = false;
    }
  }

  cancel(): boolean {
    if (!this.activeJob || !this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  async getStatus(): Promise<IndexStatus> {
    return {
      activeJob: this.activeJob === null ? null : toProgressEvent(this.activeJob),
      roots: [...this.roots.values()].toSorted((a, b) => a.path.localeCompare(b.path)),
      vectorStore: this.vectorStore.kind,
      metadataStore: this.metadata.kind,
      totalChunks: await this.vectorStore.count().catch(() => 0),
    };
  }

  async removeRoot(inputPath: string): Promise<void> {
    // Roots are keyed by their real path. Resolve symlinks to match, but fall back
    // to the literal path so a folder that has since been deleted from disk can
    // still be removed from the index.
    const candidate = resolve(inputPath);
    const root = this.roots.has(candidate)
      ? candidate
      : await realpath(candidate).catch(() => candidate);

    // A folder being indexed for the first time is not in `roots` yet, but it is
    // very much removable: without this the delete failed as "not indexed" and the
    // folder then appeared anyway when the job finished.
    const indexing = this.activeJob?.root === root;
    if (!this.roots.has(root) && !indexing) {
      throw new NotFoundException(`Not an indexed folder: ${root}`);
    }
    // A job still writing to this root would re-create the record in its `finally`.
    if (indexing) {
      this.removedDuringRun.add(root);
      this.cancel();
    }
    await this.vectorStore.deleteByRoot(root);
    await this.metadata.removeRoot(root);
    this.roots.delete(root);
  }

  private async run(job: IndexJob, signal: AbortSignal): Promise<void> {
    try {
      // Per-file state is only worth anything while the chunks it describes still
      // exist. A `stale` root means they do not: the previous run wrote to a
      // non-persistent store and the process has restarted since. Trusting the
      // records then skips every file and leaves the index silently empty — a
      // folder reporting hundreds of indexed files and zero searchable chunks.
      const recorded = await this.metadata.listFiles(job.root);
      // Records are the only thing that makes those chunks addressable file by
      // file. With none — a first run, or a persist that failed and only warned —
      // there is nothing to diff against, and re-embedding without them would
      // strand the chunks of any file that shrank.
      const reusable = this.roots.get(job.root)?.stale === false && recorded.length > 0;
      const previous = reusable
        ? new Map(recorded.map((record) => [record.path, record]))
        : new Map<string, IndexedFileRecord>();

      if (!reusable) {
        await this.vectorStore.deleteByRoot(job.root);
        await this.metadata.removeFiles(recorded.map((record) => record.path));
      }

      const files: WalkedFile[] = [];
      for await (const file of walkFiles(job.root, {
        maxFileBytes: this.config.indexing.maxFileBytes,
      })) {
        if (signal.aborted) break;
        files.push(file);
        job.filesDiscovered = files.length;
        this.emit(job);
      }
      this.emit(job, true);

      await this.processFiles(job, files, previous, signal);

      // Files still in `previous` were not seen by the walk: deleted, renamed, or
      // newly ignored. Their chunks would otherwise answer queries forever.
      if (!signal.aborted) await this.forgetMissing(job.root, previous);

      job.state = signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      // Stryker disable next-line all: log payload — see docs/testing.md#logging
      this.logger.error({ err: error, root: job.root }, 'Indexing failed');
    } finally {
      job.finishedAt = new Date().toISOString();
      job.currentFile = undefined;

      const resurrects = this.removedDuringRun.delete(job.root);
      if (!resurrects && (job.state === 'completed' || job.state === 'cancelled')) {
        const record = {
          path: job.root,
          fileCount: job.filesIndexed,
          chunkCount: job.chunksIndexed,
          lastIndexedAt: job.finishedAt,
          store: this.vectorStore.kind,
        };
        this.roots.set(job.root, { ...record, stale: false });
        await this.metadata.upsertRoot(record).catch((error: unknown) => {
          // Stryker disable next-line all: log payload — see docs/testing.md#logging
          this.logger.warn({ err: error }, 'Could not persist indexed root');
        });
      }

      this.activeJob = null;
      this.abortController = null;
      this.emit(job, true);
      this.logger.info(
        { root: job.root, state: job.state, files: job.filesIndexed, chunks: job.chunksIndexed },
        'Indexing finished',
      );
    }
  }

  private async processFiles(
    job: IndexJob,
    files: readonly WalkedFile[],
    previous: Map<string, IndexedFileRecord>,
    signal: AbortSignal,
  ): Promise<void> {
    let cursor = 0;
    const workers = Math.max(1, Math.min(this.config.indexing.concurrency, files.length));
    const seen: IndexedFileRecord[] = [];

    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const file = files[cursor];
        cursor += 1;
        if (file === undefined) return;

        job.currentFile = file.relativePath;
        try {
          const record = await this.indexOne(job, file, previous.get(file.absolutePath));
          seen.push(record);
          previous.delete(file.absolutePath);
        } catch (error) {
          // One unreadable or undecodable file must not abort a whole repository.
          // Stryker disable next-line all: log payload — see docs/testing.md#logging
          this.logger.warn({ err: error, file: file.absolutePath }, 'Skipped file');
          // Not recorded as seen, so the next run retries it rather than treating
          // a transient read failure as a deletion.
          previous.delete(file.absolutePath);
        }
        job.filesIndexed += 1;
        this.emit(job);
      }
    };

    await Promise.all(Array.from({ length: workers }, worker));
    await this.metadata.upsertFiles(seen).catch((error: unknown) => {
      // Stryker disable next-line all: log payload — see docs/testing.md#logging
      this.logger.warn({ err: error }, 'Could not persist per-file index state');
    });
  }

  /**
   * Indexes one file, or proves it does not need indexing.
   *
   * Two escalating comparisons. Matching size and mtime means the file can be
   * skipped without being opened at all, which is where most of the saving is on
   * a large repository. When they differ the content is hashed, because mtime
   * lies routinely — a fresh clone, a checkout, a `touch` — and re-embedding a
   * file whose bytes never changed is the expensive mistake.
   */
  private async indexOne(
    job: IndexJob,
    file: WalkedFile,
    previous: IndexedFileRecord | undefined,
  ): Promise<IndexedFileRecord> {
    const { mtimeMs } = file;
    if (previous?.size === file.size && previous.mtimeMs === mtimeMs) {
      job.filesSkipped += 1;
      job.chunksIndexed += previous.chunkCount;
      return previous;
    }

    const content = await readFile(file.absolutePath, 'utf8');
    const contentHash = createHash('sha256').update(content).digest('hex');

    if (previous?.contentHash === contentHash) {
      job.filesSkipped += 1;
      job.chunksIndexed += previous.chunkCount;
      // The bytes are the same but the timestamp moved; record it so the cheap
      // comparison succeeds next time.
      return { ...previous, mtimeMs };
    }

    const chunks = this.chunkContent(job.root, file, content);
    // Replace rather than merge: a file that shrank leaves orphaned chunks whose
    // ids no longer collide with anything the new content produces.
    if (previous) await this.vectorStore.deleteByPaths([file.absolutePath]);
    if (chunks.length > 0) await this.vectorStore.upsert(chunks);
    job.chunksIndexed += chunks.length;

    return {
      root: job.root,
      path: file.absolutePath,
      size: file.size,
      mtimeMs,
      contentHash,
      chunkCount: chunks.length,
    };
  }

  /** Drops the chunks and records of files the walk no longer finds. */
  private async forgetMissing(
    root: string,
    missing: ReadonlyMap<string, IndexedFileRecord>,
  ): Promise<void> {
    if (missing.size === 0) return;
    const paths = [...missing.keys()];
    await this.vectorStore.deleteByPaths(paths);
    await this.metadata.removeFiles(paths).catch((error: unknown) => {
      // Stryker disable next-line all: log payload — see docs/testing.md#logging
      this.logger.warn({ err: error, root }, 'Could not forget removed files');
    });
    // Stryker disable next-line all: log payload — see docs/testing.md#logging
    this.logger.info({ root, removed: paths.length }, 'Dropped chunks for missing files');
  }

  private chunkContent(root: string, file: WalkedFile, content: string): CodeChunk[] {
    // A NUL byte means we were handed a binary file that slipped past the
    // extension filter; embedding it would only add noise.
    if (content.includes(NUL_BYTE)) return [];

    const language = detectLanguage(file.relativePath);
    const indexedAt = new Date().toISOString();

    return chunkText(content, {
      chunkSize: this.config.indexing.chunkSize,
      chunkOverlap: this.config.indexing.chunkOverlap,
    }).map((chunk) => ({
      // eslint-disable-next-line sonarjs/hashing -- a content address, not a credential.
      id: createHash('sha1')
        .update(`${root}::${file.relativePath}::${chunk.startLine}-${chunk.endLine}`)
        .digest('hex'),
      text: chunk.text,
      metadata: {
        path: file.absolutePath,
        relativePath: file.relativePath,
        root,
        language,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        indexedAt,
      },
    }));
  }

  private emit(job: IndexJob, force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < PROGRESS_INTERVAL_MS) return;
    this.lastEmit = now;

    this.progressSubject.next(toProgressEvent(job));
  }
}
