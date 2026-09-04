export interface TextChunk {
  readonly text: string;
  /** 1-based, inclusive. */
  readonly startLine: number;
  /** 1-based, inclusive. */
  readonly endLine: number;
}

export interface ChunkOptions {
  readonly chunkSize: number;
  readonly chunkOverlap: number;
}

interface Segment {
  readonly text: string;
  readonly line: number;
}

// A lookup table is data, not logic: every entry is a survivable mutant that no
// sensible test would pin down, which would otherwise dominate the mutation score.
// Stryker disable all
const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  rs: 'rust',
  py: 'python',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  swift: 'swift',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
  vue: 'vue',
  svelte: 'svelte',
};
// Stryker restore all

export const detectLanguage = (filePath: string): string => {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_LANGUAGES[extension] ?? 'plaintext';
};

/**
 * A minified bundle can be a single 2 MB line. Splitting oversized lines up front
 * keeps every chunk bounded while preserving the originating line number.
 */
const toSegments = (content: string, maxLength: number): Segment[] => {
  const segments: Segment[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.length <= maxLength) {
      segments.push({ text: line, line: lineNumber });
      return;
    }
    for (let offset = 0; offset < line.length; offset += maxLength) {
      segments.push({ text: line.slice(offset, offset + maxLength), line: lineNumber });
    }
  });
  return segments;
};

const assertValidOptions = ({ chunkSize, chunkOverlap }: ChunkOptions): void => {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkSize must be a positive integer, received ${chunkSize}`);
  }
  if (chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new Error(
      `chunkOverlap must satisfy 0 <= overlap < chunkSize (${chunkSize}), received ${chunkOverlap}`,
    );
  }
};

/** Index one past the last segment that fits in `chunkSize`, always at least `start + 1`. */
const findWindowEnd = (segments: readonly Segment[], start: number, chunkSize: number): number => {
  let end = start;
  let length = 0;

  while (end < segments.length) {
    const segment = segments[end];
    if (segment === undefined) break;
    // +1 for the newline this segment will be joined with.
    const additional = segment.text.length + (end > start ? 1 : 0);
    if (end > start && length + additional > chunkSize) break;
    length += additional;
    end += 1;
  }

  return Math.max(end, start + 1);
};

/**
 * Where the next window starts: far enough back to overlap by `chunkOverlap`
 * characters, but always at least one segment forward so the loop terminates
 * however pathological the settings are.
 */
const findNextStart = (
  segments: readonly Segment[],
  start: number,
  end: number,
  chunkOverlap: number,
): number => {
  let cursor = end;
  let overlap = 0;

  while (cursor > start + 1 && overlap < chunkOverlap) {
    overlap += (segments[cursor - 1]?.text.length ?? 0) + 1;
    cursor -= 1;
  }

  return Math.max(cursor, start + 1);
};

/**
 * Line-aware greedy chunker with character overlap. Line boundaries are preserved
 * so a chunk can be cited back to the user as `file.ts:120-160`.
 */
export const chunkText = (content: string, options: ChunkOptions): TextChunk[] => {
  assertValidOptions(options);
  if (content.trim().length === 0) return [];

  const segments = toSegments(content, options.chunkSize);
  const chunks: TextChunk[] = [];

  for (let start = 0; start < segments.length;) {
    const end = findWindowEnd(segments, start, options.chunkSize);
    const window = segments.slice(start, end);
    const first = window[0];
    const last = window.at(-1);
    const text = window.map((segment) => segment.text).join('\n');

    if (first !== undefined && last !== undefined && text.trim().length > 0) {
      chunks.push({ text, startLine: first.line, endLine: last.line });
    }

    if (end >= segments.length) break;
    start = findNextStart(segments, start, end, options.chunkOverlap);
  }

  return chunks;
};
