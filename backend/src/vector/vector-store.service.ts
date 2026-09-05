import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import type { Embeddings } from '@langchain/core/embeddings';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { EMBEDDINGS } from './vector.tokens.js';
import { createVectorStore } from './vector-store.factory.js';
import type { CodeChunk, ScoredChunk, SearchOptions, VectorStore } from './vector-store.types.js';

/**
 * Nest-facing facade over {@link VectorStore}. Resolution is lazy and memoised so
 * a slow or absent Chroma server never blocks application bootstrap.
 */
@Injectable()
export class VectorStoreService implements VectorStore {
  private store?: Promise<VectorStore>;
  private resolvedKind: 'chroma' | 'memory' = 'memory';

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(EMBEDDINGS) private readonly embeddings: Embeddings,
    @InjectPinoLogger(VectorStoreService.name) private readonly logger: PinoLogger,
  ) {}

  get kind(): 'chroma' | 'memory' {
    // Only meaningful after the first call; `memory` is the safe assumption.
    return this.resolvedKind;
  }

  private resolve(): Promise<VectorStore> {
    this.store ??= createVectorStore(this.config, this.embeddings, (reason) => {
      this.logger.warn(
        { chromaUrl: this.config.chroma.url, reason },
        'Chroma unreachable, falling back to the in-memory vector store',
      );
    })
      .then((store) => {
        this.resolvedKind = store.kind;
        // Stryker disable next-line all: log payload — see docs/testing.md#logging
        this.logger.info({ store: store.kind }, 'Vector store ready');
        return store;
      })
      .catch((error: unknown) => {
        this.store = undefined;
        throw error;
      });
    return this.store;
  }

  async upsert(chunks: readonly CodeChunk[]): Promise<void> {
    return (await this.resolve()).upsert(chunks);
  }

  async search(query: string, options?: SearchOptions): Promise<ScoredChunk[]> {
    return (await this.resolve()).search(query, options);
  }

  async deleteByRoot(root: string): Promise<void> {
    return (await this.resolve()).deleteByRoot(root);
  }

  async deleteByPaths(paths: readonly string[]): Promise<void> {
    return (await this.resolve()).deleteByPaths(paths);
  }

  async count(): Promise<number> {
    return (await this.resolve()).count();
  }
}
