import type {
  ExplainFileResult,
  GenerateSnippetResult,
  SearchCodeResult,
} from './tool-schemas.js';

/**
 * Tool output is rendered once, here, and reused by the LangChain tools and the
 * MCP server so an agent sees identical text through either transport.
 */

export const formatSearchResult = (result: SearchCodeResult): string => {
  if (result.matches.length === 0) {
    return `No indexed code matched "${result.query}". Index a folder first with the /index endpoint.`;
  }

  return result.matches
    .map((match, position) => {
      const header = `${position + 1}. ${match.relativePath}:${match.startLine}-${match.endLine} (score ${match.score})`;
      return `${header}\n\`\`\`${match.language}\n${match.text}\n\`\`\``;
    })
    .join('\n\n');
};

export const formatExplainResult = (result: ExplainFileResult): string => {
  const imports = result.imports.length > 0 ? result.imports.join(', ') : 'none';
  const symbols =
    result.symbols.length > 0
      ? result.symbols.map((symbol) => `- ${symbol.kind} ${symbol.name} (line ${symbol.line})`).join('\n')
      : '- none detected';

  return [
    result.summary,
    '',
    `Language: ${result.language}`,
    `Lines: ${result.lineCount}`,
    `Size: ${result.byteSize} bytes`,
    `Imports: ${imports}`,
    '',
    'Symbols:',
    symbols,
  ].join('\n');
};

export const formatSnippetResult = (result: GenerateSnippetResult): string =>
  `\`\`\`${result.language}\n${result.code}\`\`\`\n\n${result.notes}`;
