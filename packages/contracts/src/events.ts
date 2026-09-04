/**
 * Socket.IO event names. Constants rather than string literals so a rename is a
 * compile error on both sides instead of a message that silently never arrives.
 */
export const SOCKET_EVENTS = {
  /** client -> server */
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  /** server -> client */
  indexProgress: 'index:progress',
  chatToken: 'chat:token',
  chatTool: 'chat:tool',
  chatDone: 'chat:done',
  chatError: 'chat:error',
} as const;

/** REST paths, so the client cannot drift from the controllers. */
export const API_ROUTES = {
  index: '/index',
  cancelIndex: '/index/cancel',
  status: '/status',
  health: '/health',
  chat: '/chat',
} as const;
