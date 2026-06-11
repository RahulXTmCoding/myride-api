import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/user.dto';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly svc: UsersService) {}

  /**
   * GET /users/me — own full profile (same as /auth/me but richer)
   */
  @Get('me')
  getMe(@CurrentUser() user: any) {
    return this.svc.findById(user.id);
  }

  /**
   * PATCH /users/me — update own profile
   * Fields: name, bio, avatar_url, emergency_contacts, push_token
   */
  @Patch('me')
  updateMe(@CurrentUser() user: any, @Body() dto: UpdateProfileDto) {
    return this.svc.updateMe(user.id, dto);
  }

  /**
   * GET /users/:id — public profile of any user
   */
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.findById(id);
  }
}
