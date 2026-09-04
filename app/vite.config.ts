import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

// An empty string means "unset" for this variable, which `??` would not catch.
const rawHost = process.env.TAURI_DEV_HOST?.trim();
const host = rawHost === undefined || rawHost === '' ? undefined : rawHost;

// https://vite.dev/config/ — tuned for `tauri dev`, which expects a fixed port.
export default defineConfig({
  plugins: [react()],
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
