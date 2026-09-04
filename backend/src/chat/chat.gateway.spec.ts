import { describe, expect, it, vi } from 'vitest';
import type { PinoLogger } from 'nestjs-pino';
import type { Socket } from 'socket.io';
import {
  SOCKET_EVENTS,
  type ChatRequest,
  type ChatStreamEvent,
} from '@ai-code-companion/contracts';
import { ChatGateway } from './chat.gateway.js';
import type { ChatService } from './chat.service.js';

/** A socket is only ever used for its id and `emit` here. */
const fakeClient = (id = 'socket-1') => {
  // Typed, so `emit.mock.calls` destructures as [event, payload] rather than any[].
  const emit = vi.fn<(event: string, payload: unknown) => boolean>();
  return { client: { id, emit } as unknown as Socket, emit };
};

const logger = { error: vi.fn() } as unknown as PinoLogger;

const token = (value: string): ChatStreamEvent => ({
  type: 'token',
  conversationId: 'c1',
  token: value,
});

/** Builds a gateway whose stream is driven by `produce`. */
const makeGateway = (
  produce: (payload: ChatRequest, signal: AbortSignal) => AsyncGenerator<ChatStreamEvent>,
): ChatGateway => new ChatGateway({ stream: produce } as unknown as ChatService, logger);

const request: ChatRequest = { message: 'hello' };

describe('ChatGateway', () => {
  it('emits each stream event under its own socket name', async () => {
    const { client, emit } = fakeClient();
    const gateway = makeGateway(async function* () {
      yield token('a');
      yield { type: 'done', conversationId: 'c1', message: 'a', toolCalls: [], model: 'stub' };
    });

    await gateway.onChat(request, client);

    expect(emit.mock.calls.map(([name]) => name)).toEqual([
      SOCKET_EVENTS.chatToken,
      SOCKET_EVENTS.chatDone,
    ]);
  });

  it('turns a crash mid-stream into chat:error rather than a dropped connection', async () => {
    const { client, emit } = fakeClient();
    const gateway = makeGateway(async function* () {
      yield token('a');
      throw new Error('model exploded');
    });

    await gateway.onChat(request, client);

    expect(emit).toHaveBeenLastCalledWith(SOCKET_EVENTS.chatError, {
      type: 'error',
      conversationId: '',
      error: 'model exploded',
    });
  });

  it('reports a non-Error throw as a string, so the client always gets a message', async () => {
    const { client, emit } = fakeClient();
    const gateway = makeGateway(async function* () {
      yield token('a');
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exactly what this covers
      throw 'just a string';
    });

    await gateway.onChat({ message: 'hi', conversationId: 'c9' }, client);

    expect(emit).toHaveBeenLastCalledWith(SOCKET_EVENTS.chatError, {
      type: 'error',
      conversationId: 'c9',
      error: 'just a string',
    });
  });

  it('cancels an in-flight turn and stops emitting', async () => {
    const { client, emit } = fakeClient();
    let release = (): void => {};
    const gateway = makeGateway(async function* () {
      yield token('a');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield token('b');
    });

    const turn = gateway.onChat(request, client);
    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledTimes(1);
    });

    expect(gateway.onCancel(client)).toEqual({ cancelled: true });
    release();
    await turn;

    // 'b' was produced after the abort, so it must never reach the client.
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('reports nothing to cancel when no turn is running', () => {
    const { client } = fakeClient();
    const gateway = makeGateway(async function* () {
      yield token('a');
    });

    expect(gateway.onCancel(client)).toEqual({ cancelled: false });
  });

  it('aborts the previous turn when the user sends again', async () => {
    const { client, emit } = fakeClient();
    const signals: AbortSignal[] = [];
    // One release per invocation: the second turn must not strand the first.
    const releases: (() => void)[] = [];
    const gateway = makeGateway(async function* (_payload, signal) {
      signals.push(signal);
      yield token('a');
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    const first = gateway.onChat(request, client);
    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledTimes(1);
    });
    const second = gateway.onChat(request, client);
    await vi.waitFor(() => {
      expect(releases).toHaveLength(2);
    });
    for (const release of releases) release();
    await Promise.all([first, second]);

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('aborts a running turn when the socket goes away', async () => {
    const { client, emit } = fakeClient();
    const signals: AbortSignal[] = [];
    let release = (): void => {};
    const gateway = makeGateway(async function* (_payload, signal) {
      signals.push(signal);
      yield token('a');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const turn = gateway.onChat(request, client);
    await vi.waitFor(() => {
      expect(emit).toHaveBeenCalledTimes(1);
    });

    gateway.handleDisconnect(client);
    release();
    await turn;

    expect(signals[0]?.aborted).toBe(true);
    // The entry is gone, so a later cancel does not claim to have cancelled it.
    expect(gateway.onCancel(client)).toEqual({ cancelled: false });
  });

  it('keeps one socket’s turn independent of another’s', async () => {
    const first = fakeClient('socket-1');
    const second = fakeClient('socket-2');
    let release = (): void => {};
    const gateway = makeGateway(async function* () {
      yield token('a');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const running = gateway.onChat(request, first.client);
    await vi.waitFor(() => {
      expect(first.emit).toHaveBeenCalledTimes(1);
    });

    expect(gateway.onCancel(second.client)).toEqual({ cancelled: false });
    expect(gateway.onCancel(first.client)).toEqual({ cancelled: true });
    release();
    await running;
  });
});
