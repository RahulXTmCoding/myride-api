import { Controller, Get, Query } from '@nestjs/common';
import { VersionService, VersionCheckResponse } from './version.service';

/**
 * Public (no-auth) version-check endpoint.
 * The app calls this on every cold launch to determine whether a force
 * update is required before the user is allowed to continue.
 */
@Controller('version')
export class VersionController {
  constructor(private readonly versionService: VersionService) {}

  @Get('check')
  check(
    @Query('platform') platform: string,
    @Query('version') currentVersion: string,
  ): VersionCheckResponse {
    return this.versionService.check(platform, currentVersion);
  }
}
