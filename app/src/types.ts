/**
 * Wire types shared with the NestJS backend.
 *
 * Duplicated by hand rather than imported: the app is bundled for a webview and
 * must not pull in Node-only backend code. In a larger repo this file would come
 * from a `packages/contracts` workspace generated from the Nest DTOs.
 */

export type IndexJobState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface IndexProgressEvent {
  jobId: string;
  root: string;
  state: IndexJobState;
  filesDiscovered: number;
  filesIndexed: number;
  chunksIndexed: number;
  currentFile?: string;
  error?: string;
  percent: number;
}

export interface IndexedRoot {
  path: string;
  fileCount: number;
  chunkCount: number;
  lastIndexedAt: string;
  stale: boolean;
}

export interface IndexStatus {
  activeJob: IndexProgressEvent | null;
  roots: IndexedRoot[];
  vectorStore: 'chroma' | 'memory';
  metadataStore: 'sqlite' | 'memory';
  totalChunks: number;
}

export interface ToolInvocation {
  name: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
  failed: boolean;
}

export type ChatStreamEvent =
  | { type: 'token'; conversationId: string; token: string }
  | { type: 'tool'; conversationId: string; tool: ToolInvocation }
  | { type: 'done'; conversationId: string; message: string; toolCalls: ToolInvocation[] }
  | { type: 'error'; conversationId: string; error: string };

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
