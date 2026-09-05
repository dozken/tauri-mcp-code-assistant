import { beforeEach, describe, expect, it } from 'vitest';
import { initialState, useAppStore } from './appStore';
import type { IndexProgressEvent, IndexStatus, ToolInvocation } from '@ai-code-companion/contracts';

// Merge (not replace): a replacing setState would wipe the actions too.
const reset = (): void => useAppStore.setState({ ...initialState, messages: [] });

const toolCall = (overrides: Partial<ToolInvocation> = {}): ToolInvocation => ({
  name: 'search_code',
  args: { query: 'auth' },
  result: 'src/auth.ts:1-10',
  durationMs: 12,
  failed: false,
  ...overrides,
});

const status = (overrides: Partial<IndexStatus> = {}): IndexStatus => ({
  activeJob: null,
  roots: [
    {
      path: '/repo',
      fileCount: 3,
      chunkCount: 9,
      lastIndexedAt: '2026-01-01T00:00:00Z',
      stale: false,
    },
  ],
  vectorStore: 'chroma',
  metadataStore: 'sqlite',
  totalChunks: 9,
  ...overrides,
});

const progress = (overrides: Partial<IndexProgressEvent> = {}): IndexProgressEvent => ({
  jobId: 'job-1',
  root: '/repo',
  state: 'running',
  filesDiscovered: 10,
  filesIndexed: 4,
  filesSkipped: 0,
  chunksIndexed: 12,
  percent: 40,
  ...overrides,
});

describe('appStore', () => {
  beforeEach(reset);

  it('starts empty and disconnected', () => {
    expect(useAppStore.getState()).toMatchObject({
      connected: false,
      messages: [],
      isStreaming: false,
    });
  });

  it('streams an assistant turn from tokens to completion', () => {
    const store = useAppStore.getState();
    store.addUserMessage('where is auth?');
    store.beginAssistantMessage();
    store.addToolCall(toolCall());
    store.appendToken('Found ');
    store.appendToken('it.');

    expect(useAppStore.getState().isStreaming).toBe(true);
    expect(useAppStore.getState().messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'Found it.',
      streaming: true,
    });

    useAppStore.getState().completeAssistantMessage('Found it. See src/auth.ts:1-10');

    const final = useAppStore.getState();
    expect(final.isStreaming).toBe(false);
    expect(final.messages).toHaveLength(2);
    expect(final.messages[1]).toMatchObject({
      streaming: false,
      content: 'Found it. See src/auth.ts:1-10',
    });
    expect(final.messages[1]!.toolCalls).toHaveLength(1);
  });

  it('keeps the streamed text when `done` carries no message', () => {
    const store = useAppStore.getState();
    store.beginAssistantMessage();
    store.appendToken('partial');
    store.completeAssistantMessage();

    expect(useAppStore.getState().messages[0]!.content).toBe('partial');
  });

  it('ignores tokens that arrive after the turn finished', () => {
    const store = useAppStore.getState();
    store.beginAssistantMessage();
    store.appendToken('done');
    store.completeAssistantMessage();

    useAppStore.getState().appendToken(' late');
    useAppStore.getState().addToolCall(toolCall({ name: 'explain_file' }));

    expect(useAppStore.getState().messages[0]!.content).toBe('done');
    expect(useAppStore.getState().messages[0]!.toolCalls).toHaveLength(0);
  });

  it('records an error on the streaming message and stops streaming', () => {
    const store = useAppStore.getState();
    store.addUserMessage('hi');
    store.beginAssistantMessage();
    store.failAssistantMessage('backend exploded');

    const state = useAppStore.getState();
    expect(state.isStreaming).toBe(false);
    expect(state.error).toBe('backend exploded');
    expect(state.messages.at(-1)).toMatchObject({ error: 'backend exploded', streaming: false });
  });

  it('clears the transcript and the conversation id together', () => {
    const store = useAppStore.getState();
    store.addUserMessage('hi');
    store.beginAssistantMessage('conv-1');
    store.completeAssistantMessage('hello');

    useAppStore.getState().clearMessages();

    expect(useAppStore.getState().messages).toEqual([]);
    expect(useAppStore.getState().conversationId).toBeUndefined();
  });

  it('applies status and keeps a selection that still exists', () => {
    useAppStore.getState().applyStatus(status());
    useAppStore.getState().selectRoot('/repo');
    useAppStore.getState().applyStatus(status());

    expect(useAppStore.getState()).toMatchObject({
      vectorStore: 'chroma',
      totalChunks: 9,
      selectedRoot: '/repo',
    });
  });

  it('drops a selection whose folder was removed', () => {
    useAppStore.getState().applyStatus(status());
    useAppStore.getState().selectRoot('/repo');

    useAppStore.getState().applyStatus(status({ roots: [], totalChunks: 0 }));

    expect(useAppStore.getState().selectedRoot).toBeUndefined();
  });

  it('tracks an active job and clears it when the job ends', () => {
    useAppStore.getState().applyProgress(progress());
    expect(useAppStore.getState().activeJob).toMatchObject({ percent: 40 });

    useAppStore.getState().applyProgress(progress({ state: 'completed', percent: 100 }));
    expect(useAppStore.getState().activeJob).toBeNull();
  });

  it('surfaces a failed indexing job as an error', () => {
    useAppStore.getState().applyProgress(progress({ state: 'failed', error: 'permission denied' }));

    expect(useAppStore.getState().activeJob).toBeNull();
    expect(useAppStore.getState().error).toBe('permission denied');
  });
});

describe('initialState', () => {
  it('names every optional key, so `setState(initialState)` is a real reset', () => {
    // `setState` merges: an optional key omitted here would survive the reset and
    // leak into the next test (or, in the app, the next conversation).
    useAppStore.setState({
      selectedRoot: '/repo',
      error: 'boom',
      conversationId: 'conv-1',
      connected: true,
    });

    useAppStore.setState(initialState);

    expect(useAppStore.getState()).toMatchObject({
      selectedRoot: undefined,
      error: undefined,
      conversationId: undefined,
      connected: false,
    });
  });
});

describe('appStore internals the streaming path depends on', () => {
  beforeEach(reset);

  it('writes to the newest assistant message, not an earlier one', () => {
    const store = useAppStore.getState();
    store.addUserMessage('first');
    store.beginAssistantMessage();
    store.completeAssistantMessage('first answer');
    store.addUserMessage('second');
    store.beginAssistantMessage();

    useAppStore.getState().appendToken('tokens for the second turn');

    const messages = useAppStore.getState().messages;
    expect(messages[1]?.content).toBe('first answer');
    expect(messages.at(-1)?.content).toBe('tokens for the second turn');
  });

  it('ignores a stray token when no assistant turn is open', () => {
    // A late token from a cancelled turn must not append itself to the transcript.
    const store = useAppStore.getState();
    store.addUserMessage('hello');

    useAppStore.getState().appendToken('late');

    expect(useAppStore.getState().messages.map((entry) => entry.content)).toEqual(['hello']);
  });

  it('still produces unique ids where randomUUID is unavailable', () => {
    // Not a secure context — a plain http:// dev server, or an older webview —
    // and the DOM types insist `crypto.randomUUID` is always there. Without the
    // fallback every message shares the key `undefined` and React reuses nodes.
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });

    try {
      const store = useAppStore.getState();
      store.addUserMessage('one');
      store.addUserMessage('two');

      const ids = useAppStore.getState().messages.map((entry) => entry.id);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });

  it('drops a selected folder that the backend no longer reports', () => {
    useAppStore.setState({ selectedRoot: '/gone' });

    useAppStore.getState().applyStatus({
      activeJob: null,
      roots: [
        {
          path: '/still-here',
          fileCount: 1,
          chunkCount: 1,
          lastIndexedAt: '2026-01-01T00:00:00.000Z',
          stale: false,
        },
      ],
      vectorStore: 'memory',
      metadataStore: 'sqlite',
      totalChunks: 1,
    });

    // Left in place, every search would filter to a folder that is not indexed.
    expect(useAppStore.getState().selectedRoot).toBeUndefined();
  });

  it('keeps a selected folder that is still reported', () => {
    useAppStore.setState({ selectedRoot: '/kept' });

    useAppStore.getState().applyStatus({
      activeJob: null,
      roots: [
        {
          path: '/kept',
          fileCount: 1,
          chunkCount: 1,
          lastIndexedAt: '2026-01-01T00:00:00.000Z',
          stale: false,
        },
      ],
      vectorStore: 'memory',
      metadataStore: 'sqlite',
      totalChunks: 1,
    });

    expect(useAppStore.getState().selectedRoot).toBe('/kept');
  });

  it.each([
    ['failed', 'disk full'],
    ['completed', undefined],
    ['cancelled', undefined],
  ])('surfaces the error of a %s job as %p', (state, expected) => {
    useAppStore.getState().applyProgress({
      jobId: 'j1',
      root: '/repo',
      state: state as 'failed' | 'completed' | 'cancelled',
      filesDiscovered: 1,
      filesIndexed: 1,
      filesSkipped: 0,
      chunksIndexed: 1,
      percent: 100,
      error: 'disk full',
    });

    expect(useAppStore.getState().error).toBe(expected);
  });
});
