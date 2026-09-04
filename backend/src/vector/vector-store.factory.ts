import type { Embeddings } from '@langchain/core/embeddings';
import { OpenAIEmbeddings } from '@langchain/openai';
import type { AppConfig } from '../config/configuration.js';
import { HashingEmbeddings } from './embeddings.js';
import { ChromaVectorStore } from './chroma-vector-store.js';
import { MemoryVectorStore } from './memory-vector-store.js';
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
 */
export const createVectorStore = async (
  config: AppConfig,
  embeddings: Embeddings,
  onFallback?: (reason: string) => void,
): Promise<VectorStore> => {
  if (!config.chroma.enabled) {
    return new MemoryVectorStore(embeddings);
  }

  const chroma = new ChromaVectorStore(embeddings, {
    url: config.chroma.url,
    collection: config.chroma.collection,
  });

  try {
    await chroma.healthCheck();
    return chroma;
  } catch (error) {
    onFallback?.(error instanceof Error ? error.message : String(error));
    return new MemoryVectorStore(embeddings);
  }
};
