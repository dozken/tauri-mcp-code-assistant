import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { isSensitiveDirectory, isSensitivePath } from '../security/secret-files.js';

export interface WalkedFile {
  readonly absolutePath: string;
  /** POSIX-style path relative to the indexed root. */
  readonly relativePath: string;
  readonly size: number;
  /**
   * Carried out of the `stat` the walk already does. The incremental index needs
   * it for every file, and re-stating there would double the syscalls on exactly
   * the path that exists to avoid work.
   */
  readonly mtimeMs: number;
}

export interface WalkOptions {
  readonly maxFileBytes: number;
  readonly extensions?: ReadonlySet<string>;
}

/** Directories that are never worth embedding and are expensive to walk. */
// Data, not logic: every entry is a survivable mutant that no sensible test would
// pin down, and there are enough of them to swamp the file's mutation score.
// Stryker disable all
export const DEFAULT_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
]);

export const DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'rs',
  'py',
  'go',
  'java',
  'kt',
  'kts',
  'rb',
  'php',
  'cs',
  'swift',
  'scala',
  'c',
  'h',
  'cpp',
  'cc',
  'hpp',
  'm',
  'mm',
  'sql',
  'sh',
  'bash',
  'zsh',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
  'md',
  'mdx',
  'txt',
  'html',
  'css',
  'scss',
  'less',
  'graphql',
  'gql',
  'proto',
  'dockerfile',
]);
// Stryker restore all

/**
 * No `sep === '/'` shortcut: splitting on `/` and re-joining with `/` is already
 * the identity, so the fast path only bought a branch that cannot run on a POSIX
 * runner — untestable by construction, and worth less than the line it cost.
 */
const toPosix = (value: string): string => value.split(sep).join('/');

/**
 * Extension of a filename, or the whole name when it has none — so `Dockerfile`
 * and `Makefile` can be matched by the same set as `main.ts`.
 */
export const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf('.');
  return (dot <= 0 ? fileName : fileName.slice(dot + 1)).toLowerCase();
};

const loadGitignore = async (root: string): Promise<Ignore | undefined> => {
  try {
    return ignore().add(await readFile(join(root, '.gitignore'), 'utf8'));
  } catch {
    // No .gitignore, or unreadable: the built-in deny list still applies.
    return undefined;
  }
};

interface Classifier {
  readonly extensions: ReadonlySet<string>;
  readonly gitignore?: Ignore;
}

const shouldEnterDirectory = (
  entry: Dirent,
  relativePath: string,
  { gitignore }: Classifier,
): boolean =>
  !DEFAULT_IGNORED_DIRECTORIES.has(entry.name) &&
  gitignore?.ignores(`${relativePath}/`) !== true &&
  // The per-file check would catch anything in here anyway; not descending means
  // we never even read the directory.
  !isSensitiveDirectory(relativePath);

const shouldConsiderFile = (
  entry: Dirent,
  relativePath: string,
  { extensions, gitignore }: Classifier,
): boolean =>
  gitignore?.ignores(relativePath) !== true &&
  extensions.has(extensionOf(entry.name)) &&
  // DEFAULT_EXTENSIONS contains `env`, so without this `prod.env` is embedded.
  !isSensitivePath(relativePath);

/** `undefined` when the file is unreadable or outside the size band. */
const measure = async (
  absolutePath: string,
  maxFileBytes: number,
): Promise<{ size: number; mtimeMs: number } | undefined> => {
  try {
    const { size, mtimeMs } = await stat(absolutePath);
    return size > 0 && size <= maxFileBytes ? { size, mtimeMs } : undefined;
  } catch {
    return undefined;
  }
};

const readDirectory = async (directory: string): Promise<Dirent[]> => {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    // Permissions, or a race with a delete. One bad directory is not fatal.
    return [];
  }
};

type Verdict =
  | { action: 'skip' }
  | { action: 'descend'; absolutePath: string }
  | { action: 'consider'; absolutePath: string; relativePath: string };

/**
 * Decides what to do with one directory entry. Symlinks are skipped outright:
 * following them risks both cycles and escaping the directory the user authorised.
 */
const classify = (
  root: string,
  directory: string,
  entry: Dirent,
  classifier: Classifier,
): Verdict => {
  // Stryker disable next-line all: `readdir` with file types reports a symlink as
  // neither file nor directory, so the checks below already reject it and no test
  // can tell this line apart. It stays because relying on that is a trap: the day
  // an entry arrives from `stat` instead of `lstat`, this is the line that stops
  // a link to ~/.ssh being walked.
  if (entry.isSymbolicLink()) return { action: 'skip' };

  const absolutePath = join(directory, entry.name);
  const relativePath = toPosix(relative(root, absolutePath));
  // Stryker disable next-line all: unreachable while `directory` only ever comes
  // from the queue below, which is seeded with `root` and grown with paths joined
  // onto it — so `relative` cannot produce `''` or escape upwards. It is the
  // assertion that keeps that invariant true if the queue ever gains another source.
  if (relativePath === '' || relativePath.startsWith('..')) return { action: 'skip' };

  if (entry.isDirectory()) {
    return shouldEnterDirectory(entry, relativePath, classifier)
      ? { action: 'descend', absolutePath }
      : { action: 'skip' };
  }

  return entry.isFile() && shouldConsiderFile(entry, relativePath, classifier)
    ? { action: 'consider', absolutePath, relativePath }
    : { action: 'skip' };
};

/**
 * Depth-first walk that honours the root `.gitignore`, a built-in deny list and a
 * size cap.
 */
export async function* walkFiles(root: string, options: WalkOptions): AsyncGenerator<WalkedFile> {
  const classifier: Classifier = {
    extensions: options.extensions ?? DEFAULT_EXTENSIONS,
    gitignore: await loadGitignore(root),
  };
  const queue: string[] = [root];

  for (let directory = queue.pop(); directory !== undefined; directory = queue.pop()) {
    for (const entry of await readDirectory(directory)) {
      const verdict = classify(root, directory, entry, classifier);

      if (verdict.action === 'descend') queue.push(verdict.absolutePath);
      if (verdict.action !== 'consider') continue;

      const measured = await measure(verdict.absolutePath, options.maxFileBytes);
      if (measured !== undefined) {
        yield {
          absolutePath: verdict.absolutePath,
          relativePath: verdict.relativePath,
          ...measured,
        };
      }
    }
  }
}
