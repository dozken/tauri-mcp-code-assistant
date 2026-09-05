import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  API_ROUTES,
  indexRequestSchema,
  removeRootQuerySchema,
  type CancelIndexingResponse,
  type HealthResponse,
  type IndexJob,
  type IndexRequest,
  type IndexStatus,
  type RemoveRootQuery,
} from '@ai-code-companion/contracts';
import { Public } from '../security/local-access.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { IndexWatcherService } from './index-watcher.service.js';
import { IndexingService } from './indexing.service.js';

/**
 * Also where watching is wired to the index's lifecycle. The watcher depends on
 * `IndexingService` to do the re-indexing, so the service cannot depend back on
 * it; the controller already knows about both and is the one place a root is
 * added or removed by a user.
 */
@Controller()
export class IndexingController {
  constructor(
    private readonly indexing: IndexingService,
    private readonly watcher: IndexWatcherService,
  ) {}

  /** Accepts the job and returns immediately; progress arrives over Socket.IO. */
  @Post(API_ROUTES.index)
  @HttpCode(HttpStatus.ACCEPTED)
  async start(
    @Body(new ZodValidationPipe(indexRequestSchema)) body: IndexRequest,
  ): Promise<IndexJob> {
    const job = await this.indexing.startIndexing(body.path);
    // From the start of the job, not its end: an edit made while the first index
    // is running is exactly the one worth catching.
    this.watcher.watchRoot(job.root);
    return job;
  }

  @Post(API_ROUTES.cancelIndex)
  @HttpCode(HttpStatus.OK)
  cancel(): CancelIndexingResponse {
    return { cancelled: this.indexing.cancel() };
  }

  @Delete(API_ROUTES.index)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Query(new ZodValidationPipe(removeRootQuerySchema)) query: RemoveRootQuery,
  ): Promise<void> {
    this.watcher.unwatchRoot(await this.indexing.removeRoot(query.path));
  }

  @Get(API_ROUTES.status)
  async status(): Promise<IndexStatus> {
    const status = await this.indexing.getStatus();

    return {
      ...status,
      roots: status.roots.map((root) => ({
        ...root,
        watching: this.watcher.isWatching(root.path),
      })),
    };
  }

  /** Liveness only, and deliberately unauthenticated: nothing here is sensitive. */
  @Public()
  @Get(API_ROUTES.health)
  health(): HealthResponse {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }
}
