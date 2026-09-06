#!/usr/bin/env node
/**
 * Builds the backend into one executable, for the desktop app to ship as a
 * sidecar.
 *
 * Three steps, each of which had to be earned:
 *
 * 1. **Bundle.** esbuild flattens `dist/` and every dependency into one CommonJS
 *    file. Nest reaches for a handful of optional packages through dynamic
 *    `import()` — microservices, class-validator — and those stay external: they
 *    are only ever loaded by features this app does not use, and bundling them
 *    would drag in half of Nest for nothing.
 * 2. **Prepare.** Node's own SEA config turns that file into a blob.
 * 3. **Inject.** `postject` writes the blob into a copy of the `node` binary.
 *
 * The result needs no Node on the user's machine and no native modules — the
 * metadata store uses `node:sqlite` precisely so this step has nothing to
 * compile. It is ~125 MB, which is the Node runtime; that is the price of a
 * desktop app that starts on its own.
 *
 * `--if-missing` stops after step 0 when the executable is already there. The
 * development loop needs the file to exist — Tauri will not compile the shell
 * without it — but never runs it, so rebuilding 125 MB on every `tauri dev` buys
 * nothing. A release must not take that path: it packages unconditionally,
 * because a bundle carrying yesterday's backend is worse than a slower build.
 */
import { access, chmod, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const run = promisify(execFile);

const BACKEND = fileURLToPath(new URL('..', import.meta.url));
const OUT = new URL('../dist-bin/', import.meta.url);
const BUNDLE = fileURLToPath(new URL('backend.cjs', OUT));
const SEA_CONFIG = fileURLToPath(new URL('sea-config.json', OUT));
const BLOB = fileURLToPath(new URL('sea-prep.blob', OUT));

/**
 * Node's own sentinel. `postject` looks for it in the binary; it is a constant of
 * the SEA format rather than something to choose.
 */
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** Loaded only by Nest features this app does not use, so never actually called. */
const OPTIONAL_NEST_EXTRAS = [
  '@nestjs/microservices',
  '@nestjs/microservices/*',
  'class-transformer',
  'class-validator',
  // The last resort if `node:sqlite` is ever missing; a native module cannot go
  // in a single file, and the store falls back to memory without it.
  'sqlite3',
];

/**
 * Tauri finds a sidecar by `<name>-<target triple>`, and strips the triple back
 * off when it copies the file into the bundle. Asking `rustc` is the only way to
 * get the same answer it will.
 */
const targetTriple = async () => {
  const { stdout } = await run('rustc', ['-vV']);
  const host = /^host:\s*(?<triple>\S+)$/m.exec(stdout)?.groups?.triple;
  if (host === undefined) throw new Error('could not read the host triple from `rustc -vV`');

  return host;
};

const executableName = (triple) =>
  `companion-backend-${triple}${process.platform === 'win32' ? '.exe' : ''}`;

const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );

const main = async () => {
  const executable = fileURLToPath(new URL(executableName(await targetTriple()), OUT));

  if (process.argv.includes('--if-missing') && (await exists(executable))) {
    console.log(`Sidecar already built: ${executable}`);
    return;
  }

  await rm(fileURLToPath(OUT), { recursive: true, force: true });
  await mkdir(fileURLToPath(OUT), { recursive: true });

  await build({
    entryPoints: [fileURLToPath(new URL('dist/main.js', `file://${BACKEND}`))],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: BUNDLE,
    external: OPTIONAL_NEST_EXTRAS,
    logLevel: 'warning',
  });

  await writeFile(
    SEA_CONFIG,
    `${JSON.stringify(
      { main: BUNDLE, output: BLOB, disableExperimentalSEAWarning: true },
      undefined,
      2,
    )}\n`,
  );
  await run(process.execPath, ['--experimental-sea-config', SEA_CONFIG]);

  // A copy of this very Node, so the sidecar is the runtime the build was tested
  // against rather than whatever happens to be installed.
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o755);
  // Resolved rather than joined: npm hoists workspace dependencies to the root,
  // so the path is not where the package that declares it lives.
  const postject = createRequire(import.meta.url).resolve('postject/dist/cli.js');
  await run(process.execPath, [
    postject,
    executable,
    'NODE_SEA_BLOB',
    BLOB,
    '--sentinel-fuse',
    FUSE,
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ]);

  console.log(`Packaged ${executable}`);
};

await main();
