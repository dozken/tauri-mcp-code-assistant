import type { IndexJob, IndexProgressEvent } from '@ai-code-companion/contracts';

/**
 * Projects a job onto the progress event the UI renders.
 *
 * `GET /status` and the `index:progress` socket event MUST return the same shape:
 * the sidebar renders both with one component, and a client that reloads mid-index
 * gets its first frame from `/status`.
 */
export const toProgressEvent = (job: IndexJob): IndexProgressEvent => ({
  jobId: job.id,
  root: job.root,
  state: job.state,
  filesDiscovered: job.filesDiscovered,
  filesIndexed: job.filesIndexed,
  filesSkipped: job.filesSkipped,
  chunksIndexed: job.chunksIndexed,
  currentFile: job.currentFile,
  error: job.error,
  percent:
    job.filesDiscovered === 0
      ? 0
      : Math.min(100, Math.round((job.filesIndexed / job.filesDiscovered) * 100)),
});
