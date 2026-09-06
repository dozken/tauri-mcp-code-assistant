import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { browserPolicy, desktopPolicy, DEFAULT_BACKEND_URL } from './src/api/backend-origin';

const TAURI_CONFIG = fileURLToPath(new URL('src-tauri/tauri.conf.json', import.meta.url));

/** The token `index.html` carries where the header belongs. */
const CSP_PLACEHOLDER = '%CSP%';

/** Set by the Tauri CLI for every build it drives, and by nothing else. */
const isDesktopBuild = (): boolean => process.env.TAURI_ENV_PLATFORM !== undefined;

/**
 * Writes the CSP into `index.html`, and refuses to build when the desktop
 * window's own policy disagrees with it.
 *
 * Both policies are enforced in a Tauri window — the `<meta>` tag from this build
 * and `app.security.csp` from `tauri.conf.json` — and a connection has to satisfy
 * the intersection. Keeping them the same string is the only way to be sure the
 * intersection is not empty. A packaged window with a perfectly good backend and
 * not one socket to it is what taught us that.
 */
const backendCsp = (): Plugin => {
  let csp = browserPolicy(DEFAULT_BACKEND_URL);

  return {
    name: 'backend-csp',
    // Vite's resolved env, not `process.env`: a `.env` file is the ordinary way to
    // set this and never reaches the process environment.
    configResolved(config) {
      const env = config.env as Record<string, string | undefined>;
      const configured = env.VITE_BACKEND_URL?.trim();
      const backendUrl =
        configured === undefined || configured === '' ? DEFAULT_BACKEND_URL : configured;

      // A desktop build's backend is started by the shell on a port chosen at
      // launch, so `VITE_BACKEND_URL` has nothing to say about it.
      csp = isDesktopBuild() ? desktopPolicy() : browserPolicy(backendUrl);
      // Here rather than in the HTML hook, so a mismatch stops the build at once
      // instead of once a page happens to be rendered.
      assertTauriCspMatches();
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replaceAll(CSP_PLACEHOLDER, csp),
    },
  };
};

const assertTauriCspMatches = (): void => {
  const { app } = JSON.parse(readFileSync(TAURI_CONFIG, 'utf8')) as {
    app?: { security?: { csp?: string } };
  };
  if (app?.security?.csp === desktopPolicy()) return;

  throw new Error(
    'app/src-tauri/tauri.conf.json no longer carries the policy this build writes into ' +
      `index.html. Both are enforced in the desktop window, so set app.security.csp to:\n\n  ${desktopPolicy()}\n`,
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
