import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { Context } from '../plugins/context.js';
import { loadConfig, type AppConfig } from '../config/configuration.js';
import { chatModelPlugin, type ChatModelRegistry } from './chat-model.plugin.js';

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
 * client, because the thing worth checking is not that we call a constructor —
 * it is that the options we hand it come out on the wire as Ollama expects, and
 * that a streamed reply reaches the caller a token at a time. A provider nobody
 * has ever run is a guess, and this repository has been bitten by one already.
 */
describe('the ollama provider', () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.close();
    if (server) await once(server, 'close');
    server = undefined;
  });

  interface OllamaToolCall {
    readonly function: { readonly name: string; readonly arguments: Record<string, unknown> };
  }

  /** Answers `/api/chat` with newline-delimited JSON, the way Ollama streams. */
  const fakeOllama = async (
    reply: { tokens?: readonly string[]; toolCalls?: readonly OllamaToolCall[] } = {},
  ): Promise<{ url: string; seen: { path?: string; body?: Record<string, unknown> } }> => {
    const seen: { path?: string; body?: Record<string, unknown> } = {};

    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seen.path = request.url;
        seen.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;

        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (const content of reply.tokens ?? []) {
          response.write(
            `${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n`,
          );
        }
        response.end(
          `${JSON.stringify({
            message: { role: 'assistant', content: '', tool_calls: reply.toolCalls },
            done: true,
            done_reason: 'stop',
          })}\n`,
        );
      });
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, seen };
  };

  it('streams a reply from a real Ollama conversation', async () => {
    const { url, seen } = await fakeOllama({ tokens: ['Hello ', 'from ', 'Ollama'] });
    const model = await (
      await registry()
    ).create('ollama', {
      config: configWith({ baseUrl: url, temperature: 0.4 }),
    });

    const received: string[] = [];
    for await (const chunk of await model.stream([new HumanMessage('hi')])) {
      received.push(String(chunk.content));
    }

    expect(received.join('')).toBe('Hello from Ollama');
    expect(seen.path).toBe('/api/chat');
    expect(seen.body).toMatchObject({ model: 'qwen2.5-coder:7b', stream: true });
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
    const { url, seen } = await fakeOllama({
      toolCalls: [{ function: { name: 'search_code', arguments: { query: 'auth' } } }],
    });
    const model = await (
      await registry()
    ).create('ollama', { config: configWith({ baseUrl: url }) });

    const reply = await model
      .bindTools?.([searchCode])
      .invoke([new HumanMessage('where do we auth?')]);

    expect(seen.body?.tools).toMatchObject([
      {
        type: 'function',
        function: { name: 'search_code', description: 'Search the indexed code' },
      },
    ]);
    expect(reply?.tool_calls).toMatchObject([{ name: 'search_code', args: { query: 'auth' } }]);
  });

  it('sends the model and temperature it was configured with', async () => {
    const { url, seen } = await fakeOllama({ tokens: ['ok'] });
    const model = await (
      await registry()
    ).create('ollama', {
      config: configWith({ baseUrl: url, model: 'llama3.1:8b', temperature: 0.7 }),
    });

    await model.invoke([new HumanMessage('hi')]);

    expect(seen.body).toMatchObject({ model: 'llama3.1:8b' });
    expect(seen.body?.options).toMatchObject({ temperature: 0.7 });
  });
});
