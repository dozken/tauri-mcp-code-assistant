import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { IndexingService } from './indexing.service.js';
import { IndexRequestDto } from './dto.js';
import type { IndexJob, IndexStatus } from './indexing.types.js';

@Controller()
export class IndexingController {
  constructor(private readonly indexing: IndexingService) {}

  /** Accepts the job and returns immediately; progress arrives over Socket.IO. */
  @Post('index')
  @HttpCode(HttpStatus.ACCEPTED)
  start(@Body() body: IndexRequestDto): Promise<IndexJob> {
    return this.indexing.startIndexing(body.path);
  }

  @Post('index/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(): { cancelled: boolean } {
    return { cancelled: this.indexing.cancel() };
  }

  @Delete('index')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Query('path') path: string): Promise<void> {
    return this.indexing.removeRoot(path);
  }

  @Get('status')
  status(): Promise<IndexStatus> {
    return this.indexing.getStatus();
  }

  @Get('health')
  health(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }
}
