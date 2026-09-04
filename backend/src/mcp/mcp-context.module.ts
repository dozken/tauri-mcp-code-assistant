import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from '../config/config.module.js';
import { CommonModule } from '../common/common.module.js';
import { stderrLoggerParams } from '../common/logging.js';
import { ToolsModule } from '../tools/tools.module.js';

/**
 * Minimal composition root for the MCP stdio process: config, storage and the
 * tool service, with no HTTP server or WebSocket gateway. Reusing the Nest
 * container here means the MCP server and the REST API share one wiring.
 */
@Module({
  imports: [
    LoggerModule.forRoot(stderrLoggerParams('mcp-server')),
    AppConfigModule,
    CommonModule,
    ToolsModule,
  ],
})
export class McpContextModule {}
