import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CodeToolsService } from '../tools/code-tools.service.js';
import {
  formatExplainResult,
  formatSearchResult,
  formatSnippetResult,
} from '../tools/formatters.js';
import {
  TOOL_DESCRIPTIONS,
  explainFileOutputShape,
  explainFileShape,
  generateSnippetOutputShape,
  generateSnippetShape,
  searchCodeOutputShape,
  searchCodeShape,
} from '../tools/tool-schemas.js';

/**
 * Publishes {@link CodeToolsService} over MCP. The same service instance backs the
 * LangChain tools used by the in-process agent, so an external editor and the app's
 * own chat see exactly the same behaviour.
 */
export const registerCodeTools = (server: McpServer, tools: CodeToolsService): void => {
  server.registerTool(
    'search_code',
    {
      title: 'Search code',
      description: TOOL_DESCRIPTIONS.search_code,
      inputSchema: searchCodeShape,
      outputSchema: searchCodeOutputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = await tools.searchCode(input);
      return {
        content: [{ type: 'text', text: formatSearchResult(result) }],
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    'explain_file',
    {
      title: 'Explain file',
      description: TOOL_DESCRIPTIONS.explain_file,
      inputSchema: explainFileShape,
      outputSchema: explainFileOutputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = await tools.explainFile(input);
      return {
        content: [{ type: 'text', text: formatExplainResult(result) }],
        structuredContent: { ...result },
      };
    },
  );

  server.registerTool(
    'generate_snippet',
    {
      title: 'Generate snippet',
      description: TOOL_DESCRIPTIONS.generate_snippet,
      inputSchema: generateSnippetShape,
      outputSchema: generateSnippetOutputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = await tools.generateSnippet(input);
      return {
        content: [{ type: 'text', text: formatSnippetResult(result) }],
        structuredContent: { ...result },
      };
    },
  );
};
