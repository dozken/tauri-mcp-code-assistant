import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { ChatPanel } from './ChatPanel';
import { initialState, useAppStore } from '../store/appStore';
import { theme } from '../theme/theme';

const renderPanel = (onSend: (message: string) => void) =>
  render(
    <ThemeProvider theme={theme}>
      <ChatPanel onSend={onSend} />
    </ThemeProvider>,
  );

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

  it('offers example prompts, and sends the one that is clicked', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderPanel(onSend);

    await user.click(screen.getByText('Where is authentication handled?'));

    expect(onSend).toHaveBeenCalledExactlyOnceWith('Where is authentication handled?');
  });

  it('disables the example prompts while offline', () => {
    useAppStore.setState({ connected: false });
    renderPanel(vi.fn());

    expect(screen.getByText('Explain the indexing service').closest('div')).toHaveClass(
      'Mui-disabled',
    );
  });

  it('explains what the composer is waiting for when offline', () => {
    useAppStore.setState({ connected: false });
    renderPanel(vi.fn());

    expect(screen.getByPlaceholderText(/Waiting for the backend/)).toBeInTheDocument();
  });

  it('says whether the search is scoped to one folder', () => {
    const { unmount } = renderPanel(vi.fn());
    expect(screen.getByText('Searching all indexed folders')).toBeInTheDocument();
    unmount();

    act(() => {
      useAppStore.getState().selectRoot('/home/dev/api');
    });
    renderPanel(vi.fn());
    expect(screen.getByText('Scoped to /home/dev/api')).toBeInTheDocument();
  });

  it('offers Clear chat only once there is a transcript, and clears it', async () => {
    const user = userEvent.setup();
    renderPanel(vi.fn());
    expect(screen.queryByText('Clear chat')).not.toBeInTheDocument();

    act(() => {
      useAppStore.getState().addUserMessage('hello');
    });
    await user.click(screen.getByText('Clear chat'));

    expect(useAppStore.getState().messages).toEqual([]);
    expect(screen.getByText('Ask something about your codebase')).toBeInTheDocument();
  });

  it('surfaces a store-level error above the composer', () => {
    act(() => {
      useAppStore.getState().setError('Cannot reach the backend');
    });
    renderPanel(vi.fn());

    expect(screen.getByRole('alert')).toHaveTextContent('Cannot reach the backend');
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

describe('ChatPanel follows the stream only when the reader is at the bottom', () => {
  /**
   * jsdom lays nothing out, so every scroll property is 0. Defining them on the
   * prototype lets the component read a scroll position that a real browser would
   * have produced, which is the only thing the effect branches on.
   */
  const pretendScrolled = (distanceFromBottom: number): void => {
    for (const [property, value] of [
      ['scrollHeight', 1000],
      ['clientHeight', 500],
      ['scrollTop', 500 - distanceFromBottom],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, property, {
        configurable: true,
        get: () => value,
      });
    }
  };

  const scrollIntoView = vi.fn();

  beforeEach(() => {
    useAppStore.setState({ ...initialState, messages: [], connected: true });
    scrollIntoView.mockReset();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
  });

  it('scrolls to the newest message when already pinned to the bottom', () => {
    pretendScrolled(0);

    renderPanel(vi.fn());
    act(() => {
      useAppStore.getState().addUserMessage('a question');
    });

    expect(scrollIntoView).toHaveBeenCalled();
    // `auto`, not `smooth`: a smooth scroll per token never finishes before the
    // next token starts, and the view lurches instead of following.
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'end', behavior: 'auto' });
  });

  it('leaves the view alone when the reader has scrolled up mid-answer', () => {
    // The bug this guards: scrolling up to re-read something was impossible,
    // because every streamed token yanked the view back to the bottom.
    pretendScrolled(400);

    renderPanel(vi.fn());
    scrollIntoView.mockReset();
    act(() => {
      useAppStore.getState().addUserMessage('a question');
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
