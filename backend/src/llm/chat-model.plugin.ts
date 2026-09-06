import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Plugin } from '../plugins/context.js';
import { ProviderRegistry } from '../plugins/registry.js';
import type { AppConfig } from '../config/configuration.js';
import { StubChatModel } from './stub-chat-model.js';

export interface ChatModelOptions {
  readonly config: AppConfig;
}

export type ChatModelRegistry = ProviderRegistry<BaseChatModel, ChatModelOptions>;

declare module '../plugins/context.js' {
  interface Services {
    chatModels: ChatModelRegistry;
  }
}

/** Where Ollama listens unless told otherwise. Loopback, like everything else here. */
const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';

/**
 * Tool-capable and code-shaped, which both matter: every turn binds `search_code`
 * and friends, and a model without tool support answers from nothing at all.
 */
const OLLAMA_DEFAULT_MODEL = 'qwen2.5-coder:7b';

/**
 * `ChatService` only ever sees `BaseChatModel`, so a provider is a config change.
 * Registering here makes it a *plugin* change: an Anthropic or vLLM provider is an
 * out-of-repo package, not a pull request.
 */
export const chatModelPlugin: Plugin = {
  name: 'chat-models',
  apply: async (ctx) => {
    const registry: ChatModelRegistry = new ProviderRegistry('chat model');

    // From the injected config, not process.env: reading the environment inside a
    // provider makes the stub impossible to configure per test, which is how a
    // timing-dependent test came to pass locally and fail in CI.
    registry.register(
      'stub',
      ({ config }) => new StubChatModel({ tokenDelayMs: config.llm.stubTokenDelayMs }),
    );

    registry.register('openai', ({ config }) => {
      if (!config.llm.apiKey) {
        throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
      }
      return new ChatOpenAI({
        apiKey: config.llm.apiKey,
        model: config.llm.model ?? 'gpt-4o-mini',
        temperature: config.llm.temperature,
        streaming: true,
        configuration: config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : undefined,
      });
    });

    // The one provider that needs no key and sends nothing off the machine, which
    // for a tool that reads your source is the difference between "try it" and
    // "ask your employer first".
    registry.register(
      'ollama',
      ({ config }) =>
        new ChatOllama({
          baseUrl: config.llm.baseUrl ?? OLLAMA_DEFAULT_URL,
          model: config.llm.model ?? OLLAMA_DEFAULT_MODEL,
          temperature: config.llm.temperature,
        }),
    );

    await ctx.provide('chatModels', registry);
  },
};
