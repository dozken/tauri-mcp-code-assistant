import { Module } from '@nestjs/common';
import { IndexingModule } from '../indexing/indexing.module.js';
import { EventsGateway } from './events.gateway.js';

@Module({
  imports: [IndexingModule],
  providers: [EventsGateway],
})
export class EventsModule {}
