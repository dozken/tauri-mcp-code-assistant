import { describe, expect, it, vi } from 'vitest';
import { CodeToolsService } from '../tools/code-tools.service.js';
import { HashingEmbeddings } from '../vector/embeddings.js';
import { MemoryVectorStore } from '../vector/memory-vector-store.js';
import type { VectorStoreService } from '../vector/vector-store.service.js';
import { McpToolsService } from '../mcp/mcp-tools.service.js';
import { StubChatModel } from '../llm/stub-chat-model.js';
import { recordingLogger, silentLogger, testConfig } from '../../test/helpers.js';
import type { PinoLogger } from 'nestjs-pino';
import { ChatService, ChatTimeoutError } from './chat.service.js';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatStreamEvent } from '@ai-code-companion/contracts';

const buildChatService = async (
  overrides: { timeoutMs?: number; tokenDelayMs?: number; logger?: PinoLogger } = {},
): Promise<{ chat: ChatService; store: MemoryVectorStore }> => {
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

  const base = testConfig();
  const config = {
    ...base,
    llm: { ...base.llm, timeoutMs: overrides.timeoutMs ?? base.llm.timeoutMs },
  };
  const codeTools = new CodeToolsService(config, store as unknown as VectorStoreService);
  const mcpTools = new McpToolsService(config, codeTools, silentLogger());
  // 0 ms per token keeps the test fast without changing the streaming code path.
  const model = new StubChatModel({ tokenDelayMs: overrides.tokenDelayMs ?? 0 });

  return {
    chat: new ChatService(model, mcpTools, config, overrides.logger ?? silentLogger()),
    store,
  };
};

const collect = async (events: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> => {
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

    const events = await collect(chat.stream({ message: 'anything', conversationId: 'conv-42' }));

    expect(events.every((event) => event.conversationId === 'conv-42')).toBe(true);
  });

  it('tells the user nothing is indexed instead of inventing an answer', async () => {
    const config = testConfig();
    const codeTools = new CodeToolsService(
      config,
      new MemoryVectorStore(
        new HashingEmbeddings({ dimensions: 32 }),
      ) as unknown as VectorStoreService,
    );
    const chat = new ChatService(
      new StubChatModel({ tokenDelayMs: 0 }),
      new McpToolsService(config, codeTools, silentLogger()),
      config,
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
    expect(response.toolCalls[0]!.result).toMatch(/vector store offline/);
    expect(response.message.length).toBeGreaterThan(0);
  });

  it('emits an error event when the model itself fails', async () => {
    const config = testConfig();
    const codeTools = new CodeToolsService(
      config,
      new MemoryVectorStore(
        new HashingEmbeddings({ dimensions: 32 }),
      ) as unknown as VectorStoreService,
    );
    const model = new StubChatModel({ tokenDelayMs: 0 });
    model.bindTools = () => {
      throw new Error('model exploded');
    };

    const chat = new ChatService(
      model,
      new McpToolsService(config, codeTools, silentLogger()),
      config,
      silentLogger(),
    );

    const events = await collect(chat.stream({ message: 'hi' }));

    expect(events.at(-1)).toMatchObject({ type: 'error', error: 'model exploded' });
  });
});

/**
 * A tool that never settles *and ignores the signal it is handed* — which is the
 * realistic failure, since an MCP tool is a separate process that owes this one
 * nothing. It is named `search_code` because that is what the stub model reaches
 * for on the first turn.
 */
const wedgedTool = (): StructuredToolInterface =>
  ({
    name: 'search_code',
    description: 'never answers',
    invoke: async () => new Promise<string>(() => undefined),
  }) as unknown as StructuredToolInterface;

const chatServiceWithWedgedTool = (timeoutMs: number): ChatService => {
  const base = testConfig();
  const config = { ...base, llm: { ...base.llm, timeoutMs } };
  const mcpTools = { getTools: async () => [wedgedTool()] } as unknown as McpToolsService;

  return new ChatService(new StubChatModel({ tokenDelayMs: 0 }), mcpTools, config, silentLogger());
};

/** A tool the service can call, standing in for whatever the MCP server exposes. */
const fakeTool = (name: string, run: () => unknown): StructuredToolInterface =>
  ({ name, description: name, invoke: async () => run() }) as unknown as StructuredToolInterface;

/**
 * A model that asks for the same tool on every turn and never volunteers an
 * answer. It is the only way to reach the tool-budget ceiling, since the real
 * stub settles after one retrieval.
 *
 * `bindTools` is deliberately absent so the `?? this.model` fallback — what a
 * model without tool support would take — is exercised too.
 */
const insatiable = (toolName: string, lastResort: string): BaseChatModel => {
  const model = {
    _llmType: () => 'insatiable',
    stream: async () =>
      (async function* () {
        yield new AIMessageChunk({
          content: '',
          tool_calls: [{ id: 'call-1', name: toolName, args: { query: 'x' }, type: 'tool_call' }],
        });
      })(),
    invoke: async () => new AIMessage({ content: lastResort }),
  };

  return model as unknown as BaseChatModel;
};

const serviceWith = (model: BaseChatModel, tools: StructuredToolInterface[]): ChatService => {
  const config = testConfig();
  const mcpTools = { getTools: async () => tools } as unknown as McpToolsService;

  return new ChatService(model, mcpTools, config, silentLogger());
};

describe('ChatService tool loop', () => {
  it('answers from what the tools returned once the budget runs out', async () => {
    const chat = serviceWith(
      insatiable('search_code', 'Out of budget, but here is what I found.'),
      [fakeTool('search_code', () => 'src/auth.ts:12-14')],
    );

    const events = await collect(chat.stream({ message: 'where do we authenticate?' }));
    const done = events.at(-1);

    // Bounded, and never empty: the user gets an answer rather than a blank turn.
    expect(events.filter((event) => event.type === 'tool')).toHaveLength(4);
    expect(done).toMatchObject({ type: 'done' });
    expect(done).toMatchObject({ message: expect.stringContaining('Out of budget') });
  });

  it('tells the model which tools exist when it invents one', async () => {
    const chat = serviceWith(insatiable('teleport', 'nothing to go on'), [
      fakeTool('search_code', () => 'src/auth.ts:12-14'),
    ]);

    const events = await collect(chat.stream({ message: 'where do we authenticate?' }));
    const first = events.find((event) => event.type === 'tool');

    expect(first).toMatchObject({ tool: { name: 'teleport', failed: true } });
    // Naming the alternatives is what lets the model recover on the next turn.
    expect(first).toMatchObject({ tool: { result: expect.stringContaining('search_code') } });
  });

  it.each([
    ['a plain string', () => 'plain text', 'plain text'],
    ['a tool message', () => ({ content: 'from a message' }), 'from a message'],
    ['anything else', () => ({ hits: 2 }), '{"hits":2}'],
    ['undefined', () => undefined, 'null'],
    // `'content' in null` throws, so the null guard is load-bearing rather than
    // defensive: without it one null tool result ends the whole turn.
    ['null', () => null, 'null'],
  ])('reads a tool result that is %s', async (_label, run, expected) => {
    const chat = serviceWith(insatiable('search_code', 'done'), [fakeTool('search_code', run)]);

    const events = await collect(chat.stream({ message: 'where do we authenticate?' }));
    const first = events.find((event) => event.type === 'tool');

    expect(first).toMatchObject({ tool: { result: expected, failed: false } });
  });

  it('reports a throwing tool as an observation rather than ending the turn', async () => {
    const chat = serviceWith(insatiable('search_code', 'recovered'), [
      fakeTool('search_code', () => {
        throw new Error('index offline');
      }),
    ]);

    const events = await collect(chat.stream({ message: 'where do we authenticate?' }));

    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(events.find((event) => event.type === 'tool')).toMatchObject({
      tool: { failed: true, result: expect.stringContaining('index offline') },
    });
  });
});

describe('ChatService tool loop, edge cases', () => {
  it('says nothing rather than yielding an empty token when the last answer is blank', async () => {
    const model = insatiable('search_code', '');
    const chat = serviceWith(model, [fakeTool('search_code', () => 'nothing useful')]);

    const events = await collect(chat.stream({ message: 'where do we authenticate?' }));

    expect(events.filter((event) => event.type === 'token')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done', message: '' });
  });

  it('asks the model to answer from the observations once the budget is spent', async () => {
    // The prompt is the whole mechanism: without it the model has no instruction
    // to stop calling tools, and the turn ends on an empty answer.
    const invoke = vi.fn().mockResolvedValue(new AIMessage({ content: 'final' }));
    const model = {
      _llmType: () => 'insatiable',
      stream: async () =>
        (async function* () {
          yield new AIMessageChunk({
            content: '',
            tool_calls: [
              { id: 'c1', name: 'search_code', args: { query: 'x' }, type: 'tool_call' },
            ],
          });
        })(),
      invoke,
    } as unknown as BaseChatModel;

    await collect(
      serviceWith(model, [fakeTool('search_code', () => 'hit')]).stream({ message: 'where?' }),
    );

    const messages = (invoke.mock.calls[0]?.[0] ?? []) as { content: unknown }[];
    expect(String(messages.at(-1)?.content)).toContain('Tool budget exhausted');
  });

  it('answers empty rather than throwing when the model streams no chunks at all', async () => {
    const silent = {
      _llmType: () => 'silent',
      bindTools: () => silent,

      stream: async () => (async function* (): AsyncGenerator<AIMessageChunk> {})(),
    } as unknown as BaseChatModel;

    const events = await collect(serviceWith(silent, []).stream({ message: 'anything' }));

    expect(events.at(-1)).toMatchObject({ type: 'done', message: '' });
  });
});

describe('ChatService prompt assembly', () => {
  /** Captures the messages the model was handed on the first turn. */
  const seenByModel = async (request: Parameters<ChatService['stream']>[0]): Promise<string[]> => {
    const messages: string[] = [];
    const recorder = {
      _llmType: () => 'recorder',
      bindTools: () => recorder,
      stream: async (given: { content: unknown }[]) => {
        messages.push(...given.map((message) => String(message.content)));

        return (async function* (): AsyncGenerator<AIMessageChunk> {})();
      },
    } as unknown as BaseChatModel;

    await collect(
      new ChatService(
        recorder,
        { getTools: async () => [] } as unknown as McpToolsService,
        testConfig(),
        silentLogger(),
      ).stream(request),
    );

    return messages;
  };

  it('replays the history it is given as alternating turns', async () => {
    const messages = await seenByModel({
      message: 'and where is it called from?',
      history: [
        { role: 'user', content: 'where do we authenticate?' },
        { role: 'assistant', content: 'In src/auth.ts.' },
      ],
    });

    // Dropping the history is invisible in the reply and ruins every follow-up.
    expect(messages).toContain('where do we authenticate?');
    expect(messages).toContain('In src/auth.ts.');
    expect(messages.at(-1)).toBe('and where is it called from?');
  });

  it('pins the search to one root when the request names one', async () => {
    const withRoot = await seenByModel({ message: 'where do we authenticate?', root: '/repo' });
    const without = await seenByModel({ message: 'where do we authenticate?' });

    expect(withRoot.some((message) => message.includes('root="/repo"'))).toBe(true);
    expect(without.some((message) => message.includes('root='))).toBe(false);
  });

  it('leads with a system prompt telling the model to ground itself first', async () => {
    const messages = await seenByModel({ message: 'anything' });

    expect(messages[0]).toContain('search_code');
  });
});

describe('ChatService deadline', () => {
  it('ends the turn with an error naming the timeout, not a raw AbortError', async () => {
    // 1 ms deadline against a stub that takes 20 ms per token: the model is mid-turn
    // when the deadline fires, which is the case that used to hang the connection.
    const { chat } = await buildChatService({ timeoutMs: 1, tokenDelayMs: 20 });

    const events = await collect(chat.stream({ message: 'where do we authenticate?' }));
    const last = events.at(-1);

    expect(last?.type).toBe('error');
    expect(last).toMatchObject({ error: expect.stringContaining('did not answer within') });
    expect(last).toMatchObject({ error: expect.stringContaining('LLM_TIMEOUT_MS') });
  });

  it('names the deadline in seconds once it is longer than a second', async () => {
    // The default is 120s, so the seconds branch is the one every real user sees;
    // the other tests all sit under a second and would never notice it break.
    const chat = chatServiceWithWedgedTool(1000);

    const events = await collect(chat.stream({ message: 'where do we authenticate?' }));

    expect(events.at(-1)).toMatchObject({ error: expect.stringContaining('within 1s') });
  });

  it('rejects the blocking /chat variant rather than holding the connection', async () => {
    const { chat } = await buildChatService({ timeoutMs: 1, tokenDelayMs: 20 });

    // The type is the contract: the HTTP layer answers 504 on this and 500 on
    // anything else, so a plain Error here would be a silent downgrade to 500.
    await expect(chat.chat({ message: 'where do we authenticate?' })).rejects.toThrow(
      ChatTimeoutError,
    );
    await expect(chat.chat({ message: 'where do we authenticate?' })).rejects.toMatchObject({
      name: 'ChatTimeoutError',
      message: expect.stringContaining('did not answer within'),
    });
  });

  it('reports a plain failure as a plain error, so it is not answered with a 504', async () => {
    const broken = {
      _llmType: () => 'broken',
      bindTools: () => broken,
      stream: () => Promise.reject(new Error('model is misconfigured')),
    } as unknown as BaseChatModel;
    const base = testConfig();
    const chat = new ChatService(
      broken,
      { getTools: async () => [] } as unknown as McpToolsService,
      base,
      silentLogger(),
    );

    await expect(chat.chat({ message: 'anything' })).rejects.toThrow('model is misconfigured');
    await expect(chat.chat({ message: 'anything' })).rejects.not.toBeInstanceOf(ChatTimeoutError);
  });

  it('still names the timeout when the model layer buries the abort', async () => {
    // The whole reason the signal is consulted instead of the error text: a
    // provider SDK that catches the abort and rethrows its own generic failure.
    // Matching on the message would leave the user with "Request failed" and no
    // hint that `LLM_TIMEOUT_MS` is the knob.
    const buriesTheAbort = {
      _llmType: () => 'burier',
      bindTools: () => buriesTheAbort,
      stream: async (_messages: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('Request failed with status code 500'));
          });
        }),
    } as unknown as BaseChatModel;

    const base = testConfig();
    const chat = new ChatService(
      buriesTheAbort,
      { getTools: async () => [] } as unknown as McpToolsService,
      { ...base, llm: { ...base.llm, timeoutMs: 20 } },
      silentLogger(),
    );

    const events = await collect(chat.stream({ message: 'where do we authenticate?' }));

    expect(events.at(-1)).toMatchObject({
      error: expect.stringContaining('did not answer within'),
    });
    expect(JSON.stringify(events.at(-1))).not.toContain('status code 500');
  });

  it('reports a caller cancel as a cancel, not as a timeout', async () => {
    const { chat } = await buildChatService({ timeoutMs: 60_000, tokenDelayMs: 20 });
    const controller = new AbortController();

    const events: ChatStreamEvent[] = [];
    const stream = chat.stream({ message: 'where do we authenticate?' }, controller.signal);
    for await (const event of stream) {
      events.push(event);
      if (events.length === 1) controller.abort();
    }

    const last = events.at(-1);
    expect(last?.type).toBe('error');
    expect(JSON.stringify(last)).not.toContain('did not answer within');
  });

  it('does not log a caller cancel as a failure', async () => {
    // Closing the window aborts the turn, which the model layer rethrows as an
    // error. Logging that at error level meant every closed tab left a stack
    // trace in the log, and the failures worth reading were buried among them.
    const logger = recordingLogger();
    const { chat } = await buildChatService({ timeoutMs: 60_000, tokenDelayMs: 20, logger });
    const controller = new AbortController();

    let seen = 0;
    for await (const _event of chat.stream(
      { message: 'where do we authenticate?' },
      controller.signal,
    )) {
      seen += 1;
      if (seen === 1) controller.abort('cancelled');
    }

    expect(logger.lines.filter((line) => line.level === 'error')).toEqual([]);
    expect(logger.lines.map((line) => line.message)).toContain('Chat turn ended by the caller');
  });

  it('still logs a genuine failure as one', async () => {
    const logger = recordingLogger();
    const { chat } = await buildChatService({ logger });
    vi.spyOn(chat as unknown as { buildMessages: () => never }, 'buildMessages').mockImplementation(
      () => {
        throw new Error('the model layer fell over');
      },
    );

    await collect(chat.stream({ message: 'where do we authenticate?' }));

    expect(
      logger.lines.filter((line) => line.level === 'error').map((line) => line.message),
    ).toEqual(['Chat failed']);
  });

  it('completes normally when the model is comfortably inside the deadline', async () => {
    const { chat } = await buildChatService({ timeoutMs: 60_000 });

    const events = await collect(chat.stream({ message: 'where do we authenticate?' }));

    expect(events.at(-1)?.type).toBe('done');
  });

  it('ends the turn when a tool wedges, instead of waiting on it forever', async () => {
    // The deadline used to cover only model streaming, so a tool that never
    // returned held the turn — and the Stop button — open indefinitely.
    const chat = chatServiceWithWedgedTool(50);

    const events = await collect(chat.stream({ message: 'where do we authenticate?' }));
    const last = events.at(-1);

    expect(last?.type).toBe('error');
    expect(last).toMatchObject({ error: expect.stringContaining('did not answer within') });
    // One timeout, not one "tool failed" observation per call in the batch.
    expect(events.filter((event) => event.type === 'tool')).toEqual([]);
  });

  it('lets the caller stop a turn that is stuck inside a tool', async () => {
    const chat = chatServiceWithWedgedTool(60_000);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 20);

    try {
      const events = await collect(
        chat.stream({ message: 'where do we authenticate?' }, controller.signal),
      );
      const last = events.at(-1);

      expect(last?.type).toBe('error');
      expect(JSON.stringify(last)).not.toContain('did not answer within');
    } finally {
      clearTimeout(timer);
    }
  });

  it('does not keep the process alive after a fast reply', async () => {
    // An uncleared AbortSignal.timeout holds the event loop for its full duration,
    // so a 10-minute ceiling would mean a 10-minute shutdown.
    const { chat } = await buildChatService({ timeoutMs: 600_000 });
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

    await collect(chat.stream({ message: 'where do we authenticate?' }));

    expect(process.getActiveResourcesInfo().filter((r) => r === 'Timeout')).toHaveLength(before);
  });
});
