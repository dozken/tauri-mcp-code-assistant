import type { IncomingMessage } from 'node:http';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import type { Server, ServerOptions } from 'socket.io';
import type { AppConfig } from '../config/configuration.js';
import { decideAccess } from './local-access.js';

/**
 * Applies the access policy to the Socket.IO handshake as well as to HTTP.
 *
 * `allowRequest` runs before the upgrade, so a rejected client never opens a
 * socket. Doing it here rather than only in the gateway guard matters: broadcasts
 * go to every connected socket, so a client that gets as far as connecting can
 * read indexing progress without ever sending a message the guard would see.
 */
export class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly config: AppConfig,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    // Nest declares the parameter as a complete `ServerOptions` even though it is
    // optional and socket.io itself takes a partial, so anything spread from it
    // needs widening back.
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.config.corsOrigins, credentials: true },
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null, allowed: boolean) => void,
      ) => {
        const decision = decideAccess(
          {
            origin: request.headers.origin,
            host: request.headers.host,
            authorization: request.headers.authorization,
          },
          this.config,
        );
        callback(decision.allowed ? null : decision.reason, decision.allowed);
      },
    } as ServerOptions);
  }
}
