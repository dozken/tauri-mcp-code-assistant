import { describe, expect, it } from 'vitest';
import { isSensitiveDirectory, isSensitivePath, sensitivePathReason } from './secret-files.js';

describe('isSensitivePath', () => {
  it.each([
    ['a bare .env', '.env'],
    ['an environment override', '.env.local'],
    ['a stacked override', '.env.production.local'],
    ['an env file named by convention', 'config/prod.env'],
    ['a private key', 'certs/server.key'],
    ['a PEM bundle', 'deploy/tls.pem'],
    ['a PKCS#12 bundle', 'ci/signing.p12'],
    ['terraform variables', 'infra/production.tfvars'],
    ['terraform state', 'infra/terraform.tfstate'],
    ['an npm token file', '.npmrc'],
    ['a netrc', 'home/.netrc'],
    ['git credentials', '.git-credentials'],
    ['a kubeconfig', 'kubeconfig'],
    ['an SSH private key', 'id_rsa'],
    ['a checked-in secrets file', 'deploy/secrets.yaml'],
    ['a bare .key dotfile', '.key'],
    ['a bare .pem dotfile', 'certs/.pem'],
    ['a bare .keystore dotfile', '.keystore'],
  ])('blocks %s', (_label, path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    ['the committed template', '.env.example'],
    ['a sample', '.env.sample'],
    ['a template', '.env.template'],
    ['a dist default', '.env.dist'],
    ['shipped defaults', '.env.defaults'],
  ])('allows %s, which exists to be read', (_label, path) => {
    expect(isSensitivePath(path)).toBe(false);
  });

  it.each([
    ['a module whose name merely starts the same way', 'src/environment.ts'],
    ['a config module', 'src/config/configuration.ts'],
    ['a public key', 'src/keys/id_rsa.pub'],
    ['a keyboard handler', 'src/hooks/useKey.ts'],
    ['a monkey-named file', 'src/monkey.ts'],
    ['a readme', 'README.md'],
    ['a gitignore', '.gitignore'],
    ['an eslint config', '.eslintrc'],
    ['an editorconfig', '.editorconfig'],
    ['a lockfile', 'package-lock.json'],
  ])('allows %s', (_label, path) => {
    expect(isSensitivePath(path)).toBe(false);
  });

  it.each([
    ['~/.ssh', '/home/dev/.ssh/known_hosts'],
    ['~/.aws', '/home/dev/.aws/config'],
    ['~/.kube', '/home/dev/.kube/config'],
    ['~/.gnupg', '/home/dev/.gnupg/pubring.kbx'],
    ['~/.docker', '/home/dev/.docker/config.json'],
  ])('blocks everything under %s, because $HOME is the default allowed root', (_label, path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it('is case-insensitive, for the filesystems that are', () => {
    expect(isSensitivePath('Certs/Server.KEY')).toBe(true);
    expect(isSensitivePath('/home/dev/.SSH/id_rsa')).toBe(true);
  });

  it('treats a backslash as a separator too, so a Windows path still splits', () => {
    expect(isSensitivePath(String.raw`C:\Users\dev\.aws\credentials`)).toBe(true);
  });

  it.each([
    ['an empty path', ''],
    ['a bare separator', '/'],
    ['a trailing separator', 'src/'],
  ])('does not blow up on %s', (_label, path) => {
    expect(isSensitivePath(path)).toBe(false);
  });

  it('matches on the last segment, not on a directory that merely looks like one', () => {
    // A directory called `credentials` is not itself a secret; a file called
    // `credentials` is. Only the leaf is name-matched.
    expect(isSensitivePath('src/credentials/README.md')).toBe(false);
    expect(isSensitivePath('src/aws/credentials')).toBe(true);
  });
});

describe('isSensitiveDirectory', () => {
  it.each([
    ['.ssh', true],
    ['home/dev/.aws', true],
    ['nested/.gnupg/subkeys', true],
    ['src/components', false],
    ['', false],
  ])('%s -> %s', (path, expected) => {
    expect(isSensitiveDirectory(path)).toBe(expected);
  });

  it('does not treat a plain file as a directory to avoid', () => {
    // The file check catches this one; the directory check must not double up and
    // stop the walker descending into a folder that only *contains* a key.
    expect(isSensitiveDirectory('certs/server.key')).toBe(false);
  });
});

describe('sensitivePathReason', () => {
  it('names the path and says the check cannot be turned off', () => {
    const reason = sensitivePathReason('/repo/.env');

    expect(reason).toContain('/repo/.env');
    expect(reason).toContain('not configurable');
  });
});
