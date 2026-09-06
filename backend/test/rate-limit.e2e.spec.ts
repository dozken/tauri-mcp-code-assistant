import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request, { type Agent } from 'supertest';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, loadConfig } from '../src/config/configuration.js';

/**
 * The fuse, through the real application.
 *
 * Its own app rather than a case inside `api.e2e.spec.ts`: a limit small enough
 * to trip on purpose would trip that suite by accident the day someone adds a
 * tenth POST, and a shared fixture that silently caps its own tests is worse than
 * no test at all.
 */
const TOKEN = 'e2e-token-000000000000000000000000';
const LIMIT = 2;

describe('rate limiting', () => {
  let app: INestApplication;
  let root: string;

  const server = (): Parameters<typeof request.agent>[0] =>
    app.getHttpServer() as Parameters<typeof request.agent>[0];

  const api = (): Agent => request.agent(server()).set('Authorization', `Bearer ${TOKEN}`);

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'companion-limit-')));

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
          watch: false,
          watchDebounceMs: 5,
        },
        rateLimit: {
          enabled: true,
          // Long enough that nothing resets mid-test by accident.
          windowMs: 60_000,
          chatPerWindow: LIMIT,
          indexPerWindow: LIMIT,
        },
        metadataDb: join(root, 'metadata.sqlite'),
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  /** Nothing may still be writing when the app — and its database — closes. */
  const settle = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { body } = await api().get('/status');
      if ((body as { activeJob: unknown }).activeJob === null) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Indexing did not finish in time');
  };

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('refuses the request past the limit, and says why and for how long', async () => {
    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      await api().post('/chat').send({ message: 'hello' });
    }

    const refused = await api().post('/chat').send({ message: 'hello' });

    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({
      statusCode: 429,
      message: expect.stringContaining('RATE_LIMIT_CHAT') as unknown,
      retryAfterSeconds: expect.any(Number) as unknown,
    });
  });

  it('counts each route on its own budget', async () => {
    // /chat is already spent by the test above; /index must not be.
    const response = await api().post('/index').send({ path: root });

    expect(response.status).not.toBe(429);
    await settle();
  });

  it('does not let one caller spend another caller’s budget', async () => {
    // The whole point of keying per caller: a script in a loop blows its own fuse
    // and the desktop window, which arrives with an Origin it cannot forge, keeps
    // working.
    const script = (): Agent => api().set('X-Client-Id', 'runaway-script');
    for (let attempt = 0; attempt < LIMIT + 2; attempt += 1) {
      await script().post('/chat').send({ message: 'hello' });
    }
    expect((await script().post('/chat').send({ message: 'hello' })).status).toBe(429);

    const app = request
      .agent(server())
      .set('Origin', 'tauri://localhost')
      .post('/chat')
      .send({ message: 'hello' });

    expect((await app).status).not.toBe(429);
  });

  it('leaves the routes a client polls alone', async () => {
    // The UI polls /status and a supervisor polls /health; limiting either would
    // break a caller that is behaving correctly, to protect against nothing.
    for (let attempt = 0; attempt < LIMIT * 3; attempt += 1) {
      expect((await api().get('/status')).status).toBe(200);
      expect((await request.agent(app.getHttpServer()).get('/health')).status).toBe(200);
    }
  });

  it('does not spend the budget on a request that was never let in', async () => {
    // Otherwise any local process could lock the real client out of its own
    // backend without ever holding the token.
    const bare = request.agent(app.getHttpServer());
    for (let attempt = 0; attempt < LIMIT * 5; attempt += 1) {
      expect((await bare.post('/index').send({ path: root })).status).toBe(401);
    }

    // Still refused for the reason the previous test spent, not for this one.
    const response = await api().post('/index').send({ path: root });
    expect([202, 409, 429]).toContain(response.status);
    expect(response.status).not.toBe(401);
    await settle();
  });
});
