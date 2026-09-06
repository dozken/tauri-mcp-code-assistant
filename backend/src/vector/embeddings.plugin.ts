import { type Embeddings } from '@langchain/core/embeddings';
import { OllamaEmbeddings } from '@langchain/ollama';
import { OpenAIEmbeddings } from '@langchain/openai';
import type { Plugin } from '../plugins/context.js';
import { ProviderRegistry } from '../plugins/registry.js';
import type { AppConfig } from '../config/configuration.js';
import { HashingEmbeddings } from './embeddings.js';

export interface EmbeddingsOptions {
  readonly config: AppConfig;
}

export type EmbeddingsRegistry = ProviderRegistry<Embeddings, EmbeddingsOptions>;

declare module '../plugins/context.js' {
  interface Services {
    embeddings: EmbeddingsRegistry;
  }
}

/**
 * The embedders that ship with the app, through the same seam as the stores and
 * the models. Which matters more here than it looks: an index is only searchable
 * by vectors from the embedder that wrote it, so this is the single most
 * consequential thing a deployment picks — and until now it was the one choice a
 * plugin could not make.
 */
export const embeddingsPlugin: Plugin = {
  // Stryker disable next-line StringLiteral: a diagnostic label, compared against
  // nothing. Any distinct string behaves identically.
  name: 'embeddings',
  apply: async (ctx) => {
    const registry: EmbeddingsRegistry = new ProviderRegistry('embeddings provider');

    registry.register(
      'hashing',
      ({ config }) => new HashingEmbeddings({ dimensions: config.embeddings.dimensions }),
    );

    registry.register('openai', ({ config }) => {
      if (!config.llm.apiKey) {
        throw new Error('EMBEDDINGS_PROVIDER=openai requires OPENAI_API_KEY');
      }
      return new OpenAIEmbeddings({
        apiKey: config.llm.apiKey,
        model: config.embeddings.model ?? 'text-embedding-3-small',
        dimensions: config.embeddings.dimensions,
        configuration: config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : undefined,
      });
    });

    // No `dimensions`: an Ollama embedding model has a native width, and asking
    // for another one is ignored by some models and an error from others. The
    // model is the setting here, and `EMBEDDINGS_DIMENSIONS` is not.
    registry.register(
      'ollama',
      ({ config }) =>
        new OllamaEmbeddings({
          baseUrl: config.ollama.baseUrl,
          model: config.embeddings.model ?? 'nomic-embed-text',
        }),
    );

    await ctx.provide('embeddings', registry);
  },
};
