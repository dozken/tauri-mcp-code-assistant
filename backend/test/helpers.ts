import type { PinoLogger } from 'nestjs-pino';
import { loadConfig, type AppConfig } from '../src/config/configuration.js';
import { Context } from '../src/plugins/context.js';
import { loadPlugins } from '../src/plugins/loader.js';
import { vectorStorePlugin } from '../src/vector/vector-store.plugin.js';
import { chatModelPlugin } from '../src/llm/chat-model.plugin.js';

/** A PinoLogger stand-in: the unit tests care about behaviour, not log output. */
export const silentLogger = (): PinoLogger => {
  const noop = (): void => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    setContext: noop,
    assign: noop,
  } as unknown as PinoLogger;
};

export interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly payload: Record<string, unknown>;
  readonly message: string;
}

/**
 * A logger that keeps what it was told. Most tests want `silentLogger`; this one
 * is for the handful of log lines that are an operational contract rather than
 * decoration — the ones somebody greps for when an index looks wrong.
 */
export const recordingLogger = (): PinoLogger & { lines: LoggedLine[] } => {
  const lines: LoggedLine[] = [];
  const record =
    (level: LoggedLine['level']) =>
    (payload: unknown, message?: unknown): void => {
      lines.push({
        level,
        payload: (payload ?? {}) as Record<string, unknown>,
        message: typeof message === 'string' ? message : '',
      });
    };
  const noop = (): void => undefined;

  return {
    lines,
    trace: noop,
    fatal: noop,
    setContext: noop,
    assign: noop,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  } as unknown as PinoLogger & { lines: LoggedLine[] };
};

/** Base config with Chroma disabled so tests never touch the network. */
export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => {
  const base = loadConfig({ CHROMA_ENABLED: 'false', LLM_PROVIDER: 'stub' });
  return { ...base, ...overrides };
};

/**
 * A context with the built-in plugins loaded — the same list the app boots with.
 * Unit tests get the real registries rather than a stub, so a test cannot pass
 * against extension points the application does not actually have.
 */
export const testPlugins = async (): Promise<Context> => {
  const ctx = Context.create();
  await loadPlugins(ctx, [
    { plugin: vectorStorePlugin, config: undefined as never },
    { plugin: chatModelPlugin, config: undefined as never },
  ]);
  return ctx;
};
