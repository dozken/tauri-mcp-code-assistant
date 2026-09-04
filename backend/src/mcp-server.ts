#!/usr/bin/env node
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpContextModule } from './mcp/mcp-context.module.js';
import { registerCodeTools } from './mcp/register-tools.js';
import { CodeToolsService } from './tools/code-tools.service.js';

/**
 * MCP stdio entry point — `node dist/mcp-server.js`.
 *
 * Point Claude Code, Cursor or any MCP client at this command and it gets
 * `search_code`, `explain_file` and `generate_snippet` over the same services the
 * desktop app uses. See the README for editor configuration.
 */
const bootstrap = async (): Promise<void> => {
  const context = await NestFactory.createApplicationContext(McpContextModule, {
    // Nest's own bootstrap logs would go to stdout and corrupt the JSON-RPC stream.
    logger: false,
    abortOnError: false,
  });
  context.enableShutdownHooks();

  const server = new McpServer(
    { name: 'ai-code-companion', version: '0.1.0' },
    {
      instructions:
        'Tools for searching and explaining a locally indexed codebase. ' +
        'Index a folder with the companion app (or POST /index) before calling search_code.',
    },
  );

  registerCodeTools(server, context.get(CodeToolsService));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[mcp] ai-code-companion server ready on stdio\n');

  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
};

bootstrap().catch((error: unknown) => {
  process.stderr.write(`[mcp] failed to start: ${String(error)}\n`);
  process.exit(1);
});
