import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { App } from './App';
import { initialState, useAppStore } from './store/appStore';
import { theme } from './theme';

const sendMessage = vi.fn();
const indexFolder = vi.fn();
const refreshStatus = vi.fn();

vi.mock('./hooks/useBackend', () => ({
  useBackend: () => ({ sendMessage, indexFolder, refreshStatus }),
}));
vi.mock('./api/tauri', () => ({
  pickFolder: () => Promise.resolve(undefined),
  getAppInfo: () => Promise.resolve(undefined),
}));

const renderApp = () =>
  render(
    <ThemeProvider theme={theme}>
      <App />
    </ThemeProvider>,
  );

describe('App', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initialState, messages: [] });
  });

  it('shows the app offline until the socket connects', () => {
    renderApp();

    expect(screen.getByTestId('connection-status')).toHaveTextContent('offline');
  });

  it('shows which store is backing the index, and how much is in it', () => {
    act(() => {
      useAppStore.setState({ connected: true, vectorStore: 'chroma', totalChunks: 137 });
    });
    renderApp();

    expect(screen.getByTestId('connection-status')).toHaveTextContent('connected');
    expect(screen.getByText('chroma · 137 chunks')).toBeInTheDocument();
  });

  it('renders both panes', () => {
    renderApp();

    expect(screen.getByText('Indexed folders')).toBeInTheDocument();
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });
});
