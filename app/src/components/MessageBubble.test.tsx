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
    const code = screen.getByText('const a = 1;');
    expect(code.tagName).toBe('CODE');
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
