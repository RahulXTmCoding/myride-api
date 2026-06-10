import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';

import { SosService } from './sos.service';
import { CreateSosDto } from './dto/create-sos.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

/**
 * SOS endpoints (FR-063..FR-075).
 *
 * Trip-scoped routes live under /trips/:tripId/sos. The cancel and
 * acknowledge actions take the SOS id directly since they're not
 * trip-disambiguated for the caller.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class SosController {
  constructor(private readonly sosService: SosService) {}

  @Post('trips/:tripId/sos')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: User,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: CreateSosDto,
  ) {
    const alert = await this.sosService.create(tripId, user.id, dto);
    return { success: true, data: alert };
  }

  @Get('trips/:tripId/sos')
  async listActive(
    @CurrentUser() user: User,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ) {
    const alerts = await this.sosService.listActive(tripId, user.id);
    return { success: true, data: alerts };
  }

  @Get('trips/:tripId/sos/all')
  async listAll(
    @CurrentUser() user: User,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ) {
    const alerts = await this.sosService.listAll(tripId, user.id);
    return { success: true, data: alerts };
  }

  @Post('sos/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const alert = await this.sosService.cancel(id, user.id);
    return { success: true, data: alert };
  }

  @Post('sos/:id/acknowledge')
  @HttpCode(HttpStatus.OK)
  async acknowledge(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const alert = await this.sosService.acknowledge(id, user.id);
    return { success: true, data: alert };
  }
}
