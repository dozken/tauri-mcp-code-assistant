import { BACKEND_URL } from './config';
import type { IndexStatus } from '../types';

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

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

  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
};

export const fetchStatus = (): Promise<IndexStatus> => request<IndexStatus>('/status');

export const startIndexing = (path: string): Promise<{ id: string; root: string }> =>
  request('/index', { method: 'POST', body: JSON.stringify({ path }) });

export const cancelIndexing = (): Promise<{ cancelled: boolean }> =>
  request('/index/cancel', { method: 'POST' });

export const removeRoot = (path: string): Promise<void> =>
  request(`/index?path=${encodeURIComponent(path)}`, { method: 'DELETE' });

export { HttpError };
