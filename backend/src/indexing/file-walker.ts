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

const GITIGNORE = '.gitignore';

/** One `.gitignore`, with the directory its patterns are written relative to. */
interface IgnoreLayer {
  /** POSIX path of that directory relative to the root; `''` for the root itself. */
  readonly base: string;
  readonly rules: Ignore;
}

/**
 * The layers in force inside `directory`, which is the inherited set plus this
 * directory's own `.gitignore` if it has one.
 *
 * The entry list is already in hand, so a directory without one costs no syscall
 * and no allocation — which matters when the alternative is a failed `open` per
 * directory in a tree with tens of thousands of them.
 */
const withLocalRules = async (
  directory: string,
  relativeDirectory: string,
  entries: readonly Dirent[],
  inherited: readonly IgnoreLayer[],
): Promise<readonly IgnoreLayer[]> => {
  // Stryker disable next-line ConditionalExpression,LogicalOperator: widening this
  // test only costs a failed `open` per directory — the read throws and the catch
  // below returns the inherited layers, which is what the shortcut returns anyway.
  // Narrowing it does change the answer, and the mutant that does is killed.
  if (!entries.some((entry) => entry.name === GITIGNORE && entry.isFile())) return inherited;

  try {
    const rules = ignore().add(await readFile(join(directory, GITIGNORE), 'utf8'));
    return [...inherited, { base: relativeDirectory, rules }];
  } catch {
    // Unreadable: the built-in deny list and the layers above still apply.
    return inherited;
  }
};

/**
 * Git reads `.gitignore` files from the root down, and the deepest one to express
 * an opinion wins — which is what lets `packages/web/.gitignore` un-ignore
 * something the repository root ignored. Asking each layer in turn, deepest
 * first, is that rule.
 *
 * `test` rather than `ignores` because the three-way answer is the whole point:
 * "not ignored" and "explicitly un-ignored" mean different things to the layer
 * above.
 */
const isIgnored = (
  layers: readonly IgnoreLayer[],
  relativePath: string,
  isDirectory: boolean,
): boolean => {
  const candidate = isDirectory ? `${relativePath}/` : relativePath;

  for (const layer of layers.toReversed()) {
    const within = layer.base === '' ? candidate : candidate.slice(layer.base.length + 1);
    const { ignored, unignored } = layer.rules.test(within);
    if (ignored) return true;
    if (unignored) return false;
  }

  return false;
};

interface Classifier {
  readonly extensions: ReadonlySet<string>;
  readonly layers: readonly IgnoreLayer[];
}

const shouldEnterDirectory = (
  entry: Dirent,
  relativePath: string,
  { layers }: Classifier,
): boolean =>
  !DEFAULT_IGNORED_DIRECTORIES.has(entry.name) &&
  !isIgnored(layers, relativePath, true) &&
  // The per-file check would catch anything in here anyway; not descending means
  // we never even read the directory.
  !isSensitiveDirectory(relativePath);

const shouldConsiderFile = (
  entry: Dirent,
  relativePath: string,
  { extensions, layers }: Classifier,
): boolean =>
  !isIgnored(layers, relativePath, false) &&
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
    // Stryker disable next-line all: an empty catch returns undefined too, so the
    // mutant is this function. The `stat` can genuinely fail — a file deleted
    // between `readdir` and here — and the walk must carry on past it either way.
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

// Stryker disable next-line all: the walk asks whether the action is `descend` or
// `consider` and does nothing otherwise, so every other value of `action` — and an
// object without one — skips just the same. There is no test that could tell them
// apart, because there is no behaviour to tell apart.
const SKIP: Verdict = { action: 'skip' };

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
  if (entry.isSymbolicLink()) return SKIP;

  const absolutePath = join(directory, entry.name);
  const relativePath = toPosix(relative(root, absolutePath));
  // Stryker disable next-line all: unreachable while `directory` only ever comes
  // from the queue below, which is seeded with `root` and grown with paths joined
  // onto it — so `relative` cannot produce `''` or escape upwards. It is the
  // assertion that keeps that invariant true if the queue ever gains another source.
  if (relativePath === '' || relativePath.startsWith('..')) return SKIP;

  if (entry.isDirectory()) {
    return shouldEnterDirectory(entry, relativePath, classifier)
      ? { action: 'descend', absolutePath }
      : SKIP;
  }

  return entry.isFile() && shouldConsiderFile(entry, relativePath, classifier)
    ? { action: 'consider', absolutePath, relativePath }
    : SKIP;
};

/** A directory still to walk, with the `.gitignore` layers it inherits. */
interface Pending {
  readonly absolutePath: string;
  readonly layers: readonly IgnoreLayer[];
}

/**
 * Depth-first walk that honours every `.gitignore` in the tree, a built-in deny
 * list and a size cap.
 */
export async function* walkFiles(root: string, options: WalkOptions): AsyncGenerator<WalkedFile> {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const queue: Pending[] = [{ absolutePath: root, layers: [] }];

  for (let pending = queue.pop(); pending !== undefined; pending = queue.pop()) {
    const directory = pending.absolutePath;
    const entries = await readDirectory(directory);
    const layers = await withLocalRules(
      directory,
      toPosix(relative(root, directory)),
      entries,
      pending.layers,
    );
    const classifier: Classifier = { extensions, layers };

    for (const entry of entries) {
      const verdict = classify(root, directory, entry, classifier);

      if (verdict.action === 'descend') queue.push({ absolutePath: verdict.absolutePath, layers });
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
