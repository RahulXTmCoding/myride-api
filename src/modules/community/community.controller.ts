import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CommunityService } from './community.service';
import { CreateCommunityDto, UpdateCommunityDto, InviteMembersDto } from './dto/community.dto';

@UseGuards(JwtAuthGuard)
@Controller('communities')
export class CommunityController {
  constructor(private readonly svc: CommunityService) {}

  // ── CRUD ──────────────────────────────────────────────────────────────

  /**
   * POST /communities — create a new community
   */
  @Post()
  create(@Body() dto: CreateCommunityDto, @CurrentUser() user: any) {
    return this.svc.create(dto, user.id);
  }

  /**
   * GET /communities/mine — communities I'm a member of
   */
  @Get('mine')
  findMine(@CurrentUser() user: any) {
    return this.svc.findMine(user.id);
  }

  /**
   * GET /communities/discover?search=&limit=&offset= — open communities
   */
  @Get('discover')
  discover(
    @Query('search') search?: string,
    @Query('limit') limit = '20',
    @Query('offset') offset = '0',
  ) {
    return this.svc.discover(search, +limit, +offset);
  }

  /**
   * GET /communities/:id
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findOne(id);
  }

  /**
   * PATCH /communities/:id — update community (admin only)
   */
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCommunityDto,
    @CurrentUser() user: any,
  ) {
    return this.svc.update(id, dto, user.id);
  }

  /**
   * DELETE /communities/:id — soft-delete (admin only)
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.svc.remove(id, user.id);
  }

  // ── Membership ────────────────────────────────────────────────────────

  /**
   * POST /communities/:id/join — join open community
   */
  @Post(':id/join')
  join(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.svc.join(id, user.id);
  }

  /**
   * POST /communities/:id/leave — leave community
   */
  @Post(':id/leave')
  @HttpCode(HttpStatus.NO_CONTENT)
  leave(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.svc.leave(id, user.id);
  }

  /**
   * GET /communities/:id/members — list members (members only)
   */
  @Get(':id/members')
  listMembers(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.svc.listMembers(id, user.id);
  }

  /**
   * DELETE /communities/:id/members/:userId — kick member (admin only)
   */
  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  kickMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @CurrentUser() user: any,
  ) {
    return this.svc.kickMember(id, targetUserId, user.id);
  }

  // ── Invites ───────────────────────────────────────────────────────────

  /**
   * POST /communities/:id/invites — invite members by phone number(s)
   */
  @Post(':id/invites')
  invite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InviteMembersDto,
    @CurrentUser() user: any,
  ) {
    return this.svc.invite(id, dto, user.id);
  }

  /**
   * POST /communities/invites/:inviteId/accept — accept invite
   */
  @Post('invites/:inviteId/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  acceptInvite(
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @CurrentUser() user: any,
  ) {
    return this.svc.respondToInvite(inviteId, user.id, 'accept');
  }

  /**
   * POST /communities/invites/:inviteId/reject — reject invite
   */
  @Post('invites/:inviteId/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  rejectInvite(
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @CurrentUser() user: any,
  ) {
    return this.svc.respondToInvite(inviteId, user.id, 'reject');
  }
}
