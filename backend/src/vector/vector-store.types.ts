export interface CodeChunkMetadata {
  readonly path: string;
  readonly relativePath: string;
  readonly root: string;
  readonly language: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly indexedAt: string;
  [key: string]: string | number | boolean;
}

export interface CodeChunk {
  readonly id: string;
  readonly text: string;
  readonly metadata: CodeChunkMetadata;
}

export interface ScoredChunk extends CodeChunk {
  /** Cosine similarity in [-1, 1]; higher is closer. */
  readonly score: number;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly root?: string;
}

export interface VectorStore {
  /** The registry kind this store was created under, for `/status` and logs. */
  readonly kind: string;
  upsert(chunks: readonly CodeChunk[]): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<ScoredChunk[]>;
  /** Removes every chunk previously indexed under `root`. */
  deleteByRoot(root: string): Promise<void>;
  /**
   * Removes the chunks of specific files. Incremental re-indexing needs this:
   * `deleteByRoot` is all-or-nothing, so without it every re-index has to
   * re-embed the whole folder to drop one deleted file's chunks.
   */
  deleteByPaths(paths: readonly string[]): Promise<void>;
  count(): Promise<number>;
}
