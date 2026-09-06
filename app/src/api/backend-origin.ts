/**
 * Where the backend lives, and the Content-Security-Policy that follows from it.
 *
 * Both come from here because they have to agree: a CSP written by hand next to a
 * URL read from the environment is two sources of truth for one fact, and the way
 * that fails is silent — every request blocked, with a console error that names
 * neither the setting nor the header.
 */

/** Used when `VITE_BACKEND_URL` is unset. */
export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3001';

/**
 * The origins the app may talk to: the backend over HTTP and the same host over
 * WebSocket, since Socket.IO upgrades to it.
 */
export const connectSources = (backendUrl: string): string[] => {
  const { protocol, host } = new URL(backendUrl);
  const secure = protocol === 'https:';

  return [`${secure ? 'https' : 'http'}://${host}`, `${secure ? 'wss' : 'ws'}://${host}`];
};

/**
 * `ipc:` and `http://ipc.localhost` are how a Tauri webview reaches the Rust side;
 * a browser build has no such thing and must not be told to allow it.
 */
export const TAURI_IPC_SOURCES: readonly string[] = ['ipc:', 'http://ipc.localhost'];

export const contentSecurityPolicy = (
  backendUrl: string,
  extraConnectSources: readonly string[] = [],
): string =>
  [
    "default-src 'self'",
    `connect-src 'self' ${[...extraConnectSources, ...connectSources(backendUrl)].join(' ')}`,
    // MUI's emotion writes real <style> elements at runtime; there is no build
    // step that could hash them.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
  ].join('; ');
