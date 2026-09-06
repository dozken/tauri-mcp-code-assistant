import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '../plugins/context.js';
import { loadConfig, type AppConfig } from '../config/configuration.js';
import { embeddingsPlugin, type EmbeddingsRegistry } from './embeddings.plugin.js';
import { HashingEmbeddings } from './embeddings.js';
import { startFakeOllama, type FakeOllama } from '../../test/fake-ollama.js';

const registry = async (): Promise<EmbeddingsRegistry> => {
  const root = Context.create();
  await root.plugin(embeddingsPlugin, undefined);

  return root.require('embeddings');
};

const configWith = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  ...loadConfig({ CHROMA_ENABLED: 'false', LLM_PROVIDER: 'stub', LOG_LEVEL: 'silent' }),
  ...overrides,
});

describe('the embeddings registry', () => {
  it('offers the embedders the app ships with', async () => {
    expect((await registry()).kinds).toEqual(['hashing', 'ollama', 'openai']);
  });

  it('uses deterministic local embeddings by default', async () => {
    const config = configWith();

    await expect(
      (await registry()).create(config.embeddings.provider, { config }),
    ).resolves.toBeInstanceOf(HashingEmbeddings);
  });

  it('honours the configured dimension count', async () => {
    const base = configWith();
    const config = { ...base, embeddings: { ...base.embeddings, dimensions: 96 } };

    const embeddings = await (await registry()).create('hashing', { config });

    expect(await embeddings.embedQuery('hello')).toHaveLength(96);
  });

  it('names what exists, and what kind of thing is missing', async () => {
    const config = configWith();

    await expect((await registry()).create('nomic', { config })).rejects.toThrow(
      /No plugin provides the embeddings provider "nomic"\. Available: hashing, ollama, openai/,
    );
  });

  it('builds an OpenAI embedder with the settings it was given', async () => {
    const base = configWith();

    const embeddings = await (
      await registry()
    ).create('openai', {
      config: {
        ...base,
        llm: { ...base.llm, apiKey: 'sk-test' },
        embeddings: { ...base.embeddings, model: 'text-embedding-3-large', dimensions: 256 },
      },
    });

    expect(embeddings).toMatchObject({ model: 'text-embedding-3-large', dimensions: 256 });
  });

  it('falls back to a small OpenAI embedding model when none is named', async () => {
    const base = configWith();

    const embeddings = await (
      await registry()
    ).create('openai', {
      config: { ...base, llm: { ...base.llm, apiKey: 'sk-test' } },
    });

    expect(embeddings).toMatchObject({ model: 'text-embedding-3-small' });
  });

  it('refuses OpenAI embeddings without a key rather than failing on first use', async () => {
    const base = configWith();

    await expect(
      (await registry()).create('openai', {
        config: { ...base, llm: { ...base.llm, apiKey: undefined } },
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe('the ollama embedder', () => {
  let ollama: FakeOllama | undefined;

  afterEach(async () => {
    await ollama?.close();
    ollama = undefined;
  });

  it('embeds against a real Ollama conversation', async () => {
    ollama = await startFakeOllama({ embeddings: [[0.1, 0.2, 0.3]] });
    const base = configWith();
    const config = { ...base, ollama: { baseUrl: ollama.url } };

    const vector = await (
      await registry()
    )
      .create('ollama', { config })
      .then((e) => e.embedQuery('where do we authenticate?'));

    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(ollama.seen.path).toBe('/api/embed');
    expect(ollama.seen.body).toMatchObject({ model: 'nomic-embed-text' });
  });

  it('asks for the model it was configured with, and never for a dimension count', async () => {
    // An Ollama embedding model has a native width; asking for another is ignored
    // by some models and rejected by others, so `EMBEDDINGS_DIMENSIONS` is not sent.
    ollama = await startFakeOllama({ embeddings: [[1]] });
    const base = configWith();
    const config = {
      ...base,
      ollama: { baseUrl: ollama.url },
      embeddings: { ...base.embeddings, model: 'mxbai-embed-large', dimensions: 96 },
    };

    await (await registry()).create('ollama', { config }).then((e) => e.embedQuery('hi'));

    expect(ollama.seen.body).toMatchObject({ model: 'mxbai-embed-large' });
    expect(JSON.stringify(ollama.seen.body)).not.toContain('96');
  });
});
