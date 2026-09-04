export interface ChatHistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ChatRequest {
  readonly message: string;
  readonly history?: ChatHistoryMessage[];
  readonly conversationId?: string;
  /** Restrict retrieval to one indexed folder. */
  readonly root?: string;
}

export interface ToolInvocation {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result: string;
  readonly durationMs: number;
  readonly failed: boolean;
}

export interface ChatResponse {
  readonly conversationId: string;
  readonly message: string;
  readonly toolCalls: ToolInvocation[];
  readonly model: string;
}

export type ChatStreamEvent =
  | { readonly type: 'token'; readonly conversationId: string; readonly token: string }
  | { readonly type: 'tool'; readonly conversationId: string; readonly tool: ToolInvocation }
  | {
      readonly type: 'done';
      readonly conversationId: string;
      readonly message: string;
      readonly toolCalls: ToolInvocation[];
    }
  | { readonly type: 'error'; readonly conversationId: string; readonly error: string };
