import type { Embeddings } from '@langchain/core/embeddings';
import type { Plugin } from '../plugins/context.js';
import { ProviderRegistry } from '../plugins/registry.js';
import type { AppConfig } from '../config/configuration.js';
import { ChromaVectorStore } from './chroma-vector-store.js';
import { MemoryVectorStore } from './memory-vector-store.js';
import type { VectorStore } from './vector-store.types.js';

/** What every vector-store provider is handed. */
export interface VectorStoreOptions {
  readonly config: AppConfig;
  readonly embeddings: Embeddings;
}

/** Declared at registration, because it decides whether an index survives a restart. */
export interface VectorStoreTraits {
  /** False for anything whose chunks die with the process. */
  readonly persistent: boolean;
}

export type VectorStoreRegistry = ProviderRegistry<
  VectorStore,
  VectorStoreOptions,
  VectorStoreTraits
>;

declare module '../plugins/context.js' {
  interface Services {
    vectorStores: VectorStoreRegistry;
  }
}

/**
 * The two stores that ship with the app. A plugin adding `qdrant` registers here
 * and becomes selectable through `VECTOR_STORE` with no change to this file —
 * that is the test of whether the seam is real.
 */
export const vectorStorePlugin: Plugin = {
  name: 'vector-stores',
  apply: async (ctx) => {
    const registry: VectorStoreRegistry = new ProviderRegistry('vector store');

    registry.register('memory', ({ embeddings }) => new MemoryVectorStore(embeddings), {
      persistent: false,
    });

    registry.register(
      'chroma',
      async ({ config, embeddings }) => {
        const store = new ChromaVectorStore(embeddings, {
          url: config.chroma.url,
          collection: config.chroma.collection,
        });
        // Fails here rather than on first search, so the caller can fall back while
        // it still has somewhere to fall back to.
        await store.healthCheck();
        return store;
      },
      { persistent: true },
    );

    await ctx.provide('vectorStores', registry);
  },
};
