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
      this.chunks.set(chunk.id, { ...chunk, vector: vectors[index] });
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

    return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async deleteByRoot(root: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.metadata.root === root) this.chunks.delete(id);
    }
  }

  async count(): Promise<number> {
    return this.chunks.size;
  }
}
