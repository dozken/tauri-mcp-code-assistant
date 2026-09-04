import { z } from 'zod';

export const MAX_MESSAGE_LENGTH = 32_000;
export const MAX_HISTORY_MESSAGES = 50;

const chatRoleSchema = z.enum(['user', 'assistant']);

export const chatHistoryMessageSchema = z.object({
  role: chatRoleSchema,
  content: z.string().max(MAX_MESSAGE_LENGTH),
});

/** `POST /chat` body, and the payload of the `chat:send` socket event. */
export const chatRequestSchema = z.object({
  message: z.string().trim().min(1, 'message is required').max(MAX_MESSAGE_LENGTH),
  history: z.array(chatHistoryMessageSchema).max(MAX_HISTORY_MESSAGES).optional(),
  conversationId: z.string().optional(),
  /** Restrict retrieval to one indexed folder. */
  root: z.string().optional(),
});

export const toolInvocationSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  result: z.string(),
  durationMs: z.number().int().nonnegative(),
  failed: z.boolean(),
});

export const chatResponseSchema = z.object({
  conversationId: z.string(),
  message: z.string(),
  toolCalls: z.array(toolInvocationSchema),
  model: z.string(),
});

const streamBase = { conversationId: z.string() };

export const chatTokenEventSchema = z.object({
  ...streamBase,
  type: z.literal('token'),
  token: z.string(),
});
export const chatToolEventSchema = z.object({
  ...streamBase,
  type: z.literal('tool'),
  tool: toolInvocationSchema,
});
export const chatDoneEventSchema = z.object({
  ...streamBase,
  type: z.literal('done'),
  message: z.string(),
  toolCalls: z.array(toolInvocationSchema),
});
export const chatErrorEventSchema = z.object({
  ...streamBase,
  type: z.literal('error'),
  error: z.string(),
});

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  chatTokenEventSchema,
  chatToolEventSchema,
  chatDoneEventSchema,
  chatErrorEventSchema,
]);

export const cancelChatResponseSchema = z.object({ cancelled: z.boolean() });

export type ChatHistoryMessage = z.infer<typeof chatHistoryMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type ChatTokenEvent = z.infer<typeof chatTokenEventSchema>;
export type ChatToolEvent = z.infer<typeof chatToolEventSchema>;
export type ChatDoneEvent = z.infer<typeof chatDoneEventSchema>;
export type ChatErrorEvent = z.infer<typeof chatErrorEventSchema>;
export type CancelChatResponse = z.infer<typeof cancelChatResponseSchema>;
