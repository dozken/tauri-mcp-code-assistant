import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';

export interface WalkedFile {
  readonly absolutePath: string;
  /** POSIX-style path relative to the indexed root. */
  readonly relativePath: string;
  readonly size: number;
}

export interface WalkOptions {
  readonly maxFileBytes: number;
  readonly extensions?: ReadonlySet<string>;
}

/** Directories that are never worth embedding and are expensive to walk. */
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
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte',
  'rs', 'py', 'go', 'java', 'kt', 'kts', 'rb', 'php', 'cs', 'swift', 'scala',
  'c', 'h', 'cpp', 'cc', 'hpp', 'm', 'mm', 'sql', 'sh', 'bash', 'zsh',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'md', 'mdx', 'txt',
  'html', 'css', 'scss', 'less', 'graphql', 'gql', 'proto', 'dockerfile',
]);

const toPosix = (value: string): string => (sep === '/' ? value : value.split(sep).join('/'));

const loadGitignore = async (root: string): Promise<Ignore | undefined> => {
  try {
    const contents = await readFile(join(root, '.gitignore'), 'utf8');
    return ignore().add(contents);
  } catch {
    return undefined;
  }
};

/**
 * Depth-first walk that honours the root `.gitignore`, a built-in deny list and a
 * size cap. Symlinks are skipped outright: following them risks both cycles and
 * escaping the directory the user actually authorised.
 */
export async function* walkFiles(root: string, options: WalkOptions): AsyncGenerator<WalkedFile> {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const gitignore = await loadGitignore(root);
  const queue: string[] = [root];

  while (queue.length > 0) {
    const directory = queue.pop() as string;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue; // Unreadable directory (permissions, race with a delete).
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const absolutePath = join(directory, entry.name);
      const relativePath = toPosix(relative(root, absolutePath));
      if (relativePath === '' || relativePath.startsWith('..')) continue;

      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (gitignore?.ignores(`${relativePath}/`)) continue;
        queue.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (gitignore?.ignores(relativePath)) continue;

      const extension = entry.name.includes('.')
        ? (entry.name.split('.').pop() as string).toLowerCase()
        : entry.name.toLowerCase();
      if (!extensions.has(extension)) continue;

      let size: number;
      try {
        size = (await stat(absolutePath)).size;
      } catch {
        continue;
      }
      if (size === 0 || size > options.maxFileBytes) continue;

      yield { absolutePath, relativePath, size };
    }
  }
}
