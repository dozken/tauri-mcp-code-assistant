import { Module } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { PLUGIN_CONTEXT } from '../extensions/extensions.module.js';
import type { Context } from '../plugins/context.js';

export const CHAT_MODEL = 'CHAT_MODEL';

/**
 * `ChatService` only ever sees `BaseChatModel`. Which one it gets is a registry
 * lookup, so adding a provider is a plugin rather than an edit here — and an
 * unknown name fails at startup naming the kinds that do exist, which is a better
 * error than the config enum used to give.
 */
export const createChatModel = async (
  plugins: Context,
  config: AppConfig,
): Promise<BaseChatModel> => plugins.require('chatModels').create(config.llm.provider, { config });

@Module({
  providers: [
    {
      provide: CHAT_MODEL,
      inject: [PLUGIN_CONTEXT, APP_CONFIG],
      useFactory: (plugins: Context, config: AppConfig) => createChatModel(plugins, config),
    },
  ],
  exports: [CHAT_MODEL],
})
export class LlmModule {}
