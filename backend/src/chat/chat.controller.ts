import { Body, Controller, Post } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { ChatRequestDto } from './dto.js';
import type { ChatResponse } from './chat.types.js';

@Controller('chat')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /**
   * Blocking variant. The desktop app uses the `chat:send` Socket.IO event instead
   * so it can render tokens as they arrive; this exists for scripts and curl.
   */
  @Post()
  send(@Body() body: ChatRequestDto): Promise<ChatResponse> {
    return this.chat.chat(body);
  }
}
