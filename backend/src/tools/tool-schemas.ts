import { z } from 'zod';

/**
 * One definition of each tool's contract, shared by three consumers:
 * the LangChain tools used by the in-process agent, the MCP server's
 * `registerTool` calls, and the Nest DTO validation. Raw shapes are exported
 * because `@modelcontextprotocol/sdk` wants `ZodRawShape`, not a `ZodObject`.
 */

export const searchCodeShape = {
  query: z.string().min(1).describe('Natural language or keyword query'),
  limit: z.number().int().min(1).max(20).optional().describe('Maximum snippets to return (default 5)'),
  root: z.string().optional().describe('Restrict the search to one indexed folder'),
} as const;

export const explainFileShape = {
  path: z.string().min(1).describe('Absolute or relative path to a file inside an indexed folder'),
} as const;

export const generateSnippetShape = {
  prompt: z.string().min(1).describe('What the snippet should do'),
  language: z.string().min(1).optional().describe('Target language (default: typescript)'),
} as const;

export const searchCodeSchema = z.object(searchCodeShape);
export const explainFileSchema = z.object(explainFileShape);
export const generateSnippetSchema = z.object(generateSnippetShape);

export type SearchCodeInput = z.infer<typeof searchCodeSchema>;
export type ExplainFileInput = z.infer<typeof explainFileSchema>;
export type GenerateSnippetInput = z.infer<typeof generateSnippetSchema>;

export interface CodeSnippetResult {
  readonly path: string;
  readonly relativePath: string;
  readonly language: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly text: string;
}

export interface SearchCodeResult {
  readonly query: string;
  readonly matches: CodeSnippetResult[];
}

export interface FileSymbol {
  readonly kind: string;
  readonly name: string;
  readonly line: number;
}

export interface ExplainFileResult {
  readonly path: string;
  readonly language: string;
  readonly lineCount: number;
  readonly byteSize: number;
  readonly imports: string[];
  readonly symbols: FileSymbol[];
  readonly summary: string;
}

export interface GenerateSnippetResult {
  readonly language: string;
  readonly code: string;
  readonly notes: string;
}

export const TOOL_DESCRIPTIONS = {
  search_code:
    'Semantic search over the indexed codebase. Returns the most relevant code snippets with file paths and line ranges.',
  explain_file:
    'Summarise a single source file: language, size, imports and the top-level symbols it declares.',
  generate_snippet:
    'Generate a starter code snippet for a described task in a given language.',
} as const;

/** Output shapes, declared so MCP clients get typed `structuredContent`. */

export const searchCodeOutputShape = {
  query: z.string(),
  matches: z.array(
    z.object({
      path: z.string(),
      relativePath: z.string(),
      language: z.string(),
      startLine: z.number(),
      endLine: z.number(),
      score: z.number(),
      text: z.string(),
    }),
  ),
} as const;

export const explainFileOutputShape = {
  path: z.string(),
  language: z.string(),
  lineCount: z.number(),
  byteSize: z.number(),
  imports: z.array(z.string()),
  symbols: z.array(z.object({ kind: z.string(), name: z.string(), line: z.number() })),
  summary: z.string(),
} as const;

export const generateSnippetOutputShape = {
  language: z.string(),
  code: z.string(),
  notes: z.string(),
} as const;
