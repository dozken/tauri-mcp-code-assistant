import { isSea } from 'node:sea';
import pino, { type LoggerOptions } from 'pino';
import type { Params } from 'nestjs-pino';

/**
 * Plain JSON logs, no pretty transport.
 *
 * `pino-pretty` is a *transport target*: pino spawns a worker and loads it by
 * module path. A single-file build has no module paths, so asking for it does not
 * degrade to plain output — it throws while the logger is being constructed and
 * takes the process down before it has served a single request. So a packaged
 * build counts as production whether or not anyone set `NODE_ENV`.
 */
const isProduction = (): boolean => process.env.NODE_ENV === 'production' || isSea();

const basePinoOptions = (name: string): LoggerOptions => ({
  name,
  level: process.env.LOG_LEVEL ?? (isProduction() ? 'info' : 'debug'),
  // Never let a stray API key reach the logs.
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'apiKey', '*.apiKey'],
    remove: true,
  },
});

export const httpLoggerParams = (): Params => ({
  pinoHttp: {
    ...basePinoOptions('code-companion'),
    transport: isProduction()
      ? undefined
      : { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss.l' } },
    autoLogging: {
      // Status polling from the UI would otherwise drown out real requests.
      ignore: (req) => req.url === '/health' || req.url === '/status',
    },
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  },
});

/**
 * Logger for the MCP stdio server.
 *
 * stdout *is* the JSON-RPC channel: a single log line written there corrupts the
 * protocol stream and the client disconnects. Everything goes to stderr, and no
 * pretty-print transport is used because that would spawn a worker owning its own
 * destination.
 */
export const stderrLoggerParams = (name: string): Params => ({
  pinoHttp: [basePinoOptions(name), pino.destination(2)],
});
