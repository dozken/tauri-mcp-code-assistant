import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { PLUGIN_CONTEXT } from '../extensions/extensions.module.js';
import type { Context } from '../plugins/context.js';
import { createEmbeddings } from './vector-store.factory.js';
import { VectorStoreService } from './vector-store.service.js';
import { EMBEDDINGS } from './vector.tokens.js';

@Module({
  providers: [
    {
      provide: EMBEDDINGS,
      inject: [PLUGIN_CONTEXT, APP_CONFIG],
      useFactory: (plugins: Context, config: AppConfig) => createEmbeddings(plugins, config),
    },
    VectorStoreService,
  ],
  exports: [VectorStoreService, EMBEDDINGS],
})
export class VectorModule {}
