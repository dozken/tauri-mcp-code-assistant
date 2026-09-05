import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import type { ToolInvocation } from '@ai-code-companion/contracts';
import { MessageBubble } from './MessageBubble';
import { theme } from '../theme/theme';
import type { ChatMessage } from '../types';

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  content: 'Hello',
  createdAt: 0,
  toolCalls: [],
  streaming: false,
  ...overrides,
});

const toolCall = (overrides: Partial<ToolInvocation> = {}): ToolInvocation => ({
  name: 'search_code',
  args: { query: 'auth' },
  result: 'src/auth.ts:1-3',
  durationMs: 7,
  failed: false,
  ...overrides,
});

const renderBubble = (value: ChatMessage) =>
  render(
    <ThemeProvider theme={theme}>
      <MessageBubble message={value} />
    </ThemeProvider>,
  );

describe('MessageBubble', () => {
  it('tags the bubble with its role so the layout can differ', () => {
    renderBubble(message({ role: 'user', content: 'a question' }));

    expect(screen.getByTestId('message-user')).toHaveTextContent('a question');
    expect(screen.queryByTestId('message-assistant')).not.toBeInTheDocument();
  });

  it('renders prose as text and a fenced block as code', () => {
    renderBubble(message({ content: 'Found it:\n```ts\nconst a = 1;\n```' }));

    expect(screen.getByText('Found it:')).toBeInTheDocument();
    // Highlighting splits the line into spans, so the assertion is on the block.
    const block = screen.getByRole('region', { name: 'ts code snippet' });
    expect(block).toHaveTextContent('const a = 1;');
    expect(block.querySelector('code')).not.toBeNull();
  });

  it('stamps every message with a machine-readable time', () => {
    // `<time datetime>` rather than a formatted string alone: that is the value a
    // screen reader announces and the one an export would keep.
    const at = Date.UTC(2026, 0, 2, 3, 4, 5);
    renderBubble(message({ content: 'hello', createdAt: at }));

    expect(screen.getByTestId('message-time')).toHaveAttribute(
      'datetime',
      new Date(at).toISOString(),
    );
  });

  it('shows the time in the reader’s own clock, not a fixed one', () => {
    const at = Date.UTC(2026, 0, 2, 3, 4, 5);
    renderBubble(message({ content: 'hello', createdAt: at }));

    expect(screen.getByTestId('message-time')).toHaveTextContent(
      new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(at),
    );
  });

  it('shows a thinking placeholder only while empty and streaming', () => {
    const { unmount } = renderBubble(message({ content: '', streaming: true }));
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
    unmount();

    renderBubble(message({ content: 'partial', streaming: true }));
    expect(screen.queryByText('Thinking…')).not.toBeInTheDocument();
  });

  it('omits the tool section entirely when no tool ran', () => {
    renderBubble(message());

    expect(screen.queryByText(/search_code/)).not.toBeInTheDocument();
  });

  it('still shows Thinking… while the stream has produced only whitespace', () => {
    // A model that opens with a newline is common, and `content === ''` misses it:
    // the placeholder vanishes and the bubble sits visibly empty instead.
    renderBubble(message({ content: '\n  ', streaming: true }));

    expect(screen.getByText('Thinking…')).toBeInTheDocument();
  });

  it('renders no tool section markup at all when the list is empty', () => {
    // `queryByText` alone passes even when an empty accordion renders; the expand
    // control is what the user sees and what a keyboard lands on. Scoped to that
    // control rather than "no buttons", because the answer carries a copy button.
    renderBubble(message());

    expect(screen.queryByRole('button', { expanded: false })).not.toBeInTheDocument();
  });

  it('offers to copy a finished answer, but not a half-streamed one', () => {
    const { unmount } = renderBubble(message({ content: 'partial', streaming: true }));
    expect(screen.queryByTestId('copy-answer')).not.toBeInTheDocument();
    unmount();

    renderBubble(message({ content: 'the whole answer' }));
    expect(screen.getByTestId('copy-answer')).toBeInTheDocument();
  });

  it('does not offer to copy the user their own message back', () => {
    renderBubble(message({ role: 'user', content: 'a question' }));

    expect(screen.queryByTestId('copy-answer')).not.toBeInTheDocument();
  });

  it('reads the timestamp against the bubble it sits in, not against the page', () => {
    // `text.secondary` is dark grey. On the assistant's paper that is right; on the
    // user's filled accent it is unreadable, and the light-theme axe scan said so.
    const { unmount } = renderBubble(message({ role: 'user', content: 'q' }));
    const user = getComputedStyle(screen.getByTestId('message-time')).color;
    unmount();

    renderBubble(message({ role: 'assistant', content: 'a' }));
    const assistant = getComputedStyle(screen.getByTestId('message-time')).color;

    expect(user).not.toBe(assistant);
  });

  it('paints the user bubble in the accent, and the assistant one on paper', () => {
    // Colour is what says who is talking. Both bubbles rendering the same, or the
    // two swapped, is a real defect that no role-based assertion can see.
    const paperOf = (testId: string): HTMLElement => {
      const paper = screen.getByTestId(testId).querySelector('.MuiPaper-root');
      if (!(paper instanceof HTMLElement)) throw new Error(`no bubble inside ${testId}`);
      return paper;
    };

    const { unmount } = renderBubble(message({ role: 'user', content: 'q' }));
    const user = getComputedStyle(paperOf('message-user')).backgroundColor;
    unmount();

    renderBubble(message({ role: 'assistant', content: 'a' }));
    const assistant = getComputedStyle(paperOf('message-assistant')).backgroundColor;

    // jsdom reports computed colours as `rgb(...)`, the palette stores hex.
    const asRgb = (hex: string): string => {
      const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((offset) =>
        Number.parseInt(hex.slice(offset, offset + 2), 16),
      );
      return `rgb(${String(red)}, ${String(green)}, ${String(blue)})`;
    };

    expect(user).not.toBe(assistant);
    expect(user).toBe(asRgb(theme.palette.primary.main));
    expect(assistant).toBe(asRgb(theme.palette.background.paper));
  });

  it('summarises each tool call as a chip and reveals its output on expand', async () => {
    renderBubble(
      message({ toolCalls: [toolCall(), toolCall({ name: 'explain_file', durationMs: 3 })] }),
    );

    expect(screen.getByText('search_code · 7ms')).toBeInTheDocument();
    expect(screen.getByText('explain_file · 3ms')).toBeInTheDocument();

    await userEvent.click(screen.getByText('search_code · 7ms'));
    expect(screen.getByText(/search_code\({"query":"auth"}\)/)).toBeInTheDocument();
  });

  it('marks a failed tool call differently from a successful one', () => {
    renderBubble(
      message({ toolCalls: [toolCall({ failed: true, result: 'Tool failed: offline' })] }),
    );

    // MUI encodes the palette in the class name; `error` vs `secondary` is the signal.
    const chip = screen.getByText('search_code · 7ms').closest('.MuiChip-root');
    expect(chip?.className).toContain('colorError');
  });

  it('renders an error alert alongside whatever streamed before it', () => {
    renderBubble(message({ content: 'partial answer', error: 'backend gone' }));

    expect(screen.getByText('partial answer')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('backend gone')).toBeInTheDocument();
  });

  it('shows no alert when there is no error', () => {
    renderBubble(message());

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
