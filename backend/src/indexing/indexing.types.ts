export type IndexJobState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface IndexJob {
  readonly id: string;
  readonly root: string;
  state: IndexJobState;
  filesDiscovered: number;
  filesIndexed: number;
  chunksIndexed: number;
  currentFile?: string;
  readonly startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface IndexedRoot {
  readonly path: string;
  readonly fileCount: number;
  readonly chunkCount: number;
  readonly lastIndexedAt: string;
  /**
   * True when the chunks were written to a non-persistent store and the process
   * has restarted since — the folder is listed but no longer searchable.
   */
  readonly stale: boolean;
}

export interface IndexStatus {
  readonly activeJob: IndexJob | null;
  readonly roots: IndexedRoot[];
  readonly vectorStore: 'chroma' | 'memory';
  readonly metadataStore: 'sqlite' | 'memory';
  readonly totalChunks: number;
}

export interface IndexProgressEvent {
  readonly jobId: string;
  readonly root: string;
  readonly state: IndexJobState;
  readonly filesDiscovered: number;
  readonly filesIndexed: number;
  readonly chunksIndexed: number;
  readonly currentFile?: string;
  readonly error?: string;
  /** 0-100; 0 while discovery is still running. */
  readonly percent: number;
}
