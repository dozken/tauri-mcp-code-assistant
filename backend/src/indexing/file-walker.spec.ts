import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('reads a .gitignore in a nested directory, not just the one at the root', async () => {
    // A monorepo keeps its real rules in packages/*/.gitignore. Reading only the
    // root file meant indexing generated code the repository itself ignores.
    await mkdir(join(root, 'packages', 'web'), { recursive: true });
    await writeFile(join(root, 'packages', 'web', 'app.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'packages', 'web', 'bundle.ts'), 'export const b = 2;\n');
    await writeFile(join(root, 'packages', 'web', '.gitignore'), 'bundle.ts\n');

    const found = await collect(root);

    expect(found).toContain('packages/web/app.ts');
    expect(found).not.toContain('packages/web/bundle.ts');
  });

  it('keeps a nested rule inside its own directory', async () => {
    // Patterns are relative to the file that declares them: `bundle.ts` under
    // packages/web says nothing about a bundle.ts elsewhere in the tree.
    await mkdir(join(root, 'packages', 'web'), { recursive: true });
    await mkdir(join(root, 'packages', 'api'), { recursive: true });
    await writeFile(join(root, 'packages', 'web', 'bundle.ts'), 'export const b = 2;\n');
    await writeFile(join(root, 'packages', 'api', 'bundle.ts'), 'export const c = 3;\n');
    await writeFile(join(root, 'packages', 'web', '.gitignore'), 'bundle.ts\n');

    const found = await collect(root);

    expect(found).not.toContain('packages/web/bundle.ts');
    expect(found).toContain('packages/api/bundle.ts');
  });

  it('lets a nested file un-ignore what the root ignored', async () => {
    // The deepest opinion wins, which is what makes `!` in a package's own file
    // work at all — and the reason "not ignored" and "un-ignored" cannot be the
    // same answer.
    await mkdir(join(root, 'packages', 'web'), { recursive: true });
    await writeFile(join(root, 'generated.ts'), 'export const e = 5;\n');
    await writeFile(join(root, 'packages', 'web', 'generated.ts'), 'export const f = 6;\n');
    await writeFile(join(root, '.gitignore'), 'generated.ts\n');
    await writeFile(join(root, 'packages', 'web', '.gitignore'), '!generated.ts\n');

    const found = await collect(root);

    expect(found).not.toContain('generated.ts');
    expect(found).toContain('packages/web/generated.ts');
  });

  it('never descends into a directory the root ignored, whatever it contains', async () => {
    // Git does not read a .gitignore inside an ignored directory, and neither
    // should this: an ignored folder cannot un-ignore itself.
    await mkdir(join(root, 'vendored'), { recursive: true });
    await writeFile(join(root, 'vendored', 'lib.ts'), 'export const d = 4;\n');
    await writeFile(join(root, 'vendored', '.gitignore'), '!lib.ts\n');
    await writeFile(join(root, '.gitignore'), 'vendored/\n');

    expect(await collect(root)).not.toContain('vendored/lib.ts');
  });

  it('keeps applying the root rules inside a directory that has rules of its own', async () => {
    // The deepest opinion wins, but only where it has one. A nested file that says
    // nothing about generated code must not turn the root's rule off for everything
    // beneath it — which is what "keep asking the layer above" means.
    await mkdir(join(root, 'packages', 'web'), { recursive: true });
    await writeFile(join(root, '.gitignore'), '*.gen.ts\n');
    await writeFile(join(root, 'packages', 'web', '.gitignore'), 'bundle.ts\n');
    await writeFile(join(root, 'packages', 'web', 'api.gen.ts'), 'export const g = 7;\n');
    await writeFile(join(root, 'packages', 'web', 'app.ts'), 'export const a = 1;\n');

    const found = await collect(root);

    expect(found).not.toContain('packages/web/api.gen.ts');
    expect(found).toContain('packages/web/app.ts');
  });

  it('anchors a nested rule to its own directory, not to the root', async () => {
    // A leading slash means "here and nowhere below". The pattern is written
    // relative to the file that declares it, so the path has to be too: matching
    // `packages/web/local.md` against `/local.md` finds nothing, and the rule
    // silently does nothing at all.
    await mkdir(join(root, 'packages', 'web', 'docs'), { recursive: true });
    await writeFile(join(root, 'packages', 'web', '.gitignore'), '/local.md\n');
    await writeFile(join(root, 'packages', 'web', 'local.md'), '# local\n');
    await writeFile(join(root, 'packages', 'web', 'docs', 'local.md'), '# docs\n');

    const found = await collect(root);

    expect(found).not.toContain('packages/web/local.md');
    expect(found).toContain('packages/web/docs/local.md');
  });

  it('reads a .gitignore from a directory that holds nothing else', async () => {
    // The file is only opened when the entry list says it is there, and here that
    // list is one .gitignore and one subdirectory — no other file to notice.
    await mkdir(join(root, 'packages', 'web'), { recursive: true });
    await writeFile(join(root, 'packages', '.gitignore'), 'bundle.ts\n');
    await writeFile(join(root, 'packages', 'web', 'bundle.ts'), 'export const b = 2;\n');
    await writeFile(join(root, 'packages', 'web', 'app.ts'), 'export const a = 1;\n');

    const found = await collect(root);

    expect(found).not.toContain('packages/web/bundle.ts');
    expect(found).toContain('packages/web/app.ts');
  });

  it('does not let a directory-only rule swallow a file of the same name', async () => {
    // The converse of the rule above: a trailing slash means directories, so the
    // walk must ask about a file as a file. Asking both ways for everything would
    // prune `notes.md` on a rule that was never about it.
    await writeFile(join(root, '.gitignore'), 'notes.md/\n');

    expect(await collect(root)).toContain('notes.md');
  });

  // Root has CAP_DAC_OVERRIDE, so mode 000 is still readable and there is no way to
  // make the OS refuse. CI runs as an ordinary user, which is where this is checked.
  it.skipIf(process.getuid?.() === 0 || process.getuid === undefined)(
    'carries on when a .gitignore cannot be read',
    async () => {
      // One unreadable file must not take the walk down, and must not silently
      // become permission to index what the layers above already ruled out.
      await mkdir(join(root, 'packages', 'web'), { recursive: true });
      await writeFile(join(root, '.gitignore'), 'secret.ts\n');
      await writeFile(join(root, 'packages', 'web', '.gitignore'), '!secret.ts\n');
      await writeFile(join(root, 'packages', 'web', 'secret.ts'), 'export const s = 1;\n');
      await chmod(join(root, 'packages', 'web', '.gitignore'), 0o000);

      const found = await collect(root);

      expect(found).not.toContain('packages/web/secret.ts');
      expect(found).toContain('src/deep.ts');
    },
  );

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
