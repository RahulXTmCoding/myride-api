import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';

import { TripsService } from './trips.service';
import { StopProgressService } from './stop-progress.service';
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { ListTripsDto } from './dto/list-trips.dto';
import { DiscoverTripsDto } from './dto/discover-trips.dto';
import { JoinRequestDto } from './dto/join-request.dto';
import { CompleteStopDto } from './dto/complete-stop.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@Controller('trips')
@UseGuards(JwtAuthGuard)
export class TripsController {
  constructor(
    private readonly tripsService: TripsService,
    private readonly stopProgressService: StopProgressService,
  ) {}

  /** Create a new trip. Creator becomes admin participant. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() user: User, @Body() dto: CreateTripDto) {
    const trip = await this.tripsService.create(user.id, dto);
    return { success: true, data: trip };
  }

  /** List trips (scope=mine|joined|all). */
  @Get()
  async list(@CurrentUser() user: User, @Query() dto: ListTripsDto) {
    const { items, total } = await this.tripsService.list(user.id, dto);
    return {
      success: true,
      data: items,
      pagination: {
        total,
        limit: dto.limit ?? 20,
        offset: dto.offset ?? 0,
        hasMore: (dto.offset ?? 0) + items.length < total,
      },
    };
  }

  /**
   * Public discovery feed (FR-011..FR-013). Must be declared BEFORE the
   * `:id` route — otherwise Nest's path matcher treats "discover" as a UUID
   * candidate and ParseUUIDPipe 400s the request.
   */
  @Get('discover')
  async discover(@CurrentUser() user: User, @Query() dto: DiscoverTripsDto) {
    const { items, total } = await this.tripsService.discover(user.id, dto);
    return {
      success: true,
      data: items,
      pagination: {
        total,
        limit: dto.limit ?? 20,
        offset: dto.offset ?? 0,
        hasMore: (dto.offset ?? 0) + items.length < total,
      },
    };
  }

  /** Get a single trip (with stops + participants). */
  @Get(':id')
  async get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    const trip = await this.tripsService.findOne(id, user.id);
    return { success: true, data: trip };
  }

  /** Update trip (admin only, ≥6h before departure). */
  @Patch(':id')
  async update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTripDto,
  ) {
    const trip = await this.tripsService.update(id, user.id, dto);
    return { success: true, data: trip };
  }

  /** Cancel trip (admin only). */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async cancel(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.tripsService.cancel(id, user.id);
  }

  // ── Join requests / membership ───────────────────────────────────────────

  /** Submit a join request. */
  @Post(':id/join')
  @HttpCode(HttpStatus.CREATED)
  async requestJoin(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: JoinRequestDto,
  ) {
    const participant = await this.tripsService.requestJoin(id, user.id, dto.message);
    return { success: true, data: participant };
  }

  /** Admin: list pending join requests for a trip. */
  @Get(':id/join-requests')
  async listJoinRequests(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const items = await this.tripsService.listJoinRequests(id, user.id);
    return { success: true, data: items };
  }

  /** Admin: approve a pending request. */
  @Post(':id/join-requests/:userId/approve')
  @HttpCode(HttpStatus.OK)
  async approveJoin(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    const participant = await this.tripsService.approveJoin(id, user.id, userId);
    return { success: true, data: participant };
  }

  /** Admin: reject a pending request. */
  @Post(':id/join-requests/:userId/reject')
  @HttpCode(HttpStatus.OK)
  async rejectJoin(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    const participant = await this.tripsService.rejectJoin(id, user.id, userId);
    return { success: true, data: participant };
  }

  /** Member: leave a trip (cannot be the creator). */
  @Post(':id/leave')
  @HttpCode(HttpStatus.OK)
  async leaveTrip(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.tripsService.leaveTrip(id, user.id);
  }

  // ── Stop progress (FR-047–052) ───────────────────────────────────────────

  /** My progress for every stop in the trip. */
  @Get(':id/progress')
  async myProgress(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const items = await this.stopProgressService.getMyProgress(id, user.id);
    return { success: true, data: items };
  }

  /** Admin-only aggregate of every member's progress per stop. */
  @Get(':id/progress/all')
  async allProgress(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const items = await this.stopProgressService.getAllProgress(id, user.id);
    return { success: true, data: items };
  }

  /** Mark a specific stop completed for me. Auto-advances next pending stop. */
  @Post(':id/stops/:stopId/complete')
  @HttpCode(HttpStatus.OK)
  async completeStop(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stopId', ParseUUIDPipe) stopId: string,
    @Body() dto: CompleteStopDto,
  ) {
    const progress = await this.stopProgressService.markComplete(id, user.id, stopId, dto);
    return { success: true, data: progress };
  }
}
