/** Backend origin. Override with `VITE_BACKEND_URL` (e.g. for a packaged build). */
export const BACKEND_URL: string = import.meta.env.VITE_BACKEND_URL ?? 'http://127.0.0.1:3001';
