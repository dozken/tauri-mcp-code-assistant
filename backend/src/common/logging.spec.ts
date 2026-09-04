import { describe, expect, it } from 'vitest';
import { httpLoggerParams, stderrLoggerParams } from './logging.js';

/** `pinoHttp` is either an options object or an `[options, stream]` tuple. */
const optionsOf = (params: ReturnType<typeof httpLoggerParams>): Record<string, unknown> => {
  const value = params.pinoHttp;
  return (Array.isArray(value) ? value[0] : value) as Record<string, unknown>;
};

describe('httpLoggerParams', () => {
  const params = httpLoggerParams();
  const options = optionsOf(params);

  it('redacts anything that could carry a credential', () => {
    const redact = options.redact as { paths: string[]; remove: boolean };

    expect(redact.paths).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'apiKey',
        '*.apiKey',
      ]),
    );
    // `remove` rather than a mask: a mask still tells an attacker a key was there.
    expect(redact.remove).toBe(true);
  });

  it('does not log the endpoints the UI polls', () => {
    const autoLogging = options.autoLogging as { ignore: (req: { url: string }) => boolean };

    expect(autoLogging.ignore({ url: '/health' })).toBe(true);
    expect(autoLogging.ignore({ url: '/status' })).toBe(true);
    expect(autoLogging.ignore({ url: '/chat' })).toBe(false);
    expect(autoLogging.ignore({ url: '/index' })).toBe(false);
  });

  it.each([
    [200, 'info'],
    [204, 'info'],
    [400, 'warn'],
    [404, 'warn'],
    [500, 'error'],
    [503, 'error'],
  ])('logs a %d response at %s', (statusCode, level) => {
    const customLogLevel = options.customLogLevel as (
      request: unknown,
      response: { statusCode: number },
      error?: Error,
    ) => string;

    expect(customLogLevel({}, { statusCode })).toBe(level);
  });

  it('logs an error at error level whatever the status says', () => {
    const customLogLevel = options.customLogLevel as (
      request: unknown,
      response: { statusCode: number },
      error?: Error,
    ) => string;

    expect(customLogLevel({}, { statusCode: 200 }, new Error('socket hang up'))).toBe('error');
  });
});

describe('stderrLoggerParams', () => {
  it('writes to stderr, because stdout is the MCP protocol channel', () => {
    const params = stderrLoggerParams('mcp-server');
    const value = params.pinoHttp;

    // A tuple, not an object: the second element is the destination stream. One
    // log line on stdout corrupts JSON-RPC and the client disconnects.
    expect(Array.isArray(value)).toBe(true);
    const [options, stream] = value as [Record<string, unknown>, { fd: number }];
    expect(options.name).toBe('mcp-server');
    expect(stream.fd).toBe(2);
  });

  it('uses no transport, which would spawn a worker owning its own destination', () => {
    const [options] = stderrLoggerParams('mcp-server').pinoHttp as [Record<string, unknown>];

    expect(options.transport).toBeUndefined();
  });

  it('redacts the same paths as the HTTP logger', () => {
    const [options] = stderrLoggerParams('mcp-server').pinoHttp as [Record<string, unknown>];

    expect(options.redact).toEqual(optionsOf(httpLoggerParams()).redact);
  });
});
