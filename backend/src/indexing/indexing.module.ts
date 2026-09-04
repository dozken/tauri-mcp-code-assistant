import { Module } from '@nestjs/common';
import { VectorModule } from '../vector/vector.module.js';
import { IndexingController } from './indexing.controller.js';
import { IndexingService } from './indexing.service.js';

@Module({
  imports: [VectorModule],
  controllers: [IndexingController],
  providers: [IndexingService],
  exports: [IndexingService],
})
export class IndexingModule {}
