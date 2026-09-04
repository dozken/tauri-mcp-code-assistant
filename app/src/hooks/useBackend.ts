import { useCallback, useEffect, useRef } from 'react';
import { getSocket } from '../api/socket';
import { fetchStatus, startIndexing } from '../api/http';
import { useAppStore } from '../store/appStore';
import type { ChatStreamEvent, IndexProgressEvent } from '../types';

/**
 * Binds the Socket.IO connection to the Zustand store and exposes the two write
 * actions the UI needs. Everything I/O-shaped lives here so the store stays pure.
 */
export const useBackend = () => {
  const refreshStatus = useCallback(async () => {
    const store = useAppStore.getState();
    try {
      store.applyStatus(await fetchStatus());
    } catch (error) {
      store.setError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  // Kept in a ref so the effect below never needs it in its dependency list.
  const refreshRef = useRef(refreshStatus);
  refreshRef.current = refreshStatus;

  useEffect(() => {
    const socket = getSocket();
    const store = () => useAppStore.getState();

    const onConnect = (): void => {
      store().setConnected(true);
      void refreshRef.current();
    };
    const onDisconnect = (): void => store().setConnected(false);
    const onConnectError = (error: Error): void => {
      store().setConnected(false);
      store().setError(`Cannot reach the backend: ${error.message}`);
    };

    const onProgress = (event: IndexProgressEvent): void => {
      store().applyProgress(event);
      // A finished job changes the folder list, so re-read the authoritative status.
      if (event.state !== 'running') void refreshRef.current();
    };

    const onToken = (event: Extract<ChatStreamEvent, { type: 'token' }>): void =>
      store().appendToken(event.token);
    const onTool = (event: Extract<ChatStreamEvent, { type: 'tool' }>): void =>
      store().addToolCall(event.tool);
    const onDone = (event: Extract<ChatStreamEvent, { type: 'done' }>): void =>
      store().completeAssistantMessage(event.message);
    const onChatError = (event: Extract<ChatStreamEvent, { type: 'error' }>): void =>
      store().failAssistantMessage(event.error);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('index:progress', onProgress);
    socket.on('chat:token', onToken);
    socket.on('chat:tool', onTool);
    socket.on('chat:done', onDone);
    socket.on('chat:error', onChatError);

    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('index:progress', onProgress);
      socket.off('chat:token', onToken);
      socket.off('chat:tool', onTool);
      socket.off('chat:done', onDone);
      socket.off('chat:error', onChatError);
    };
  }, []);

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

    getSocket().emit('chat:send', {
      message: content,
      history,
      conversationId: store.conversationId,
      root: store.selectedRoot,
    });
  }, []);

  const indexFolder = useCallback(
    async (path: string) => {
      const store = useAppStore.getState();
      try {
        await startIndexing(path);
        await refreshRef.current();
      } catch (error) {
        store.setError(error instanceof Error ? error.message : String(error));
      }
    },
    [],
  );

  return { sendMessage, indexFolder, refreshStatus };
};
