import { describe, expect, it } from 'vitest';
import { CodeToolsService } from '../tools/code-tools.service.js';
import { HashingEmbeddings } from '../vector/embeddings.js';
import { MemoryVectorStore } from '../vector/memory-vector-store.js';
import type { VectorStoreService } from '../vector/vector-store.service.js';
import { McpToolsService } from '../mcp/mcp-tools.service.js';
import { StubChatModel } from '../llm/stub-chat-model.js';
import { silentLogger, testConfig } from '../../test/helpers.js';
import { ChatService } from './chat.service.js';
import type { ChatStreamEvent } from './chat.types.js';

const buildChatService = async (): Promise<{ chat: ChatService; store: MemoryVectorStore }> => {
  const store = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 128 }));
  await store.upsert([
    {
      id: 'chunk-auth',
      text: 'export function authenticateUser(token: string) {\n  return token.length > 0;\n}',
      metadata: {
        path: '/repo/src/auth.ts',
        relativePath: 'src/auth.ts',
        root: '/repo',
        language: 'typescript',
        startLine: 12,
        endLine: 14,
        indexedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  ]);

  const config = testConfig();
  const codeTools = new CodeToolsService(config, store as unknown as VectorStoreService);
  const mcpTools = new McpToolsService(config, codeTools, silentLogger());
  // 0 ms per token keeps the test fast without changing the streaming code path.
  const model = new StubChatModel({ tokenDelayMs: 0 });

  return { chat: new ChatService(model, mcpTools, silentLogger()), store };
};

const collect = async (
  events: AsyncGenerator<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> => {
  const out: ChatStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

describe('ChatService', () => {
  it('retrieves before answering and streams the answer as tokens', async () => {
    const { chat } = await buildChatService();

    const events = await collect(chat.stream({ message: 'where do we authenticate the user?' }));

    const toolEvents = events.filter((event) => event.type === 'tool');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({ tool: { name: 'search_code', failed: false } });

    const tokens = events.filter((event) => event.type === 'token');
    expect(tokens.length).toBeGreaterThan(3);

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    // The streamed tokens must reconstruct exactly the final message.
    expect(done?.type === 'done' && done.message).toBe(
      tokens.map((event) => (event.type === 'token' ? event.token : '')).join(''),
    );
    expect(done?.type === 'done' && done.message).toContain('src/auth.ts:12-14');
  });

  it('exposes the same result through the blocking API', async () => {
    const { chat } = await buildChatService();

    const response = await chat.chat({ message: 'authenticate user' });

    expect(response.model).toBe('stub-chat-model');
    expect(response.conversationId).toMatch(/[0-9a-f-]{36}/);
    expect(response.toolCalls.map((call) => call.name)).toEqual(['search_code']);
    expect(response.message).toContain('src/auth.ts');
  });

  it('reuses the caller conversation id across every event', async () => {
    const { chat } = await buildChatService();

    const events = await collect(
      chat.stream({ message: 'anything', conversationId: 'conv-42' }),
    );

    expect(events.every((event) => event.conversationId === 'conv-42')).toBe(true);
  });

  it('tells the user nothing is indexed instead of inventing an answer', async () => {
    const config = testConfig();
    const codeTools = new CodeToolsService(
      config,
      new MemoryVectorStore(new HashingEmbeddings({ dimensions: 32 })) as unknown as VectorStoreService,
    );
    const chat = new ChatService(
      new StubChatModel({ tokenDelayMs: 0 }),
      new McpToolsService(config, codeTools, silentLogger()),
      silentLogger(),
    );

    const response = await chat.chat({ message: 'explain the auth flow' });

    expect(response.message).toMatch(/No indexed code matched/);
  });

  it('turns a failing tool into an observation rather than an exception', async () => {
    const { chat, store } = await buildChatService();
    store.search = async () => {
      throw new Error('vector store offline');
    };

    const response = await chat.chat({ message: 'where is auth?' });

    expect(response.toolCalls[0]).toMatchObject({ failed: true });
    expect(response.toolCalls[0].result).toMatch(/vector store offline/);
    expect(response.message.length).toBeGreaterThan(0);
  });

  it('emits an error event when the model itself fails', async () => {
    const config = testConfig();
    const codeTools = new CodeToolsService(
      config,
      new MemoryVectorStore(new HashingEmbeddings({ dimensions: 32 })) as unknown as VectorStoreService,
    );
    const model = new StubChatModel({ tokenDelayMs: 0 });
    model.bindTools = () => {
      throw new Error('model exploded');
    };

    const chat = new ChatService(
      model,
      new McpToolsService(config, codeTools, silentLogger()),
      silentLogger(),
    );

    const events = await collect(chat.stream({ message: 'hi' }));

    expect(events.at(-1)).toMatchObject({ type: 'error', error: 'model exploded' });
  });
});
