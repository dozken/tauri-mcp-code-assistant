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
import { METADATA_STORE, type MetadataStore } from '../common/metadata-store.js';
import { resolveWithinRoots } from '../common/path-guard.js';
import { VectorStoreService } from '../vector/vector-store.service.js';
import type { CodeChunk } from '../vector/vector-store.types.js';
import { chunkText, detectLanguage } from './chunker.js';
import { walkFiles, type WalkedFile } from './file-walker.js';
import type {
  IndexJob,
  IndexProgressEvent,
  IndexStatus,
  IndexedRoot,
} from './indexing.types.js';

const PROGRESS_INTERVAL_MS = 100;
const NUL_BYTE = String.fromCharCode(0);

@Injectable()
export class IndexingService implements OnModuleInit {
  private readonly progressSubject = new Subject<IndexProgressEvent>();
  private readonly roots = new Map<string, IndexedRoot>();
  private activeJob: IndexJob | null = null;
  private abortController: AbortController | null = null;
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
    if (this.activeJob) {
      throw new ConflictException(`Indexing already running for ${this.activeJob.root}`);
    }

    const root = await this.resolveRoot(inputPath);
    const job: IndexJob = {
      id: randomUUID(),
      root,
      state: 'running',
      filesDiscovered: 0,
      filesIndexed: 0,
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
  }

  cancel(): boolean {
    if (!this.activeJob || !this.abortController) return false;
    this.abortController.abort();
    return true;
  }

  async getStatus(): Promise<IndexStatus> {
    return {
      activeJob: this.activeJob,
      roots: [...this.roots.values()].sort((a, b) => a.path.localeCompare(b.path)),
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

    if (!this.roots.has(root)) {
      throw new NotFoundException(`Not an indexed folder: ${root}`);
    }
    await this.vectorStore.deleteByRoot(root);
    await this.metadata.removeRoot(root);
    this.roots.delete(root);
  }

  private async run(job: IndexJob, signal: AbortSignal): Promise<void> {
    try {
      // Re-indexing replaces the folder wholesale; without this, chunks for files
      // that were deleted or renamed would linger forever.
      await this.vectorStore.deleteByRoot(job.root);

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

      await this.processFiles(job, files, signal);

      job.state = signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, root: job.root }, 'Indexing failed');
    } finally {
      job.finishedAt = new Date().toISOString();
      job.currentFile = undefined;

      if (job.state === 'completed' || job.state === 'cancelled') {
        const record = {
          path: job.root,
          fileCount: job.filesIndexed,
          chunkCount: job.chunksIndexed,
          lastIndexedAt: job.finishedAt,
          store: this.vectorStore.kind,
        };
        this.roots.set(job.root, { ...record, stale: false });
        await this.metadata.upsertRoot(record).catch((error: unknown) => {
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
    signal: AbortSignal,
  ): Promise<void> {
    let cursor = 0;
    const workers = Math.max(1, Math.min(this.config.indexing.concurrency, files.length));

    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = cursor;
        cursor += 1;
        if (index >= files.length) return;

        const file = files[index];
        job.currentFile = file.relativePath;
        try {
          const chunks = await this.chunkFile(job.root, file);
          if (chunks.length > 0) {
            await this.vectorStore.upsert(chunks);
            job.chunksIndexed += chunks.length;
          }
        } catch (error) {
          // One unreadable or undecodable file must not abort a whole repository.
          this.logger.warn({ err: error, file: file.absolutePath }, 'Skipped file');
        }
        job.filesIndexed += 1;
        this.emit(job);
      }
    };

    await Promise.all(Array.from({ length: workers }, worker));
  }

  private async chunkFile(root: string, file: WalkedFile): Promise<CodeChunk[]> {
    const content = await readFile(file.absolutePath, 'utf8');
    // A NUL byte means we were handed a binary file that slipped past the
    // extension filter; embedding it would only add noise.
    if (content.includes(NUL_BYTE)) return [];

    const language = detectLanguage(file.relativePath);
    const indexedAt = new Date().toISOString();

    return chunkText(content, {
      chunkSize: this.config.indexing.chunkSize,
      chunkOverlap: this.config.indexing.chunkOverlap,
    }).map((chunk) => ({
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

    this.progressSubject.next({
      jobId: job.id,
      root: job.root,
      state: job.state,
      filesDiscovered: job.filesDiscovered,
      filesIndexed: job.filesIndexed,
      chunksIndexed: job.chunksIndexed,
      currentFile: job.currentFile,
      error: job.error,
      percent:
        job.filesDiscovered === 0
          ? 0
          : Math.round((job.filesIndexed / job.filesDiscovered) * 100),
    });
  }
}
