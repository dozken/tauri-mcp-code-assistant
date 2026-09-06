import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveBackendUrl } from './api/config';
import { AppThemeProvider } from './theme/AppThemeProvider';

const container = document.querySelector('#root');
if (!container) throw new Error('Missing #root element');

/**
 * Asks the shell where its backend is before the first render, because the socket
 * connects as the app mounts and a packaged build's backend is on a port only the
 * shell knows.
 *
 * A function rather than top-level await: the desktop build targets the WebKit
 * that Tauri ships, which has none.
 */
const start = async (): Promise<void> => {
  await resolveBackendUrl();

  createRoot(container).render(
    <StrictMode>
      <AppThemeProvider>
        <App />
      </AppThemeProvider>
    </StrictMode>,
  );
};

void start();
