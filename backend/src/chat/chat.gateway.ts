import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Socket } from 'socket.io';
import {
  SOCKET_EVENTS,
  chatRequestSchema,
  type CancelChatResponse,
  type ChatRequest,
  type ChatStreamEvent,
} from '@ai-code-companion/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ChatService } from './chat.service.js';

/** Maps a stream event onto its socket name, so a rename cannot silently orphan a listener. */
const STREAM_EVENT_NAMES: Record<ChatStreamEvent['type'], string> = {
  token: SOCKET_EVENTS.chatToken,
  tool: SOCKET_EVENTS.chatTool,
  done: SOCKET_EVENTS.chatDone,
  error: SOCKET_EVENTS.chatError,
};

/**
 * Streams the agent to the client. One in-flight turn per socket: a second
 * `chat:send` aborts the first, which is what a user pressing Enter again expects.
 */
@WebSocketGateway()
export class ChatGateway implements OnGatewayDisconnect {
  private readonly inFlight = new Map<string, AbortController>();

  constructor(
    private readonly chat: ChatService,
    @InjectPinoLogger(ChatGateway.name) private readonly logger: PinoLogger,
  ) {}

  @SubscribeMessage(SOCKET_EVENTS.chatSend)
  async onChat(
    @MessageBody(new ZodValidationPipe(chatRequestSchema)) payload: ChatRequest,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    this.abort(client.id);

    const controller = new AbortController();
    this.inFlight.set(client.id, controller);

    try {
      for await (const event of this.chat.stream(payload, controller.signal)) {
        if (controller.signal.aborted) return;
        client.emit(STREAM_EVENT_NAMES[event.type], event);
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Chat stream crashed');
      client.emit(SOCKET_EVENTS.chatError, {
        type: 'error',
        conversationId: payload.conversationId ?? '',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.inFlight.get(client.id) === controller) this.inFlight.delete(client.id);
    }
  }

  @SubscribeMessage(SOCKET_EVENTS.chatCancel)
  onCancel(@ConnectedSocket() client: Socket): CancelChatResponse {
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
