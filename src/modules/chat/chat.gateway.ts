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
import {
  UseGuards,
  UsePipes,
  ValidationPipe,
  Logger,
  Inject,
} from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';

import { WsJwtGuard } from './guards/ws-jwt.guard';
import { ChatService, CHAT_ADAPTER_REDIS } from './chat.service';
import { ChatFlushWorker } from './chat-flush.worker';
import { SendMessageDto } from './dto/send-message.dto';
import { ReactMessageDto } from './dto/react-message.dto';
import { CHAT_REDIS } from './chat.service';

/**
 * ChatGateway
 *
 * Security model:
 *   1. JWT validated at connection → unauthenticated sockets dropped immediately
 *   2. JWT re-validated per-event via WsJwtGuard (defense-in-depth)
 *   3. Input validated via ValidationPipe on the gateway class
 *   4. Flood control (10 msg/sec) before access check on send
 *   5. Room membership checked on every send/react
 *   6. Typing uses socket room membership (no Redis call) — fix #UX6
 *   7. Broadcast only to verified room key — no cross-room leakage
 *
 * FIX #9: Socket.IO adapter uses CHAT_ADAPTER_REDIS (dedicated connection)
 * so it never contends with the write-ahead stream or rate-limit operations.
 */
@WebSocketGateway({
  namespace: '/chat',
  cors: {
    origin: true, // Allow all origins — mobile apps send no Origin header.
    credentials: true, // Security is enforced by WsJwtGuard, not CORS.
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
    private readonly flushWorker: ChatFlushWorker,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(CHAT_REDIS) private readonly redis: Redis,
    // FIX #9: dedicated connection for Socket.IO adapter pub/sub
    @Inject(CHAT_ADAPTER_REDIS) private readonly adapterRedis: Redis,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  afterInit(server: Server) {
    // FIX #9: use the dedicated adapter Redis, not the general CHAT_REDIS.
    // Socket.IO adapter requires two clients (pub + sub) in subscribe mode.
    const pubClient = this.adapterRedis;
    const subClient = this.adapterRedis.duplicate();

    Promise.resolve()
      .then(() => {
        server.adapter(createAdapter(pubClient, subClient));
        this.logger.log(
          'Redis adapter wired for Socket.IO (dedicated connection)',
        );
      })
      .catch((err) => this.logger.error('Failed to wire Redis adapter', err));

    // Kick eviction subscription — uses general CHAT_REDIS (separate duplicate)
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

  async handleConnection(socket: Socket) {
    const token = WsJwtGuard.extractTokenStatic(socket);
    if (!token) {
      socket.emit('chat:error', {
        code: 'UNAUTHENTICATED',
        message: 'Token required',
      });
      socket.disconnect(true);
      return;
    }
    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
      socket.data.user = payload;
      this.logger.log(
        `[Chat] Connected: userId=${payload.sub} socketId=${socket.id}`,
      );
    } catch {
      socket.emit('chat:error', {
        code: 'TOKEN_INVALID',
        message: 'Invalid or expired token',
      });
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket) {
    const userId = socket.data?.user?.sub ?? 'unknown';
    this.logger.log(
      `[Chat] Disconnected: userId=${userId} socketId=${socket.id}`,
    );
  }

  // ── Client → Server Events ────────────────────────────────────────────────

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

    const hasAccess = await this.chatService.checkRoomAccess(
      userId,
      room_type,
      room_id,
    );
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

    // Register this stream so the flush worker discovers it
    await this.flushWorker.registerStream(room_type, room_id);

    this.logger.log(`[Chat] userId=${userId} joined room=${roomKey}`);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('chat:leave')
  async handleLeave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { room_type: string; room_id: string },
  ) {
    const roomKey = `${body.room_type}:${body.room_id}`;
    await socket.leave(roomKey);
    socket.emit('chat:left', {
      room_type: body.room_type,
      room_id: body.room_id,
    });
  }

  /**
   * Send a message.
   * Order of checks: auth → flood control → access → queue + broadcast.
   * FIX #4: flood control (10 msg/sec per user) before the access check.
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

    // FIX #4: flood control — 10 msg/sec per user (cheap INCR before DB)
    const floodOk = await this.chatService.checkFloodControl(userId);
    if (!floodOk) {
      socket.emit('chat:error', {
        code: 'FLOOD_CONTROL',
        message: 'Sending too fast.',
      });
      return;
    }

    // Room access (Redis-cached)
    const hasAccess = await this.chatService.checkRoomAccess(
      userId,
      dto.room_type,
      dto.room_id,
    );
    if (!hasAccess) {
      socket.emit('chat:error', { code: 'ACCESS_DENIED' });
      return;
    }

    const fullUser = {
      id: userId,
      name: user.name,
      profile_photo_url: user.profile_photo_url,
    } as any;
    const message = await this.chatService.queueMessage(fullUser, dto);
    const roomKey = `${dto.room_type}:${dto.room_id}`;
    this.server.to(roomKey).emit('chat:message', message);
  }

  /**
   * React to a message.
   * FIX #7: uses getMessageRoom() cache to avoid per-reaction Postgres SELECT.
   * FIX #3: toggleReaction is now atomic (INSERT ON CONFLICT DO NOTHING).
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

    const allowed = await this.chatService.checkRateLimit(userId, 'react');
    if (!allowed) {
      socket.emit('chat:error', {
        code: 'RATE_LIMITED',
        message: 'Too many reactions.',
      });
      return;
    }

    // FIX #7: cached room lookup — no Postgres round-trip on every reaction
    const room = await this.chatService.getMessageRoom(dto.message_id);
    if (!room) {
      socket.emit('chat:error', { code: 'MESSAGE_NOT_FOUND' });
      return;
    }

    // Cross-room security: verify membership of the message's room
    const hasAccess = await this.chatService.checkRoomAccess(
      userId,
      room.roomType,
      room.roomId,
    );
    if (!hasAccess) {
      socket.emit('chat:error', { code: 'ACCESS_DENIED' });
      return;
    }

    // FIX #3: atomic toggle
    const result = await this.chatService.toggleReaction(
      userId,
      dto.message_id,
      dto.emoji,
    );
    const roomKey = `${result.roomType}:${result.roomId}`;
    this.server.to(roomKey).emit('chat:reaction_update', {
      message_id: dto.message_id,
      reactions: result.reactions,
    });
  }

  /**
   * Typing indicator.
   * FIX UX#6: checks socket room membership instead of calling Redis checkRoomAccess.
   * The user already passed access check in chat:join — if they're in the
   * Socket.IO room they're authorised. Eliminates a Redis round-trip per typing event.
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

    const roomKey = `${body.room_type}:${body.room_id}`;

    // FIX UX#6: trust socket room membership for ephemeral typing events
    // instead of paying a Redis round-trip on every keystroke.
    if (!socket.rooms.has(roomKey)) return;

    socket.to(roomKey).emit('chat:typing', {
      user_id: userId,
      name: user.name ?? 'Someone',
      room_type: body.room_type,
      room_id: body.room_id,
    });
  }

  // ── Kick / Eviction ───────────────────────────────────────────────────────

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
            `[Chat] Evicted userId=${userId} from room=${roomKey}`,
          );
        }
      }
    } catch (e) {
      this.logger.error(
        `[Chat] Failed to evict userId=${userId} from room=${roomKey}`,
        e,
      );
    }
  }
}
