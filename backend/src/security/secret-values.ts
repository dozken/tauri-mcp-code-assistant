/**
 * Credentials that are *in* a file, as opposed to files that are credentials.
 *
 * `secret-files.ts` refuses `~/.aws/credentials` by name. This is the other half:
 * a live token pasted into `notes.md`, which the walker is right to index and the
 * agent is then free to quote back. Nothing about the file says "secret" — only
 * the bytes do.
 *
 * **Entropy alone does not work, and it is worth writing down why.** Measured
 * against real credentials and ordinary strings, a 40-character hex API key
 * scores 3.96 bits per character while `application/json; charset=utf-8` scores
 * 4.26 and an English sentence 4.16. Any threshold that catches the key redacts
 * the header. So the detection here is two narrower things:
 *
 *   - **Shapes.** `AKIA…`, `ghp_…`, `sk-…`, a PEM block. These are issued in a
 *     format their vendor chose to be recognisable, need no surrounding context,
 *     and catch the pasted-bare case that context never would.
 *   - **Context.** A value assigned to something *named* like a credential, long
 *     enough to be one. Entropy appears here only as a floor, to throw out
 *     `changeme` and `xxxxxxxx` — it is the last filter, not the first.
 *
 * Over-redacting has a real cost: the assistant then answers questions about code
 * it cannot see. So the marker says what happened rather than deleting silently,
 * and every rule is narrow enough to name.
 */

/** Replaces the value, so a reader sees a hole rather than plausible nonsense. */
export const REDACTED = '[redacted: possible secret]';

/**
 * Credential formats recognisable on sight. Each is anchored on a vendor prefix
 * and a length, which is what keeps them from matching ordinary identifiers.
 */
// Stryker disable all: a table of vendor formats. Data, not logic — every entry
// is a mutant no test would sensibly pin, and the set is asserted as a whole.
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  // Key material, marker to marker. The body is the secret, but a lone `BEGIN`
  // line is not, so the pair is matched together.
  /-----BEGIN[ A-Z]{0,20}PRIVATE KEY-----[^-]{0,20000}-----END[ A-Z]{0,20}PRIVATE KEY-----/g,
  /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  /\bgithub_pat_\w{22,255}\b/g,
  /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{20,255}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,255}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,255}\b/g,
  // A JSON Web Token: three base64url segments, the first of which decodes to a
  // header and so always starts `eyJ`.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // Credentials in a URL. Only the userinfo is replaced; the host is the useful
  // half and is not a secret.
  /(?<=:\/\/)[^\s/:@]{1,64}:[^\s/:@]{1,64}(?=@)/g,
];
// Stryker restore all

/**
 * Names whose value is a credential. Deliberately specific: `auth` alone would
 * match `authUrl` and `authProvider`, and redacting those breaks real answers
 * about real code.
 */
const CREDENTIAL_WORDS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'clientsecret',
  'credential',
  'bearer',
];

/**
 * Matched against the name with its separators removed, so `API_KEY`, `apiKey`
 * and `api-key` are one entry rather than three alternations — which is also what
 * keeps this out of the regex-complexity weeds.
 */
const isCredentialName = (key: string): boolean => {
  const letters = key.toLowerCase().replaceAll(/[^a-z]/g, '');

  return CREDENTIAL_WORDS.some((word) => letters.includes(word));
};

/**
 * `key = "value"` in any of the languages this indexes. The optional quote after
 * the key is what makes JSON's `"client_secret": "…"` match, and the value cannot
 * contain a quote or a newline, which is what keeps this linear.
 */
const ASSIGNMENT =
  /(?<key>[A-Za-z_][\w.-]{0,60})["']?\s*[:=]\s*(?<quote>['"`])(?<value>[^'"`\n]{20,512})\k<quote>/g;

/**
 * Values that announce themselves as filler, whatever their entropy says.
 *
 * Every entry has to be filler and nothing else. `example` was here and is not:
 * it skipped `password: "…CYEXAMPLE"`, and a real credential is free to contain
 * the word. Missing a live secret is the worse error, so a term that could appear
 * inside one does not belong on this list.
 */
// Stryker disable Regex: a list of filler words, like the shapes table above. Its
// separators are spelling, not logic — every variant of `[-_ ]` a mutant produces
// is another way to write the same intent, and pinning them pins the spelling.
// A region rather than `next-line`: the declaration wraps, so the mutants land on
// the second line and `next-line` would reach the `const`.
const PLACEHOLDER =
  /\$\{|<[a-z]|your[-_ ]|replace[-_ ]?with|change[-_ ]?me|placeholder|dummy|redacted|todo|fixme|insert[-_ ]|xxxx/i;
// Stryker restore Regex

/** Shannon entropy in bits per character. */
export const shannonEntropy = (value: string): number => {
  // No empty-string guard: the loop below simply does not run, and the zero it
  // returns is the same zero the guard would have.
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);

  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }

  return bits;
};

/**
 * The floor, not the test. 3.0 bits keeps out `changeme` and a run of one
 * character; anything above it has already had to be assigned to something named
 * like a credential to get here.
 */
const MINIMUM_ENTROPY = 3;

const looksLikeSecretValue = (value: string): boolean =>
  !value.includes(REDACTED) && !PLACEHOLDER.test(value) && shannonEntropy(value) >= MINIMUM_ENTROPY;

export interface Redacted {
  readonly text: string;
  /** How many values were replaced, for a log line that says so without saying what. */
  readonly count: number;
}

/**
 * Replaces anything that looks like a live credential, and says how many.
 *
 * Applied where text enters the index and again where it leaves the tools, because
 * an index built before this existed still holds whatever it held.
 */
export const redactSecrets = (text: string): Redacted => {
  let count = 0;

  let redacted = text;
  for (const shape of CREDENTIAL_SHAPES) {
    redacted = redacted.replaceAll(shape, () => {
      count += 1;
      return REDACTED;
    });
  }

  redacted = redacted.replaceAll(ASSIGNMENT, (match, ...rest) => {
    const groups = rest.at(-1) as { key: string; quote: string; value: string };
    if (!isCredentialName(groups.key) || !looksLikeSecretValue(groups.value)) return match;

    count += 1;
    // Replacing inside the match keeps whatever preceded the value — the name, the
    // separator, the indentation — so the line still reads as the code it was.
    return match.replaceAll(
      `${groups.quote}${groups.value}${groups.quote}`,
      `${groups.quote}${REDACTED}${groups.quote}`,
    );
  });

  return { text: redacted, count };
};
