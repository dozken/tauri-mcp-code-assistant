import { io, type Socket } from 'socket.io-client';
import { BACKEND_URL } from './config';

let socket: Socket | undefined;

/**
 * One shared connection for the window. Created lazily so importing this module
 * from a unit test does not open a socket.
 */
export const getSocket = (): Socket => {
  socket ??= io(BACKEND_URL, {
    transports: ['websocket'],
    autoConnect: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  return socket;
};

export const disconnectSocket = (): void => {
  socket?.disconnect();
  socket = undefined;
};
