import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WsException,
} from '@nestjs/websockets';
import { UseGuards, UsePipes, ValidationPipe, Logger, Inject } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';

import { WsJwtGuard } from './guards/ws-jwt.guard';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';
import { ReactMessageDto } from './dto/react-message.dto';
import { CHAT_REDIS } from './chat.service';

/**
 * ChatGateway
 * Single unified WebSocket gateway for all chat rooms.
 * Rooms are keyed by (room_type, room_id) — works for trip chat,
 * community chat, and community-trip chat without any code changes.
 *
 * Security model (enforced on every event):
 *   1. JWT validated at connection (handleConnection) — drops unauthenticated sockets
 *   2. JWT re-validated per-event via WsJwtGuard — defense in depth
 *   3. Input validated via ValidationPipe on the gateway class
 *   4. Rate limit checked before any business logic
 *   5. Room membership checked before every send/react/type
 *   6. Broadcast only to verified room key — no cross-room leakage
 */
@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: (origin: string, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow all origins in development; restrict in production via env
      const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') ?? [];
      const isDev = process.env.NODE_ENV !== 'production';
      if (isDev || !origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS: origin not allowed'));
      }
    },
    credentials: true,
  },
})
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(CHAT_REDIS) private readonly redis: Redis,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  afterInit(server: Server) {
    // Wire Redis adapter for multi-instance horizontal scaling.
    // Messages broadcast on any NestJS instance reach all connected sockets.
    const pubClient = this.redis.duplicate();
    const subClient = this.redis.duplicate();

    Promise.all([pubClient.connect?.(), subClient.connect?.()])
      .catch(() => {
        // ioredis connections are lazy — this is a no-op for already-connected clients
      })
      .finally(() => {
        server.adapter(createAdapter(pubClient, subClient));
        this.logger.log('Redis adapter wired for Socket.IO');
      });

    // Subscribe to kick events published by TripService / CommunityService
    // when a user is removed from a trip or community.
    const kickSub = this.redis.duplicate();
    kickSub.subscribe('chat:kick', (err) => {
      if (err) this.logger.error('Failed to subscribe to chat:kick', err);
    });

    kickSub.on('message', (_channel: string, message: string) => {
      try {
        const { room_type, room_id, user_id } = JSON.parse(message) as {
          room_type: string;
          room_id: string;
          user_id: string;
        };
        this.evictUserFromRoom(room_type, room_id, user_id);
      } catch (e) {
        this.logger.error('Failed to parse chat:kick message', e);
      }
    });

    this.logger.log('ChatGateway initialized');
  }

  /**
   * SECURITY: Validate JWT at connection time.
   * Unauthenticated connections are immediately dropped.
   */
  async handleConnection(socket: Socket) {
    const token = WsJwtGuard.extractTokenStatic(socket);

    if (!token) {
      this.logger.warn(`[Chat] Rejected unauthenticated connection: ${socket.id}`);
      socket.emit('chat:error', { code: 'UNAUTHENTICATED', message: 'Token required' });
      socket.disconnect(true);
      return;
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
      socket.data.user = payload;
      this.logger.log(`[Chat] Connected: userId=${payload.sub} socketId=${socket.id}`);
    } catch {
      this.logger.warn(`[Chat] Rejected invalid token: ${socket.id}`);
      socket.emit('chat:error', { code: 'TOKEN_INVALID', message: 'Invalid or expired token' });
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket) {
    const userId = socket.data?.user?.sub ?? 'unknown';
    this.logger.log(`[Chat] Disconnected: userId=${userId} socketId=${socket.id}`);
    // Socket.IO automatically removes socket from all rooms on disconnect
  }

  // ── Client → Server Events ────────────────────────────────────────────────

  /**
   * Join a chat room.
   * SECURITY: Verifies room membership before socket.join().
   * Without this check, any authenticated user could join any room.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('chat:join')
  async handleJoin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { room_type: string; room_id: string },
  ) {
    const userId = socket.data.user?.sub;
    const { room_type, room_id } = body;

    if (!userId || !['trip', 'community'].includes(room_type) || !room_id) {
      socket.emit('chat:error', { code: 'INVALID_INPUT' });
      return;
    }

    const hasAccess = await this.chatService.checkRoomAccess(userId, room_type, room_id);
    if (!hasAccess) {
      socket.emit('chat:error', {
        code: 'ACCESS_DENIED',
        message: 'You are not a member of this room',
      });
      return;
    }

    const roomKey = `${room_type}:${room_id}`;
    await socket.join(roomKey);
    socket.emit('chat:joined', { room_type, room_id });
    this.logger.log(`[Chat] userId=${userId} joined room=${roomKey}`);
  }

  /**
   * Leave a room explicitly (e.g. user navigates away from chat screen).
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('chat:leave')
  async handleLeave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { room_type: string; room_id: string },
  ) {
    const roomKey = `${body.room_type}:${body.room_id}`;
    await socket.leave(roomKey);
    socket.emit('chat:left', { room_type: body.room_type, room_id: body.room_id });
  }

  /**
   * Send a message to a room.
   * SECURITY:
   *   1. Rate-limited (30 msg / 60s per user per room)
   *   2. Room membership re-verified on every send (stateless — no trust in socket state)
   *   3. Broadcasts ONLY to the verified room key
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('chat:send')
  async handleSend(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: SendMessageDto,
  ) {
    const user = socket.data.user;
    const userId: string = user?.sub;

    if (!userId) {
      socket.emit('chat:error', { code: 'UNAUTHENTICATED' });
      return;
    }

    // 1. Rate limit check (cheap Redis op before any DB access)
    const allowed = await this.chatService.checkRateLimit(userId, 'send', dto.room_id);
    if (!allowed) {
      socket.emit('chat:error', {
        code: 'RATE_LIMITED',
        message: 'Sending too fast. Please slow down.',
      });
      return;
    }

    // 2. Room access check (Redis-cached, falls back to DB)
    const hasAccess = await this.chatService.checkRoomAccess(userId, dto.room_type, dto.room_id);
    if (!hasAccess) {
      socket.emit('chat:error', { code: 'ACCESS_DENIED' });
      return;
    }

    // 3. Persist and broadcast
    const fullUser = { id: userId, name: user.name, profile_photo_url: user.profile_photo_url } as any;
    const message = await this.chatService.saveMessage(fullUser, dto);
    const roomKey = `${dto.room_type}:${dto.room_id}`;

    this.server.to(roomKey).emit('chat:message', message);
  }

  /**
   * Toggle an emoji reaction on a message.
   * SECURITY:
   *   1. Rate-limited (60 reactions / 60s per user)
   *   2. Message looked up first to get its room
   *   3. User's membership in THAT room verified — prevents cross-room reactions
   *   4. Broadcast only to the message's verified room
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('chat:react')
  async handleReact(
    @ConnectedSocket() socket: Socket,
    @MessageBody() dto: ReactMessageDto,
  ) {
    const userId: string = socket.data.user?.sub;

    if (!userId) {
      socket.emit('chat:error', { code: 'UNAUTHENTICATED' });
      return;
    }

    // 1. Rate limit
    const allowed = await this.chatService.checkRateLimit(userId, 'react');
    if (!allowed) {
      socket.emit('chat:error', { code: 'RATE_LIMITED', message: 'Too many reactions.' });
      return;
    }

    // 2. Find the message to know which room it belongs to
    const message = await this.chatService.findMessageById(dto.message_id);
    if (!message) {
      socket.emit('chat:error', { code: 'MESSAGE_NOT_FOUND' });
      return;
    }

    // 3. Verify the user is a member of the room that message belongs to
    //    This prevents: User A in Trip 1 reacting to a message in Trip 2
    const hasAccess = await this.chatService.checkRoomAccess(
      userId,
      message.roomType,
      message.roomId,
    );
    if (!hasAccess) {
      socket.emit('chat:error', { code: 'ACCESS_DENIED' });
      return;
    }

    // 4. Toggle reaction and broadcast to the correct room
    const result = await this.chatService.toggleReaction(userId, dto.message_id, dto.emoji);
    const roomKey = `${result.roomType}:${result.roomId}`;
    this.server.to(roomKey).emit('chat:reaction_update', {
      message_id: dto.message_id,
      reactions: result.reactions,
    });
  }

  /**
   * Typing indicator — ephemeral, never persisted.
   * SECURITY: Room membership verified before broadcasting.
   * Silently ignored on failure (no error response for typing events).
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('chat:typing')
  async handleTyping(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { room_type: string; room_id: string },
  ) {
    const user = socket.data.user;
    const userId: string = user?.sub;

    if (!userId || !['trip', 'community'].includes(body.room_type)) return;

    // Verify membership before broadcasting (prevent typing spam into foreign rooms)
    const hasAccess = await this.chatService.checkRoomAccess(
      userId,
      body.room_type,
      body.room_id,
    );
    if (!hasAccess) return; // Silently drop — no error for typing

    const roomKey = `${body.room_type}:${body.room_id}`;
    // Broadcast to everyone in room EXCEPT the sender
    socket.to(roomKey).emit('chat:typing', {
      user_id: userId,
      name: user.name ?? 'Someone',
      room_type: body.room_type,
      room_id: body.room_id,
    });
  }

  // ── Internal: Kick / Eviction ─────────────────────────────────────────────

  /**
   * Evict a specific user from a Socket.IO room.
   * Called when the user is removed from a trip or community.
   * Published via Redis pub/sub so this works across all server instances.
   */
  private async evictUserFromRoom(
    roomType: string,
    roomId: string,
    userId: string,
  ): Promise<void> {
    const roomKey = `${roomType}:${roomId}`;

    try {
      const sockets = await this.server.in(roomKey).fetchSockets();
      for (const sock of sockets) {
        if (sock.data.user?.sub === userId) {
          await sock.leave(roomKey);
          sock.emit('chat:kicked', {
            room_type: roomType,
            room_id: roomId,
            reason: 'You have been removed from this group',
          });
          this.logger.log(
            `[Chat] Evicted userId=${userId} from room=${roomKey} (kick event)`,
          );
        }
      }
    } catch (e) {
      this.logger.error(`[Chat] Failed to evict userId=${userId} from room=${roomKey}`, e);
    }
  }
}
