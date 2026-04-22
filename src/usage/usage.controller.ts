import { Controller, Get, Query } from '@nestjs/common';
import { UsageService } from './usage.service';

@Controller('usage')
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  @Get('summary')
  getSummary() {
    return this.usageService.getSummary();
  }

  @Get('daily')
  getDaily(@Query('days') days?: string) {
    const n = days !== undefined ? parseInt(days, 10) : 30;
    return this.usageService.getDaily(n === 0 ? null : n);
  }

  @Get('sessions')
  getSessions(@Query('limit') limit?: string, @Query('offset') offset?: string) {
    return this.usageService.getSessions(
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @Get('projects')
  getProjects() {
    return this.usageService.getProjects();
  }
}
