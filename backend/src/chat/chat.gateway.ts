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
/**
 * Why a turn was aborted, because the two cases owe the client different things.
 * A replaced turn must go quiet — its events would bleed into the one that took
 * its place. A cancelled turn must say so, or the client waits forever for an end
 * that is never coming: the composer stays stuck on Stop and nothing can be sent.
 */
const CANCELLED = 'cancelled';
const REPLACED = 'replaced';

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
    this.abort(client.id, REPLACED);

    const controller = new AbortController();
    this.inFlight.set(client.id, controller);
    const conversationId = payload.conversationId ?? '';
    // Accumulated as it is forwarded, so a stop can hand back what did arrive.
    let answer = '';

    try {
      for await (const event of this.chat.stream(payload, controller.signal)) {
        if (controller.signal.aborted) break;
        if (event.type === 'token') answer += event.token;
        client.emit(STREAM_EVENT_NAMES[event.type], event);
      }

      // Stopping is not a failure: what streamed before the stop is the answer.
      if (controller.signal.reason === CANCELLED) {
        client.emit(SOCKET_EVENTS.chatDone, {
          type: 'done',
          conversationId,
          message: answer,
          toolCalls: [],
        });
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Chat stream crashed');
      client.emit(SOCKET_EVENTS.chatError, {
        type: 'error',
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (this.inFlight.get(client.id) === controller) this.inFlight.delete(client.id);
    }
  }

  @SubscribeMessage(SOCKET_EVENTS.chatCancel)
  onCancel(@ConnectedSocket() client: Socket): CancelChatResponse {
    return { cancelled: this.abort(client.id, CANCELLED) };
  }

  handleDisconnect(client: Socket): void {
    // Nobody left to tell, so this is the silent kind.
    this.abort(client.id, REPLACED);
  }

  private abort(clientId: string, reason: typeof CANCELLED | typeof REPLACED): boolean {
    const controller = this.inFlight.get(clientId);
    if (!controller) return false;
    controller.abort(reason);
    this.inFlight.delete(clientId);
    return true;
  }
}
