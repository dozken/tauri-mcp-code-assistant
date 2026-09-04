import { describe, expect, it } from 'vitest';
import { CodeToolsService } from '../tools/code-tools.service.js';
import { HashingEmbeddings } from '../vector/embeddings.js';
import { MemoryVectorStore } from '../vector/memory-vector-store.js';
import type { VectorStoreService } from '../vector/vector-store.service.js';
import { silentLogger, testConfig } from '../../test/helpers.js';
import { McpToolsService, mcpChildEnv } from './mcp-tools.service.js';

const build = (overrides: Record<string, unknown> = {}): McpToolsService => {
  const config = testConfig();
  const tools = new CodeToolsService(
    config,
    new MemoryVectorStore(
      new HashingEmbeddings({ dimensions: 32 }),
    ) as unknown as VectorStoreService,
  );
  return new McpToolsService(
    { ...config, mcp: { ...config.mcp, ...overrides } },
    tools,
    silentLogger(),
  );
};

describe('McpToolsService', () => {
  it('exposes the three tools in-process by default', async () => {
    const service = build();

    const names = (await service.getTools()).map((tool) => tool.name).toSorted();
    expect(names).toEqual(['explain_file', 'generate_snippet', 'search_code']);
    await service.onModuleDestroy();
  });

  it('memoises the toolbelt so every turn does not re-resolve it', async () => {
    const service = build();

    expect(await service.getTools()).toBe(await service.getTools());
    await service.onModuleDestroy();
  });

  it('degrades to in-process tools when the MCP server cannot start', async () => {
    // Enabled, but pointed at a command that does not exist.
    const service = build({
      clientEnabled: true,
      serverCommand: 'definitely-not-a-real-binary',
      serverArgs: ['--nope'],
    });
    const names = (await service.getTools()).map((tool) => tool.name).toSorted();

    // Chat keeps working; the log records why.
    expect(names).toEqual(['explain_file', 'generate_snippet', 'search_code']);
    await service.onModuleDestroy();
  });

  it('closing twice is safe, so shutdown order cannot matter', async () => {
    const service = build();
    await service.getTools();

    await service.onModuleDestroy();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe('mcpChildEnv', () => {
  // A stdio MCP child does NOT inherit the parent environment — the SDK starts it
  // from a small safe default set — so anything the child needs must be forwarded
  // explicitly, or it silently runs on defaults with a different allow-list.
  it('forwards the effective configuration', () => {
    const config = testConfig();

    expect(mcpChildEnv(config)).toMatchObject({
      CHROMA_ENABLED: String(config.chroma.enabled),
      CHROMA_URL: config.chroma.url,
      CHROMA_COLLECTION: config.chroma.collection,
      EMBEDDINGS_PROVIDER: config.embeddings.provider,
      EMBEDDINGS_DIMENSIONS: String(config.embeddings.dimensions),
      EMBEDDINGS_MODEL: config.embeddings.model,
      INDEX_ALLOWED_ROOTS: config.indexing.allowedRoots.join(','),
      MAX_FILE_BYTES: String(config.indexing.maxFileBytes),
      METADATA_DB: config.metadataDb,
    });
  });

  it('stops the child from spawning a grandchild', () => {
    const config = testConfig();

    expect(mcpChildEnv({ ...config, mcp: { ...config.mcp, clientEnabled: true } })).toMatchObject({
      MCP_CLIENT_ENABLED: 'false',
    });
  });

  it('joins multiple allowed roots the way loadConfig parses them', () => {
    const config = testConfig();

    const env = mcpChildEnv({
      ...config,
      indexing: { ...config.indexing, allowedRoots: ['/a', '/b'] },
    });

    expect(env.INDEX_ALLOWED_ROOTS).toBe('/a,/b');
  });

  it('omits an unset key rather than passing the string "undefined"', () => {
    const config = testConfig();

    const env = mcpChildEnv({
      ...config,
      llm: { ...config.llm, apiKey: undefined, baseUrl: undefined },
    });

    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('OPENAI_BASE_URL');
    expect(Object.values(env).every((value) => typeof value === 'string')).toBe(true);
  });

  it('forwards the credentials when they are configured', () => {
    const config = testConfig();

    const env = mcpChildEnv({
      ...config,
      llm: { ...config.llm, apiKey: 'sk-test', baseUrl: 'https://gateway.example' },
    });

    expect(env).toMatchObject({
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'https://gateway.example',
    });
  });
});
