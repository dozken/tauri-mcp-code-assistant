import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SOCKET_EVENTS, type IndexStatus } from '@ai-code-companion/contracts';
import { initialState, useAppStore } from '../store/appStore';

/** A Socket.IO stand-in that records handlers so a test can drive the server side. */
class FakeSocket {
  connected = false;
  readonly emitted: { event: string; payload: unknown }[] = [];
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void): this {
    (this.handlers.get(event) ?? this.handlers.set(event, new Set()).get(event))?.add(handler);
    return this;
  }

  off(event: string, handler: (payload: unknown) => void): this {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: string, payload: unknown): this {
    this.emitted.push({ event, payload });
    return this;
  }

  /** Simulates the server pushing an event. */
  receive(event: string, payload?: unknown): void {
    act(() => {
      this.receiveRaw(event, payload);
    });
  }

  /** Delivers without its own `act`, so a caller can batch a burst into one. */
  receiveRaw(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

const socket = new FakeSocket();
const fetchStatus = vi.fn<() => Promise<IndexStatus>>();
const startIndexing = vi.fn<(path: string) => Promise<unknown>>();

vi.mock('../api/socket', () => ({ getSocket: () => socket }));
vi.mock('../api/http', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchStatus: () => fetchStatus(),
    startIndexing: (path: string) => startIndexing(path),
  };
});

const { useBackend } = await import('./useBackend');

const status = (overrides: Partial<IndexStatus> = {}): IndexStatus => ({
  activeJob: null,
  roots: [],
  vectorStore: 'memory',
  metadataStore: 'sqlite',
  totalChunks: 0,
  ...overrides,
});

const progress = (state: 'running' | 'completed' = 'running') => ({
  jobId: 'job-1',
  root: '/repo',
  state,
  filesDiscovered: 4,
  filesIndexed: 2,
  chunksIndexed: 6,
  percent: 50,
});

describe('useBackend', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initialState, messages: [] });
    fetchStatus.mockReset().mockResolvedValue(status());
    startIndexing.mockReset().mockResolvedValue(undefined);
    socket.emitted.length = 0;
    socket.connected = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('marks the app connected and loads status on connect', async () => {
    renderHook(() => useBackend());

    socket.receive('connect');

    await waitFor(() => {
      expect(useAppStore.getState().connected).toBe(true);
    });
    expect(fetchStatus).toHaveBeenCalled();
  });

  it('surfaces a connection failure without pretending to be connected', () => {
    renderHook(() => useBackend());

    socket.receive('connect_error', new Error('ECONNREFUSED'));

    expect(useAppStore.getState()).toMatchObject({ connected: false });
    expect(useAppStore.getState().error).toMatch(/ECONNREFUSED/);
  });

  it('applies a valid progress event and re-reads status once the job ends', async () => {
    renderHook(() => useBackend());
    fetchStatus.mockClear();

    socket.receive(SOCKET_EVENTS.indexProgress, progress());
    expect(useAppStore.getState().activeJob).toMatchObject({ percent: 50 });
    expect(fetchStatus).not.toHaveBeenCalled();

    socket.receive(SOCKET_EVENTS.indexProgress, { ...progress('completed'), percent: 100 });
    await waitFor(() => {
      expect(fetchStatus).toHaveBeenCalledTimes(1);
    });
    expect(useAppStore.getState().activeJob).toBeNull();
  });

  it('ignores a malformed event and says so, rather than corrupting the store', () => {
    renderHook(() => useBackend());

    socket.receive(SOCKET_EVENTS.indexProgress, { jobId: 'x', percent: 'half' });

    expect(useAppStore.getState().activeJob).toBeNull();
    expect(useAppStore.getState().error).toMatch(/malformed "index:progress"/);
  });

  it('streams a chat turn into the store', () => {
    renderHook(() => useBackend());
    act(() => {
      useAppStore.getState().beginAssistantMessage();
    });

    socket.receive(SOCKET_EVENTS.chatToken, { conversationId: 'c', type: 'token', token: 'Hi ' });
    socket.receive(SOCKET_EVENTS.chatToken, { conversationId: 'c', type: 'token', token: 'there' });
    socket.receive(SOCKET_EVENTS.chatDone, {
      conversationId: 'c',
      type: 'done',
      message: 'Hi there',
      toolCalls: [],
    });

    expect(useAppStore.getState().messages[0]).toMatchObject({
      content: 'Hi there',
      streaming: false,
    });
  });

  it('coalesces a burst of tokens into one store write', async () => {
    renderHook(() => useBackend());
    act(() => {
      useAppStore.getState().beginAssistantMessage();
    });

    // A single tick delivering many packets is what socket.io actually does when
    // the model streams faster than the socket flushes. One React update per
    // token used to exceed React's nested-update limit and stop the render.
    const writes: number[] = [];
    const unsubscribe = useAppStore.subscribe(() => writes.push(1));
    act(() => {
      for (let index = 0; index < 200; index += 1) {
        socket.receiveRaw(SOCKET_EVENTS.chatToken, {
          conversationId: 'c',
          type: 'token',
          token: 'x',
        });
      }
    });

    await waitFor(() => {
      expect(useAppStore.getState().messages[0]?.content).toBe('x'.repeat(200));
    });
    unsubscribe();
    expect(writes.length).toBeLessThan(200);
  });

  it('records a streamed error on the message', () => {
    renderHook(() => useBackend());
    act(() => {
      useAppStore.getState().beginAssistantMessage();
    });

    socket.receive(SOCKET_EVENTS.chatError, {
      conversationId: 'c',
      type: 'error',
      error: 'model exploded',
    });

    expect(useAppStore.getState()).toMatchObject({ isStreaming: false, error: 'model exploded' });
  });

  it('sends the message with the recent history and the selected root', () => {
    const { result } = renderHook(() => useBackend());
    act(() => {
      const store = useAppStore.getState();
      store.addUserMessage('first');
      store.beginAssistantMessage();
      store.completeAssistantMessage('answer');
      store.selectRoot('/repo');
    });

    act(() => {
      result.current.sendMessage('  second  ');
    });

    expect(socket.emitted.at(-1)).toEqual({
      event: SOCKET_EVENTS.chatSend,
      payload: {
        message: 'second',
        history: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer' },
        ],
        conversationId: undefined,
        root: '/repo',
      },
    });
  });

  it('does not send an empty message or a second one mid-stream', () => {
    const { result } = renderHook(() => useBackend());

    act(() => {
      result.current.sendMessage('   ');
    });
    expect(socket.emitted).toHaveLength(0);

    act(() => {
      useAppStore.getState().beginAssistantMessage();
      result.current.sendMessage('too soon');
    });
    expect(socket.emitted).toHaveLength(0);
  });

  it('refreshes status after a successful index request', async () => {
    const { result } = renderHook(() => useBackend());
    fetchStatus.mockClear();

    await act(async () => {
      await result.current.indexFolder('/repo');
    });

    expect(startIndexing).toHaveBeenCalledWith('/repo');
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('reports a failed index request instead of throwing at the caller', async () => {
    startIndexing.mockRejectedValue(new Error('Path is outside the allowed roots'));
    const { result } = renderHook(() => useBackend());

    await act(async () => {
      await result.current.indexFolder('/etc');
    });

    expect(useAppStore.getState().error).toMatch(/outside the allowed roots/);
  });

  it('marks the app offline when the socket drops', () => {
    renderHook(() => useBackend());
    socket.receive('connect');

    socket.receive('disconnect');

    expect(useAppStore.getState().connected).toBe(false);
  });

  it('loads status immediately when the socket is already connected on mount', async () => {
    socket.connected = true;

    renderHook(() => useBackend());

    await waitFor(() => {
      expect(useAppStore.getState().connected).toBe(true);
    });
    expect(fetchStatus).toHaveBeenCalled();
  });

  it('keeps an unfinished or failed turn out of the replayed history', () => {
    const { result } = renderHook(() => useBackend());
    act(() => {
      const store = useAppStore.getState();
      store.addUserMessage('answered');
      store.beginAssistantMessage();
      store.completeAssistantMessage('an answer');
      store.addUserMessage('failed');
      store.beginAssistantMessage();
      store.failAssistantMessage('boom');
    });

    act(() => {
      result.current.sendMessage('next');
    });

    const { payload } = socket.emitted.at(-1) as { payload: { history: unknown[] } };
    // The errored assistant turn would poison the next prompt with a non-answer.
    expect(payload.history).toEqual([
      { role: 'user', content: 'answered' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: 'failed' },
    ]);
  });

  it('carries the conversation id once the backend has assigned one', () => {
    const { result } = renderHook(() => useBackend());
    act(() => {
      useAppStore.getState().beginAssistantMessage('conv-7');
      useAppStore.getState().completeAssistantMessage('hi');
    });

    act(() => {
      result.current.sendMessage('again');
    });

    expect(socket.emitted.at(-1)).toMatchObject({ payload: { conversationId: 'conv-7' } });
  });

  it('explains a contract mismatch as a version skew, not a network error', async () => {
    const { ContractError } = await import('../api/http');
    fetchStatus.mockRejectedValue(new ContractError('/status', 'totalChunks: required'));
    renderHook(() => useBackend());

    socket.receive('connect');

    await waitFor(() => {
      expect(useAppStore.getState().error).toMatch(/different versions/);
    });
  });

  it('removes every listener on unmount', () => {
    const { unmount } = renderHook(() => useBackend());
    expect(socket.listenerCount(SOCKET_EVENTS.chatToken)).toBe(1);

    unmount();

    for (const event of Object.values(SOCKET_EVENTS)) {
      expect(socket.listenerCount(event)).toBe(0);
    }
    expect(socket.listenerCount('connect')).toBe(0);
  });
});
