import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
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
describe('HTTP API', () => {
  let app: INestApplication;
  let root: string;

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
      const { body } = await request(app.getHttpServer()).get('/status');
      if ((body as { activeJob: unknown }).activeJob === null) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Indexing did not finish in time');
  };

  it('reports health', async () => {
    const { body } = await request(app.getHttpServer()).get('/health').expect(200);

    expect(body).toMatchObject({ status: 'ok' });
  });

  it('returns a status payload that satisfies the shared contract', async () => {
    const { body } = await request(app.getHttpServer()).get('/status').expect(200);

    expect(indexStatusSchema.safeParse(body).success).toBe(true);
  });

  it('accepts an index request and reports progress through /status', async () => {
    await request(app.getHttpServer()).post('/index').send({ path: root }).expect(202);
    await settle();

    const { body } = await request(app.getHttpServer()).get('/status').expect(200);
    const status = indexStatusSchema.parse(body);

    expect(status.roots.map((entry) => entry.path)).toEqual([root]);
    expect(status.totalChunks).toBeGreaterThan(0);
  });

  it('answers a chat request with a contract-shaped response', async () => {
    const { body } = await request(app.getHttpServer())
      .post('/chat')
      .send({ message: 'where do we authenticate?' })
      .expect(201);

    const response = chatResponseSchema.parse(body);
    expect(response.model).toBe('stub-chat-model');
    expect(response.toolCalls.map((call) => call.name)).toEqual(['search_code']);
    expect(response.message).toContain('auth.ts');
  });

  it('rejects a malformed body with the field that failed', async () => {
    const { body } = await request(app.getHttpServer()).post('/index').send({}).expect(400);

    expect(body).toMatchObject({ statusCode: 400 });
    expect(JSON.stringify(body)).toContain('path');
  });

  it.each([
    ['an empty message', { message: '   ' }],
    ['an unknown history role', { message: 'hi', history: [{ role: 'system', content: 'x' }] }],
  ])('rejects %s on /chat', async (_label, payload) => {
    const response = await request(app.getHttpServer()).post('/chat').send(payload);

    expect(response.status).toBe(400);
  });

  it('refuses a path outside the allow-list', async () => {
    const { body } = await request(app.getHttpServer())
      .post('/index')
      .send({ path: '/etc' })
      .expect(403);

    expect(JSON.stringify(body)).toContain('outside the allowed roots');
  });

  it('404s a path that does not exist', async () => {
    const response = await request(app.getHttpServer())
      .post('/index')
      .send({ path: join(root, 'nope') });

    expect(response.status).toBe(404);
  });

  it('removes an indexed folder and 404s the second time', async () => {
    const removed = await request(app.getHttpServer()).delete('/index').query({ path: root });
    const again = await request(app.getHttpServer()).delete('/index').query({ path: root });

    expect(removed.status).toBe(204);
    expect(again.status).toBe(404);

    const { body } = await request(app.getHttpServer()).get('/status').expect(200);
    expect(indexStatusSchema.parse(body).roots).toEqual([]);
  });

  it('requires a path on delete', async () => {
    const response = await request(app.getHttpServer()).delete('/index');

    expect(response.status).toBe(400);
  });

  it('reports that there was nothing to cancel', async () => {
    const { body } = await request(app.getHttpServer()).post('/index/cancel').expect(200);

    expect(body).toEqual({ cancelled: false });
  });
});
