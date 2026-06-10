import {
  Controller,
  Post,
  Param,
  UseGuards,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';

import { VoiceCallService } from './voice-call.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';

@Controller()
@UseGuards(JwtAuthGuard)
export class VoiceCallController {
  constructor(private readonly svc: VoiceCallService) {}

  /**
   * Issue a short-lived LiveKit token for the trip room.
   * Caller MUST be an approved participant (or the trip creator).
   */
  @Post('trips/:tripId/voice-call/token')
  @HttpCode(HttpStatus.OK)
  async token(
    @CurrentUser() user: User,
    @Param('tripId', ParseUUIDPipe) tripId: string,
  ) {
    const data = await this.svc.issueToken(tripId, user.id, user.name);
    return { success: true, data };
  }
}
