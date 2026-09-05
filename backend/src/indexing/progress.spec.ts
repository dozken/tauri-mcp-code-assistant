import { describe, expect, it } from 'vitest';
import type { IndexJob } from '@ai-code-companion/contracts';
import { toProgressEvent } from './progress.js';

const job = (overrides: Partial<IndexJob> = {}): IndexJob => ({
  id: 'job-1',
  root: '/repo',
  state: 'running',
  filesDiscovered: 0,
  filesIndexed: 0,
  chunksIndexed: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('toProgressEvent', () => {
  it('carries every field the UI renders', () => {
    expect(
      toProgressEvent(
        job({
          state: 'failed',
          filesDiscovered: 4,
          filesIndexed: 2,
          chunksIndexed: 9,
          currentFile: 'src/a.ts',
          error: 'nope',
        }),
      ),
    ).toEqual({
      jobId: 'job-1',
      root: '/repo',
      state: 'failed',
      filesDiscovered: 4,
      filesIndexed: 2,
      chunksIndexed: 9,
      currentFile: 'src/a.ts',
      error: 'nope',
      percent: 50,
    });
  });

  it.each([
    ['nothing discovered yet', 0, 0, 0],
    ['a quarter done', 4, 1, 25],
    ['two thirds, rounded', 3, 2, 67],
    ['all done', 7, 7, 100],
  ])('reports %s as %i%%', (_label, filesDiscovered, filesIndexed, percent) => {
    expect(toProgressEvent(job({ filesDiscovered, filesIndexed })).percent).toBe(percent);
  });

  it('never exceeds 100, even when more files are indexed than were discovered', () => {
    // The walker keeps discovering while workers index, so the two counters can
    // cross briefly; a progress bar must not render 240%.
    expect(toProgressEvent(job({ filesDiscovered: 5, filesIndexed: 12 })).percent).toBe(100);
  });

  it('reports 0 rather than dividing by zero before discovery starts', () => {
    expect(toProgressEvent(job({ filesDiscovered: 0, filesIndexed: 3 })).percent).toBe(0);
  });
});
