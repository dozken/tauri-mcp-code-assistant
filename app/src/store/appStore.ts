import { create } from 'zustand';
import type {
  IndexProgressEvent,
  IndexStatus,
  IndexedRoot,
  ToolInvocation,
} from '@ai-code-companion/contracts';
import type { ChatMessage } from '../types';

export interface AppState {
  connected: boolean;
  messages: ChatMessage[];
  isStreaming: boolean;
  conversationId?: string;

  roots: IndexedRoot[];
  activeJob: IndexProgressEvent | null;
  vectorStore: IndexStatus['vectorStore'];
  metadataStore: IndexStatus['metadataStore'];
  totalChunks: number;
  /** `undefined` searches every indexed folder. */
  selectedRoot?: string;
  error?: string;
}

/**
 * Declared as function properties rather than methods: these are plain closures,
 * never bound to `this`, and property syntax keeps them contravariant (method
 * syntax is bivariant, and reads as an unbound method at every call site).
 */
interface AppActions {
  setConnected: (connected: boolean) => void;
  setError: (error?: string) => void;

  addUserMessage: (content: string) => void;
  /** Opens the assistant bubble that streamed tokens will land in. */
  beginAssistantMessage: (conversationId?: string) => void;
  appendToken: (token: string) => void;
  addToolCall: (tool: ToolInvocation) => void;
  completeAssistantMessage: (content?: string) => void;
  failAssistantMessage: (error: string) => void;
  clearMessages: () => void;

  applyStatus: (status: IndexStatus) => void;
  applyProgress: (progress: IndexProgressEvent) => void;
  selectRoot: (root?: string) => void;
}

export type AppStore = AppState & AppActions;

export const initialState: AppState = {
  connected: false,
  messages: [],
  isStreaming: false,
  // Named explicitly, undefined and all: `setState` merges, so an optional key
  // left out here would survive a "reset" and leak into the next state.
  conversationId: undefined,
  roots: [],
  activeJob: null,
  vectorStore: 'memory',
  metadataStore: 'memory',
  totalChunks: 0,
  selectedRoot: undefined,
  error: undefined,
};

const createId = (): string => {
  // `crypto.randomUUID` is unavailable outside secure contexts even though the DOM
  // lib types it as always present, so the fallback is real. These ids are React
  // keys, not tokens, so a non-cryptographic fallback is fine.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, sonarjs/pseudo-random
  return globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`;
};

const message = (role: ChatMessage['role'], content: string, streaming = false): ChatMessage => ({
  id: createId(),
  role,
  content,
  createdAt: Date.now(),
  toolCalls: [],
  streaming,
});

/**
 * Applies `update` to the newest assistant message. Every streaming mutation goes
 * through here so a stray event that arrives after the turn ended (a late token,
 * a duplicated `done`) cannot corrupt an earlier message.
 */
const updateLastAssistant = (
  messages: ChatMessage[],
  update: (current: ChatMessage) => ChatMessage,
): ChatMessage[] => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const current = messages[index];
    if (current?.role === 'assistant') {
      const next = [...messages];
      next[index] = update(current);
      return next;
    }
  }
  return messages;
};

/**
 * The single source of truth for the UI. Deliberately synchronous and free of
 * I/O — the socket and HTTP layers call these mutators — which keeps the store
 * unit-testable without mocking a network.
 */
export const useAppStore = create<AppStore>()((set) => ({
  ...initialState,

  setConnected: (connected) => set({ connected }),
  setError: (error) => set({ error }),

  addUserMessage: (content) =>
    set((state) => ({
      messages: [...state.messages, message('user', content)],
      error: undefined,
    })),

  beginAssistantMessage: (conversationId) =>
    set((state) => ({
      messages: [...state.messages, message('assistant', '', true)],
      isStreaming: true,
      conversationId: conversationId ?? state.conversationId,
    })),

  appendToken: (token) =>
    set((state) => ({
      messages: updateLastAssistant(state.messages, (current) =>
        current.streaming ? { ...current, content: current.content + token } : current,
      ),
    })),

  addToolCall: (tool) =>
    set((state) => ({
      messages: updateLastAssistant(state.messages, (current) =>
        current.streaming ? { ...current, toolCalls: [...current.toolCalls, tool] } : current,
      ),
    })),

  completeAssistantMessage: (content) =>
    set((state) => ({
      isStreaming: false,
      messages: updateLastAssistant(state.messages, (current) =>
        current.streaming
          ? { ...current, streaming: false, content: content ?? current.content }
          : current,
      ),
    })),

  failAssistantMessage: (error) =>
    set((state) => ({
      isStreaming: false,
      error,
      messages: updateLastAssistant(state.messages, (current) =>
        current.streaming ? { ...current, streaming: false, error } : current,
      ),
    })),

  clearMessages: () => set({ messages: [], conversationId: undefined, error: undefined }),

  applyStatus: (status) =>
    set((state) => ({
      roots: status.roots,
      activeJob: status.activeJob,
      vectorStore: status.vectorStore,
      metadataStore: status.metadataStore,
      totalChunks: status.totalChunks,
      // Drop a selection whose folder is gone, otherwise every search silently
      // filters to nothing.
      selectedRoot: status.roots.some((root) => root.path === state.selectedRoot)
        ? state.selectedRoot
        : undefined,
    })),

  applyProgress: (progress) =>
    set(() => ({
      activeJob: progress.state === 'running' ? progress : null,
      error: progress.state === 'failed' ? progress.error : undefined,
    })),

  selectRoot: (selectedRoot) => set({ selectedRoot }),
}));
