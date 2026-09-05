import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerCodeTools } from '../src/mcp/register-tools.js';
import { CodeToolsService } from '../src/tools/code-tools.service.js';
import { HashingEmbeddings } from '../src/vector/embeddings.js';
import { MemoryVectorStore } from '../src/vector/memory-vector-store.js';
import type { VectorStoreService } from '../src/vector/vector-store.service.js';
import { testConfig } from './helpers.js';

/**
 * Exercises the real MCP protocol (initialize, tools/list, tools/call) over the
 * SDK's in-memory transport pair. Same server code as `dist/mcp-server.js`,
 * without spawning a process — so this runs before any build step.
 */
describe('MCP server', () => {
  let root: string;
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'companion-mcp-')));
    const file = join(root, 'auth.ts');
    const source =
      'export function authenticateUser(token: string) {\n  return token.length > 0;\n}\n';
    await writeFile(file, source);

    const store = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 128 }));
    await store.upsert([
      {
        id: 'chunk-auth',
        text: source,
        metadata: {
          path: file,
          relativePath: 'auth.ts',
          root,
          language: 'typescript',
          startLine: 1,
          endLine: 3,
          indexedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);

    const config = testConfig({
      indexing: {
        chunkSize: 400,
        chunkOverlap: 40,
        maxFileBytes: 64 * 1024,
        concurrency: 2,
        allowedRoots: [root],
        watch: false,
        watchDebounceMs: 5,
      },
    });

    server = new McpServer({ name: 'ai-code-companion', version: '0.1.0' });
    registerCodeTools(server, new CodeToolsService(config, store as unknown as VectorStoreService));

    client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it('advertises the three tools with input schemas', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'explain_file',
      'generate_snippet',
      'search_code',
    ]);
    const search = tools.find((tool) => tool.name === 'search_code');
    expect(search?.inputSchema.required).toEqual(['query']);
    expect(search?.annotations?.readOnlyHint).toBe(true);
  });

  it('answers tools/call for search_code with text and structured content', async () => {
    const result = await client.callTool({
      name: 'search_code',
      arguments: { query: 'authenticate user', limit: 3 },
    });

    expect(result.isError).toBeFalsy();
    const [content] = result.content as { type: string; text: string }[];
    expect(content).toMatchObject({ type: 'text' });
    expect(content?.text).toContain('auth.ts:1-3');
    expect(result.structuredContent).toMatchObject({ query: 'authenticate user' });
  });

  it('answers tools/call for explain_file', async () => {
    const result = await client.callTool({
      name: 'explain_file',
      arguments: { path: join(root, 'auth.ts') },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      language: 'typescript',
      symbols: [{ kind: 'function', name: 'authenticateUser', line: 1 }],
    });
  });

  it('answers tools/call for generate_snippet', async () => {
    const result = await client.callTool({
      name: 'generate_snippet',
      arguments: { prompt: 'retry with backoff', language: 'rust' },
    });

    expect(result.structuredContent).toMatchObject({ language: 'rust' });
    expect((result.structuredContent as { code: string }).code).toContain('pub fn run');
  });

  it('rejects an argument that violates the input schema', async () => {
    const result = await client.callTool({ name: 'search_code', arguments: { query: '' } });

    expect(result.isError).toBe(true);
  });

  it('reports a tool failure as an error result rather than dropping the connection', async () => {
    const result = await client.callTool({
      name: 'explain_file',
      arguments: { path: '/etc/hosts' },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/outside the allowed roots/);
  });
});
