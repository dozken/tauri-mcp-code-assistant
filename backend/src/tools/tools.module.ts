import { Module } from '@nestjs/common';
import { VectorModule } from '../vector/vector.module.js';
import { CodeToolsService } from './code-tools.service.js';

@Module({
  imports: [VectorModule],
  providers: [CodeToolsService],
  exports: [CodeToolsService],
})
export class ToolsModule {}
