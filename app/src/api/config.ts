import { DEFAULT_BACKEND_URL } from './backend-origin';
import { getAppInfo } from './tauri';

/**
 * Backend origin from the build. Override with `VITE_BACKEND_URL`; the CSP in
 * `index.html` is generated from the same value, so the two cannot drift.
 */
const CONFIGURED: string = import.meta.env.VITE_BACKEND_URL ?? DEFAULT_BACKEND_URL;

let resolved = CONFIGURED;

/**
 * Where the backend actually is.
 *
 * A packaged desktop app starts its own backend on a port chosen at launch — a
 * fixed one is the port a developer already has something on — so the window has
 * to ask the shell rather than assume. Read through a function because the answer
 * arrives after the modules that need it have loaded.
 */
export const backendUrl = (): string => resolved;

/**
 * Asks the desktop shell where its backend is, before anything connects.
 * Falls back to the configured URL in a browser, which has no shell to ask.
 */
export const resolveBackendUrl = async (): Promise<string> => {
  const info = await getAppInfo().catch(() => undefined);
  resolved = info?.backendUrl ?? CONFIGURED;

  return resolved;
};
