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
import { CreateTripDto } from './dto/create-trip.dto';
import { UpdateTripDto } from './dto/update-trip.dto';
import { ListTripsDto } from './dto/list-trips.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@Controller('trips')
@UseGuards(JwtAuthGuard)
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

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
}
