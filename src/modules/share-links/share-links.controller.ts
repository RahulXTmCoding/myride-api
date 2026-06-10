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
  BadRequestException,
} from '@nestjs/common';

import { ShareLinksService } from './share-links.service';
import {
  CreateShareLinkDto,
  UpdateShareLinkDto,
  VerifyPasswordDto,
  JoinViaLinkDto,
} from './dto/share-link.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@Controller()
export class ShareLinksController {
  constructor(private readonly svc: ShareLinksService) {}

  // ── Admin-only management endpoints ────────────────────────────────

  @Post('trips/:tripId/share-link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async upsert(
    @CurrentUser() user: User,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: CreateShareLinkDto,
  ) {
    const link = await this.svc.upsert(tripId, user.id, dto);
    return {
      success: true,
      data: {
        link_id: link.id,
        link_token: link.link_token,
        access_mode: link.access_mode,
        expires_at: link.expires_at,
        is_active: link.is_active,
      },
    };
  }

  @Get('trips/:tripId/share-link')
  @UseGuards(JwtAuthGuard)
  async getAdminView(
    @CurrentUser() user: User,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ) {
    const link = await this.svc.getForAdmin(tripId, user.id);
    return { success: true, data: link };
  }

  @Patch('trips/:tripId/share-link')
  @UseGuards(JwtAuthGuard)
  async update(
    @CurrentUser() user: User,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Body() dto: UpdateShareLinkDto,
  ) {
    const link = await this.svc.update(tripId, user.id, dto);
    return { success: true, data: link };
  }

  @Delete('trips/:tripId/share-link')
  @UseGuards(JwtAuthGuard)
  async deleteOrRegen(
    @CurrentUser() user: User,
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Query('action') action?: 'disable' | 'regenerate',
  ) {
    if (action === 'regenerate') {
      const link = await this.svc.regenerate(tripId, user.id);
      return { success: true, data: link };
    }
    if (action === 'disable' || action === undefined) {
      return this.svc.disable(tripId, user.id);
    }
    throw new BadRequestException({ error: 'INVALID_ACTION' });
  }

  // ── Public link-token endpoints ─────────────────────────────────────

  /**
   * Public: anyone with the token reads the trip summary. No auth required —
   * the JWT guard is intentionally omitted to allow web-preview unfurls.
   */
  @Get('trips/link/:token')
  async resolve(@Param('token') token: string) {
    const data = await this.svc.resolveByToken(token);
    return { success: true, data };
  }

  @Post('trips/link/:token/verify-password')
  @HttpCode(HttpStatus.OK)
  async verifyPassword(
    @Param('token') token: string,
    @Body() dto: VerifyPasswordDto,
  ) {
    const data = await this.svc.verifyPassword(token, dto.password);
    return { success: true, data };
  }

  /**
   * Join via link. MUST be authenticated — the caller becomes a participant.
   */
  @Post('trips/link/:token/join')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  async join(
    @CurrentUser() user: User,
    @Param('token') token: string,
    @Body() dto: JoinViaLinkDto,
  ) {
    const participant = await this.svc.joinViaLink(token, user.id, dto);
    return { success: true, data: participant };
  }
}
