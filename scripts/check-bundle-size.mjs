#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A bundle budget, in about twenty lines.
 *
 * `size-limit` does this well, but it pulls in ~50 packages and, at the time of
 * writing, twelve moderate advisories through its archive handling — a bad trade
 * for a byte count we can compute with `zlib`.
 *
 * Gzipped, because that is what the user actually downloads. The desktop build
 * loads from disk, so this budget is really about keeping the dependency
 * footprint honest rather than about network time.
 */
// No CSS entry: MUI styles via emotion, so everything lands in the JS bundle.
const BUDGETS = [{ pattern: /\.js$/, label: 'app bundle', maxGzipKb: 200 }];

const ASSET_DIR = new URL('../app/dist/assets/', import.meta.url).pathname;

const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;

const main = async () => {
  try {
    await stat(ASSET_DIR);
  } catch {
    console.error(`No build found at ${ASSET_DIR}. Run \`npm run build\` first.`);
    process.exit(1);
  }

  const files = await readdir(ASSET_DIR);
  let failed = false;

  for (const { pattern, label, maxGzipKb } of BUDGETS) {
    const matches = files.filter((file) => pattern.test(file));
    if (matches.length === 0) {
      console.error(`✖ ${label}: no asset matched ${String(pattern)}`);
      failed = true;
      continue;
    }

    const total = matches.reduce(
      (sum, file) => sum + gzipSync(readFileSync(path.join(ASSET_DIR, file))).byteLength,
      0,
    );
    const over = kb(total) > maxGzipKb;
    failed ||= over;
    console.log(
      `${over ? '✖' : '✔'} ${label}: ${String(kb(total))} kB gzipped (budget ${String(maxGzipKb)} kB)` +
        ` — ${matches.join(', ')}`,
    );
  }

  if (failed) {
    console.error('\nBundle budget exceeded. Either justify the growth or raise the budget.');
    process.exit(1);
  }
};

await main();
