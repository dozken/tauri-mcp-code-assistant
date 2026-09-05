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
import { IndexingService } from './indexing.service.js';

@Controller()
export class IndexingController {
  constructor(private readonly indexing: IndexingService) {}

  /** Accepts the job and returns immediately; progress arrives over Socket.IO. */
  @Post(API_ROUTES.index)
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Body(new ZodValidationPipe(indexRequestSchema)) body: IndexRequest): Promise<IndexJob> {
    return this.indexing.startIndexing(body.path);
  }

  @Post(API_ROUTES.cancelIndex)
  @HttpCode(HttpStatus.OK)
  cancel(): CancelIndexingResponse {
    return { cancelled: this.indexing.cancel() };
  }

  @Delete(API_ROUTES.index)
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Query(new ZodValidationPipe(removeRootQuerySchema)) query: RemoveRootQuery,
  ): Promise<void> {
    return this.indexing.removeRoot(query.path);
  }

  @Get(API_ROUTES.status)
  status(): Promise<IndexStatus> {
    return this.indexing.getStatus();
  }

  /** Liveness only, and deliberately unauthenticated: nothing here is sensitive. */
  @Public()
  @Get(API_ROUTES.health)
  health(): HealthResponse {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }
}
