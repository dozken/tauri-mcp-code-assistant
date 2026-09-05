import type { Embeddings } from '@langchain/core/embeddings';
import { OpenAIEmbeddings } from '@langchain/openai';
import type { AppConfig } from '../config/configuration.js';
import type { Context } from '../plugins/context.js';
import { HashingEmbeddings } from './embeddings.js';
import type { VectorStore } from './vector-store.types.js';

export const createEmbeddings = (config: AppConfig): Embeddings => {
  if (config.embeddings.provider === 'openai') {
    if (!config.llm.apiKey) {
      throw new Error('EMBEDDINGS_PROVIDER=openai requires OPENAI_API_KEY');
    }
    return new OpenAIEmbeddings({
      apiKey: config.llm.apiKey,
      model: config.embeddings.model,
      dimensions: config.embeddings.dimensions,
      configuration: config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : undefined,
    });
  }
  return new HashingEmbeddings({ dimensions: config.embeddings.dimensions });
};

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
