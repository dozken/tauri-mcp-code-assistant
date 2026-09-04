import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import {
  SOCKET_EVENTS,
  chatDoneEventSchema,
  chatStreamEventSchema,
  indexProgressEventSchema,
  type ChatStreamEvent,
  type IndexProgressEvent,
} from '@ai-code-companion/contracts';
import { AppModule } from '../src/app.module.js';
import { ConfiguredIoAdapter } from '../src/common/io-adapter.js';
import { APP_CONFIG, loadConfig, type AppConfig } from '../src/config/configuration.js';

const TOKEN = 'ws-token-1111111111111111111111111111';

/**
 * The desktop app talks to the backend over Socket.IO, not REST, so this is the
 * path that actually matters: a real Nest server, a real client, real streaming.
 */
describe('Socket.IO gateways', () => {
  let app: INestApplication;
  let root: string;
  let url: string;

  const connect = async (headers?: Record<string, string>): Promise<Socket> => {
    const socket = io(url, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: headers ?? { authorization: `Bearer ${TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        resolve();
      });
      socket.once('connect_error', reject);
    });
    return socket;
  };

  /** Collects stream events until `done` or `error`. */
  const runChat = async (socket: Socket, message: string): Promise<ChatStreamEvent[]> => {
    const events: ChatStreamEvent[] = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`chat did not finish; saw ${String(events.length)} events`));
      }, 15_000);

      for (const event of [
        SOCKET_EVENTS.chatToken,
        SOCKET_EVENTS.chatTool,
        SOCKET_EVENTS.chatDone,
        SOCKET_EVENTS.chatError,
      ]) {
        socket.on(event, (payload: unknown) => {
          const parsed = chatStreamEventSchema.parse(payload);
          events.push(parsed);
          if (parsed.type === 'done' || parsed.type === 'error') {
            clearTimeout(timer);
            resolve(events);
          }
        });
      }

      socket.emit(SOCKET_EVENTS.chatSend, { message });
    });
  };

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'companion-ws-')));
    await writeFile(
      join(root, 'auth.ts'),
      'export function authenticateUser() {\n  return true;\n}\n',
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue({
        ...loadConfig({ CHROMA_ENABLED: 'false', LLM_PROVIDER: 'stub', LOG_LEVEL: 'silent' }),
        corsOrigins: ['tauri://localhost'],
        auth: { enabled: true, token: TOKEN, tokenFile: join(root, 'token') },
        indexing: {
          chunkSize: 400,
          chunkOverlap: 40,
          maxFileBytes: 64 * 1024,
          concurrency: 2,
          allowedRoots: [root],
        },
        metadataDb: join(root, 'metadata.sqlite'),
      })
      .compile();

    app = moduleRef.createNestApplication();
    // The real adapter, so the handshake is guarded here exactly as it is in main.ts.
    app.useWebSocketAdapter(new ConfiguredIoAdapter(app, app.get<AppConfig>(APP_CONFIG)));
    // Port 0: let the OS pick, so a developer's running backend cannot collide.
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('streams a chat turn as tool, tokens and done', async () => {
    const socket = await connect();
    try {
      const events = await runChat(socket, 'where do we authenticate?');

      expect(events.filter((event) => event.type === 'tool')).toHaveLength(1);
      const tokens = events.filter((event) => event.type === 'token');
      expect(tokens.length).toBeGreaterThan(3);

      const done = chatDoneEventSchema.parse(events.at(-1));
      // The streamed tokens must reconstruct the final message exactly.
      expect(done.message).toBe(tokens.map((event) => event.token).join(''));
    } finally {
      socket.disconnect();
    }
  });

  it('rejects a malformed chat payload instead of crashing the connection', async () => {
    const socket = await connect();
    try {
      const failure = await new Promise<unknown>((resolve) => {
        socket.once('exception', resolve);
        socket.emit(SOCKET_EVENTS.chatSend, { message: '' });
      });

      expect(JSON.stringify(failure)).toContain('message');
      // The socket survives, so the user can simply retype.
      expect(socket.connected).toBe(true);
    } finally {
      socket.disconnect();
    }
  });

  it('reports that there is nothing to cancel', async () => {
    const socket = await connect();
    try {
      const ack = await socket.emitWithAck(SOCKET_EVENTS.chatCancel);

      expect(ack).toEqual({ cancelled: false });
    } finally {
      socket.disconnect();
    }
  });

  it('broadcasts indexing progress to every connected client', async () => {
    const [first, second] = await Promise.all([connect(), connect()]);
    try {
      const collect = (socket: Socket): Promise<IndexProgressEvent[]> =>
        new Promise((resolve, reject) => {
          const seen: IndexProgressEvent[] = [];
          const timer = setTimeout(() => {
            reject(new Error('no completed progress event'));
          }, 15_000);
          socket.on(SOCKET_EVENTS.indexProgress, (payload: unknown) => {
            const event = indexProgressEventSchema.parse(payload);
            seen.push(event);
            if (event.state !== 'running') {
              clearTimeout(timer);
              resolve(seen);
            }
          });
        });

      const both = Promise.all([collect(first), collect(second)]);
      await fetch(`${url}/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ path: root }),
      });

      const [seenByFirst, seenBySecond] = await both;
      for (const seen of [seenByFirst, seenBySecond]) {
        expect(seen.at(-1)).toMatchObject({ state: 'completed', percent: 100, root });
      }
    } finally {
      first.disconnect();
      second.disconnect();
    }
  });

  describe('access control', () => {
    /**
     * Polling rather than websocket: engine.io returns the refusal as an HTTP
     * body, so the client can see *why*. A rejected websocket upgrade just closes.
     */
    const reasonForRefusing = async (headers: Record<string, string>): Promise<string> => {
      const response = await fetch(`${url}/socket.io/?EIO=4&transport=polling`, { headers });
      expect(response.status).toBe(403);
      return JSON.stringify(await response.json());
    };

    it('refuses the handshake outright when no credentials are offered', async () => {
      await expect(connect({})).rejects.toThrow();
      expect(await reasonForRefusing({})).toContain('Authorization: Bearer');
    });

    it('refuses the handshake from a page we do not serve', async () => {
      await expect(connect({ origin: 'https://evil.example' })).rejects.toThrow();
      expect(await reasonForRefusing({ origin: 'https://evil.example' })).toContain('evil.example');
    });

    it('accepts the desktop app on its Origin alone', async () => {
      const socket = await connect({ origin: 'tauri://localhost' });
      try {
        expect(socket.connected).toBe(true);
      } finally {
        socket.disconnect();
      }
    });
  });
});
