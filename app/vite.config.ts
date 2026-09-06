import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
import {
  contentSecurityPolicy,
  connectSources,
  DEFAULT_BACKEND_URL,
  TAURI_IPC_SOURCES,
} from './src/api/backend-origin';

const TAURI_CONFIG = fileURLToPath(new URL('src-tauri/tauri.conf.json', import.meta.url));

/** The token `index.html` carries where the header belongs. */
const CSP_PLACEHOLDER = '%CSP%';

/**
 * Writes the CSP into `index.html` from the same backend URL the app connects to,
 * and refuses to build when the Tauri window's own CSP would not allow it.
 *
 * The desktop shell takes its CSP from `tauri.conf.json`, which is static JSON
 * with nowhere to read an environment variable — so the best that can be done for
 * it is to notice the disagreement at build time and say exactly what to paste.
 * Silently shipping a window that blocks every request is the outcome worth
 * spending a build failure to avoid.
 */
const backendCsp = (): Plugin => {
  let backendUrl = DEFAULT_BACKEND_URL;

  return {
    name: 'backend-csp',
    // Vite's resolved env, not `process.env`: a `.env` file is the ordinary way to
    // set this and never reaches the process environment.
    configResolved(config) {
      const env = config.env as Record<string, string | undefined>;
      const configured = env.VITE_BACKEND_URL?.trim();
      backendUrl = configured === undefined || configured === '' ? DEFAULT_BACKEND_URL : configured;
      // Here rather than in the HTML hook, so a mismatch stops the build at once
      // instead of once a page happens to be rendered.
      assertTauriCspAllows(backendUrl);
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html.replaceAll(CSP_PLACEHOLDER, contentSecurityPolicy(backendUrl, TAURI_IPC_SOURCES)),
    },
  };
};

const assertTauriCspAllows = (backendUrl: string): void => {
  const { app } = JSON.parse(readFileSync(TAURI_CONFIG, 'utf8')) as {
    app?: { security?: { csp?: string } };
  };
  const csp = app?.security?.csp ?? '';
  const missing = connectSources(backendUrl).filter((source) => !csp.includes(source));
  if (missing.length === 0) return;

  throw new Error(
    `VITE_BACKEND_URL is ${backendUrl}, which app/src-tauri/tauri.conf.json does not allow ` +
      `(missing ${missing.join(', ')}). The desktop window would block every request. Set ` +
      `app.security.csp there to:\n\n  ${contentSecurityPolicy(backendUrl, TAURI_IPC_SOURCES)}\n`,
  );
};

// An empty string means "unset" for this variable, which `??` would not catch.
const rawHost = process.env.TAURI_DEV_HOST?.trim();
const host = rawHost === undefined || rawHost === '' ? undefined : rawHost;

// https://vite.dev/config/ — tuned for `tauri dev`, which expects a fixed port.
export default defineConfig({
  plugins: [react(), backendCsp()],
  // Tauri exposes TAURI_* variables to the frontend build.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  clearScreen: false,
  server: {
    port: 1420,
    // Tauri points the webview at a fixed URL, so silently moving ports would
    // leave the desktop window on a dead address.
    strictPort: true,
    host: host ?? '127.0.0.1',
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    // Match the browsers Tauri v2 ships: WebKit on macOS/Linux, WebView2 on Windows.
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
