import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_FILE_VARIABLE,
  applySettings,
  defaultSettingsFile,
  readSettingsFile,
} from './settings-file.js';

const written = async (contents: string, mode = 0o600): Promise<NodeJS.ProcessEnv> => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-settings-'));
  const path = join(directory, 'config.json');
  await writeFile(path, contents);
  await chmod(path, mode);

  return { [SETTINGS_FILE_VARIABLE]: path };
};

describe('defaultSettingsFile', () => {
  it('is somewhere a person would actually open', () => {
    // Not the app-data directory the packaged shell uses for the database and
    // token: those are written by the program, this one is typed by a human, and
    // `~/Library/Application Support/…` is not a path anyone visits twice.
    expect(defaultSettingsFile()).toBe(join(homedir(), '.ai-code-companion', 'config.json'));
  });
});

describe('readSettingsFile', () => {
  it('treats a missing file as the ordinary case, not a failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'companion-settings-'));

    const settings = readSettingsFile({
      [SETTINGS_FILE_VARIABLE]: join(directory, 'nothing-here.json'),
    });

    expect(settings.values).toEqual({});
    expect(settings.problems).toEqual([]);
  });

  it('reads the settings as the environment variables they are named after', async () => {
    const env = await written(
      JSON.stringify({ LLM_PROVIDER: 'ollama', LLM_MODEL: 'qwen2.5-coder:7b' }),
    );

    expect(readSettingsFile(env).values).toEqual({
      LLM_PROVIDER: 'ollama',
      LLM_MODEL: 'qwen2.5-coder:7b',
    });
  });

  it('accepts the numbers and booleans a hand-written file actually contains', async () => {
    // `"chroma_enabled": true` is what someone writes; every reader downstream
    // parses strings, so these are converted rather than refused.
    const env = await written(JSON.stringify({ CHROMA_ENABLED: true, PORT: 3005 }));

    expect(readSettingsFile(env).values).toEqual({ CHROMA_ENABLED: 'true', PORT: '3005' });
  });

  it('keeps the entries it understands and names the one it does not', async () => {
    const env = await written(JSON.stringify({ LLM_PROVIDER: 'ollama', NESTED: { no: 1 } }));

    const settings = readSettingsFile(env);

    expect(settings.values).toEqual({ LLM_PROVIDER: 'ollama' });
    expect(settings.problems.join(' ')).toContain('NESTED');
  });

  it('starts anyway when the JSON is broken, and says why', async () => {
    // A desktop app that refuses to start over a stray comma is worse than one
    // that starts and complains — but it must complain, or the user is left
    // wondering why their settings did nothing.
    const env = await written('{ "LLM_PROVIDER": "ollama", }');

    const settings = readSettingsFile(env);

    expect(settings.values).toEqual({});
    expect(settings.problems).toHaveLength(1);
    expect(settings.problems[0]).toContain('not valid JSON');
  });

  it('refuses a JSON array, which has no keys to read', async () => {
    const env = await written(JSON.stringify(['LLM_PROVIDER']));

    const settings = readSettingsFile(env);

    expect(settings.values).toEqual({});
    expect(settings.problems[0]).toContain('must contain a JSON object');
  });

  it('warns when other users can read it, because this is where an API key lives', async () => {
    const env = await written(JSON.stringify({ OPENAI_API_KEY: 'not-a-real-key' }), 0o644);

    const settings = readSettingsFile(env);

    // Still applied: refusing to start would turn a warning into an outage.
    expect(settings.values.OPENAI_API_KEY).toBe('not-a-real-key');
    expect(settings.problems.join(' ')).toContain('readable by other users');
  });

  it('says nothing about permissions when the file is private', async () => {
    const env = await written(JSON.stringify({ LLM_PROVIDER: 'ollama' }), 0o600);

    expect(readSettingsFile(env).problems).toEqual([]);
  });
});

describe('applySettings', () => {
  it('fills in what the environment has not set', () => {
    const env: NodeJS.ProcessEnv = {};

    applySettings({ values: { LLM_PROVIDER: 'ollama' }, problems: [] }, env);

    expect(env.LLM_PROVIDER).toBe('ollama');
  });

  it('leaves the real environment alone, so one run can override the file', () => {
    // The whole point of the precedence: `LLM_PROVIDER=openai npm start` must work
    // without editing a file first.
    const env: NodeJS.ProcessEnv = { LLM_PROVIDER: 'openai' };

    applySettings({ values: { LLM_PROVIDER: 'ollama' }, problems: [] }, env);

    expect(env.LLM_PROVIDER).toBe('openai');
  });

  it('treats a variable set to empty as set, not as absent', () => {
    // `??=` and not `||=`: an exported empty string is a deliberate act, and the
    // readers downstream already treat it as "unset" if that is what they want.
    const env: NodeJS.ProcessEnv = { LLM_PROVIDER: '' };

    applySettings({ values: { LLM_PROVIDER: 'ollama' }, problems: [] }, env);

    expect(env.LLM_PROVIDER).toBe('');
  });
});
