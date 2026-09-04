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

/** Base config with Chroma disabled so tests never touch the network. */
export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => {
  const base = loadConfig({ CHROMA_ENABLED: 'false', LLM_PROVIDER: 'stub' });
  return { ...base, ...overrides };
};
