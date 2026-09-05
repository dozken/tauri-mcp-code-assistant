import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { App } from './App';
import { initialState, useAppStore } from './store/appStore';
import { theme } from './theme/theme';

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
    vi.clearAllMocks();
    useAppStore.setState({ ...initialState, messages: [], connected: true });
  });

  it('shows the app offline until the socket connects', () => {
    act(() => {
      useAppStore.setState({ connected: false });
    });
    renderApp();

    expect(screen.getByTestId('connection-status')).toHaveTextContent('offline');
  });

  it('shows which store is backing the index, and how much is in it', () => {
    act(() => {
      useAppStore.setState({ vectorStore: 'chroma', totalChunks: 137 });
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

  it('warns that an in-memory index will not survive a restart', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.hover(screen.getByText('memory · 0 chunks'));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(/lost on restart/);
  });

  it('says the index is persisted when Chroma is backing it', async () => {
    const user = userEvent.setup();
    act(() => {
      useAppStore.setState({ vectorStore: 'chroma' });
    });
    renderApp();

    await user.hover(screen.getByText('chroma · 0 chunks'));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(/persisted in ChromaDB/);
  });

  it('passes the backend actions down to the panes', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.type(screen.getByTestId('chat-input'), 'hello');
    await user.click(screen.getByTestId('send-button'));
    expect(sendMessage).toHaveBeenCalledWith('hello');

    await user.click(screen.getByRole('button', { name: 'Refresh status' }));
    expect(refreshStatus).toHaveBeenCalled();
  });
});
