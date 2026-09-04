import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request, { type Agent } from 'supertest';
import { indexStatusSchema, chatResponseSchema } from '@ai-code-companion/contracts';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, loadConfig } from '../src/config/configuration.js';

/**
 * Boots the real Nest application and drives it over HTTP.
 *
 * Unit tests cover the services; this covers the wiring nothing else does —
 * controller routing, the ZodValidationPipe's error shape, and whether the
 * responses actually match the contract the client validates against.
 */
const TOKEN = 'e2e-token-000000000000000000000000';

describe('HTTP API', () => {
  let app: INestApplication;
  let root: string;

  /** Every call carries the bearer token, the way a non-browser client must. */
  const api = (): Agent =>
    request.agent(app.getHttpServer()).set('Authorization', `Bearer ${TOKEN}`);

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'companion-api-')));
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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const settle = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { body } = await api().get('/status');
      if ((body as { activeJob: unknown }).activeJob === null) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Indexing did not finish in time');
  };

  describe('access control', () => {
    const bare = (): Agent => request.agent(app.getHttpServer());

    it('turns away a local process that presents no credentials', async () => {
      const { body } = await bare().get('/status').expect(401);

      expect(JSON.stringify(body)).toContain('Authorization: Bearer');
    });

    it('turns away a wrong token, however well formed', async () => {
      const response = await bare().get('/status').set('Authorization', 'Bearer not-the-token');

      expect(response.status).toBe(401);
    });

    it('lets the desktop app in on its Origin alone, as a browser cannot forge one', async () => {
      const response = await bare().get('/status').set('Origin', 'tauri://localhost');

      expect(response.status).toBe(200);
    });

    it('turns away a page the user happens to have open', async () => {
      const { body } = await bare()
        .post('/index')
        .set('Origin', 'https://evil.example')
        .send({ path: root })
        .expect(401);

      expect(JSON.stringify(body)).toContain('evil.example');
    });

    it('leaves /health open, so a launcher can wait for the port', async () => {
      const response = await bare().get('/health');

      expect(response.status).toBe(200);
    });
  });

  it('reports health', async () => {
    const { body } = await api().get('/health').expect(200);

    expect(body).toMatchObject({ status: 'ok' });
  });

  it('returns a status payload that satisfies the shared contract', async () => {
    const { body } = await api().get('/status').expect(200);

    expect(indexStatusSchema.safeParse(body).success).toBe(true);
  });

  it('accepts an index request and reports progress through /status', async () => {
    await api().post('/index').send({ path: root }).expect(202);
    await settle();

    const { body } = await api().get('/status').expect(200);
    const status = indexStatusSchema.parse(body);

    expect(status.roots.map((entry) => entry.path)).toEqual([root]);
    expect(status.totalChunks).toBeGreaterThan(0);
  });

  it('answers a chat request with a contract-shaped response', async () => {
    const { body } = await api()
      .post('/chat')
      .send({ message: 'where do we authenticate?' })
      .expect(201);

    const response = chatResponseSchema.parse(body);
    expect(response.model).toBe('stub-chat-model');
    expect(response.toolCalls.map((call) => call.name)).toEqual(['search_code']);
    expect(response.message).toContain('auth.ts');
  });

  it('rejects a malformed body with the field that failed', async () => {
    const { body } = await api().post('/index').send({}).expect(400);

    expect(body).toMatchObject({ statusCode: 400 });
    expect(JSON.stringify(body)).toContain('path');
  });

  it.each([
    ['an empty message', { message: '   ' }],
    ['an unknown history role', { message: 'hi', history: [{ role: 'system', content: 'x' }] }],
  ])('rejects %s on /chat', async (_label, payload) => {
    const response = await api().post('/chat').send(payload);

    expect(response.status).toBe(400);
  });

  it('refuses a path outside the allow-list', async () => {
    const { body } = await api().post('/index').send({ path: '/etc' }).expect(403);

    expect(JSON.stringify(body)).toContain('outside the allowed roots');
  });

  it('404s a path that does not exist', async () => {
    const response = await api()
      .post('/index')
      .send({ path: join(root, 'nope') });

    expect(response.status).toBe(404);
  });

  it('removes an indexed folder and 404s the second time', async () => {
    const removed = await api().delete('/index').query({ path: root });
    const again = await api().delete('/index').query({ path: root });

    expect(removed.status).toBe(204);
    expect(again.status).toBe(404);

    const { body } = await api().get('/status').expect(200);
    expect(indexStatusSchema.parse(body).roots).toEqual([]);
  });

  it('requires a path on delete', async () => {
    const response = await api().delete('/index');

    expect(response.status).toBe(400);
  });

  it('reports that there was nothing to cancel', async () => {
    const { body } = await api().post('/index/cancel').expect(200);

    expect(body).toEqual({ cancelled: false });
  });
});
