import { describe, expect, it } from 'vitest';
import { CodeToolsService } from '../tools/code-tools.service.js';
import { HashingEmbeddings } from '../vector/embeddings.js';
import { MemoryVectorStore } from '../vector/memory-vector-store.js';
import type { VectorStoreService } from '../vector/vector-store.service.js';
import { silentLogger, testConfig } from '../../test/helpers.js';
import { McpToolsService } from './mcp-tools.service.js';

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
