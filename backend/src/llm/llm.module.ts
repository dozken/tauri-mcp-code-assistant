import { Module } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { StubChatModel } from './stub-chat-model.js';

export const CHAT_MODEL = 'CHAT_MODEL';

/**
 * One provider, two implementations. `ChatService` only ever sees `BaseChatModel`,
 * so swapping the stub for a hosted model is a config change, not a code change.
 */
export const createChatModel = (config: AppConfig): BaseChatModel => {
  if (config.llm.provider === 'openai') {
    if (!config.llm.apiKey) {
      throw new Error('LLM_PROVIDER=openai requires OPENAI_API_KEY');
    }
    return new ChatOpenAI({
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      temperature: config.llm.temperature,
      streaming: true,
      configuration: config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : undefined,
    });
  }
  // From the injected config, not process.env: reading the environment inside a
  // provider makes the stub impossible to configure per-test, which is exactly how
  // a timing-dependent test came to pass locally and fail in CI.
  return new StubChatModel({ tokenDelayMs: config.llm.stubTokenDelayMs });
};

@Module({
  providers: [
    {
      provide: CHAT_MODEL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createChatModel(config),
    },
  ],
  exports: [CHAT_MODEL],
})
export class LlmModule {}
