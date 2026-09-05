/**
 * Files that must never be read, indexed or returned, whatever the allow-list says.
 *
 * The allow-list answers "may this process touch that folder"; this answers "is
 * this particular file the kind of thing nobody meant to share". Both are needed,
 * because the default allowed root is `$HOME` — so `~/.ssh/id_rsa` and
 * `~/.aws/credentials` are already inside it, and `explain_file` deliberately
 * ignores `.gitignore` (you may well want to explain an ignored file).
 *
 * Three readers share this predicate, because blocking only the obvious one moves
 * the leak rather than closing it:
 *
 *   - `explain_file`, which returns the file's own contents to an MCP client;
 *   - the indexer, which would otherwise embed the text into the vector store
 *     (`DEFAULT_EXTENSIONS` includes `env`, so `prod.env` was being indexed);
 *   - `search_code`, so an index built before this existed cannot still serve it.
 *
 * Deliberately not configurable. A deny-list with an off switch is one that ends
 * up switched off.
 */

/** Whole names that are secrets regardless of extension. */
// Data, not logic: each entry is a survivable mutant no sensible test would pin.
// Stryker disable all
const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  '.netrc',
  '_netrc',
  '.pgpass',
  '.htpasswd',
  '.git-credentials',
  '.npmrc',
  '.yarnrc',
  '.pypirc',
  '.dockercfg',
  'credentials',
  'kubeconfig',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'terraform.tfstate',
  'terraform.tfstate.backup',
  'secrets.yml',
  'secrets.yaml',
  'secrets.json',
]);

/** Extensions that are almost always key material. */
const SENSITIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  'pem',
  'key',
  'p12',
  'pfx',
  'jks',
  'keystore',
  'ppk',
  'asc',
  'gpg',
  'kdbx',
  'tfvars',
]);

/**
 * Directories whose entire contents are credentials. These sit in `$HOME`, which
 * is the default allowed root, so this is the check that matters most in practice.
 */
const SENSITIVE_DIRECTORIES: ReadonlySet<string> = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  '.docker',
  '.chef',
]);

/** `.env.example` and friends are committed on purpose and hold no secrets. */
const PUBLISHABLE_ENV_SUFFIXES: ReadonlySet<string> = new Set([
  'example',
  'sample',
  'template',
  'dist',
  'defaults',
]);
// Stryker restore all

const ENV_PREFIX = '.env.';

/**
 * `.env`, `.env.local`, `prod.env` — but not `.env.example`, and not
 * `environment.ts`, which merely starts with the same letters.
 */
const isEnvFile = (name: string): boolean => {
  if (name === '.env') return true;
  if (name.startsWith(ENV_PREFIX)) {
    return !PUBLISHABLE_ENV_SUFFIXES.has(name.slice(ENV_PREFIX.length));
  }
  return name.endsWith('.env');
};

/** Extension without the dot; empty for a dotfile or a name with no dot. */
const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1);
};

/**
 * True when any part of the path marks it as a credential.
 *
 * Accepts an absolute or relative path, in either separator style, so the walker
 * can pass its POSIX relative path and the tools their resolved absolute one.
 */
export const isSensitivePath = (path: string): boolean => {
  // Both separators always: a Windows-shaped path handed to a POSIX process must
  // still split, and treating a stray backslash as a separator only ever blocks more.
  const segments = path.toLowerCase().split(/[/\\]/);
  const name = segments.at(-1);
  if (name === undefined || name === '') return false;

  if (segments.slice(0, -1).some((segment) => SENSITIVE_DIRECTORIES.has(segment))) return true;

  return (
    SENSITIVE_NAMES.has(name) || SENSITIVE_EXTENSIONS.has(extensionOf(name)) || isEnvFile(name)
  );
};

/**
 * True when the directory itself is a credential store, so a walker can decline to
 * enter it rather than filtering its contents one by one.
 */
export const isSensitiveDirectory = (path: string): boolean =>
  path
    .toLowerCase()
    .split(/[/\\]/)
    .some((segment) => SENSITIVE_DIRECTORIES.has(segment));

/** Why a path was refused, phrased for a user who expected it to work. */
export const sensitivePathReason = (path: string): string =>
  `Refusing to read ${path}: it looks like credentials (key material, an environment ` +
  'file, or a file under a credential directory). This check is not configurable.';
