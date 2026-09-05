import type { Embeddings } from '@langchain/core/embeddings';
import { cosineSimilarity } from './embeddings.js';
import type { CodeChunk, ScoredChunk, SearchOptions, VectorStore } from './vector-store.types.js';

interface StoredChunk extends CodeChunk {
  readonly vector: number[];
}

/**
 * Zero-dependency brute-force store. Used for tests and as the fallback when no
 * Chroma server is reachable, so the app is always usable out of the box.
 */
export class MemoryVectorStore implements VectorStore {
  readonly kind = 'memory' as const;

  private readonly chunks = new Map<string, StoredChunk>();

  constructor(private readonly embeddings: Embeddings) {}

  async upsert(chunks: readonly CodeChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const vectors = await this.embeddings.embedDocuments(chunks.map((chunk) => chunk.text));
    chunks.forEach((chunk, index) => {
      const vector = vectors[index];
      // An embedder that returns fewer vectors than documents is a contract
      // violation; dropping the chunk beats storing an undefined vector.
      if (vector !== undefined) this.chunks.set(chunk.id, { ...chunk, vector });
    });
  }

  async search(query: string, options: SearchOptions = {}): Promise<ScoredChunk[]> {
    const limit = options.limit ?? 5;
    if (this.chunks.size === 0 || limit <= 0) return [];

    const queryVector = await this.embeddings.embedQuery(query);
    const candidates: ScoredChunk[] = [];
    for (const { vector, ...chunk } of this.chunks.values()) {
      if (options.root && chunk.metadata.root !== options.root) continue;
      candidates.push({ ...chunk, score: cosineSimilarity(queryVector, vector) });
    }

    return candidates.toSorted((a, b) => b.score - a.score).slice(0, limit);
  }

  async deleteByRoot(root: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.metadata.root === root) this.chunks.delete(id);
    }
  }

  async deleteByPaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    const targets = new Set(paths);
    for (const [id, chunk] of this.chunks) {
      if (targets.has(chunk.metadata.path)) this.chunks.delete(id);
    }
  }

  async count(): Promise<number> {
    return this.chunks.size;
  }
}
