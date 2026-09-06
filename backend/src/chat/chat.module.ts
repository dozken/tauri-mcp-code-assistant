import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module.js';
import { McpModule } from '../mcp/mcp.module.js';
import { ChatController } from './chat.controller.js';
import { ChatGateway } from './chat.gateway.js';
import { ChatService } from './chat.service.js';
import { ConversationStore } from './conversation.store.js';

@Module({
  imports: [LlmModule, McpModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, ConversationStore],
  exports: [ChatService],
})
export class ChatModule {}
