import { describe, expect, it } from 'vitest';
import { HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { StubChatModel, messageText, tokenise } from './stub-chat-model.js';
import { createChatModel } from './llm.module.js';
import { testConfig, testPlugins } from '../../test/helpers.js';

const searchTool = tool(async () => 'result', {
  name: 'search_code',
  description: 'search',
  schema: z.object({ query: z.string() }),
});

describe('tokenise', () => {
  it('preserves whitespace so the stream reassembles exactly', () => {
    const text = 'Hello  world\nagain';
    expect(tokenise(text).join('')).toBe(text);
  });

  it('returns nothing for an empty string', () => {
    expect(tokenise('')).toEqual([]);
  });
});

describe('messageText', () => {
  it('passes a plain string through', () => {
    expect(messageText('hello')).toBe('hello');
  });

  it('concatenates textual content blocks and ignores the rest', () => {
    expect(
      messageText([
        { type: 'text', text: 'a' },
        { type: 'image_url', image_url: { url: 'x' } },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('ab');
  });

  it('never stringifies an object into the answer', () => {
    expect(messageText([{ type: 'text', text: { nested: true } }])).toBe('');
  });
});

describe('StubChatModel', () => {
  const model = new StubChatModel({ tokenDelayMs: 0 });

  it('identifies itself so /chat can report the provider', () => {
    expect(model._llmType()).toBe('stub-chat-model');
  });

  it('calls the retrieval tool on the first turn', async () => {
    const reply = await model.bindTools([searchTool]).invoke([new HumanMessage('where is auth?')]);

    expect(reply.tool_calls).toEqual([
      expect.objectContaining({ name: 'search_code', args: { query: 'where is auth?', limit: 5 } }),
    ]);
  });

  it('answers in prose once a tool has reported back', async () => {
    const reply = await model
      .bindTools([searchTool])
      .invoke([
        new HumanMessage('where is auth?'),
        new ToolMessage({ content: 'src/auth.ts:1-3', tool_call_id: 'x', name: 'search_code' }),
      ]);

    expect(reply.tool_calls ?? []).toEqual([]);
    expect(messageText(reply.content)).toContain('src/auth.ts:1-3');
  });

  it('answers directly when no retrieval tool is bound', async () => {
    const reply = await model.invoke([new HumanMessage('hello')]);

    expect(reply.tool_calls ?? []).toEqual([]);
    expect(messageText(reply.content)).toContain('Offline stub model');
  });

  it('says nothing is indexed rather than inventing an answer', async () => {
    const reply = await model.invoke([new HumanMessage('explain auth')]);

    expect(messageText(reply.content)).toMatch(/Nothing has been indexed yet/);
  });

  it('handles a conversation with no human turn at all', async () => {
    const reply = await model.invoke([new SystemMessage('you are a bot')]);

    expect(messageText(reply.content)).toContain('Offline stub model');
  });

  it('streams the answer in pieces that rebuild the whole message', async () => {
    const chunks: string[] = [];
    for await (const chunk of await model.stream([new HumanMessage('hi')])) {
      chunks.push(messageText(chunk.content));
    }

    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join('')).toContain('Offline stub model');
  });

  it('streams a tool call as a single indivisible chunk', async () => {
    const chunks = [];
    for await (const chunk of await model.bindTools([searchTool]).stream([new HumanMessage('q')])) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.tool_calls?.[0]?.name).toBe('search_code');
  });
});

describe('createChatModel', () => {
  it('returns the offline stub when no provider is configured', async () => {
    const model = await createChatModel(await testPlugins(), testConfig());

    expect(model._llmType()).toBe('stub-chat-model');
  });

  it('refuses to build an OpenAI model without a key rather than failing later', async () => {
    const config = testConfig();

    await expect(
      createChatModel(await testPlugins(), {
        ...config,
        llm: { ...config.llm, provider: 'openai', apiKey: undefined },
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('builds an OpenAI model when a key is present', async () => {
    const config = testConfig();

    const model = await createChatModel(await testPlugins(), {
      ...config,
      llm: { ...config.llm, provider: 'openai', apiKey: 'sk-test' },
    });

    expect(model._llmType()).not.toBe('stub-chat-model');
  });

  it('names the providers that exist when the configured one does not', async () => {
    // `LLM_PROVIDER` is a registry kind now, so a typo is a startup error rather
    // than a silent fall back to the stub answering with no model at all.
    const config = testConfig();

    await expect(
      createChatModel(await testPlugins(), {
        ...config,
        llm: { ...config.llm, provider: 'oepnai' },
      }),
    ).rejects.toThrow(/"oepnai".*openai, stub/s);
  });
});
