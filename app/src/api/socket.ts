import { io, type Socket } from 'socket.io-client';
import { backendUrl } from './config';

let socket: Socket | undefined;

/**
 * One shared connection for the window. Created lazily so importing this module
 * from a unit test does not open a socket.
 */
export const getSocket = (): Socket => {
  socket ??= io(backendUrl(), {
    // Polling first, upgrading to websocket where one is allowed.
    //
    // This was `['websocket']` alone, and in the packaged macOS app that meant no
    // socket at all: the window is served from `tauri://localhost`, WebKit treats
    // a custom scheme as a secure context, and a secure context may not open a
    // plain `ws://` — the loopback exemption browsers apply to `http://127.0.0.1`
    // is not applied to WebSocket. The connection was blocked before it reached
    // the network, so the backend logged nothing and the window showed only
    // "Cannot reach the backend: websocket error" while HTTP worked fine.
    //
    // Polling is ordinary HTTP to the same origin, which is allowed in every case
    // the app runs in — the desktop CSP names `http://127.0.0.1:*` alongside
    // `ws://127.0.0.1:*`, and so does the browser policy. Socket.IO upgrades off
    // it by itself when the websocket succeeds, so a browser build still ends up
    // on one and the desktop window keeps working when it cannot.
    transports: ['polling', 'websocket'],
    autoConnect: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  return socket;
};
