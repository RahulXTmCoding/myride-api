import { Injectable, Inject, ForbiddenException } from '@nestjs/common';
import Redis from 'ioredis';
import { ChatService } from '../chat/chat.service';

export const LOC_REDIS = 'LOC_REDIS_CLIENT';

export interface LocationPayload {
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  ts: number;
}

export interface ParticipantPosition {
  user_id: string;
  name: string | null;
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  ts: number;
}

// Redis keys
// loc:pos:{tripId}:{userId}  →  JSON ParticipantPosition, EX 3600
// loc:rl:{userId}            →  rate-limit counter (INCR + EXPIRE 2s)

const POS_TTL = 3600;       // evict after 1 h offline
const RL_MAX = 1;           // max updates per RL_WINDOW_S
const RL_WINDOW_S = 2;
const MIN_MOVE_M = 10;      // ignore server-side if moved < 10 m

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

@Injectable()
export class LocationService {
  constructor(
    @Inject(LOC_REDIS) private readonly redis: Redis,
    private readonly chatService: ChatService,
  ) {}

  /** Reuse chat's membership cache (trip participant approved check). */
  async checkMembership(userId: string, tripId: string): Promise<boolean> {
    return this.chatService.checkRoomAccess(userId, 'trip', tripId);
  }

  /** Server-side rate limit: max 1 update per 2 s per user. */
  async checkRateLimit(userId: string): Promise<boolean> {
    const key = `loc:rl:${userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, RL_WINDOW_S);
    return count <= RL_MAX;
  }

  /**
   * Store position in Redis and return the full position object.
   * Returns null if the move was < MIN_MOVE_M (no meaningful change).
   */
  async updatePosition(
    userId: string,
    name: string | null,
    tripId: string,
    payload: LocationPayload,
  ): Promise<ParticipantPosition | null> {
    const key = `loc:pos:${tripId}:${userId}`;
    const existing = await this.redis.get(key);

    if (existing) {
      const prev: ParticipantPosition = JSON.parse(existing);
      const dist = haversineM(prev.lat, prev.lng, payload.lat, payload.lng);
      if (dist < MIN_MOVE_M) return null; // skip tiny jitter
    }

    const position: ParticipantPosition = {
      user_id: userId,
      name,
      ...payload,
    };
    await this.redis.set(key, JSON.stringify(position), 'EX', POS_TTL);
    return position;
  }

  /** Fetch all live positions for a trip. */
  async getSnapshot(tripId: string): Promise<ParticipantPosition[]> {
    const pattern = `loc:pos:${tripId}:*`;
    const keys = await this.redis.keys(pattern);
    if (!keys.length) return [];
    const values = await this.redis.mget(...keys);
    return values
      .filter((v): v is string => v !== null)
      .map((v) => JSON.parse(v) as ParticipantPosition);
  }

  /** Remove a user's position (on leave / disconnect). */
  async removePosition(userId: string, tripId: string): Promise<void> {
    await this.redis.del(`loc:pos:${tripId}:${userId}`);
  }

  /** Enforce membership or throw ForbiddenException (for REST). */
  async assertMembership(userId: string, tripId: string): Promise<void> {
    const ok = await this.checkMembership(userId, tripId);
    if (!ok) throw new ForbiddenException('Not a trip member');
  }
}
