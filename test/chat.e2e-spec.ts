/**
 * E2E tests for the Chat system.
 *
 * Tests the full flow via HTTP (REST history) and Socket.IO (WS events).
 * Requires PostgreSQL + Redis to be reachable. If infra is unavailable,
 * all tests are skipped gracefully (same pattern as auth.e2e-spec.ts).
 *
 * Flows covered:
 *  - Unauthenticated WS connection is rejected
 *  - User can connect with a valid JWT
 *  - User cannot join a trip room they are not a member of
 *  - User can join a community room (placeholder: open access)
 *  - Sending a message to a room the user hasn't joined is denied
 *  - Full send → receive flow within a room
 *  - Two users in different rooms cannot see each other's messages (room isolation)
 *  - Reaction toggle on/off
 *  - REST GET /chat/:type/:id/messages requires auth
 *  - REST GET /chat/:type/:id/messages is access-controlled for trip rooms
 *  - Rate limiting: 31st message in 60s window is rejected
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import type Redis from 'ioredis';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';
import { REDIS_CLIENT } from './../src/modules/auth/redis.provider';
import { TripParticipant } from './../src/modules/trips/entities/trip-participant.entity';
import { Trip } from './../src/modules/trips/entities/trip.entity';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function registerUser(app: INestApplication<App>, redis: Redis, phone: string) {
  await request(app.getHttpServer())
    .post('/api/v1/auth/request-otp')
    .send({ phone })
    .expect(200);

  const otp = await redis.get(`otp:code:${phone}`);
  const loginRes = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ phone, otp })
    .expect(200);

  return {
    userId: loginRes.body.user.id as string,
    token: loginRes.body.access_token as string,
  };
}

function connectSocket(port: number, token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://localhost:${port}/chat`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 5000);
  });
}

function waitForEvent(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('Chat system (e2e)', () => {
  let app: INestApplication<App>;
  let redis: Redis;
  let ds: DataSource;
  let port: number;
  let available = true;

  // Test users
  let userA: { userId: string; token: string };
  let userB: { userId: string; token: string };
  let tripId: string;

  beforeAll(async () => {
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleFixture.createNestApplication();
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      app.setGlobalPrefix('api/v1');
      await app.init();

      redis = app.get<Redis>(REDIS_CLIENT);
      ds = app.get(DataSource);

      const server = app.getHttpServer();
      await new Promise<void>((resolve) => server.listen(0, resolve));
      port = server.address().port;

      // Register two test users
      const phone = (n: number) =>
        `+1${String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)).slice(0, 10)}${n}`;
      userA = await registerUser(app, redis, phone(1));
      userB = await registerUser(app, redis, phone(2));

      // Create a trip row directly (Trip CRUD module not yet built)
      const tripResult = await ds.query(
        `INSERT INTO trips (title, description, start_location, end_location, created_by_user_id, status)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        ['Test Trip', 'desc', 'A', 'B', userA.userId, 'upcoming'],
      );
      tripId = tripResult[0].id;

      // Add userA as approved participant
      await ds.query(
        `INSERT INTO trip_participants (trip_id, user_id, status) VALUES ($1,$2,'approved')`,
        [tripId, userA.userId],
      );
      // userB is NOT a participant (used to test access denial)
    } catch (err) {
      console.warn('[e2e/chat] infra unavailable, skipping:', (err as Error).message);
      available = false;
    }
  }, 60_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  function skip() {
    if (!available) return true;
    return false;
  }

  // ── WS Connection ─────────────────────────────────────────────────────────────

  describe('WebSocket connection', () => {
    it('rejects connection with no token', async () => {
      if (skip()) return;

      const socket = ioClient(`http://localhost:${port}/chat`, {
        auth: {},
        transports: ['websocket'],
        forceNew: true,
      });

      const errorData = await waitForEvent(socket, 'chat:error');
      expect(errorData.code).toBe('UNAUTHENTICATED');

      await new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
      socket.close();
    }, 10_000);

    it('rejects connection with invalid token', async () => {
      if (skip()) return;

      const socket = ioClient(`http://localhost:${port}/chat`, {
        auth: { token: 'not.a.real.jwt' },
        transports: ['websocket'],
        forceNew: true,
      });

      const errorData = await waitForEvent(socket, 'chat:error');
      expect(errorData.code).toBe('TOKEN_INVALID');

      socket.close();
    }, 10_000);

    it('accepts connection with valid JWT', async () => {
      if (skip()) return;

      const socket = await connectSocket(port, userA.token);
      expect(socket.connected).toBe(true);
      socket.close();
    }, 10_000);
  });

  // ── Room Join ─────────────────────────────────────────────────────────────────

  describe('chat:join', () => {
    it('denies joining a trip room the user is not a member of', async () => {
      if (skip()) return;

      const socket = await connectSocket(port, userB.token);

      socket.emit('chat:join', { room_type: 'trip', room_id: tripId });
      const errorData = await waitForEvent(socket, 'chat:error');

      expect(errorData.code).toBe('ACCESS_DENIED');
      socket.close();
    }, 10_000);

    it('allows joining a trip room as an approved participant', async () => {
      if (skip()) return;

      const socket = await connectSocket(port, userA.token);

      socket.emit('chat:join', { room_type: 'trip', room_id: tripId });
      const joined = await waitForEvent(socket, 'chat:joined');

      expect(joined.room_type).toBe('trip');
      expect(joined.room_id).toBe(tripId);
      socket.close();
    }, 10_000);

    it('allows joining a community room (placeholder access)', async () => {
      if (skip()) return;

      const socket = await connectSocket(port, userB.token);

      socket.emit('chat:join', { room_type: 'community', room_id: 'global-community' });
      const joined = await waitForEvent(socket, 'chat:joined');

      expect(joined.room_type).toBe('community');
      socket.close();
    }, 10_000);
  });

  // ── Send Message ──────────────────────────────────────────────────────────────

  describe('chat:send', () => {
    it('denies sending to a room the user is not a member of', async () => {
      if (skip()) return;

      const socket = await connectSocket(port, userB.token);

      socket.emit('chat:send', {
        room_type: 'trip',
        room_id: tripId,
        content: 'I should not be here',
      });
      const errorData = await waitForEvent(socket, 'chat:error');

      expect(errorData.code).toBe('ACCESS_DENIED');
      socket.close();
    }, 10_000);

    it('broadcasts message to room members on successful send', async () => {
      if (skip()) return;

      const senderSocket = await connectSocket(port, userA.token);
      const receiverSocket = await connectSocket(port, userA.token); // same user, second connection

      // Both join the room
      senderSocket.emit('chat:join', { room_type: 'trip', room_id: tripId });
      await waitForEvent(senderSocket, 'chat:joined');

      receiverSocket.emit('chat:join', { room_type: 'trip', room_id: tripId });
      await waitForEvent(receiverSocket, 'chat:joined');

      // Send from senderSocket
      senderSocket.emit('chat:send', {
        room_type: 'trip',
        room_id: tripId,
        content: 'Hello from e2e test',
      });

      // Both should receive it
      const [msgOnSender, msgOnReceiver] = await Promise.all([
        waitForEvent(senderSocket, 'chat:message'),
        waitForEvent(receiverSocket, 'chat:message'),
      ]);

      expect(msgOnSender.content).toBe('Hello from e2e test');
      expect(msgOnReceiver.content).toBe('Hello from e2e test');
      expect(msgOnSender.room_type).toBe('trip');
      expect(msgOnSender.room_id).toBe(tripId);

      senderSocket.close();
      receiverSocket.close();
    }, 15_000);

    it('does NOT leak messages across rooms (room isolation)', async () => {
      if (skip()) return;

      const socketA = await connectSocket(port, userA.token);
      const socketB = await connectSocket(port, userB.token);

      // A joins trip room, B joins community room
      socketA.emit('chat:join', { room_type: 'trip', room_id: tripId });
      await waitForEvent(socketA, 'chat:joined');

      socketB.emit('chat:join', { room_type: 'community', room_id: 'global-community' });
      await waitForEvent(socketB, 'chat:joined');

      // A sends to trip room
      socketA.emit('chat:send', {
        room_type: 'trip',
        room_id: tripId,
        content: 'Trip-only message',
      });

      // A receives their own message
      const msg = await waitForEvent(socketA, 'chat:message');
      expect(msg.content).toBe('Trip-only message');

      // B should NOT receive A's trip message within 1s
      let bGotMessage = false;
      socketB.once('chat:message', () => { bGotMessage = true; });
      await new Promise((r) => setTimeout(r, 1000));
      expect(bGotMessage).toBe(false);

      socketA.close();
      socketB.close();
    }, 15_000);
  });

  // ── Reactions ─────────────────────────────────────────────────────────────────

  describe('chat:react', () => {
    let messageId: string;

    beforeAll(async () => {
      if (!available) return;

      // Send a message first to get a real message ID
      const socket = await connectSocket(port, userA.token);
      socket.emit('chat:join', { room_type: 'trip', room_id: tripId });
      await waitForEvent(socket, 'chat:joined');

      socket.emit('chat:send', {
        room_type: 'trip',
        room_id: tripId,
        content: 'Message to react to',
      });
      const msg = await waitForEvent(socket, 'chat:message');
      messageId = msg.id;
      socket.close();
    }, 15_000);

    it('adds a reaction and broadcasts reaction_update to room', async () => {
      if (skip() || !messageId) return;

      const socket = await connectSocket(port, userA.token);
      socket.emit('chat:join', { room_type: 'trip', room_id: tripId });
      await waitForEvent(socket, 'chat:joined');

      socket.emit('chat:react', { message_id: messageId, emoji: '👍' });
      const update = await waitForEvent(socket, 'chat:reaction_update');

      expect(update.message_id).toBe(messageId);
      expect(update.reactions['👍']).toContain(userA.userId);
      socket.close();
    }, 10_000);

    it('removes reaction on second react with same emoji (toggle off)', async () => {
      if (skip() || !messageId) return;

      const socket = await connectSocket(port, userA.token);
      socket.emit('chat:join', { room_type: 'trip', room_id: tripId });
      await waitForEvent(socket, 'chat:joined');

      // Second toggle — should remove
      socket.emit('chat:react', { message_id: messageId, emoji: '👍' });
      const update = await waitForEvent(socket, 'chat:reaction_update');

      // Should no longer have user-1 in the '👍' list (or key may be absent)
      const thumbsUp: string[] = update.reactions['👍'] ?? [];
      expect(thumbsUp).not.toContain(userA.userId);
      socket.close();
    }, 10_000);

    it('denies reacting to a message in a room the user does not belong to', async () => {
      if (skip() || !messageId) return;

      // userB is not a trip participant — cannot react to trip messages
      const socket = await connectSocket(port, userB.token);

      socket.emit('chat:react', { message_id: messageId, emoji: '❤️' });
      const errorData = await waitForEvent(socket, 'chat:error');

      expect(['ACCESS_DENIED', 'RATE_LIMITED', 'MESSAGE_NOT_FOUND']).toContain(errorData.code);
      // Specifically should be ACCESS_DENIED for the room check
      if (errorData.code !== 'RATE_LIMITED') {
        expect(errorData.code).toBe('ACCESS_DENIED');
      }
      socket.close();
    }, 10_000);
  });

  // ── REST: GET /chat/:type/:id/messages ────────────────────────────────────────

  describe('GET /chat/:type/:id/messages', () => {
    it('returns 401 without auth token', async () => {
      if (skip()) return;

      await request(app.getHttpServer())
        .get(`/api/v1/chat/trip/${tripId}/messages`)
        .expect(401);
    });

    it('returns 403 when user is not a trip member', async () => {
      if (skip()) return;

      await request(app.getHttpServer())
        .get(`/api/v1/chat/trip/${tripId}/messages`)
        .set('Authorization', `Bearer ${userB.token}`)
        .expect(403);
    });

    it('returns message history for approved trip member', async () => {
      if (skip()) return;

      const res = await request(app.getHttpServer())
        .get(`/api/v1/chat/trip/${tripId}/messages`)
        .set('Authorization', `Bearer ${userA.token}`)
        .expect(200);

      expect(Array.isArray(res.body.messages)).toBe(true);
      expect(typeof res.body.has_more).toBe('boolean');
    });

    it('returns 200 for community room (placeholder: open access)', async () => {
      if (skip()) return;

      const res = await request(app.getHttpServer())
        .get('/api/v1/chat/community/global-community/messages')
        .set('Authorization', `Bearer ${userB.token}`)
        .expect(200);

      expect(Array.isArray(res.body.messages)).toBe(true);
    });

    it('supports cursor pagination via before param', async () => {
      if (skip()) return;

      const first = await request(app.getHttpServer())
        .get(`/api/v1/chat/trip/${tripId}/messages?limit=1`)
        .set('Authorization', `Bearer ${userA.token}`)
        .expect(200);

      if (first.body.messages.length === 0) return; // no messages to paginate

      const firstMsgId = first.body.messages[0].id;

      await request(app.getHttpServer())
        .get(`/api/v1/chat/trip/${tripId}/messages?before=${firstMsgId}`)
        .set('Authorization', `Bearer ${userA.token}`)
        .expect(200);
    });
  });

  // ── Rate Limiting ──────────────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('rejects the 31st message in the same 60s window', async () => {
      if (skip()) return;

      const socket = await connectSocket(port, userA.token);
      socket.emit('chat:join', { room_type: 'trip', room_id: tripId });
      await waitForEvent(socket, 'chat:joined');

      const errors: any[] = [];
      socket.on('chat:error', (e) => errors.push(e));

      // Clear rate limit for this user+room first (Redis key purge)
      await redis.del(`chat:rl:send:${userA.userId}:${tripId}`);

      // Send 30 messages (should all succeed)
      for (let i = 0; i < 30; i++) {
        socket.emit('chat:send', {
          room_type: 'trip',
          room_id: tripId,
          content: `msg ${i}`,
        });
      }
      // Wait a moment for all to process
      await new Promise((r) => setTimeout(r, 500));

      // 31st should be rate limited
      socket.emit('chat:send', {
        room_type: 'trip',
        room_id: tripId,
        content: 'over limit',
      });
      await new Promise((r) => setTimeout(r, 500));

      const rateLimitError = errors.find((e) => e.code === 'RATE_LIMITED');
      expect(rateLimitError).toBeDefined();

      socket.close();
    }, 30_000);
  });
});
