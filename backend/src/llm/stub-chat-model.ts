import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type MessageContent,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';

export interface StubChatModelCallOptions extends BaseChatModelCallOptions {
  tools?: BindToolsInput[];
}

export interface StubChatModelParams extends BaseChatModelParams {
  /** Delay between streamed tokens, in ms. 0 makes tests instant. */
  tokenDelayMs?: number;
  /** Tool the stub reaches for on the first turn of a conversation. */
  retrievalToolName?: string;
}

/**
 * Message content is either a string or a list of content blocks. Only textual
 * blocks contribute; an image or a tool-use block stringifies to `[object Object]`
 * if you are careless, which is exactly what the user would then see streamed.
 */
export const messageText = (content: MessageContent): string => {
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const text: unknown = 'text' in part ? part.text : undefined;
      return typeof text === 'string' ? text : '';
    })
    .join('');
};

const toolName = (tool: BindToolsInput): string | undefined => {
  const name: unknown = (tool as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
};

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}\n… (truncated)`;

/**
 * An offline stand-in for a hosted chat model.
 *
 * It is not a mock in the test-double sense: it implements the same `BaseChatModel`
 * contract as `ChatOpenAI` — tool binding, tool calls and token streaming — so the
 * agent loop in `ChatService` is exercised for real without an API key. Set
 * `OPENAI_API_KEY` and the same loop runs against a hosted model instead.
 */
export class StubChatModel extends BaseChatModel<StubChatModelCallOptions> {
  private readonly tokenDelayMs: number;
  private readonly retrievalToolName: string;

  constructor(params: StubChatModelParams = {}) {
    super(params);
    this.tokenDelayMs = params.tokenDelayMs ?? 8;
    this.retrievalToolName = params.retrievalToolName ?? 'search_code';
  }

  override _llmType(): string {
    return 'stub-chat-model';
  }

  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<StubChatModelCallOptions>,
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, StubChatModelCallOptions> {
    // LangChain v1 renamed `bind` to `withConfig`; the bound options land in
    // `_generate`/`_streamResponseChunks` as `options.tools`.
    return this.withConfig({ tools, ...kwargs });
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const message = this.plan(messages, options.tools ?? []);
    if (typeof message.content === 'string' && message.content.length > 0) {
      await runManager?.handleLLMNewToken(message.content);
    }
    return {
      generations: [{ text: messageText(message.content), message }],
      llmOutput: { model: this._llmType() },
    };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const message = this.plan(messages, options.tools ?? []);

    // A tool call is a single indivisible decision — there is nothing to stream.
    if ((message.tool_calls?.length ?? 0) > 0) {
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({ content: '', tool_calls: message.tool_calls }),
      });
      return;
    }

    for (const token of tokenise(messageText(message.content))) {
      if (options.signal?.aborted) return;
      if (this.tokenDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.tokenDelayMs));
      }
      await runManager?.handleLLMNewToken(token);
      yield new ChatGenerationChunk({
        text: token,
        message: new AIMessageChunk({ content: token }),
      });
    }
  }

  /**
   * One deterministic step of a ReAct loop: retrieve on the first turn, answer
   * from the retrieved context on the second.
   */
  private plan(messages: BaseMessage[], tools: BindToolsInput[]): AIMessage {
    const lastHumanIndex = findLastIndex(messages, (message) => message.type === 'human');
    const lastHuman = lastHumanIndex === -1 ? undefined : messages[lastHumanIndex];
    const question = lastHuman === undefined ? '' : messageText(lastHuman.content).trim();
    const since = messages.slice(lastHumanIndex + 1);
    const alreadySearched = since.some((message) => message.type === 'tool');
    const canSearch = tools.some((tool) => toolName(tool) === this.retrievalToolName);

    if (canSearch && !alreadySearched && question.length > 0) {
      return new AIMessage({
        content: '',
        tool_calls: [
          {
            id: `stub-${Date.now().toString(36)}`,
            name: this.retrievalToolName,
            args: { query: question, limit: 5 },
            type: 'tool_call',
          },
        ],
      });
    }

    const observations = since
      .filter((message) => message.type === 'tool')
      .map((message) => messageText(message.content))
      .join('\n\n')
      .trim();

    return new AIMessage({ content: this.compose(question, observations) });
  }

  private compose(question: string, observations: string): string {
    const header = question
      ? `**Offline stub model.** Here is what the index has for _"${question}"_:`
      : '**Offline stub model.**';

    const body = observations
      ? truncate(observations, 2000)
      : 'Nothing has been indexed yet — add a folder in the sidebar and try again.';

    return [
      header,
      '',
      body,
      '',
      '_No LLM was called. Set `OPENAI_API_KEY` (and optionally `OPENAI_BASE_URL`) to answer with a real model — the retrieval, tool-calling and streaming path is identical._',
    ].join('\n');
  }
}

/** Splits text into whitespace-preserving tokens so the stream reads naturally. */
export const tokenise = (text: string): string[] => text.match(/\s+|\S+/g) ?? [];

const findLastIndex = <T>(items: readonly T[], predicate: (item: T) => boolean): number => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && predicate(item)) return index;
  }
  return -1;
};
