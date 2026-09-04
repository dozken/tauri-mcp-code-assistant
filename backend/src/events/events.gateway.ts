import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';
import type { Subscription } from 'rxjs';
import { SOCKET_EVENTS } from '@ai-code-companion/contracts';
import { IndexingService } from '../indexing/indexing.service.js';

/**
 * Fans indexing progress out to every connected client. Progress is broadcast
 * rather than addressed: indexing is a global, single-job operation, so every open
 * window should see the same bar.
 */
@Injectable()
@WebSocketGateway()
export class EventsGateway implements OnModuleInit, OnModuleDestroy {
  @WebSocketServer()
  private server?: Server;

  private subscription?: Subscription;

  constructor(private readonly indexing: IndexingService) {}

  onModuleInit(): void {
    this.subscription = this.indexing.progress.subscribe((event) => {
      this.server?.emit(SOCKET_EVENTS.indexProgress, event);
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }
}
