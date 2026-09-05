import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import { CopyButton } from './CopyButton';
import { theme } from '../theme/theme';

const writeText = vi.fn<(value: string) => Promise<void>>();

const renderButton = (value = 'const a = 1;') =>
  render(
    <ThemeProvider theme={theme}>
      <CopyButton value={value} label="snippet" />
    </ThemeProvider>,
  );

describe('CopyButton', () => {
  beforeEach(() => {
    writeText.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('puts the value on the clipboard', async () => {
    renderButton('export const answer = 42;');

    await userEvent.click(screen.getByTestId('copy-snippet'));

    expect(writeText).toHaveBeenCalledWith('export const answer = 42;');
  });

  it('confirms the copy, then goes quiet again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderButton();

    await userEvent.click(screen.getByTestId('copy-snippet'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    vi.advanceTimersByTime(1600);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy snippet' })).toBeInTheDocument();
    });
  });

  it('says it could not copy rather than looking like a dead button', async () => {
    // A webview without clipboard permission rejects. Swallowing that is
    // indistinguishable from nothing happening, which is what the user reports.
    writeText.mockRejectedValue(new Error('denied'));
    renderButton();

    await userEvent.click(screen.getByTestId('copy-snippet'));

    expect(await screen.findByRole('button', { name: 'Could not copy' })).toBeInTheDocument();
  });

  it('names what it copies, so two buttons on one answer are distinguishable', () => {
    renderButton();

    expect(screen.getByRole('button', { name: 'Copy snippet' })).toBeInTheDocument();
  });
});
