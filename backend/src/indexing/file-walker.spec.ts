import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EXTENSIONS,
  DEFAULT_IGNORED_DIRECTORIES,
  extensionOf,
  walkFiles,
  type WalkedFile,
} from './file-walker.js';

const collect = async (root: string, maxFileBytes = 64 * 1024): Promise<string[]> => {
  const found: WalkedFile[] = [];
  for await (const file of walkFiles(root, { maxFileBytes })) found.push(file);
  return found.map((file) => file.relativePath).toSorted((a, b) => a.localeCompare(b));
};

describe('extensionOf', () => {
  it.each([
    ['main.ts', 'ts'],
    ['Component.test.tsx', 'tsx'],
    ['README.MD', 'md'],
    // No dot: the whole name is the key, so `Dockerfile` can be allow-listed.
    ['Dockerfile', 'dockerfile'],
    // A dotfile is not an extension.
    ['.gitignore', '.gitignore'],
  ])('maps %s to %s', (name, expected) => {
    expect(extensionOf(name)).toBe(expected);
  });
});

describe('default sets', () => {
  it('denies the directories that make a walk slow and useless', () => {
    expect(DEFAULT_IGNORED_DIRECTORIES.has('node_modules')).toBe(true);
    expect(DEFAULT_IGNORED_DIRECTORIES.has('.git')).toBe(true);
    expect(DEFAULT_IGNORED_DIRECTORIES.has('src')).toBe(false);
  });

  it('allows source extensions and not binaries', () => {
    expect(DEFAULT_EXTENSIONS.has('ts')).toBe(true);
    expect(DEFAULT_EXTENSIONS.has('rs')).toBe(true);
    expect(DEFAULT_EXTENSIONS.has('png')).toBe(false);
    expect(DEFAULT_EXTENSIONS.has('exe')).toBe(false);
  });
});

describe('walkFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'companion-walk-')));
    await writeFile(join(root, 'index.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'notes.md'), '# notes\n');
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50]));
    await writeFile(join(root, 'empty.ts'), '');

    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'deep.ts'), 'export const b = 2;\n');

    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('yields source files recursively and skips denied directories', async () => {
    expect(await collect(root)).toEqual(['index.ts', 'notes.md', 'src/deep.ts']);
  });

  it('skips empty files and files above the size cap', async () => {
    await writeFile(join(root, 'big.ts'), 'x'.repeat(200));

    expect(await collect(root, 100)).not.toContain('big.ts');
    expect(await collect(root)).not.toContain('empty.ts');
  });

  it('takes a file of exactly the cap, and rejects the first byte over', async () => {
    // An inclusive bound: `<` instead of `<=` would quietly drop every file that
    // happens to land on the limit.
    await writeFile(join(root, 'exact.ts'), 'x'.repeat(100));
    await writeFile(join(root, 'over.ts'), 'x'.repeat(101));

    const found = await collect(root, 100);

    expect(found).toContain('exact.ts');
    expect(found).not.toContain('over.ts');
  });

  it('honours a gitignore directory rule written without a trailing slash', async () => {
    // `ignore` matches a directory rule only when asked with the trailing slash,
    // so the walker has to ask both ways or `build` never gets pruned.
    await mkdir(join(root, 'build'), { recursive: true });
    await writeFile(join(root, 'build', 'out.ts'), 'export const d = 4;\n');
    await writeFile(join(root, '.gitignore'), 'build\n');

    expect(await collect(root)).not.toContain('build/out.ts');
  });

  it('honours .gitignore, including a directory rule', async () => {
    await mkdir(join(root, 'generated'), { recursive: true });
    await writeFile(join(root, 'generated', 'api.ts'), 'export const c = 3;\n');
    await writeFile(join(root, '.gitignore'), 'notes.md\ngenerated/\n');

    const found = await collect(root);

    expect(found).toContain('index.ts');
    expect(found).not.toContain('notes.md');
    expect(found).not.toContain('generated/api.ts');
  });

  it('does not follow symlinks, so a cycle cannot hang the walk', async () => {
    await symlink(root, join(root, 'self'), 'dir');
    await symlink(join(root, 'index.ts'), join(root, 'alias.ts'));

    const found = await collect(root);

    expect(found).toEqual(['index.ts', 'notes.md', 'src/deep.ts']);
  });

  it('returns nothing for a directory it cannot read instead of throwing', async () => {
    await expect(collect(join(root, 'missing'))).resolves.toEqual([]);
  });

  it('reports the real byte size of each file', async () => {
    const files: WalkedFile[] = [];
    for await (const file of walkFiles(root, { maxFileBytes: 64 * 1024 })) files.push(file);

    const index = files.find((file) => file.relativePath === 'index.ts');
    expect(index?.size).toBe('export const a = 1;\n'.length);
    expect(index?.absolutePath).toBe(join(root, 'index.ts'));
  });
});

describe('walkFiles and secrets', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'companion-walk-secret-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('does not index a .env, whose extension the default set allows', async () => {
    await writeFile(join(root, 'app.ts'), 'export const a = 1;\n');
    // `env` is in DEFAULT_EXTENSIONS, so this file was previously embedded whole.
    await writeFile(join(root, 'prod.env'), 'DATABASE_URL=postgres://user:pw@host/db\n');
    await writeFile(join(root, '.env'), 'API_KEY=secret\n');

    expect(await collect(root)).toEqual(['app.ts']);
  });

  it('excludes the secret and keeps the template, given an extension set allowing both', async () => {
    await writeFile(join(root, '.env'), 'API_KEY=secret\n');
    await writeFile(join(root, '.env.example'), 'API_KEY=\n');

    // A bespoke extension set, so this asserts the secret check rather than
    // DEFAULT_EXTENSIONS (which happens to exclude `example` on its own).
    const found: string[] = [];
    for await (const file of walkFiles(root, {
      maxFileBytes: 64 * 1024,
      extensions: new Set(['.env', 'example']),
    })) {
      found.push(file.relativePath);
    }

    expect(found).toEqual(['.env.example']);
  });

  it('never descends into a credential directory', async () => {
    await mkdir(join(root, '.ssh'));
    await writeFile(join(root, '.ssh', 'config'), 'Host *\n');
    await writeFile(join(root, '.ssh', 'notes.md'), '# keys\n');
    await writeFile(join(root, 'app.ts'), 'export const a = 1;\n');

    expect(await collect(root)).toEqual(['app.ts']);
  });
});
