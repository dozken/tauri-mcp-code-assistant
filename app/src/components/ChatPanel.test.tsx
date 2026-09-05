import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { ChatPanel } from './ChatPanel';
import { initialState, useAppStore } from '../store/appStore';
import { theme } from '../theme/theme';

const renderPanel = (onSend: (message: string) => void, onCancel: () => void = vi.fn()) =>
  render(
    <ThemeProvider theme={theme}>
      <ChatPanel onSend={onSend} onCancel={onCancel} />
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
    // The snippet is syntax-highlighted, so its text is spread across spans and
    // only the block as a whole holds the line.
    expect(screen.getByRole('region', { name: 'ts code snippet' })).toHaveTextContent(
      'export const authenticate = () => true;',
    );
    expect(screen.getByText('search_code · 7ms')).toBeInTheDocument();
  });

  it('blocks a second message while one is still streaming', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    renderPanel(onSend);

    act(() => useAppStore.getState().beginAssistantMessage());

    await user.type(screen.getByTestId('chat-input'), 'another question{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    // Send is not disabled mid-turn any more, it is replaced: the only useful
    // action while an answer is streaming is to stop it.
    expect(screen.getByTestId('stop-button')).toBeInTheDocument();
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

describe('ChatPanel stopping a turn', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initialState, messages: [], connected: true });
  });

  it('offers Stop while a turn is streaming, and Send otherwise', () => {
    const { unmount } = renderPanel(vi.fn());
    expect(screen.getByTestId('send-button')).toBeInTheDocument();
    expect(screen.queryByTestId('stop-button')).not.toBeInTheDocument();
    unmount();

    act(() => {
      useAppStore.setState({ isStreaming: true });
    });
    renderPanel(vi.fn());

    // One control, two jobs: a separate Stop would sit disabled and dead the
    // rest of the time, and Send is useless mid-turn anyway.
    expect(screen.getByTestId('stop-button')).toBeInTheDocument();
    expect(screen.queryByTestId('send-button')).not.toBeInTheDocument();
  });

  it('asks the backend to stop when it is clicked', async () => {
    // The gateway has always been able to abort a turn; nothing in the UI reached
    // it, so a wrong answer streamed to the end while the user watched.
    const onCancel = vi.fn();
    act(() => {
      useAppStore.setState({ isStreaming: true });
    });
    renderPanel(vi.fn(), onCancel);

    await userEvent.click(screen.getByTestId('stop-button'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('names the Stop control for a screen reader, not just an icon', () => {
    act(() => {
      useAppStore.setState({ isStreaming: true });
    });
    renderPanel(vi.fn());

    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();
  });
});

describe('ChatPanel follows the stream only when the reader is at the bottom', () => {
  /**
   * jsdom lays nothing out, so every scroll property is 0. Defining them on the
   * prototype lets the component read a scroll position that a real browser would
   * have produced, which is the only thing the behaviour branches on.
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

  /** What the reader does: move the transcript, and let the component notice. */
  const readerScrollsTo = (distanceFromBottom: number): void => {
    pretendScrolled(distanceFromBottom);
    fireEvent.scroll(screen.getByTestId('message-list'));
  };

  /** There is no end to scroll to until the transcript has something in it. */
  const withTranscript = (): void => {
    act(() => {
      const store = useAppStore.getState();
      store.addUserMessage('a question');
      store.beginAssistantMessage();
      store.appendToken('the beginning of an answer');
    });
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

  it('scrolls to the newest message', () => {
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

  it('keeps following a turn that is taller than the slack in one go', () => {
    // The regression this pins: pinned-ness used to be measured when the message
    // arrived, by which time the message itself was already in the layout. A
    // question and its answer bubble are far taller than the slack, so sending
    // one made the component decide the reader had scrolled away — and then
    // stop scrolling to the message they had just sent. Nobody scrolled here.
    pretendScrolled(400);

    renderPanel(vi.fn());
    act(() => {
      useAppStore.getState().addUserMessage('a question');
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'auto' });
    expect(screen.queryByTestId('jump-to-latest')).not.toBeInTheDocument();
  });

  it('leaves the view alone once the reader has scrolled up mid-answer', () => {
    // The bug this guards: scrolling up to re-read something was impossible,
    // because every streamed token yanked the view back to the bottom.
    pretendScrolled(0);
    renderPanel(vi.fn());
    withTranscript();
    readerScrollsTo(400);
    scrollIntoView.mockReset();

    act(() => {
      useAppStore.getState().appendToken('more of the answer');
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('offers a way back down once the reader has scrolled away', () => {
    // Not following is right; stranding them there is not. Without this the only
    // way back to a live answer is to scroll by hand and guess when it ends.
    pretendScrolled(0);
    renderPanel(vi.fn());

    readerScrollsTo(400);

    expect(screen.getByTestId('jump-to-latest')).toBeInTheDocument();
  });

  it('offers nothing while the reader is already at the bottom', () => {
    pretendScrolled(0);
    renderPanel(vi.fn());

    readerScrollsTo(0);

    expect(screen.queryByTestId('jump-to-latest')).not.toBeInTheDocument();
  });

  it('scrolls back to the newest message when it is clicked, and stands down', async () => {
    pretendScrolled(0);
    renderPanel(vi.fn());
    withTranscript();
    readerScrollsTo(400);
    scrollIntoView.mockReset();

    await userEvent.click(screen.getByTestId('jump-to-latest'));

    // `smooth` here, unlike the per-token follow: this is one deliberate jump, so
    // the movement is worth seeing.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'smooth' });
    expect(screen.queryByTestId('jump-to-latest')).not.toBeInTheDocument();
  });

  it('follows again after the jump, without waiting for another scroll', async () => {
    pretendScrolled(0);
    renderPanel(vi.fn());
    withTranscript();
    readerScrollsTo(400);
    await userEvent.click(screen.getByTestId('jump-to-latest'));
    scrollIntoView.mockReset();

    act(() => {
      useAppStore.getState().addUserMessage('the next question');
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'auto' });
  });

  it('follows again when the reader scrolls back to the bottom themselves', () => {
    pretendScrolled(0);
    renderPanel(vi.fn());
    withTranscript();
    readerScrollsTo(400);
    readerScrollsTo(0);
    scrollIntoView.mockReset();

    act(() => {
      useAppStore.getState().appendToken('the rest of it');
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'end', behavior: 'auto' });
    expect(screen.queryByTestId('jump-to-latest')).not.toBeInTheDocument();
  });
});
