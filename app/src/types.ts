import type { ToolInvocation } from '@ai-code-companion/contracts';

/**
 * UI-only types. Everything that crosses a process boundary lives in
 * `@ai-code-companion/contracts` and is imported from there directly.
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  toolCalls: ToolInvocation[];
  /** True while tokens are still arriving for this message. */
  streaming: boolean;
  error?: string;
}
