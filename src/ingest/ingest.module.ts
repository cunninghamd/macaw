import { Module } from '@nestjs/common';
import { IngestService } from './ingest.service';
import { IngestController } from './ingest.controller';

@Module({
  providers: [IngestService],
  controllers: [IngestController],
  exports: [IngestService],
})
export class IngestModule {}
