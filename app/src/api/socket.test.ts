import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => vi.fn(() => ({ id: 'socket' })));

vi.mock('socket.io-client', () => ({ io }));

describe('getSocket', () => {
  beforeEach(() => {
    vi.resetModules();
    io.mockClear();
  });

  it('opens one connection and hands the same one back', async () => {
    // Every caller sharing a socket is the whole point of the module: a second
    // connection means duplicated `chat:token` streams and a listener leak that
    // only shows up as the answer arriving twice.
    const { getSocket } = await import('./socket');

    const first = getSocket();
    const second = getSocket();

    expect(io).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('does not connect merely because the module was imported', async () => {
    await import('./socket');

    expect(io).not.toHaveBeenCalled();
  });

  it('can fall back to polling, and keeps reconnecting without hammering', async () => {
    const { getSocket } = await import('./socket');
    getSocket();

    const [, options] = io.mock.calls[0] as unknown as [string, Record<string, unknown>];
    // Websocket-only is what shipped in 0.1.1, and the packaged macOS window got
    // no socket at all: WebKit refuses a plain `ws://` from the `tauri://localhost`
    // origin, before the request reaches the network. Polling must come first so
    // there is a transport that works there; the upgrade to websocket still
    // happens wherever one is allowed.
    expect(options.transports).toEqual(['polling', 'websocket']);
    expect(options.autoConnect).toBe(true);
    // Backs off, but not so far that a backend restart looks like a hang.
    expect(options.reconnectionDelay).toBeLessThan(options.reconnectionDelayMax as number);
    expect(options.reconnectionDelayMax).toBeLessThanOrEqual(5000);
  });
});
