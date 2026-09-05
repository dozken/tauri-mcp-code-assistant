import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { MessageContent } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';
import { CHAT_MODEL } from '../llm/llm.module.js';
import { messageText } from '../llm/stub-chat-model.js';
import { McpToolsService } from '../mcp/mcp-tools.service.js';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ToolInvocation,
} from '@ai-code-companion/contracts';

// Sub-second deadlines only really occur in tests, but rounding 500ms to "1s"
// makes the one message a reader checks against their config a lie.
const humaniseMs = (ms: number): string =>
  ms < 1000 ? `${String(ms)}ms` : `${String(Math.round(ms / 1000))}s`;

const TIMEOUT_MESSAGE = (ms: number): string =>
  `The model did not answer within ${humaniseMs(ms)}, so the request was cancelled. ` +
  'Raise LLM_TIMEOUT_MS if your model is legitimately this slow.';

/**
 * Raised by the blocking variant so the HTTP layer can answer 504 rather than 500.
 * Declared here, but deliberately not an HttpException: this service also backs the
 * Socket.IO gateway and must not know about HTTP.
 */
export class ChatTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatTimeoutError';
  }
}

/** True when *our* deadline fired, as opposed to the caller pressing Stop. */
const isTimeout = (signal: AbortSignal): boolean =>
  signal.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError';

/**
 * Settles as soon as either the work or the signal does.
 *
 * A tool is handed the signal and is free to ignore it — an MCP tool is a
 * separate process, and nothing here can reach into it. Racing the signal caps
 * the turn either way: the call is left to finish and its result discarded,
 * which is the most that can be done from this side. The listener is removed
 * once the work settles so a turn full of tool calls does not accumulate them.
 */
const raceAbort = async <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (signal === undefined) return work;

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // Attaching handlers here is also what keeps a late rejection from the
    // discarded call from surfacing as an unhandled one.
    void work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
};

/** Either the bare model or the same model with tools bound; both stream chunks. */
type ChatModelLike = Runnable<BaseLanguageModelInput, AIMessageChunk>;

const MAX_TOOL_STEPS = 4;
const MAX_TOOL_RESULT_CHARS = 8000;

/**
 * A LangChain tool returns a string, or a `ToolMessage` when it was invoked with a
 * tool call. `invoke` is typed `any`, so the narrowing happens once, here.
 */
const toolOutputText = (output: unknown): string => {
  if (typeof output === 'string') return output;
  if (output !== null && typeof output === 'object' && 'content' in output) {
    return messageText((output as { content: MessageContent }).content);
  }
  // `JSON.stringify(undefined)` is `undefined` at runtime despite its `string` type.
  return JSON.stringify(output ?? null);
};

const SYSTEM_PROMPT = `You are the AI Code Companion, embedded in a desktop app that has indexed the user's local codebase.

Rules:
- Before answering anything about the user's code, call search_code to ground yourself in the actual source.
- Cite what you used as \`relative/path.ts:12-40\`.
- Call explain_file when the user names a specific file.
- Call generate_snippet when the user asks for new code.
- If retrieval comes back empty, say so plainly and suggest indexing a folder. Never invent file paths.`;

/**
 * The agent loop: bind tools, stream the model, execute any tool calls it emits,
 * feed the observations back, repeat until it answers in prose.
 *
 * Written out rather than delegated to a prebuilt agent because it is the part a
 * reviewer most wants to see, and because streaming tokens straight out of the
 * loop needs control over each turn.
 */
@Injectable()
export class ChatService {
  constructor(
    @Inject(CHAT_MODEL) private readonly model: BaseChatModel,
    private readonly mcpTools: McpToolsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(ChatService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * The caller's signal (the Stop button) combined with a deadline for the whole
   * turn. Returned separately from its disposer so the timer can be cleared the
   * moment the turn ends — an uncleared `AbortSignal.timeout` keeps the event loop
   * alive for its full duration, which turns a fast reply into a slow shutdown.
   */
  private withDeadline(signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new DOMException(TIMEOUT_MESSAGE(this.config.llm.timeoutMs), 'TimeoutError'));
    }, this.config.llm.timeoutMs);

    return {
      signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      done: () => {
        clearTimeout(timer);
      },
    };
  }

  /** Non-streaming variant, built on the same generator so behaviour cannot drift. */
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const conversationId = request.conversationId ?? randomUUID();
    let message = '';
    let toolCalls: ToolInvocation[] = [];

    for await (const event of this.stream({ ...request, conversationId }, signal)) {
      if (event.type === 'done') {
        message = event.message;
        toolCalls = event.toolCalls;
      } else if (event.type === 'error') {
        // Compared against the string we generate, not pattern-matched on someone
        // else's error text.
        throw event.error === TIMEOUT_MESSAGE(this.config.llm.timeoutMs)
          ? new ChatTimeoutError(event.error)
          : new Error(event.error);
      }
    }

    return { conversationId, message, toolCalls, model: this.modelName };
  }

  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    const conversationId = request.conversationId ?? randomUUID();
    const toolCalls: ToolInvocation[] = [];
    const deadline = this.withDeadline(signal);
    let answer = '';

    try {
      const tools = await this.mcpTools.getTools();
      const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
      const bound = this.model.bindTools?.(tools) ?? this.model;
      const messages = this.buildMessages(request);

      for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
        // `yield*` forwards every token to the caller and hands back the turn's
        // reassembled reply — tool calls arrive as fragments and only exist once
        // the stream ends.
        const turn = yield* this.streamTurn(bound, messages, conversationId, deadline.signal);
        answer += turn.text;
        messages.push(turn.reply);

        const requested = turn.reply.tool_calls ?? [];
        if (requested.length === 0) break;

        for await (const invocation of this.runToolCalls(
          toolsByName,
          requested,
          messages,
          deadline.signal,
        )) {
          toolCalls.push(invocation);
          yield { type: 'tool', conversationId, tool: invocation };
        }

        if (step === MAX_TOOL_STEPS - 1) {
          const text = await this.forceAnswer(messages, deadline.signal);
          answer += text;
          if (text.length > 0) yield { type: 'token', conversationId, token: text };
        }
      }

      yield { type: 'done', conversationId, message: answer, toolCalls };
    } catch (error) {
      this.logger.error({ err: error, conversationId }, 'Chat failed');
      yield { type: 'error', conversationId, error: this.describeFailure(error, deadline.signal) };
    } finally {
      deadline.done();
    }
  }

  /**
   * A deadline abort surfaces as whatever the model layer wrapped it in, so ask the
   * signal rather than trying to pattern-match somebody else's error text.
   */
  private describeFailure(error: unknown, signal: AbortSignal): string {
    if (isTimeout(signal)) return TIMEOUT_MESSAGE(this.config.llm.timeoutMs);
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * One model turn: yields each text token as it arrives and *returns* the
   * reassembled reply, so `stream` can `yield*` it in a single expression.
   */
  private async *streamTurn(
    model: ChatModelLike,
    messages: BaseMessage[],
    conversationId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent, { reply: AIMessageChunk; text: string }> {
    let gathered: AIMessageChunk | undefined;
    let text = '';

    for await (const chunk of await model.stream(messages, { signal })) {
      // `AIMessageChunk#concat` merges partial tool calls; it is not `Array#concat`.
      // eslint-disable-next-line unicorn/prefer-spread
      gathered = gathered === undefined ? chunk : gathered.concat(chunk);
      const token = messageText(chunk.content);
      if (token.length > 0) {
        text += token;
        yield { type: 'token', conversationId, token };
      }
    }

    return { reply: gathered ?? new AIMessageChunk({ content: '' }), text };
  }

  /**
   * Runs the tool calls from one turn and appends each observation to `messages`,
   * yielding the invocation so the caller can stream it to the client.
   */
  private async *runToolCalls(
    tools: ReadonlyMap<string, StructuredToolInterface>,
    calls: readonly { id?: string; name: string; args: Record<string, unknown> }[],
    messages: BaseMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<ToolInvocation> {
    for (const call of calls) {
      const invocation = await this.runTool(tools, call.name, call.args, signal);
      messages.push(
        new ToolMessage({
          content: invocation.result,
          tool_call_id: call.id ?? randomUUID(),
          name: call.name,
        }),
      );
      yield invocation;
    }
  }

  /** Last resort when the tool budget runs out, so the user never gets an empty answer. */
  private async forceAnswer(messages: BaseMessage[], signal?: AbortSignal): Promise<string> {
    messages.push(
      new HumanMessage(
        'Tool budget exhausted. Answer now using only what the tools already returned.',
      ),
    );
    const final = await this.model.invoke(messages, { signal });
    return messageText(final.content);
  }

  get modelName(): string {
    return this.model._llmType();
  }

  private buildMessages(request: ChatRequest): BaseMessage[] {
    const messages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT)];

    if (request.root) {
      messages.push(
        new SystemMessage(`Restrict every search_code call to root="${request.root}".`),
      );
    }

    for (const entry of request.history ?? []) {
      messages.push(
        entry.role === 'user' ? new HumanMessage(entry.content) : new AIMessage(entry.content),
      );
    }

    messages.push(new HumanMessage(request.message));
    return messages;
  }

  private async runTool(
    tools: ReadonlyMap<string, StructuredToolInterface>,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolInvocation> {
    const startedAt = Date.now();
    const tool = tools.get(name);

    if (!tool) {
      return {
        name,
        args,
        result: `Unknown tool "${name}". Available: ${[...tools.keys()].join(', ')}.`,
        durationMs: 0,
        failed: true,
      };
    }

    try {
      const output: unknown = await raceAbort(tool.invoke(args, { signal }), signal);
      return {
        name,
        args,
        result: toolOutputText(output).slice(0, MAX_TOOL_RESULT_CHARS),
        durationMs: Date.now() - startedAt,
        failed: false,
      };
    } catch (error) {
      // A deadline or a Stop is the turn ending, not this tool failing. Letting it
      // propagate reports one timeout instead of turning every remaining call in
      // the batch into its own "tool failed" observation.
      if (signal?.aborted === true) throw error;

      // Otherwise: surfaced back to the model as an observation, so a failed tool
      // lets the agent recover rather than aborting the whole conversation.
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, tool: name }, 'Tool call failed');
      return {
        name,
        args,
        result: `Tool "${name}" failed: ${reason}`,
        durationMs: Date.now() - startedAt,
        failed: true,
      };
    }
  }
}
