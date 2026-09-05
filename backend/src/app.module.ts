import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './config/config.module.js';
import { CommonModule } from './common/common.module.js';
import { ExtensionsModule } from './extensions/extensions.module.js';
import { httpLoggerParams } from './common/logging.js';
import { VectorModule } from './vector/vector.module.js';
import { ToolsModule } from './tools/tools.module.js';
import { McpModule } from './mcp/mcp.module.js';
import { LlmModule } from './llm/llm.module.js';
import { IndexingModule } from './indexing/indexing.module.js';
import { ChatModule } from './chat/chat.module.js';
import { EventsModule } from './events/events.module.js';

@Module({
  imports: [
    LoggerModule.forRoot(httpLoggerParams()),
    AppConfigModule,
    CommonModule,
    ExtensionsModule,
    VectorModule,
    ToolsModule,
    McpModule,
    LlmModule,
    IndexingModule,
    ChatModule,
    EventsModule,
  ],
})
export class AppModule {}
