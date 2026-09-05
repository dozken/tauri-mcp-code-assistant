import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import type { IndexProgressEvent, IndexedRoot } from '@ai-code-companion/contracts';
import { Sidebar } from './Sidebar';
import { initialState, useAppStore } from '../store/appStore';
import { theme } from '../theme/theme';

const pickFolder = vi.fn<() => Promise<string | null | undefined>>();
const getAppInfo = vi.fn<() => Promise<unknown>>();
const removeRoot = vi.fn<(path: string) => Promise<void>>();
const cancelIndexing = vi.fn<() => Promise<{ cancelled: boolean }>>();

vi.mock('../api/tauri', () => ({
  pickFolder: () => pickFolder(),
  getAppInfo: () => getAppInfo(),
}));
vi.mock('../api/http', () => ({
  removeRoot: (path: string) => removeRoot(path),
  cancelIndexing: () => cancelIndexing(),
}));

const root = (overrides: Partial<IndexedRoot> = {}): IndexedRoot => ({
  path: '/home/dev/projects/api',
  fileCount: 12,
  chunkCount: 48,
  lastIndexedAt: '2026-01-01T00:00:00.000Z',
  stale: false,
  ...overrides,
});

const activeJob: IndexProgressEvent = {
  jobId: 'job-1',
  root: '/home/dev/projects/api',
  state: 'running',
  filesDiscovered: 10,
  filesIndexed: 4,
  filesSkipped: 0,
  chunksIndexed: 20,
  currentFile: 'src/auth.ts',
  percent: 40,
};

const renderSidebar = (props: Partial<ComponentProps<typeof Sidebar>> = {}) => {
  const onIndexFolder = props.onIndexFolder ?? vi.fn();
  const onRefresh = props.onRefresh ?? vi.fn();
  render(
    <ThemeProvider theme={theme}>
      <Sidebar onIndexFolder={onIndexFolder} onRefresh={onRefresh} />
    </ThemeProvider>,
  );
  return { onIndexFolder, onRefresh };
};

describe('Sidebar', () => {
  beforeEach(() => {
    useAppStore.setState({ ...initialState, messages: [] });
    pickFolder.mockReset().mockResolvedValue(undefined);
    getAppInfo.mockReset().mockResolvedValue(undefined);
    removeRoot.mockReset().mockResolvedValue(undefined);
    cancelIndexing.mockReset().mockResolvedValue({ cancelled: true });
  });

  it('explains the empty state instead of showing a blank list', () => {
    renderSidebar();

    expect(screen.getByText('No folders yet')).toBeInTheDocument();
  });

  it('lists a folder with its counts', () => {
    act(() => {
      useAppStore.setState({ roots: [root()] });
    });
    renderSidebar();

    const list = screen.getByTestId('root-list');
    expect(within(list).getByText('api')).toBeInTheDocument();
    expect(within(list).getByText(/12 files · 48 chunks/)).toBeInTheDocument();
  });

  it('flags a folder whose chunks did not survive a restart', () => {
    act(() => {
      useAppStore.setState({ roots: [root({ stale: true })] });
    });
    renderSidebar();

    expect(screen.getByText('needs re-index')).toBeInTheDocument();
  });

  it('uses the native picker when Tauri provides one', async () => {
    pickFolder.mockResolvedValue('/home/dev/projects/web');
    const { onIndexFolder } = renderSidebar();

    await userEvent.click(screen.getByTestId('add-folder'));

    await waitFor(() => {
      expect(onIndexFolder).toHaveBeenCalledWith('/home/dev/projects/web');
    });
  });

  it('does nothing when the native picker is cancelled', async () => {
    pickFolder.mockResolvedValue(null);
    const { onIndexFolder } = renderSidebar();

    await userEvent.click(screen.getByTestId('add-folder'));

    await waitFor(() => {
      expect(pickFolder).toHaveBeenCalled();
    });
    expect(onIndexFolder).not.toHaveBeenCalled();
  });

  it('falls back to a path dialog in the browser build', async () => {
    const { onIndexFolder } = renderSidebar();

    await userEvent.click(screen.getByTestId('add-folder'));
    const input = await screen.findByTestId('manual-path');
    await userEvent.type(input, '  /home/dev/projects/web  ');
    await userEvent.click(screen.getByTestId('manual-path-submit'));

    await waitFor(() => {
      expect(onIndexFolder).toHaveBeenCalledWith('/home/dev/projects/web');
    });
  });

  it('submits the path dialog on Enter', async () => {
    const { onIndexFolder } = renderSidebar();

    await userEvent.click(screen.getByTestId('add-folder'));
    await userEvent.type(await screen.findByTestId('manual-path'), '/home/dev/web{Enter}');

    await waitFor(() => {
      expect(onIndexFolder).toHaveBeenCalledWith('/home/dev/web');
    });
  });

  it('discards the typed path when the dialog is cancelled', async () => {
    const { onIndexFolder } = renderSidebar();

    await userEvent.click(screen.getByTestId('add-folder'));
    await userEvent.type(await screen.findByTestId('manual-path'), '/home/dev/web');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onIndexFolder).not.toHaveBeenCalled();

    // Reopening must not resurrect the abandoned path.
    await userEvent.click(screen.getByTestId('add-folder'));
    expect(await screen.findByTestId('manual-path')).toHaveValue('');
  });

  it('highlights only the folder the search is scoped to', async () => {
    act(() => {
      useAppStore.setState({ roots: [root(), root({ path: '/home/dev/projects/web' })] });
    });
    renderSidebar();

    const [api, web] = screen.getAllByRole('button', { name: /api|web/ });
    await userEvent.click(screen.getByText('api'));

    expect(api).toHaveClass('Mui-selected');
    expect(web).not.toHaveClass('Mui-selected');
  });

  it('ignores an empty path from the dialog', async () => {
    const { onIndexFolder } = renderSidebar();

    await userEvent.click(screen.getByTestId('add-folder'));
    await userEvent.click(await screen.findByTestId('manual-path-submit'));

    expect(onIndexFolder).not.toHaveBeenCalled();
  });

  it('shows live progress and can cancel the job', async () => {
    act(() => {
      useAppStore.setState({ activeJob });
    });
    renderSidebar();

    const progress = screen.getByTestId('index-progress');
    expect(within(progress).getByText(/4\/10 files, 20 chunks/)).toBeInTheDocument();
    expect(within(progress).getByText('src/auth.ts')).toBeInTheDocument();
    expect(screen.getByTestId('add-folder')).toBeDisabled();

    await userEvent.click(screen.getByTestId('cancel-index'));

    await waitFor(() => {
      expect(cancelIndexing).toHaveBeenCalled();
    });
  });

  it('says how many files it reused rather than re-embedded', () => {
    act(() => {
      useAppStore.setState({ activeJob: { ...activeJob, filesSkipped: 6 } });
    });
    renderSidebar();

    expect(
      within(screen.getByTestId('index-progress')).getByText(/20 chunks, 6 unchanged/),
    ).toBeInTheDocument();
  });

  it('stays quiet about reuse on a first index, which reuses nothing', () => {
    // ", 0 unchanged" would be noise on the one line the user actually watches.
    act(() => {
      useAppStore.setState({ activeJob });
    });
    renderSidebar();

    expect(within(screen.getByTestId('index-progress')).queryByText(/unchanged/)).toBeNull();
  });

  it('reports a failed cancel rather than swallowing it', async () => {
    cancelIndexing.mockRejectedValue(new Error('backend gone'));
    act(() => {
      useAppStore.setState({ activeJob });
    });
    renderSidebar();

    await userEvent.click(screen.getByTestId('cancel-index'));

    await waitFor(() => {
      expect(useAppStore.getState().error).toBe('backend gone');
    });
  });

  it('scopes search to a folder and clears the scope on a second click', async () => {
    act(() => {
      useAppStore.setState({ roots: [root()] });
    });
    renderSidebar();

    const item = screen.getByText('api');
    await userEvent.click(item);
    expect(useAppStore.getState().selectedRoot).toBe('/home/dev/projects/api');

    await userEvent.click(item);
    expect(useAppStore.getState().selectedRoot).toBeUndefined();
  });

  it('removes a folder and refreshes', async () => {
    act(() => {
      useAppStore.setState({ roots: [root()] });
    });
    const { onRefresh } = renderSidebar();

    await userEvent.click(screen.getByLabelText('Remove /home/dev/projects/api'));

    await waitFor(() => {
      expect(removeRoot).toHaveBeenCalledWith('/home/dev/projects/api');
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it('reports a failed removal', async () => {
    removeRoot.mockRejectedValue(new Error('still indexing'));
    act(() => {
      useAppStore.setState({ roots: [root()] });
    });
    renderSidebar();

    await userEvent.click(screen.getByLabelText('Remove /home/dev/projects/api'));

    await waitFor(() => {
      expect(useAppStore.getState().error).toBe('still indexing');
    });
  });

  it('shows the build footer only inside the desktop app', async () => {
    getAppInfo.mockResolvedValue({
      version: '0.1.0',
      platform: 'macos',
      backendUrl: 'http://127.0.0.1:3001',
    });
    renderSidebar();

    expect(await screen.findByText(/v0\.1\.0 · macos/)).toBeInTheDocument();
  });
});
