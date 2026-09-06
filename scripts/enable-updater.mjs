#!/usr/bin/env node
/**
 * Turns on signed auto-updates, which is the one thing about this app that cannot
 * be committed for you.
 *
 * Updates are verified against a public key baked into the bundle, and signed with
 * a private key that has to stay out of the repository. So the shape of the
 * feature is: everything except the key is already here — the plugin is compiled
 * in and registers itself when `plugins.updater` exists — and this writes the
 * config that brings it to life.
 *
 * Run it once, keep the private key, and put it in the repository's secrets. It is
 * deliberately not idempotent about the key: overwriting a signing key silently
 * would orphan every copy of the app already installed, because a new key cannot
 * verify updates the old one signed.
 */
import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TAURI_CONFIG = path.join(ROOT, 'app/src-tauri/tauri.conf.json');
const KEY_PATH = process.env.TAURI_KEY_PATH ?? path.join(homedir(), '.tauri', 'companion.key');

const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * `owner/repo` from the origin remote, in either URL form. Split rather than
 * matched in one pattern: an expression covering both forms at once backtracks.
 */
const repositorySlug = async () => {
  const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: ROOT });
  const remote = stdout.trim().replace(/\.git$/, '');
  const slug = remote.split('github.com').at(-1)?.replace(/^[/:]/, '') ?? '';
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(`could not read owner/repo from the origin remote: ${remote}`);
  }

  return slug;
};

const generateKey = async () => {
  if (await exists(KEY_PATH)) {
    throw new Error(
      `${KEY_PATH} already exists. Reuse that key — a new one cannot verify updates the old one signed, ` +
        'so replacing it strands every copy of the app already installed. Delete it deliberately if that is what you mean.',
    );
  }

  await run('npm', ['run', 'tauri', '-w', 'app', '--', 'signer', 'generate', '-w', KEY_PATH], {
    cwd: ROOT,
    env: { ...process.env, CI: 'true' },
  });

  const pubkey = await readFile(`${KEY_PATH}.pub`, 'utf8');

  return pubkey.trim();
};

const main = async () => {
  const pubkey = await generateKey();
  const slug = await repositorySlug();

  const config = JSON.parse(await readFile(TAURI_CONFIG, 'utf8'));
  config.bundle.createUpdaterArtifacts = true;
  config.plugins = {
    ...config.plugins,
    updater: {
      pubkey,
      // The manifest `tauri-action` uploads alongside the bundles. `latest`
      // resolves to the newest *published* release, so a draft is invisible to
      // installed copies until somebody has looked at it.
      endpoints: [`https://github.com/${slug}/releases/latest/download/latest.json`],
    },
  };
  await writeFile(TAURI_CONFIG, `${JSON.stringify(config, undefined, 2)}\n`);

  console.log(`Updater enabled in app/src-tauri/tauri.conf.json.

  Public key   committed, above
  Private key  ${KEY_PATH}   (never commit this)

Two things left, both yours:

  1. Store the private key as a repository secret, so the release can sign:
       gh secret set TAURI_SIGNING_PRIVATE_KEY < ${KEY_PATH}
     This key has no password, and the release workflow passes an empty
     TAURI_SIGNING_PRIVATE_KEY_PASSWORD for you. Building by hand needs it too —
     unset, Tauri prompts for it and a non-interactive build dies there.

  2. Commit the config change, then cut a release. Installed copies check the
     latest *published* release, so nothing reaches a user from a draft.
`);
};

await main();
