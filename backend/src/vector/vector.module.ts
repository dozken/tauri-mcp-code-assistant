import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { createEmbeddings } from './vector-store.factory.js';
import { VectorStoreService } from './vector-store.service.js';
import { EMBEDDINGS } from './vector.tokens.js';

@Module({
  providers: [
    {
      provide: EMBEDDINGS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createEmbeddings(config),
    },
    VectorStoreService,
  ],
  exports: [VectorStoreService, EMBEDDINGS],
})
export class VectorModule {}
