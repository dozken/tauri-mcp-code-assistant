import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPluginContext } from './extensions.module.js';
import { testConfig } from '../../test/helpers.js';

describe('createPluginContext', () => {
  it('loads the extension points the app itself depends on', async () => {
    // The built-ins go through the same door a third party does; if this list is
    // wrong the app boots and then fails on first use, not at startup.
    const ctx = await createPluginContext(testConfig());

    expect(ctx.provided).toEqual(['chatModels', 'vectorStores']);
  });

  it('ships both stores and both models, and says so by name', async () => {
    const ctx = await createPluginContext(testConfig());

    expect(ctx.require('vectorStores').kinds).toEqual(['chroma', 'memory']);
    expect(ctx.require('chatModels').kinds).toEqual(['openai', 'stub']);
  });

  it('declares whether each store survives a restart, rather than leaving it to be guessed', async () => {
    const ctx = await createPluginContext(testConfig());
    const stores = ctx.require('vectorStores');

    expect(stores.describe('memory')?.persistent).toBe(false);
    expect(stores.describe('chroma')?.persistent).toBe(true);
  });

  it('loads a plugin the user named, and lets it add a kind the core never heard of', async () => {
    // The whole promise of the exercise, tested from outside: a file this repo
    // does not know about adds a vector store that config can then select.
    const directory = await mkdtemp(join(tmpdir(), 'companion-plugin-'));
    const file = join(directory, 'plugin.mjs');
    await writeFile(
      file,
      `export default {
         name: 'third-party-store',
         inject: ['vectorStores'],
         apply: (ctx) => {
           ctx.require('vectorStores').register('qdrant', () => ({ kind: 'qdrant' }), {
             persistent: true,
           });
         },
       };`,
    );

    const base = testConfig();
    const ctx = await createPluginContext({
      ...base,
      plugins: { load: [fileURLToPath(new URL(`file://${file}`))] },
    });

    expect(ctx.require('vectorStores').kinds).toContain('qdrant');
  });

  it('refuses to start when VECTOR_STORE names a kind no plugin provides', async () => {
    // Resolution is lazy, so without this check the app boots happily and then
    // serves an in-memory store: every query answers nothing, /status looks
    // healthy, and the configured store is never mentioned again.
    const base = testConfig();

    await expect(createPluginContext({ ...base, vector: { store: 'qdrant' } })).rejects.toThrow(
      /VECTOR_STORE="qdrant".*Available: chroma, memory/s,
    );
  });

  it('accepts a kind a loaded plugin added, which is the point of checking late', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'companion-plugin-'));
    const file = join(directory, 'store.mjs');
    await writeFile(
      file,
      `export default {
         name: 'late-store',
         inject: ['vectorStores'],
         apply: (ctx) => {
           ctx.require('vectorStores').register('qdrant', () => ({ kind: 'qdrant' }), {
             persistent: true,
           });
         },
       };`,
    );

    const base = testConfig();

    await expect(
      createPluginContext({
        ...base,
        vector: { store: 'qdrant' },
        plugins: { load: [fileURLToPath(new URL(`file://${file}`))] },
      }),
    ).resolves.toBeDefined();
  });

  it('fails at startup, naming the module, when a listed plugin is not one', async () => {
    const base = testConfig();

    await expect(
      createPluginContext({ ...base, plugins: { load: ['node:path'] } }),
    ).rejects.toThrow(/does not export a plugin/);
  });
});
