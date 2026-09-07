import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A file the user can edit, for the settings there is otherwise no way to reach.
 *
 * Every setting this backend has comes from the environment, which is fine for a
 * terminal and useless for a desktop app: launched from Finder the process
 * inherits almost nothing, and the shell passes only the four values it computes
 * itself. So an installed app could never be pointed at a model — it ran the
 * offline stub and the deterministic hashing embeddings whatever was installed on
 * the machine, and the answers looked random because with those embeddings the
 * ranking effectively is.
 *
 * Entries are read as environment variables rather than translated from some
 * friendlier shape. One set of names, documented in one place, with nothing in
 * between to drift: what the README tells you to export is what you put here.
 *
 * The real environment still wins, so a one-off `LLM_PROVIDER=openai …` from a
 * terminal overrides the file without editing it.
 */

/** Points somewhere else, for tests and for anyone running more than one. */
export const SETTINGS_FILE_VARIABLE = 'COMPANION_SETTINGS_FILE';

/**
 * Deliberately not the app-data directory the packaged shell uses for the
 * database and the token. Those are written by the program and belong where the
 * OS wants them; this one is typed by a person, and
 * `~/Library/Application Support/dev.aicodecompanion.desktop/` is not a path
 * anyone opens twice. One predictable place, whichever way the app was started.
 */
export const defaultSettingsFile = (): string =>
  join(homedir(), '.ai-code-companion', 'config.json');

export interface Settings {
  /** Ready to merge under the real environment. */
  readonly values: Record<string, string>;
  /**
   * Why the file was ignored or is worth a second look. Absent when there was
   * nothing to say — including when there is simply no file, which is the normal
   * case and not a problem.
   */
  readonly problems: readonly string[];
}

const EMPTY: Settings = { values: {}, problems: [] };

/** JSON is wider than the environment, which is strings. */
const asValue = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  // Numbers and booleans are what a hand-written config actually contains —
  // `"chroma_enabled": true` rather than `"true"` — and every reader downstream
  // parses strings, so they are converted rather than refused.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);

  return undefined;
};

/**
 * Whether anyone but the owner can read it. A settings file is exactly where an
 * `OPENAI_API_KEY` ends up, so this is worth a line in the log — but not worth
 * refusing to start over, which would turn a warning into an outage.
 */
const looksExposed = (path: string): boolean => {
  try {
    return (statSync(path).mode & 0o077) !== 0;
  } catch {
    return false;
  }
};

/**
 * Reads the settings file, if there is one. Never throws: a desktop app that
 * refuses to start because of a stray comma is worse than one that starts and
 * says so.
 */
export const readSettingsFile = (env: NodeJS.ProcessEnv = process.env): Settings => {
  const path = env[SETTINGS_FILE_VARIABLE] ?? defaultSettingsFile();

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    // No file is the default state, not a mistake.
    return EMPTY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      values: {},
      problems: [
        `${path} is not valid JSON, so it was ignored: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { values: {}, problems: [`${path} must contain a JSON object, so it was ignored`] };
  }

  const values: Record<string, string> = {};
  const problems: string[] = [];
  for (const [key, raw] of Object.entries(parsed)) {
    const value = asValue(raw);
    if (value === undefined) {
      problems.push(`${path}: "${key}" is not a string, number or boolean, so it was ignored`);
      continue;
    }
    values[key] = value;
  }

  if (Object.keys(values).length > 0 && looksExposed(path)) {
    problems.push(`${path} is readable by other users; it may hold an API key. chmod 600 it.`);
  }

  return { values, problems };
};

/**
 * Puts the file's entries underneath the environment, in place.
 *
 * `??=` rather than assignment, so anything already set wins: a value exported
 * for one run is more specific than one written down, and overriding the file
 * must not mean editing it. Applied to `process.env` once at startup rather than
 * threaded through `loadConfig`, because every reader already takes the
 * environment and this is the one place that knows the file exists.
 */
export const applySettings = (settings: Settings, env: NodeJS.ProcessEnv = process.env): void => {
  for (const [key, value] of Object.entries(settings.values)) env[key] ??= value;
};
