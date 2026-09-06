import { DEFAULT_BACKEND_URL } from './backend-origin';

/**
 * Backend origin. Override with `VITE_BACKEND_URL` (e.g. for a packaged build);
 * the CSP in `index.html` is generated from the same value at build time, so the
 * two cannot drift.
 */
export const BACKEND_URL: string = import.meta.env.VITE_BACKEND_URL ?? DEFAULT_BACKEND_URL;
