import { Module } from '@nestjs/common';
import { ToolsModule } from '../tools/tools.module.js';
import { McpToolsService } from './mcp-tools.service.js';

@Module({
  imports: [ToolsModule],
  providers: [McpToolsService],
  exports: [McpToolsService],
})
export class McpModule {}
