import type { PinoLogger } from 'nestjs-pino';
import { loadConfig, type AppConfig } from '../src/config/configuration.js';

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
  readonly level: 'info' | 'warn' | 'error';
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
    debug: noop,
    fatal: noop,
    setContext: noop,
    assign: noop,
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
