import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import Redis from 'ioredis';
import { encode as escapeHtml } from 'html-entities';
import { v4 as uuidv4 } from 'uuid';

import {
  ChatMessage,
  RoomType,
  ReplyToSnapshot,
} from './entities/chat-message.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';
import { CommunityMember } from '../community/entities/community-member.entity';
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

/**
 * Wire format stored in the Redis Stream entries.
 * Flushed to Postgres by ChatFlushWorker every 100ms in batches.
 */
export interface QueuedMessage {
  id: string; // pre-generated UUID (stable for broadcast and reactions)
  room_type: RoomType;
  room_id: string;
  sender_id: string;
  sender_name: string;
  sender_avatar: string | null;
  content: string; // already sanitized
  reply_to: ReplyToSnapshot | null;
  created_at: string; // ISO string set at queue time (used as DB createdAt)
}

export const CHAT_REDIS = 'CHAT_REDIS_CLIENT';
export const CHAT_ADAPTER_REDIS = 'CHAT_ADAPTER_REDIS_CLIENT';

/**
 * Redis Stream key per room — avoids hot key on a single global list.
 * Pattern: chat:stream:trip:<tripId> | chat:stream:community:<communityId>
 */
export function chatStreamKey(roomType: string, roomId: string): string {
  return `chat:stream:${roomType}:${roomId}`;
}

/** Consumer group name used by ChatFlushWorker */
export const CHAT_STREAM_GROUP = 'flush-workers';

/** Rate-limit: reactions only (60/min per user) */
const RL_REACT_MAX = 60;
const RL_WINDOW_MS = 60_000;

/** Loose flood-control: max sends per user per second */
const FLOOD_MAX_PER_SEC = 10;

/** Alert threshold: warn when any room stream has this many unacked entries */
const QUEUE_DEPTH_WARN = 5_000;

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @InjectRepository(ChatMessage)
    private readonly messagesRepo: Repository<ChatMessage>,

    @InjectRepository(MessageReaction)
    private readonly reactionsRepo: Repository<MessageReaction>,

    @InjectRepository(TripParticipant)
    private readonly tripParticipantsRepo: Repository<TripParticipant>,

    @InjectRepository(CommunityMember)
    private readonly communityMemberRepo: Repository<CommunityMember>,

    @Inject(CHAT_REDIS)
    private readonly redis: Redis,
  ) {}

  // ── Access Control ────────────────────────────────────────────────────────

  /**
   * Check if a user is a member of the given room.
   * Results are cached in Redis:
   *   '1' (access granted) → 5 min TTL  (membership stable once granted)
   *   '0' (access denied)  → 30 sec TTL (fast recovery after being added to trip)
   * MUST invalidate cache on membership changes via invalidateRoomAccessCache().
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
      const member = await this.communityMemberRepo.findOne({
        where: { community_id: roomId, user_id: userId, is_active: true },
      });
      hasAccess = !!member;
    }

    // FIX #10: cache '1' for 5 min, '0' for only 30 sec so newly-added members
    // aren't stuck waiting 5 minutes to join chat after being approved.
    const ttl = hasAccess ? 300 : 30;
    await this.redis.set(cacheKey, hasAccess ? '1' : '0', 'EX', ttl);
    return hasAccess;
  }

  async invalidateRoomAccessCache(
    userId: string,
    roomType: string,
    roomId: string,
  ): Promise<void> {
    await this.redis.del(`chat:access:${roomType}:${roomId}:${userId}`);
  }

  // ── Rate / Flood Control ───────────────────────────────────────────────────

  /**
   * Reaction rate limit: 60 reactions per user per 60s.
   * Uses a sliding-window sorted set.
   */
  async checkRateLimit(userId: string, action: 'react'): Promise<boolean> {
    const key = `chat:rl:${action}:${userId}`;
    const now = Date.now();
    const windowStart = now - RL_WINDOW_MS;

    const pipe = this.redis.pipeline();
    pipe.zremrangebyscore(key, 0, windowStart);
    pipe.zcard(key);
    const results = await pipe.exec();

    const count = (results?.[1]?.[1] as number) ?? 0;
    if (count >= RL_REACT_MAX) return false;

    await this.redis
      .pipeline()
      .zadd(key, now, `${now}-${Math.random()}`)
      .expire(key, 70)
      .exec();

    return true;
  }

  /**
   * FIX #4 — Flood control for sends: max 10 messages per user per second.
   * Uses a simple Redis INCR counter with a 1-second TTL.
   * Allows rapid natural chatting while blocking runaway clients / bugs.
   * Returns true if the send is allowed.
   */
  async checkFloodControl(userId: string): Promise<boolean> {
    const key = `chat:flood:${userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      // First increment in this window — set 1s expiry
      await this.redis.expire(key, 1);
    }
    return count <= FLOOD_MAX_PER_SEC;
  }

  // ── Redis-first message queue (Streams) ───────────────────────────────────

  /**
   * FIX #5 + #6: Queue a message using Redis Streams (per-room key).
   *
   * Why Streams over a List:
   *   - XREADGROUP + XACK gives at-least-once delivery with PEL crash recovery
   *   - Per-room stream key (chat:stream:trip:<id>) eliminates the global hot key
   *   - Entries persist until XACK, surviving worker crashes
   *
   * FIX #1: Before hitting Postgres for reply_to, check the in-flight stream
   * entries for the room so replies to very-recent messages still resolve.
   */
  async queueMessage(
    user: Pick<User, 'id' | 'name' | 'profile_photo_url'>,
    dto: SendMessageDto,
  ): Promise<FormattedMessage> {
    // 1. Reply snapshot — check stream first, then Postgres
    let replyToSnapshot: ReplyToSnapshot | null = null;
    if (dto.reply_to_id) {
      replyToSnapshot = await this.resolveReplySnapshot(
        dto.reply_to_id,
        dto.room_type,
        dto.room_id,
      );
    }

    // 2. Sanitize
    const sanitizedContent = escapeHtml(dto.content.trim());

    // 3. Build payload with stable pre-generated UUID
    const queued: QueuedMessage = {
      id: uuidv4(),
      room_type: dto.room_type,
      room_id: dto.room_id,
      sender_id: user.id,
      sender_name: user.name ?? 'Unknown',
      sender_avatar: user.profile_photo_url ?? null,
      content: sanitizedContent,
      reply_to: replyToSnapshot,
      created_at: new Date().toISOString(),
    };

    // 4. Push to per-room Redis Stream
    const streamKey = chatStreamKey(dto.room_type, dto.room_id);
    await this.redis.xadd(streamKey, '*', 'data', JSON.stringify(queued));

    // 5. Return immediately — no Postgres wait
    return {
      id: queued.id,
      room_type: queued.room_type,
      room_id: queued.room_id,
      sender: {
        id: user.id,
        name: user.name ?? 'Unknown',
        avatar_url: user.profile_photo_url ?? null,
      },
      content: queued.content,
      message_type: 'text',
      reply_to: queued.reply_to,
      reactions: {},
      created_at: queued.created_at,
      is_deleted: false,
    };
  }

  /**
   * FIX #1: Resolve reply_to snapshot.
   * Checks the in-flight Redis Stream for the room first, so replies to
   * messages sent in the last <100ms (still in queue, not yet in Postgres)
   * resolve correctly instead of returning null.
   */
  private async resolveReplySnapshot(
    replyToId: string,
    roomType: string,
    roomId: string,
  ): Promise<ReplyToSnapshot | null> {
    // Check in-flight stream entries first
    try {
      const streamKey = chatStreamKey(roomType, roomId);
      // Read all pending entries in this room's stream (bounded to last 200)
      const entries = await this.redis.xrevrange(
        streamKey,
        '+',
        '-',
        'COUNT',
        200,
      );
      for (const [, fields] of entries) {
        // fields is alternating [key, value, key, value...]
        const dataIndex = fields.indexOf('data');
        if (dataIndex === -1) continue;
        const q: QueuedMessage = JSON.parse(fields[dataIndex + 1]);
        if (q.id === replyToId) {
          return {
            id: q.id,
            content: q.content.slice(0, 200),
            sender_name: q.sender_name,
          };
        }
      }
    } catch {
      // Stream lookup failure is non-fatal — fall through to Postgres
    }

    // Fall back to Postgres
    const parent = await this.messagesRepo.findOne({
      where: { id: replyToId },
      relations: ['sender'],
    });
    if (parent && !parent.isDeleted) {
      return {
        id: parent.id,
        content: parent.content.slice(0, 200),
        sender_name: parent.sender?.name ?? 'Unknown',
      };
    }
    return null;
  }

  /**
   * Ensure the consumer group exists for a room stream.
   * Called by ChatFlushWorker before reading. Safe to call multiple times.
   */
  async ensureConsumerGroup(streamKey: string): Promise<void> {
    try {
      await this.redis.xgroup(
        'CREATE',
        streamKey,
        CHAT_STREAM_GROUP,
        '0',
        'MKSTREAM',
      );
    } catch (err: any) {
      // BUSYGROUP = group already exists — expected on restart
      if (!err?.message?.includes('BUSYGROUP')) throw err;
    }
  }

  /**
   * FIX #5: Batch-flush up to batchSize messages from a room's Redis Stream
   * into Postgres using XREADGROUP + XACK (at-least-once, crash-safe).
   *
   * Returns the number of messages flushed.
   */
  async flushStream(
    streamKey: string,
    workerId: string,
    batchSize = 50,
  ): Promise<number> {
    // First drain any previously-pending (unacked) entries from a prior crash
    await this.recoverPendingEntries(streamKey, workerId, batchSize);

    // Read new entries assigned to this worker
    const results = (await this.redis.xreadgroup(
      'GROUP',
      CHAT_STREAM_GROUP,
      workerId,
      'COUNT',
      String(batchSize),
      'STREAMS',
      streamKey,
      '>',
    )) as Array<[string, Array<[string, string[]]>]> | null;

    if (!results || results.length === 0) return 0;

    const entries: Array<[string, string[]]> = results[0][1];
    if (entries.length === 0) return 0;

    // FIX #8: Queue depth alert
    const depth = await this.redis.xlen(streamKey);
    if (depth > QUEUE_DEPTH_WARN) {
      this.logger.error(
        `[Chat] Stream ${streamKey} depth=${depth} exceeds ${QUEUE_DEPTH_WARN} — flush worker may be lagging`,
      );
    }

    const messages: Partial<ChatMessage>[] = entries.map(([, fields]) => {
      const dataIndex = fields.indexOf('data');
      const q: QueuedMessage = JSON.parse(fields[dataIndex + 1]);
      return {
        id: q.id,
        roomType: q.room_type,
        roomId: q.room_id,
        senderId: q.sender_id,
        content: q.content,
        messageType: 'text' as const,
        replyTo: q.reply_to,
        metadata: {},
        isPinned: false,
        isDeleted: false,
        // FIX #2: use the timestamp set at queue time, not DB INSERT time,
        // so each message has its own unique createdAt for cursor pagination.
        createdAt: new Date(q.created_at),
        deletedAt: null,
      };
    });

    // Bulk INSERT — ON CONFLICT DO NOTHING for idempotent retries
    await this.messagesRepo
      .createQueryBuilder()
      .insert()
      .into(ChatMessage)
      .values(messages as any)
      .orIgnore()
      .execute();

    // ACK only after successful INSERT — entries leave PEL
    const ids = entries.map(([id]) => id);
    await this.redis.xack(streamKey, CHAT_STREAM_GROUP, ...ids);

    return entries.length;
  }

  /**
   * Re-deliver entries that were read but never ACKed (worker crashed mid-flush).
   * Reclaims entries idle for > 5s.
   */
  private async recoverPendingEntries(
    streamKey: string,
    workerId: string,
    batchSize: number,
  ): Promise<void> {
    try {
      const pending = (await this.redis.xpending(
        streamKey,
        CHAT_STREAM_GROUP,
        '-',
        '+',
        batchSize,
      )) as Array<[string, string, number, number]>;

      if (!pending || pending.length === 0) return;

      // Reclaim entries idle > 5000ms
      const staleIds = pending
        .filter(([, , idleMs]) => idleMs > 5_000)
        .map(([id]) => id);

      if (staleIds.length === 0) return;

      await this.redis.xclaim(
        streamKey,
        CHAT_STREAM_GROUP,
        workerId,
        5_000,
        ...staleIds,
      );

      this.logger.warn(
        `[Chat] Reclaimed ${staleIds.length} pending entries on ${streamKey}`,
      );
    } catch {
      // xpending on a non-existent group is safe to ignore
    }
  }

  // ── Message Lookup ────────────────────────────────────────────────────────

  /**
   * FIX #7: Cache message→room mapping in Redis to avoid a Postgres round-trip
   * on every reaction event. Popular messages get reacted to constantly.
   */
  async findMessageById(messageId: string): Promise<ChatMessage | null> {
    return this.messagesRepo.findOne({ where: { id: messageId } });
  }

  async getMessageRoom(
    messageId: string,
  ): Promise<{ roomType: string; roomId: string } | null> {
    const cacheKey = `chat:msg:room:${messageId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const message = await this.messagesRepo.findOne({
      where: { id: messageId },
      select: ['id', 'roomType', 'roomId'],
    });
    if (!message) return null;

    const room = { roomType: message.roomType, roomId: message.roomId };
    await this.redis.set(cacheKey, JSON.stringify(room), 'EX', 3600);
    return room;
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
      .where('m.roomType = :roomType AND m.roomId = :roomId', {
        roomType,
        roomId,
      })
      .andWhere('m.isDeleted = false')
      .orderBy('m.createdAt', 'DESC')
      .addOrderBy('m.id', 'DESC') // FIX #2: compound sort for stable pagination
      .limit(Math.min(limit, 100));

    if (before) {
      const cursor = await this.messagesRepo.findOne({ where: { id: before } });
      if (cursor) {
        // FIX #2: compound cursor (createdAt, id) prevents skipping messages
        // that share the same createdAt timestamp (e.g. from a batch flush).
        qb.andWhere(
          '(m.createdAt < :cursorTime OR (m.createdAt = :cursorTime AND m.id < :cursorId))',
          { cursorTime: cursor.createdAt, cursorId: cursor.id },
        );
      }
    }

    const messages = await qb.getMany();

    const messageIds = messages.map((m) => m.id);
    const reactions =
      messageIds.length > 0
        ? await this.reactionsRepo.find({
            where: { messageId: In(messageIds) },
          })
        : [];

    return messages.reverse().map((msg) =>
      this.formatMessage(
        msg,
        msg.sender,
        reactions.filter((r) => r.messageId === msg.id),
      ),
    );
  }

  // ── Reactions ─────────────────────────────────────────────────────────────

  /**
   * FIX #3 + #7: Atomic toggle using INSERT ON CONFLICT DO NOTHING.
   * Eliminates the SELECT→DELETE/INSERT race condition and reduces
   * round-trips from 4 to 2 (upsert + load all reactions).
   * Uses getMessageRoom() cache to avoid extra message lookup.
   */
  async toggleReaction(
    userId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ roomType: string; roomId: string; reactions: ReactionsMap }> {
    const room = await this.getMessageRoom(messageId);
    if (!room) throw new NotFoundException('Message not found');

    // Atomic upsert: try INSERT first
    const insertResult = await this.reactionsRepo
      .createQueryBuilder()
      .insert()
      .into(MessageReaction)
      .values({ messageId, userId, emoji })
      .onConflict('ON CONFLICT (message_id, user_id, emoji) DO NOTHING')
      .returning('id')
      .execute();

    // If nothing was inserted the reaction already existed → toggle it off
    if (insertResult.raw.length === 0) {
      await this.reactionsRepo.delete({ messageId, userId, emoji });
    }

    const allReactions = await this.reactionsRepo.find({
      where: { messageId },
    });
    return {
      roomType: room.roomType,
      roomId: room.roomId,
      reactions: this.groupReactions(allReactions),
    };
  }

  async getReactionsForMessage(messageId: string): Promise<ReactionsMap> {
    const reactions = await this.reactionsRepo.find({ where: { messageId } });
    return this.groupReactions(reactions);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private groupReactions(reactions: MessageReaction[]): ReactionsMap {
    return reactions.reduce((acc, r) => {
      if (!acc[r.emoji]) acc[r.emoji] = [];
      acc[r.emoji].push(r.userId);
      return acc;
    }, {} as ReactionsMap);
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
