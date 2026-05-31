import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ChatService } from './chat.service';
import { GetHistoryDto } from './dto/get-history.dto';
import { User } from '../users/entities/user.entity';

/**
 * ChatController — REST endpoints for chat history.
 * WebSocket (real-time) is handled by ChatGateway.
 * HTTP is used for initial history load and load-more (cursor pagination).
 * Both REST and WS share the same checkRoomAccess logic in ChatService.
 */
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  /**
   * GET /api/v1/chat/:room_type/:room_id/messages
   * Load message history with cursor-based pagination.
   * ?before=<message_uuid>&limit=50
   *
   * SECURITY: JwtAuthGuard + checkRoomAccess inside ChatService.getHistory()
   */
  @Get(':room_type/:room_id/messages')
  async getHistory(
    @Param('room_type') roomType: string,
    @Param('room_id') roomId: string,
    @Query() query: GetHistoryDto,
    @CurrentUser() user: User,
  ) {
    if (!['trip', 'community'].includes(roomType)) {
      throw new BadRequestException('room_type must be "trip" or "community"');
    }

    const messages = await this.chatService.getHistory(
      user.id,
      roomType,
      roomId,
      query.before,
      query.limit,
    );

    return { success: true, data: messages };
  }

  /**
   * GET /api/v1/chat/:room_type/:room_id/messages/:message_id/reactions
   * Get all reactions for a specific message.
   *
   * SECURITY: JwtAuthGuard + room membership check
   */
  @Get(':room_type/:room_id/messages/:message_id/reactions')
  async getReactions(
    @Param('room_type') roomType: string,
    @Param('room_id') roomId: string,
    @Param('message_id') messageId: string,
    @CurrentUser() user: User,
  ) {
    if (!['trip', 'community'].includes(roomType)) {
      throw new BadRequestException('room_type must be "trip" or "community"');
    }

    const hasAccess = await this.chatService.checkRoomAccess(user.id, roomType, roomId);
    if (!hasAccess) {
      throw new BadRequestException('Not a member of this room');
    }

    const reactions = await this.chatService.getReactionsForMessage(messageId);
    return { success: true, data: reactions };
  }
}
