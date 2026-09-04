import {
  API_ROUTES,
  cancelIndexingResponseSchema,
  indexJobSchema,
  indexStatusSchema,
  type CancelIndexingResponse,
  type IndexJob,
  type IndexStatus,
} from '@ai-code-companion/contracts';
import type { ZodType } from 'zod';
import { BACKEND_URL } from './config';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** The response did not match the contract — usually app/backend version skew. */
export class ContractError extends Error {
  constructor(path: string, detail: string) {
    super(`${path} returned data that does not match the contract: ${detail}`);
    this.name = 'ContractError';
  }
}

const request = async <T>(
  path: string,
  schema: ZodType<T> | undefined,
  init?: RequestInit,
): Promise<T> => {
  // `HeadersInit` may be an object, a tuple list or a `Headers`; spreading it into
  // an object literal turns the last two into `{0: [...], 1: [...]}`.
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');

  const response = await fetch(`${BACKEND_URL}${path}`, { ...init, headers });

  if (!response.ok) {
    // Nest returns `{ statusCode, message }`; surface that instead of "500".
    const detail = await response
      .json()
      .then((body: { message?: string | string[] }) =>
        Array.isArray(body.message) ? body.message.join(', ') : body.message,
      )
      .catch(() => undefined);
    throw new HttpError(detail ?? `${response.status} ${response.statusText}`, response.status);
  }

  if (schema === undefined || response.status === 204) return undefined as T;

  // Validating here rather than trusting the cast means a backend that drifts
  // fails loudly at the boundary instead of rendering `undefined` deep in the UI.
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ContractError(path, parsed.error.issues.map((issue) => issue.message).join(', '));
  }
  return parsed.data;
};

export const fetchStatus = (): Promise<IndexStatus> =>
  request(API_ROUTES.status, indexStatusSchema);

export const startIndexing = (path: string): Promise<IndexJob> =>
  request(API_ROUTES.index, indexJobSchema, {
    method: 'POST',
    body: JSON.stringify({ path }),
  });

export const cancelIndexing = (): Promise<CancelIndexingResponse> =>
  request(API_ROUTES.cancelIndex, cancelIndexingResponseSchema, { method: 'POST' });

export const removeRoot = (path: string): Promise<void> =>
  request(`${API_ROUTES.index}?path=${encodeURIComponent(path)}`, undefined, { method: 'DELETE' });
