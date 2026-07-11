import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
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

import { WsJwtGuard } from '../chat/guards/ws-jwt.guard';
import { LocationService, LOC_REDIS, LocationPayload } from './location.service';

export const LOC_ADAPTER_REDIS = 'LOC_ADAPTER_REDIS_CLIENT';

/**
 * LocationGateway
 *
 * Namespace: /location
 *
 * Security model mirrors ChatGateway:
 *   1. JWT validated at connect handshake → unauthenticated sockets dropped
 *   2. JWT re-validated per-event via WsJwtGuard
 *   3. Trip membership enforced on join (reuses chat's checkRoomAccess cache)
 *   4. Server-side rate limit: max 1 location:update per 2 s per user
 *   5. Min-movement filter: skip updates < 10 m (haversine, in LocationService)
 *
 * Redis keys:
 *   loc:pos:{tripId}:{userId}  → JSON ParticipantPosition, EX 3600
 *   loc:rl:{userId}            → rate-limit counter, EX 2s
 *
 * Events (client → server):
 *   location:join    { trip_id }
 *   location:leave   { trip_id }
 *   location:update  { trip_id, lat, lng, heading?, speed?, ts }
 *
 * Events (server → client):
 *   location:snapshot  { positions: ParticipantPosition[] }
 *   location:changed   ParticipantPosition
 *   location:left      { trip_id, user_id }
 *   location:error     { code, message? }
 *   location:joined    { trip_id }
 */
@WebSocketGateway({
  namespace: '/location',
  cors: {
    origin: true, // Allow all origins — mobile apps send no Origin header.
    credentials: true, // Security is enforced by WsJwtGuard, not CORS.
  },
})
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class LocationGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(LocationGateway.name);

  constructor(
    private readonly locationService: LocationService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @Inject(LOC_REDIS) private readonly redis: Redis,
    @Inject(LOC_ADAPTER_REDIS) private readonly adapterRedis: Redis,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  afterInit(server: Server) {
    const pubClient = this.adapterRedis;
    const subClient = this.adapterRedis.duplicate();

    Promise.resolve()
      .then(() => {
        server.adapter(createAdapter(pubClient, subClient));
        this.logger.log('Redis adapter wired for LocationGateway');
      })
      .catch((err) =>
        this.logger.error('Failed to wire Location Redis adapter', err),
      );

    this.logger.log('LocationGateway initialized');
  }

  async handleConnection(socket: Socket) {
    const token = WsJwtGuard.extractTokenStatic(socket);
    if (!token) {
      socket.emit('location:error', {
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
        `[Location] Connected: userId=${payload.sub} socketId=${socket.id}`,
      );
    } catch {
      socket.emit('location:error', {
        code: 'TOKEN_INVALID',
        message: 'Invalid or expired token',
      });
      socket.disconnect(true);
    }
  }

  async handleDisconnect(socket: Socket) {
    const userId: string | undefined = socket.data?.user?.sub;
    this.logger.log(
      `[Location] Disconnected: userId=${userId ?? 'unknown'} socketId=${socket.id}`,
    );

    // Clean up all trip rooms this socket was in.
    // Socket.IO room names we use are `trip:{tripId}`.
    if (userId) {
      for (const room of socket.rooms) {
        if (room.startsWith('trip:')) {
          const tripId = room.replace('trip:', '');
          await this.locationService.removePosition(userId, tripId);
          this.server.to(room).emit('location:left', { trip_id: tripId, user_id: userId });
          this.logger.log(
            `[Location] Auto-cleanup: userId=${userId} removed from trip=${tripId}`,
          );
        }
      }
    }
  }

  // ── Client → Server Events ─────────────────────────────────────────────────

  /**
   * location:join — join a trip's location room.
   * Checks membership (reuses chat's Redis-cached checkRoomAccess),
   * then sends a snapshot of all current participant positions.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('location:join')
  async handleJoin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { trip_id: string },
  ) {
    const userId: string = socket.data.user?.sub;
    const { trip_id } = body;

    if (!userId || !trip_id) {
      socket.emit('location:error', { code: 'INVALID_INPUT' });
      return;
    }

    const isMember = await this.locationService.checkMembership(userId, trip_id);
    if (!isMember) {
      socket.emit('location:error', {
        code: 'ACCESS_DENIED',
        message: 'You are not a member of this trip',
      });
      return;
    }

    const roomKey = `trip:${trip_id}`;
    await socket.join(roomKey);
    socket.emit('location:joined', { trip_id });

    // Send existing positions as an initial snapshot
    const positions = await this.locationService.getSnapshot(trip_id);
    socket.emit('location:snapshot', { positions });

    this.logger.log(`[Location] userId=${userId} joined trip=${trip_id}`);
  }

  /**
   * location:leave — leave the trip's location room, remove position from Redis.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('location:leave')
  async handleLeave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { trip_id: string },
  ) {
    const userId: string = socket.data.user?.sub;
    const { trip_id } = body;

    if (!userId || !trip_id) return;

    const roomKey = `trip:${trip_id}`;
    await socket.leave(roomKey);
    await this.locationService.removePosition(userId, trip_id);

    // Broadcast departure to remaining participants
    this.server.to(roomKey).emit('location:left', { trip_id, user_id: userId });
    this.logger.log(`[Location] userId=${userId} left trip=${trip_id}`);
  }

  /**
   * location:update — publish a new GPS coordinate.
   * Guards: rate limit (1/2s), min-distance (10 m).
   * On success broadcasts location:changed to the room.
   */
  @UseGuards(WsJwtGuard)
  @SubscribeMessage('location:update')
  async handleUpdate(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    body: {
      trip_id: string;
      lat: number;
      lng: number;
      heading?: number;
      speed?: number;
      ts: number;
    },
  ) {
    const user = socket.data.user;
    const userId: string = user?.sub;
    const { trip_id, lat, lng, heading, speed, ts } = body;

    if (!userId || !trip_id || lat == null || lng == null) {
      socket.emit('location:error', { code: 'INVALID_INPUT' });
      return;
    }

    // Server-side rate limit: max 1 update / 2 s
    const withinLimit = await this.locationService.checkRateLimit(userId);
    if (!withinLimit) {
      // Silent drop — client already throttles; no need to surface an error
      return;
    }

    const payload: LocationPayload = { lat, lng, heading, speed, ts };
    const position = await this.locationService.updatePosition(
      userId,
      user.name ?? null,
      trip_id,
      payload,
    );

    // null means the move was < 10 m — skip broadcast
    if (!position) return;

    const roomKey = `trip:${trip_id}`;
    this.server.to(roomKey).emit('location:changed', position);
  }
}
