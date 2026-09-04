import { Body, Controller, Post } from '@nestjs/common';
import {
  API_ROUTES,
  chatRequestSchema,
  type ChatRequest,
  type ChatResponse,
} from '@ai-code-companion/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ChatService } from './chat.service.js';

@Controller(API_ROUTES.chat)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /**
   * Blocking variant. The desktop app uses the `chat:send` Socket.IO event instead
   * so it can render tokens as they arrive; this exists for scripts and curl.
   */
  @Post()
  send(@Body(new ZodValidationPipe(chatRequestSchema)) body: ChatRequest): Promise<ChatResponse> {
    return this.chat.chat(body);
  }
}
