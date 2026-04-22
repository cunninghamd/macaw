import { Controller, Post, HttpException, HttpStatus } from '@nestjs/common';
import { IngestService } from './ingest.service';

@Controller('ingest')
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Post()
  async triggerIngest() {
    try {
      await this.ingestService.ingest();
      return { success: true };
    } catch (err: any) {
      throw new HttpException(
        { success: false, error: err.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
