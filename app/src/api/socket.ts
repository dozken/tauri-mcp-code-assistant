import { io, type Socket } from 'socket.io-client';
import { backendUrl } from './config';

let socket: Socket | undefined;

/**
 * One shared connection for the window. Created lazily so importing this module
 * from a unit test does not open a socket.
 */
export const getSocket = (): Socket => {
  socket ??= io(backendUrl(), {
    transports: ['websocket'],
    autoConnect: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  return socket;
};
