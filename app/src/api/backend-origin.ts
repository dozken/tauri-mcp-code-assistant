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
const TAURI_IPC_SOURCES = ['ipc:', 'http://ipc.localhost'];

/**
 * The desktop window's backend is on a port chosen at launch — a fixed one is the
 * port a developer already has something on — so its policy cannot name the port.
 * Still confined to loopback, which is the part that matters.
 */
const LOOPBACK_CONNECT_SOURCES = ['http://127.0.0.1:*', 'ws://127.0.0.1:*'];

const policy = (connect: readonly string[]): string =>
  [
    "default-src 'self'",
    `connect-src 'self' ${connect.join(' ')}`,
    // MUI's emotion writes real <style> elements at runtime; there is no build
    // step that could hash them.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
  ].join('; ');

/** For a build served in a browser, where the backend URL is known at build time. */
export const browserPolicy = (backendUrl: string): string => policy(connectSources(backendUrl));

/**
 * For the desktop build. Written into `index.html` *and* `tauri.conf.json`,
 * because both policies are enforced and a connection has to satisfy the
 * intersection — the failure that taught us this was a packaged window with a
 * perfectly good backend and not a single socket to it.
 */
export const desktopPolicy = (): string =>
  policy([...TAURI_IPC_SOURCES, ...LOOPBACK_CONNECT_SOURCES]);
