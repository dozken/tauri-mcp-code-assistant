import { Global, Module } from '@nestjs/common';
import { Context } from '../plugins/context.js';
import { importPlugin, loadPlugins, type PluginEntry } from '../plugins/loader.js';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { vectorStorePlugin } from '../vector/vector-store.plugin.js';
import { embeddingsPlugin } from '../vector/embeddings.plugin.js';
import { chatModelPlugin } from '../llm/chat-model.plugin.js';

export const PLUGIN_CONTEXT = 'PLUGIN_CONTEXT';

/**
 * Everything the app ships is loaded the same way a third-party plugin is. That
 * is deliberate: an extension point only stays honest while the built-ins use it
 * too, because anything the core reaches around is a seam nobody else can use.
 */
export const BUILT_INS: readonly PluginEntry[] = [
  { plugin: vectorStorePlugin, config: undefined as never },
  { plugin: embeddingsPlugin, config: undefined as never },
  { plugin: chatModelPlugin, config: undefined as never },
];

/**
 * Everything the config *names* has to exist, checked once at startup.
 *
 * Vector-store resolution is deliberately lazy so a slow Chroma cannot block
 * boot — which means a `VECTOR_STORE` naming a plugin that was never loaded
 * would otherwise surface as a healthy-looking in-memory store answering every
 * query with nothing. A typo should stop the app, not quietly change what it is.
 *
 * `EMBEDDINGS_PROVIDER` is worse still, and used to fall back silently: an index
 * is only searchable by vectors from the embedder that wrote it, so a misspelled
 * provider wrote a whole index that nothing could ever search.
 */
const assertConfiguredKindsExist = (ctx: Context, config: AppConfig): void => {
  const embedders = ctx.require('embeddings');
  if (!embedders.has(config.embeddings.provider)) {
    throw new Error(
      `EMBEDDINGS_PROVIDER="${config.embeddings.provider}" is not provided by any loaded plugin. ` +
        `Available: ${embedders.kinds.join(', ')}.`,
    );
  }

  if (config.vector.store === 'auto') return;

  const stores = ctx.require('vectorStores');
  if (!stores.has(config.vector.store)) {
    throw new Error(
      `VECTOR_STORE="${config.vector.store}" is not provided by any loaded plugin. ` +
        `Available: ${stores.kinds.join(', ')}.`,
    );
  }
};

export const createPluginContext = async (config: AppConfig): Promise<Context> => {
  const ctx = Context.create();
  await loadPlugins(ctx, BUILT_INS);

  for (const specifier of config.plugins.load) {
    const plugin = await importPlugin(specifier);
    await ctx.plugin(plugin, undefined as never);
  }

  assertConfiguredKindsExist(ctx, config);
  return ctx;
};

/**
 * Global so a feature module can reach the registries without every module in
 * between having to import and re-export them.
 */
@Global()
@Module({
  providers: [
    {
      provide: PLUGIN_CONTEXT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createPluginContext(config),
    },
  ],
  exports: [PLUGIN_CONTEXT],
})
export class ExtensionsModule {}
