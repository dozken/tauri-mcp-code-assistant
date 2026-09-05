import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexStatus } from '@ai-code-companion/contracts';
import {
  ContractError,
  HttpError,
  cancelIndexing,
  fetchStatus,
  removeRoot,
  startIndexing,
} from './http';

const status: IndexStatus = {
  activeJob: null,
  roots: [],
  vectorStore: 'memory',
  metadataStore: 'sqlite',
  totalChunks: 0,
};

const respond = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

const fetchMock = vi.fn<typeof fetch>();

/** The `Request` the code under test actually built. */
const lastCall = (): { url: string; init: RequestInit } => {
  const call = fetchMock.mock.calls.at(-1);
  return { url: String(call?.[0]), init: call?.[1] ?? {} };
};

describe('http client', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a valid status response', async () => {
    fetchMock.mockResolvedValue(respond(status));

    await expect(fetchStatus()).resolves.toEqual(status);
    expect(lastCall().url).toMatch(/\/status$/);
  });

  it('sends JSON with a Content-Type header', async () => {
    fetchMock.mockResolvedValue(
      respond(
        {
          id: 'job',
          root: '/repo',
          state: 'running',
          filesDiscovered: 0,
          filesIndexed: 0,
          filesSkipped: 0,
          chunksIndexed: 0,
          startedAt: '2026-01-01T00:00:00.000Z',
        },
        { status: 202 },
      ),
    );

    await startIndexing('/repo');

    const { init } = lastCall();
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ path: '/repo' }));
    // `new Headers` rather than object spread: a HeadersInit may be a tuple list.
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('percent-encodes a path with spaces on delete', async () => {
    fetchMock.mockResolvedValue(respond(undefined, { status: 204 }));

    await expect(removeRoot('/my repo/&x')).resolves.toBeUndefined();
    expect(lastCall().url).toContain('path=%2Fmy%20repo%2F%26x');
  });

  it('surfaces the backend message rather than the status code', async () => {
    fetchMock.mockResolvedValue(
      respond({ statusCode: 403, message: 'Path is outside the allowed roots' }, { status: 403 }),
    );

    await expect(startIndexing('/etc')).rejects.toThrow(/outside the allowed roots/);
  });

  it('joins a list of validation messages', async () => {
    fetchMock.mockResolvedValue(
      respond({ statusCode: 400, message: ['path: required', 'limit: too big'] }, { status: 400 }),
    );

    await expect(fetchStatus()).rejects.toThrow('path: required, limit: too big');
  });

  it('falls back to the status text when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
    );

    const error: unknown = await fetchStatus().catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(502);
    expect((error as HttpError).message).toBe('502 Bad Gateway');
  });

  it('rejects a response that does not match the contract', async () => {
    // `totalChunks` missing: exactly the app/backend skew this guard exists for.
    fetchMock.mockResolvedValue(respond({ activeJob: null, roots: [], vectorStore: 'memory' }));

    await expect(fetchStatus()).rejects.toBeInstanceOf(ContractError);
  });

  it('rejects a status payload with an unknown store kind', async () => {
    fetchMock.mockResolvedValue(respond({ ...status, vectorStore: 'pinecone' }));

    await expect(fetchStatus()).rejects.toBeInstanceOf(ContractError);
  });

  it('parses the cancel acknowledgement', async () => {
    fetchMock.mockResolvedValue(respond({ cancelled: true }));

    await expect(cancelIndexing()).resolves.toEqual({ cancelled: true });
  });

  it('propagates a network failure untouched', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(fetchStatus()).rejects.toThrow('Failed to fetch');
  });
});
