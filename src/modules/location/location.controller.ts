import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseGuards,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LocationService } from './location.service';
import { UpdateLocationDto } from './dto/update-location.dto';

@UseGuards(JwtAuthGuard)
@Controller('trips/:id')
export class LocationController {
  constructor(private readonly locationService: LocationService) {}

  /**
   * POST /api/v1/trips/:id/location
   * REST fallback for clients that cannot use WebSockets.
   * Same membership + rate-limit checks as the WS gateway.
   */
  @Post('location')
  async postLocation(
    @Param('id', ParseUUIDPipe) tripId: string,
    @Body() dto: UpdateLocationDto,
    @Req() req: any,
  ) {
    const userId: string = req.user.sub;
    const name: string | null = req.user.name ?? null;

    await this.locationService.assertMembership(userId, tripId);

    const withinLimit = await this.locationService.checkRateLimit(userId);
    if (!withinLimit) {
      return { skipped: true, reason: 'rate_limited' };
    }

    const position = await this.locationService.updatePosition(userId, name, tripId, {
      lat: dto.lat,
      lng: dto.lng,
      heading: dto.heading,
      speed: dto.speed,
      ts: dto.ts,
    });

    if (!position) {
      return { skipped: true, reason: 'no_significant_movement' };
    }

    return position;
  }

  /**
   * GET /api/v1/trips/:id/locations
   * Returns all live participant positions for the trip (from Redis).
   */
  @Get('locations')
  async getLocations(
    @Param('id', ParseUUIDPipe) tripId: string,
    @Req() req: any,
  ) {
    await this.locationService.assertMembership(req.user.sub, tripId);
    const positions = await this.locationService.getSnapshot(tripId);
    return { positions };
  }
}
