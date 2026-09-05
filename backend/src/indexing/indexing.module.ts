import { Module } from '@nestjs/common';
import { VectorModule } from '../vector/vector.module.js';
import { IndexWatcherService } from './index-watcher.service.js';
import { IndexingController } from './indexing.controller.js';
import { IndexingService } from './indexing.service.js';

@Module({
  imports: [VectorModule],
  controllers: [IndexingController],
  providers: [IndexingService, IndexWatcherService],
  exports: [IndexingService],
})
export class IndexingModule {}
