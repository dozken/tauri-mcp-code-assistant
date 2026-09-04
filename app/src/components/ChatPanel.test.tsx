import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { ChatPanel } from './ChatPanel';
import { splitFences } from './MessageBubble';
import { initialState, useAppStore } from '../store/appStore';
import { theme } from '../theme';

const renderPanel = (onSend: (message: string) => void) =>
  render(
    <ThemeProvider theme={theme}>
      <ChatPanel onSend={onSend} />
    </ThemeProvider>,
  );

describe('splitFences', () => {
  it('separates prose from fenced code and records the language', () => {
    expect(splitFences('Here:\n```ts\nconst a = 1;\n```\nDone.')).toEqual([
      { kind: 'text', content: 'Here:\n' },
      { kind: 'code', language: 'ts', content: 'const a = 1;\n' },
      { kind: 'text', content: '\nDone.' },
    ]);
  });

  it('renders a fence that is still streaming (no closing marker yet)', () => {
    expect(splitFences('```ts\nconst a =')).toEqual([
      { kind: 'code', language: 'ts', content: 'const a =' },
    ]);
  });

  it('treats plain text as a single segment', () => {
    expect(splitFences('just words')).toEqual([{ kind: 'text', content: 'just words' }]);
  });
});

describe('ChatPanel', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initialState, messages: [], connected: true });
  });

  it('disables input until the backend connects', () => {
    useAppStore.setState({ connected: false });
    renderPanel(vi.fn());

    expect(screen.getByTestId('chat-input')).toBeDisabled();
  });

  it('sends the typed message and clears the box', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderPanel(onSend);

    const input = screen.getByTestId('chat-input');
    await user.type(input, 'where is auth?');
    await user.click(screen.getByTestId('send-button'));

    expect(onSend).toHaveBeenCalledExactlyOnceWith('where is auth?');
    expect(input).toHaveValue('');
  });

  it('sends on Enter but inserts a newline on Shift+Enter', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderPanel(onSend);

    const input = screen.getByTestId('chat-input');
    await user.type(input, 'first{Shift>}{Enter}{/Shift}second');
    expect(onSend).not.toHaveBeenCalled();

    await user.type(input, '{Enter}');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('first\nsecond');
  });

  it('ignores an empty or whitespace-only draft', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderPanel(onSend);

    await user.type(screen.getByTestId('chat-input'), '   {Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('renders the streamed answer, its tool calls and its code fences', async () => {
    renderPanel(vi.fn());

    // Store writes drive React re-renders, so they belong inside act().
    act(() => {
      const store = useAppStore.getState();
      store.addUserMessage('where is auth?');
      store.beginAssistantMessage();
      store.addToolCall({
        name: 'search_code',
        args: { query: 'auth' },
        result: 'src/auth.ts:1-10',
        durationMs: 7,
        failed: false,
      });
      store.appendToken('Found it in ');
      store.appendToken('`src/auth.ts`:\n```ts\nexport const authenticate = () => true;\n```');
      store.completeAssistantMessage();
    });

    await waitFor(() => expect(screen.getByTestId('message-assistant')).toBeInTheDocument());
    expect(screen.getByText(/Found it in/)).toBeInTheDocument();
    expect(screen.getByText(/export const authenticate/)).toBeInTheDocument();
    expect(screen.getByText('search_code · 7ms')).toBeInTheDocument();
  });

  it('blocks a second message while one is still streaming', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderPanel(onSend);

    act(() => useAppStore.getState().beginAssistantMessage());

    await user.type(screen.getByTestId('chat-input'), 'another question{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('send-button')).toBeDisabled();
  });

  it('shows a backend error without losing the transcript', async () => {
    renderPanel(vi.fn());

    act(() => {
      useAppStore.getState().addUserMessage('hi');
      useAppStore.getState().beginAssistantMessage();
      useAppStore.getState().failAssistantMessage('Cannot reach the backend');
    });

    await waitFor(() =>
      expect(screen.getAllByText('Cannot reach the backend').length).toBeGreaterThan(0),
    );
    expect(screen.getByTestId('message-user')).toHaveTextContent('hi');
  });
});
