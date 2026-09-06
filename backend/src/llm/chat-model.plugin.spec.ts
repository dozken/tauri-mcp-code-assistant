import { afterEach, describe, expect, it } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { Context } from '../plugins/context.js';
import { loadConfig, type AppConfig } from '../config/configuration.js';
import { chatModelPlugin, type ChatModelRegistry } from './chat-model.plugin.js';
import { startFakeOllama, type FakeOllama } from '../../test/fake-ollama.js';

const registry = async (): Promise<ChatModelRegistry> => {
  const root = Context.create();
  await root.plugin(chatModelPlugin, undefined);

  return root.require('chatModels');
};

const configWith = (llm: Partial<AppConfig['llm']>): AppConfig => {
  const base = loadConfig({ CHROMA_ENABLED: 'false', LLM_PROVIDER: 'stub', LOG_LEVEL: 'silent' });

  return { ...base, llm: { ...base.llm, ...llm } };
};

describe('chat model registry', () => {
  it('offers the providers the app ships with', async () => {
    expect((await registry()).kinds).toEqual(['ollama', 'openai', 'stub']);
  });

  it('names what exists when asked for something that does not', async () => {
    await expect((await registry()).create('gpt5', { config: configWith({}) })).rejects.toThrow(
      /Available: ollama, openai, stub/,
    );
  });

  it('refuses openai without a key, rather than failing on the first turn', async () => {
    await expect(
      (await registry()).create('openai', { config: configWith({ apiKey: undefined }) }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

/**
 * Driven against a server speaking Ollama's wire protocol rather than a mocked
 * client: what matters is that the options we hand it come out as Ollama expects,
 * that a streamed reply reaches the caller a token at a time, and that a tool call
 * comes back as one. See `test/fake-ollama.ts`.
 */
describe('the ollama provider', () => {
  let ollama: FakeOllama | undefined;

  afterEach(async () => {
    await ollama?.close();
    ollama = undefined;
  });

  const model = async (overrides: Partial<AppConfig['llm']> = {}): Promise<BaseChatModel> => {
    const base = configWith(overrides);

    return (await registry()).create('ollama', {
      config: { ...base, ollama: { baseUrl: ollama?.url ?? '' } },
    });
  };

  it('streams a reply from a real Ollama conversation', async () => {
    ollama = await startFakeOllama({ tokens: ['Hello ', 'from ', 'Ollama'] });

    const received: string[] = [];
    for await (const chunk of await (await model()).stream([new HumanMessage('hi')])) {
      received.push(String(chunk.content));
    }

    expect(received.join('')).toBe('Hello from Ollama');
    expect(ollama.seen.path).toBe('/api/chat');
    expect(ollama.seen.body).toMatchObject({ model: 'qwen2.5-coder:7b', stream: true });
  });

  it('puts the bound tools on the wire and reads a tool call back out', async () => {
    // This app is a tool loop end to end: a bound tool that does not reach Ollama,
    // or a tool call that does not come back as one, leaves the model answering
    // from nothing at all — with no error to say so.
    const searchCode = tool(() => 'hits', {
      name: 'search_code',
      description: 'Search the indexed code',
      schema: z.object({ query: z.string() }),
    });
    ollama = await startFakeOllama({
      toolCalls: [{ function: { name: 'search_code', arguments: { query: 'auth' } } }],
    });

    const bound = (await model()).bindTools?.([searchCode]);
    const reply = await bound?.invoke([new HumanMessage('where do we auth?')]);

    expect(ollama.seen.body?.tools).toMatchObject([
      {
        type: 'function',
        function: { name: 'search_code', description: 'Search the indexed code' },
      },
    ]);
    expect(reply?.tool_calls).toMatchObject([{ name: 'search_code', args: { query: 'auth' } }]);
  });

  it('sends the model and temperature it was configured with', async () => {
    ollama = await startFakeOllama({ tokens: ['ok'] });

    await (
      await model({ model: 'llama3.1:8b', temperature: 0.7 })
    ).invoke([new HumanMessage('hi')]);

    expect(ollama.seen.body).toMatchObject({ model: 'llama3.1:8b' });
    expect(ollama.seen.body?.options).toMatchObject({ temperature: 0.7 });
  });
});
