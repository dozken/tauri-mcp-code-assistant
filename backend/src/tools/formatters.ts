import type {
  ExplainFileResult,
  GenerateSnippetResult,
  SearchCodeResult,
} from '@ai-code-companion/contracts';

/**
 * Tool output is rendered once, here, and reused by the LangChain tools and the
 * MCP server so an agent sees identical text through either transport.
 */

/**
 * Indexed Markdown routinely contains ``` fences of its own, which would close the
 * wrapper early and corrupt everything after it. CommonMark allows longer fences,
 * so pick one longer than anything inside the snippet.
 */
const fenceFor = (text: string): string => {
  const longest = [...text.matchAll(/^[ \t]*(`{3,})/gm)].reduce(
    (max, match) => Math.max(max, match[1]?.length ?? 0),
    2,
  );
  return '`'.repeat(longest + 1);
};

export const formatSearchResult = (result: SearchCodeResult): string => {
  if (result.matches.length === 0) {
    return `No indexed code matched "${result.query}". Index a folder first with the /index endpoint.`;
  }

  return result.matches
    .map((match, position) => {
      const header = `${position + 1}. ${match.relativePath}:${match.startLine}-${match.endLine} (score ${match.score})`;
      const fence = fenceFor(match.text);
      return `${header}\n${fence}${match.language}\n${match.text}\n${fence}`;
    })
    .join('\n\n');
};

export const formatExplainResult = (result: ExplainFileResult): string => {
  const imports = result.imports.length > 0 ? result.imports.join(', ') : 'none';
  const symbols =
    result.symbols.length > 0
      ? result.symbols
          .map((symbol) => `- ${symbol.kind} ${symbol.name} (line ${symbol.line})`)
          .join('\n')
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

export const formatSnippetResult = (result: GenerateSnippetResult): string => {
  const fence = fenceFor(result.code);
  return `${fence}${result.language}\n${result.code}${fence}\n\n${result.notes}`;
};
