import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets, shannonEntropy } from './secret-values.js';
import { shapedCredential } from '../../test/helpers.js';

const redact = (text: string): string => redactSecrets(text).text;

describe('shannonEntropy', () => {
  it('is zero for one repeated character, and rises with variety', () => {
    expect(shannonEntropy('xxxxxxxx')).toBe(0);
    expect(shannonEntropy('abcdefgh')).toBe(3);
  });

  it('is zero for nothing, rather than NaN from a log of zero', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('cannot separate a credential from a header on its own', () => {
    // The measurement this module exists to *not* rely on: a real 40-character
    // hex key scores below an ordinary Content-Type. Any threshold that catches
    // the first redacts the second, which is why entropy here is only a floor.
    expect(shannonEntropy('a3f5c9d21b8e4076af31cc90de5217b48fa0c6d9')).toBeLessThan(
      shannonEntropy('application/json; charset=utf-8'),
    );
  });
});

describe('redactSecrets, on credentials with a recognisable shape', () => {
  it.each([
    ['an OpenAI key pasted into prose', `the key is ${shapedCredential('sk-proj-', 32)} ok`],
    ['an AWS access key id', `AWS_ACCESS_KEY_ID=${shapedCredential('AKIA', 16, true)}`],
    ['a GitHub token', shapedCredential('ghp_', 36)],
    ['a GitHub fine-grained token', shapedCredential('github_pat_', 40)],
    ['a Slack token', shapedCredential('xoxb-', 24)],
    ['a Google API key', shapedCredential('AIza', 35)],
    ['a Stripe live key', shapedCredential('sk_live_', 24)],
    ['a GitLab token', shapedCredential('glpat-', 20)],
    ['an npm token', shapedCredential('npm_', 36)],
    [
      'a JSON Web Token',
      [shapedCredential('eyJ', 20), shapedCredential('', 20), shapedCredential('', 20)].join('.'),
    ],
  ])('replaces %s', (_label, text) => {
    expect(redact(text)).toContain(REDACTED);
  });

  it('replaces a private key from marker to marker', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----';

    const result = redact(`before\n${pem}\nafter`);

    expect(result).not.toContain('MIIEowIBAAKCAQEA1234');
    // The surrounding file is still readable, which is the point of replacing a
    // value rather than dropping the chunk.
    expect(result).toContain('before');
    expect(result).toContain('after');
  });

  it('replaces the credentials in a URL but keeps the host', () => {
    const result = redact('postgres://admin:h8Kd0sPq2Lm4@db.internal:5432/app');

    expect(result).not.toContain('h8Kd0sPq2Lm4');
    // Which database the code talks to is the useful half, and is not a secret.
    expect(result).toContain('db.internal:5432/app');
  });

  it('counts what it replaced, so a log line can say so without saying what', () => {
    const aws = shapedCredential('AKIA', 16, true);
    const { count, text } = redactSecrets(`${aws} and ${shapedCredential('ghp_', 36)}`);

    expect(count).toBe(2);
    expect(text).not.toContain(aws);
  });
});

describe('redactSecrets, on values assigned to a credential-shaped name', () => {
  it.each([
    ['an api key', 'const apiKey = "a3f5c9d21b8e4076af31cc90de5217b48fa0c6d9";'],
    ['a yaml password', 'password: "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE"'],
    ['a json client secret', '"client_secret": "8Kj2mNp4Qr7tVw9yZb3dF6hJ1lO5sX0a"'],
    ['a shell-ish token', "export TOKEN='Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2Rl'"],
    // The commonest spelling of all, and the one that only matches once the
    // separator is stripped out of the name.
    ['a snake_case api key', 'api_key = "a3f5c9d21b8e4076af31cc90de5217b48fa0c6d9"'],
    ['a SCREAMING_SNAKE api key', 'API_KEY: "a3f5c9d21b8e4076af31cc90de5217b48fa0c6d9"'],
  ])('replaces %s', (_label, text) => {
    expect(redact(text)).toContain(REDACTED);
  });

  it('counts an assignment it replaced, the same as a shape', () => {
    const { count } = redactSecrets('const apiKey = "a3f5c9d21b8e4076af31cc90de5217b48fa0c6d9";');

    expect(count).toBe(1);
  });

  it('takes the entropy floor as a floor, not a ceiling', () => {
    // Exactly 3 bits: eight characters, each appearing three times. The threshold
    // is inclusive, and a value sitting on it is a value that gets redacted.
    const onTheLine = 'abcdefgh'.repeat(3);
    expect(shannonEntropy(onTheLine)).toBe(3);

    expect(redactSecrets(`password = "${onTheLine}"`).count).toBe(1);
  });

  it('leaves the code around it intact, so the line still reads', () => {
    const result = redact('const apiKey = "a3f5c9d21b8e4076af31cc90de5217b48fa0c6d9";');

    expect(result).toBe(`const apiKey = "${REDACTED}";`);
  });
});

/**
 * The half that decides whether this is usable. Redacting a value the assistant
 * then cannot see turns a correct answer into a wrong one, silently — so these
 * are as load-bearing as the detections above.
 */
describe('redactSecrets, on things that only look like secrets', () => {
  it.each([
    ['a placeholder', 'const apiKey = "your-api-key-here-goes-something";'],
    ['an interpolation', 'const token = "${OPENAI_API_KEY}";'],
    ['an angle-bracket placeholder', 'password = "<your password here, please>"'],
    ['a content type', "const contentType = 'application/json; charset=utf-8';"],
    ['an English sentence', 'const message = "the quick brown fox jumps over the lazy dog";'],
    ['an auth URL', "const authUrl = 'https://accounts.example.com/oauth/authorize';"],
    ['a list of CSS classes', "const className = 'btn btn-primary btn-large rounded shadow';"],
    ['a uuid', "const requestId = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';"],
    ['an import path', "import { thing } from '../../shared/utilities/formatting/dates';"],
    ['a subresource hash', 'integrity: "sha512-abc123def456ghi789jkl012mno345pqr678"'],
    ['a short value under a secret name', 'const token = "Bearer";'],
    ['a repeated placeholder run', 'const secret = "xxxxxxxxxxxxxxxxxxxxxxxx";'],
    // Not on the placeholder list and long enough, so only the entropy floor
    // stands between this and a redaction it does not deserve.
    ['a long run of one character', 'const secret = "aaaaaaaaaaaaaaaaaaaaaaaa";'],
  ])('leaves %s alone', (_label, text) => {
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });

  it('does not redact a value merely because the name contains "auth"', () => {
    // `auth` was in the name list and is not: it matches `authUrl`, `authProvider`
    // and `authMessage`, none of which hold a credential.
    const text = "const authProvider = 'https://login.microsoftonline.com/common/v2.0';";

    expect(redactSecrets(text).count).toBe(0);
  });

  it('does not redact its own marker on a second pass', () => {
    // Applied at index time and again on the way out, so it meets its own output.
    const once = redact('const apiKey = "a3f5c9d21b8e4076af31cc90de5217b48fa0c6d9";');

    expect(redactSecrets(once)).toEqual({ text: once, count: 0 });
  });
});
