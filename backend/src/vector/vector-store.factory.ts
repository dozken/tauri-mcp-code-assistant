import type { Embeddings } from '@langchain/core/embeddings';
import type { AppConfig } from '../config/configuration.js';
import type { Context } from '../plugins/context.js';
import type { VectorStore } from './vector-store.types.js';

/** A registry lookup, so an embedder can come from a plugin like everything else. */
export const createEmbeddings = async (plugins: Context, config: AppConfig): Promise<Embeddings> =>
  plugins.require('embeddings').create(config.embeddings.provider, { config });

/**
 * Prefers Chroma and degrades to the in-memory store when no server answers, so
 * `npm run dev` works with nothing else installed. The choice is made once at
 * startup rather than per call — silently flip-flopping between two stores with
 * different contents would be worse than a clear, logged decision.
 *
 * `VECTOR_STORE` names a registry kind instead, and then there is no fallback:
 * someone who asked for `qdrant` wants to hear that it is missing, not to be
 * quietly downgraded to a store that answers every query with nothing.
 */
export const selectVectorStore = async (
  plugins: Context,
  config: AppConfig,
  embeddings: Embeddings,
  onFallback?: (reason: string) => void,
): Promise<VectorStore> => {
  const registry = plugins.require('vectorStores');
  const options = { config, embeddings };

  if (config.vector.store !== 'auto') {
    return registry.create(config.vector.store, options);
  }

  if (!config.chroma.enabled) {
    return registry.create('memory', options);
  }

  try {
    return await registry.create('chroma', options);
  } catch (error) {
    onFallback?.(error instanceof Error ? error.message : String(error));
    return registry.create('memory', options);
  }
};
