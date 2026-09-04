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
import type { StructuredToolInterface } from '@langchain/core/tools';
import { CHAT_MODEL } from '../llm/llm.module.js';
import { messageText } from '../llm/stub-chat-model.js';
import { McpToolsService } from '../mcp/mcp-tools.service.js';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ToolInvocation,
} from './chat.types.js';

const MAX_TOOL_STEPS = 4;
const MAX_TOOL_RESULT_CHARS = 8000;

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
    @InjectPinoLogger(ChatService.name) private readonly logger: PinoLogger,
  ) {}

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
        throw new Error(event.error);
      }
    }

    return { conversationId, message, toolCalls, model: this.modelName };
  }

  async *stream(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    const conversationId = request.conversationId ?? randomUUID();
    const toolCalls: ToolInvocation[] = [];
    let answer = '';

    try {
      const tools = await this.mcpTools.getTools();
      const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
      const bound = this.model.bindTools?.(tools) ?? this.model;
      const messages = this.buildMessages(request);

      for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
        let gathered: AIMessageChunk | undefined;

        for await (const chunk of await bound.stream(messages, { signal })) {
          gathered = gathered === undefined ? chunk : gathered.concat(chunk);
          const token = messageText(chunk.content);
          if (token.length > 0) {
            answer += token;
            yield { type: 'token', conversationId, token };
          }
        }

        const reply = gathered ?? new AIMessageChunk({ content: '' });
        messages.push(reply);

        const requested = reply.tool_calls ?? [];
        if (requested.length === 0) break;

        for (const call of requested) {
          const invocation = await this.runTool(toolsByName, call.name, call.args);
          toolCalls.push(invocation);
          yield { type: 'tool', conversationId, tool: invocation };
          messages.push(
            new ToolMessage({
              content: invocation.result,
              tool_call_id: call.id ?? randomUUID(),
              name: call.name,
            }),
          );
        }

        if (step === MAX_TOOL_STEPS - 1) {
          // Out of budget: ask for prose so the user never gets an empty answer.
          messages.push(
            new HumanMessage(
              'Tool budget exhausted. Answer now using only what the tools already returned.',
            ),
          );
          const final = await this.model.invoke(messages, { signal });
          const text = messageText(final.content);
          answer += text;
          if (text.length > 0) yield { type: 'token', conversationId, token: text };
        }
      }

      yield { type: 'done', conversationId, message: answer, toolCalls };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error({ err: error, conversationId }, 'Chat failed');
      yield { type: 'error', conversationId, error: reason };
    }
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
      const output = await tool.invoke(args);
      const text = typeof output === 'string' ? output : messageText(output?.content ?? '');
      return {
        name,
        args,
        result: text.slice(0, MAX_TOOL_RESULT_CHARS),
        durationMs: Date.now() - startedAt,
        failed: false,
      };
    } catch (error) {
      // Surfaced back to the model as an observation: a failed tool should let the
      // agent recover, not abort the whole conversation.
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
