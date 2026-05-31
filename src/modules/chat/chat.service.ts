import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import Redis from 'ioredis';
import { encode as escapeHtml } from 'html-entities';

import { ChatMessage, RoomType, ReplyToSnapshot } from './entities/chat-message.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';
import { User } from '../users/entities/user.entity';
import { SendMessageDto } from './dto/send-message.dto';

export type ReactionsMap = Record<string, string[]>; // emoji → [userId, ...]

export interface FormattedMessage {
  id: string;
  room_type: RoomType;
  room_id: string;
  sender: { id: string; name: string; avatar_url: string | null } | null;
  content: string;
  message_type: 'text' | 'system';
  reply_to: ReplyToSnapshot | null;
  reactions: ReactionsMap;
  created_at: string;
  is_deleted: boolean;
}

export const CHAT_REDIS = 'CHAT_REDIS_CLIENT';

/** Rate-limit: max messages per window */
const RL_SEND_MAX = 30;
const RL_REACT_MAX = 60;
const RL_WINDOW_MS = 60_000;

@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(ChatMessage)
    private readonly messagesRepo: Repository<ChatMessage>,

    @InjectRepository(MessageReaction)
    private readonly reactionsRepo: Repository<MessageReaction>,

    @InjectRepository(TripParticipant)
    private readonly tripParticipantsRepo: Repository<TripParticipant>,

    @Inject(CHAT_REDIS)
    private readonly redis: Redis,
  ) {}

  // ── Access Control ────────────────────────────────────────────────────────

  /**
   * Check if a user is a member of the given room.
   * Results are cached in Redis for 5 minutes.
   * MUST invalidate cache when membership changes via invalidateRoomAccessCache().
   */
  async checkRoomAccess(
    userId: string,
    roomType: string,
    roomId: string,
  ): Promise<boolean> {
    if (!['trip', 'community'].includes(roomType)) return false;

    const cacheKey = `chat:access:${roomType}:${roomId}:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached !== null) return cached === '1';

    let hasAccess = false;

    if (roomType === 'trip') {
      const participant = await this.tripParticipantsRepo.findOne({
        where: { trip_id: roomId, user_id: userId, status: 'approved' },
      });
      hasAccess = !!participant;
    } else if (roomType === 'community') {
      // Community members table will be added when CommunityModule is built.
      // For now, access is always granted to community rooms to avoid blocking
      // development — replace this with real membership check once that module exists.
      // TODO: replace with community_members check
      hasAccess = true;
    }

    await this.redis.set(cacheKey, hasAccess ? '1' : '0', 'EX', 300);
    return hasAccess;
  }

  /**
   * Invalidate the access cache for a user+room combination.
   * Call this whenever membership changes (kick, leave, join).
   */
  async invalidateRoomAccessCache(
    userId: string,
    roomType: string,
    roomId: string,
  ): Promise<void> {
    await this.redis.del(`chat:access:${roomType}:${roomId}:${userId}`);
  }

  // ── Rate Limiting ──────────────────────────────────────────────────────────

  /** Returns true if the action is allowed under the rate limit */
  async checkRateLimit(
    userId: string,
    action: 'send' | 'react',
    roomId?: string,
  ): Promise<boolean> {
    const max = action === 'send' ? RL_SEND_MAX : RL_REACT_MAX;
    const scope = action === 'send' ? `${userId}:${roomId}` : userId;
    const key = `chat:rl:${action}:${scope}`;
    const now = Date.now();
    const windowStart = now - RL_WINDOW_MS;

    const pipe = this.redis.pipeline();
    pipe.zremrangebyscore(key, 0, windowStart);
    pipe.zcard(key);
    const results = await pipe.exec();

    const count = (results?.[1]?.[1] as number) ?? 0;
    if (count >= max) return false;

    await this.redis
      .pipeline()
      .zadd(key, now, `${now}-${Math.random()}`)
      .expire(key, 70)
      .exec();

    return true;
  }

  // ── Message Persistence ───────────────────────────────────────────────────

  async saveMessage(
    user: User,
    dto: SendMessageDto,
  ): Promise<FormattedMessage> {
    let replyToSnapshot: ReplyToSnapshot | null = null;

    if (dto.reply_to_id) {
      const parent = await this.messagesRepo.findOne({
        where: { id: dto.reply_to_id },
        relations: ['sender'],
      });
      if (parent && !parent.isDeleted) {
        replyToSnapshot = {
          id: parent.id,
          content: parent.content.slice(0, 200),
          sender_name: parent.sender?.name ?? 'Unknown',
        };
      }
    }

    // Sanitize content — escape HTML entities for defense-in-depth
    const sanitizedContent = escapeHtml(dto.content.trim());

    const message = this.messagesRepo.create({
      roomType: dto.room_type as RoomType,
      roomId: dto.room_id,
      senderId: user.id,
      content: sanitizedContent,
      messageType: 'text',
      replyTo: replyToSnapshot,
      metadata: {},
    });

    const saved = await this.messagesRepo.save(message);
    return this.formatMessage(saved, user, []);
  }

  // ── Message Lookup ────────────────────────────────────────────────────────

  async findMessageById(messageId: string): Promise<ChatMessage | null> {
    return this.messagesRepo.findOne({ where: { id: messageId } });
  }

  // ── History (cursor pagination) ───────────────────────────────────────────

  async getHistory(
    userId: string,
    roomType: string,
    roomId: string,
    before?: string,
    limit = 50,
  ): Promise<FormattedMessage[]> {
    const hasAccess = await this.checkRoomAccess(userId, roomType, roomId);
    if (!hasAccess) throw new ForbiddenException('Not a member of this room');

    const qb = this.messagesRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.sender', 'sender')
      .where('m.roomType = :roomType AND m.roomId = :roomId', { roomType, roomId })
      .andWhere('m.isDeleted = false')
      .orderBy('m.createdAt', 'DESC')
      .limit(Math.min(limit, 100));

    if (before) {
      const cursor = await this.messagesRepo.findOne({ where: { id: before } });
      if (cursor) {
        qb.andWhere('m.createdAt < :cursorTime', { cursorTime: cursor.createdAt });
      }
    }

    const messages = await qb.getMany();

    // Batch-load reactions for all fetched messages (single query)
    const messageIds = messages.map((m) => m.id);
    const reactions =
      messageIds.length > 0
        ? await this.reactionsRepo.find({ where: { messageId: In(messageIds) } })
        : [];

    return messages
      .reverse() // Return oldest-first for the client to render top-to-bottom
      .map((msg) =>
        this.formatMessage(
          msg,
          msg.sender,
          reactions.filter((r) => r.messageId === msg.id),
        ),
      );
  }

  // ── Reactions ─────────────────────────────────────────────────────────────

  async toggleReaction(
    userId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ roomType: string; roomId: string; reactions: ReactionsMap }> {
    const message = await this.messagesRepo.findOne({ where: { id: messageId } });
    if (!message) throw new NotFoundException('Message not found');

    const existing = await this.reactionsRepo.findOne({
      where: { messageId, userId, emoji },
    });

    if (existing) {
      await this.reactionsRepo.delete(existing.id);
    } else {
      await this.reactionsRepo.save(
        this.reactionsRepo.create({ messageId, userId, emoji }),
      );
    }

    const allReactions = await this.reactionsRepo.find({ where: { messageId } });
    return {
      roomType: message.roomType,
      roomId: message.roomId,
      reactions: this.groupReactions(allReactions),
    };
  }

  async getReactionsForMessage(messageId: string): Promise<ReactionsMap> {
    const reactions = await this.reactionsRepo.find({ where: { messageId } });
    return this.groupReactions(reactions);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private groupReactions(reactions: MessageReaction[]): ReactionsMap {
    return reactions.reduce(
      (acc, r) => {
        if (!acc[r.emoji]) acc[r.emoji] = [];
        acc[r.emoji].push(r.userId);
        return acc;
      },
      {} as ReactionsMap,
    );
  }

  private formatMessage(
    msg: ChatMessage,
    sender: User | null,
    reactions: MessageReaction[],
  ): FormattedMessage {
    return {
      id: msg.id,
      room_type: msg.roomType,
      room_id: msg.roomId,
      sender: sender
        ? {
            id: sender.id,
            name: sender.name ?? 'Unknown',
            avatar_url: sender.profile_photo_url ?? null,
          }
        : null,
      content: msg.isDeleted ? 'This message was deleted.' : msg.content,
      message_type: msg.messageType,
      reply_to: msg.replyTo ?? null,
      reactions: this.groupReactions(reactions),
      created_at: msg.createdAt.toISOString(),
      is_deleted: msg.isDeleted,
    };
  }
}
