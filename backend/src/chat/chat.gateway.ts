import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import { UsePipes, ValidationPipe } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Socket } from 'socket.io';
import { ChatService } from './chat.service.js';
import { ChatRequestDto } from './dto.js';

/**
 * Streams the agent to the client. One in-flight turn per socket: a second
 * `chat:send` aborts the first, which is what a user pressing Enter again expects.
 */
@WebSocketGateway()
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ChatGateway implements OnGatewayDisconnect {
  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    private readonly chat: ChatService,
    @InjectPinoLogger(ChatGateway.name) private readonly logger: PinoLogger,
  ) {}

  @SubscribeMessage('chat:send')
  async onChat(
    @MessageBody() payload: ChatRequestDto,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    this.abort(client.id);

    const controller = new AbortController();
    this.inFlight.set(client.id, controller);

    try {
      for await (const event of this.chat.stream(payload, controller.signal)) {
        if (controller.signal.aborted) return;
        client.emit(`chat:${event.type}`, event);
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Chat stream crashed');
      client.emit('chat:error', {
        type: 'error',
        conversationId: payload.conversationId ?? '',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.inFlight.get(client.id) === controller) this.inFlight.delete(client.id);
    }
  }

  @SubscribeMessage('chat:cancel')
  onCancel(@ConnectedSocket() client: Socket): { cancelled: boolean } {
    return { cancelled: this.abort(client.id) };
  }

  handleDisconnect(client: Socket): void {
    this.abort(client.id);
  }

  private abort(clientId: string): boolean {
    const controller = this.inFlight.get(clientId);
    if (!controller) return false;
    controller.abort();
    this.inFlight.delete(clientId);
    return true;
  }
}
