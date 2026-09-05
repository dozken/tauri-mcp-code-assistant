import { useCallback, useEffect } from 'react';
import { getSocket } from '../api/socket';
import { ContractError, HttpError, fetchStatus, startIndexing } from '../api/http';
import { useAppStore } from '../store/appStore';
import {
  SOCKET_EVENTS,
  chatDoneEventSchema,
  chatErrorEventSchema,
  chatTokenEventSchema,
  chatToolEventSchema,
  indexProgressEventSchema,
} from '@ai-code-companion/contracts';
import type { ZodType } from 'zod';

/**
 * Binds the Socket.IO connection to the Zustand store and exposes the two write
 * actions the UI needs. Everything I/O-shaped lives here so the store stays pure.
 */
/** Turns a thrown value into something worth showing a user. */
const describe = (error: unknown): string => {
  if (error instanceof ContractError) {
    return `${error.message} The app and the backend are probably different versions.`;
  }
  if (error instanceof HttpError) return error.message;
  return error instanceof Error ? error.message : String(error);
};

export const useBackend = () => {
  const refreshStatus = useCallback(async () => {
    const store = useAppStore.getState();
    try {
      store.applyStatus(await fetchStatus());
    } catch (error) {
      store.setError(describe(error));
    }
  }, []);

  useEffect(() => {
    const socket = getSocket();
    const store = () => useAppStore.getState();

    const onConnect = (): void => {
      store().setConnected(true);
      void refreshStatus();
    };
    const onDisconnect = (): void => store().setConnected(false);
    const onConnectError = (error: Error): void => {
      store().setConnected(false);
      store().setError(`Cannot reach the backend: ${error.message}`);
    };

    /**
     * Tokens are coalesced to one store write per frame.
     *
     * One write per token meant one React render per token. socket.io can deliver
     * a burst of buffered packets in a single tick, and past React's nested-update
     * limit that threw "Maximum update depth exceeded" — the answer simply stopped
     * rendering mid-stream. Batching fixes the crash and the per-token render cost
     * together, and the flush before every ordering-sensitive event keeps
     * `tool`/`done`/`error` strictly after the text that preceded them.
     */
    let pendingTokens = '';
    let frame: number | undefined;

    const flushTokens = (): void => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }
      if (pendingTokens === '') return;
      const chunk = pendingTokens;
      pendingTokens = '';
      store().appendToken(chunk);
    };

    const queueToken = (token: string): void => {
      pendingTokens += token;
      frame ??= requestAnimationFrame(flushTokens);
    };

    // Each subscription hands back its own teardown, so `off` cannot drift from `on`.
    const disposers: (() => void)[] = [];

    const on = (event: string, handler: (...args: unknown[]) => void): void => {
      socket.on(event, handler);
      disposers.push(() => socket.off(event, handler));
    };

    /**
     * Socket payloads arrive as untyped JSON. Parsing them against the shared
     * contract turns a backend/app version skew into one visible warning instead
     * of `undefined` surfacing somewhere deep in a component.
     */
    const onValidated = <T>(
      event: string,
      schema: ZodType<T>,
      handler: (payload: T) => void,
    ): void =>
      on(event, (raw) => {
        const parsed = schema.safeParse(raw);
        if (parsed.success) handler(parsed.data);
        else store().setError(`Ignored a malformed "${event}" event from the backend.`);
      });

    on('connect', onConnect);
    on('disconnect', onDisconnect);
    on('connect_error', (error) => {
      onConnectError(error instanceof Error ? error : new Error(String(error)));
    });

    onValidated(SOCKET_EVENTS.indexProgress, indexProgressEventSchema, (event) => {
      store().applyProgress(event);
      // A finished job changes the folder list, so re-read the authoritative status.
      if (event.state !== 'running') void refreshStatus();
    });
    onValidated(SOCKET_EVENTS.chatToken, chatTokenEventSchema, (event) => {
      queueToken(event.token);
    });
    onValidated(SOCKET_EVENTS.chatTool, chatToolEventSchema, (event) => {
      flushTokens();
      store().addToolCall(event.tool);
    });
    onValidated(SOCKET_EVENTS.chatDone, chatDoneEventSchema, (event) => {
      flushTokens();
      store().completeAssistantMessage(event.message);
    });
    onValidated(SOCKET_EVENTS.chatError, chatErrorEventSchema, (event) => {
      flushTokens();
      store().failAssistantMessage(event.error);
    });

    if (socket.connected) onConnect();

    return () => {
      // Anything already buffered belongs to the transcript, so land it before
      // tearing the subscriptions down.
      flushTokens();
      for (const dispose of disposers) dispose();
    };
  }, [refreshStatus]);

  const sendMessage = useCallback((text: string) => {
    const content = text.trim();
    if (content.length === 0) return;

    const store = useAppStore.getState();
    if (store.isStreaming) return;

    // The client owns the transcript, so the backend stays stateless.
    const history = store.messages
      .filter((entry) => !entry.streaming && !entry.error)
      .slice(-20)
      .map((entry) => ({ role: entry.role, content: entry.content }));

    store.addUserMessage(content);
    store.beginAssistantMessage();

    getSocket().emit(SOCKET_EVENTS.chatSend, {
      message: content,
      history,
      conversationId: store.conversationId,
      root: store.selectedRoot,
    });
  }, []);

  /**
   * The backend has always been able to stop a turn — `chat:cancel` aborts the
   * signal the model and its tools are already listening on. Nothing in the UI
   * reached it, so a wrong answer streamed to the end while the user watched.
   */
  const cancelMessage = useCallback(() => {
    if (!useAppStore.getState().isStreaming) return;
    getSocket().emit(SOCKET_EVENTS.chatCancel, {});
  }, []);

  const indexFolder = useCallback(
    async (path: string) => {
      const store = useAppStore.getState();
      try {
        await startIndexing(path);
        await refreshStatus();
      } catch (error) {
        store.setError(describe(error));
      }
    },
    [refreshStatus],
  );

  return { sendMessage, cancelMessage, indexFolder, refreshStatus };
};
