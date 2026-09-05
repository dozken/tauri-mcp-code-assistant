import type { Context, Plugin } from './context.js';

export interface PluginEntry<Config = never> {
  readonly plugin: Plugin<Config>;
  readonly config: Config;
}

/** Loads in the order given. Order still does not matter — `inject` handles that. */
export const loadPlugins = async (ctx: Context, entries: readonly PluginEntry[]): Promise<void> => {
  for (const entry of entries) {
    await ctx.plugin(entry.plugin, entry.config);
  }
};

const isPlugin = (value: unknown): value is Plugin<never> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { name?: unknown }).name === 'string' &&
  typeof (value as { apply?: unknown }).apply === 'function';

/**
 * Imports a plugin the user named in their own config.
 *
 * This runs third-party code in the backend process, with everything that
 * implies. It is opt-in, never discovered by scanning a directory, and no
 * different in kind from the user installing an npm package — but it is worth
 * being explicit that no sandbox stands between a listed plugin and the machine.
 */
export const importPlugin = async (specifier: string): Promise<Plugin<never>> => {
  const module: unknown = await import(specifier);
  const candidate = (module as { default?: unknown }).default ?? module;

  if (!isPlugin(candidate)) {
    throw new Error(
      `"${specifier}" does not export a plugin. Expected a default export with a "name" and an "apply" function.`,
    );
  }
  return candidate;
};
