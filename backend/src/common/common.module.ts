import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { LocalAccessGuard } from '../security/local-access.guard.js';
import { RateLimitGuard } from '../security/rate-limit.guard.js';
import { METADATA_STORE, createMetadataStore, type MetadataStore } from './metadata-store.js';

/** Closes the SQLite handle on shutdown so nothing is left half-written. */
@Injectable()
class MetadataStoreLifecycle implements OnApplicationShutdown {
  constructor(@Inject(METADATA_STORE) private readonly store: MetadataStore) {}

  async onApplicationShutdown(): Promise<void> {
    await this.store.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: METADATA_STORE,
      inject: [APP_CONFIG, PinoLogger],
      useFactory: (config: AppConfig, logger: PinoLogger) =>
        createMetadataStore(config.metadataDb, (reason) => {
          logger.warn({ reason }, 'sqlite3 unavailable, indexed folders will not persist');
        }),
    },
    MetadataStoreLifecycle,
    // Global, so a new endpoint is protected because it exists rather than
    // because someone remembered to decorate it.
    { provide: APP_GUARD, useClass: LocalAccessGuard },
    // After it, deliberately: an unauthenticated caller must not be able to spend
    // the budget and lock the real client out of its own backend.
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
  exports: [METADATA_STORE],
})
export class CommonModule {}
