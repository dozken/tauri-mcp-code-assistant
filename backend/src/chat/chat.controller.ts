import { Body, Controller, GatewayTimeoutException, Post } from '@nestjs/common';
import {
  API_ROUTES,
  chatRequestSchema,
  type ChatRequest,
  type ChatResponse,
} from '@ai-code-companion/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ChatService, ChatTimeoutError } from './chat.service.js';

@Controller(API_ROUTES.chat)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /**
   * Blocking variant. The desktop app uses the `chat:send` Socket.IO event instead
   * so it can render tokens as they arrive; this exists for scripts and curl.
   */
  @Post()
  async send(
    @Body(new ZodValidationPipe(chatRequestSchema)) body: ChatRequest,
  ): Promise<ChatResponse> {
    try {
      return await this.chat.chat(body);
    } catch (error) {
      // 504 rather than 500: the upstream model ran out of time, and the caller
      // can reasonably retry or raise LLM_TIMEOUT_MS.
      if (error instanceof ChatTimeoutError) throw new GatewayTimeoutException(error.message);
      throw error;
    }
  }
}
