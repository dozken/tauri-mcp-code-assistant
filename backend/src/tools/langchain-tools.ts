import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { CodeToolsService } from './code-tools.service.js';
import { formatExplainResult, formatSearchResult, formatSnippetResult } from './formatters.js';
import {
  TOOL_DESCRIPTIONS,
  explainFileSchema,
  generateSnippetSchema,
  searchCodeSchema,
  type ExplainFileInput,
  type GenerateSnippetInput,
  type SearchCodeInput,
} from '@ai-code-companion/contracts';

/**
 * Wraps {@link CodeToolsService} as LangChain tools. The agent uses these
 * directly by default; set `MCP_CLIENT_ENABLED=true` to route the same calls
 * through the MCP stdio server instead (see `McpToolsService`).
 */
export const createLangChainTools = (service: CodeToolsService): StructuredToolInterface[] =>
  [
    tool(async (input: SearchCodeInput) => formatSearchResult(await service.searchCode(input)), {
      name: 'search_code',
      description: TOOL_DESCRIPTIONS.search_code,
      schema: searchCodeSchema,
    }),
    tool(async (input: ExplainFileInput) => formatExplainResult(await service.explainFile(input)), {
      name: 'explain_file',
      description: TOOL_DESCRIPTIONS.explain_file,
      schema: explainFileSchema,
    }),
    tool(
      async (input: GenerateSnippetInput) =>
        formatSnippetResult(await service.generateSnippet(input)),
      {
        name: 'generate_snippet',
        description: TOOL_DESCRIPTIONS.generate_snippet,
        schema: generateSnippetSchema,
      },
    ),
  ] as StructuredToolInterface[];
