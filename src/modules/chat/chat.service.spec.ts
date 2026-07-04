import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  ChatService,
  CHAT_REDIS,
  chatStreamKey,
  CHAT_STREAM_GROUP,
  QueuedMessage,
} from './chat.service';
import { ChatMessage } from './entities/chat-message.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';
import { CommunityMember } from '../community/entities/community-member.entity';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<any> = {}) {
  return {
    id: 'user-1',
    name: 'Alice',
    profile_photo_url: null,
    ...overrides,
  } as any;
}

function makeMessage(overrides: Partial<any> = {}) {
  return {
    id: 'msg-1',
    roomType: 'trip',
    roomId: 'trip-1',
    content: 'Hello',
    messageType: 'text',
    replyTo: null,
    isDeleted: false,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    sender: makeUser(),
    ...overrides,
  } as any;
}

// ─── Redis Mock ────────────────────────────────────────────────────────────────
// Implements all Redis primitives used by ChatService.

class RedisMock {
  store = new Map<string, { value: string; expiresAt?: number }>();
  zsets = new Map<string, Map<string, number>>();
  // streams: key → [{id, fields}]
  streams = new Map<string, Array<{ id: string; fields: string[] }>>();
  sets = new Map<string, Set<string>>();
  // Consumer groups: streamKey → groupName → Map<consumerId, Set<entryId>>
  groups = new Map<string, Map<string, Map<string, Set<string>>>>();
  published: Array<{ channel: string; message: string }> = [];
  private seq = 0;

  private now() {
    return Date.now();
  }
  private nextId() {
    return `${this.now()}-${++this.seq}`;
  }

  private purge(key: string) {
    const e = this.store.get(key);
    if (e?.expiresAt !== undefined && e.expiresAt <= this.now())
      this.store.delete(key);
  }

  async get(key: string): Promise<string | null> {
    this.purge(key);
    return this.store.get(key)?.value ?? null;
  }

  async set(
    key: string,
    value: string,
    _mode?: string,
    ttl?: number,
  ): Promise<'OK'> {
    const expiresAt = ttl ? this.now() + ttl * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.store.delete(key);
    this.zsets.delete(key);
    this.streams.delete(key);
    this.sets.delete(key);
    return 1;
  }

  async incr(key: string): Promise<number> {
    this.purge(key);
    const entry = this.store.get(key);
    const next = entry ? parseInt(entry.value, 10) + 1 : 1;
    this.store.set(key, { value: String(next), expiresAt: entry?.expiresAt });
    return next;
  }

  async expire(key: string, ttl: number): Promise<number> {
    const e = this.store.get(key);
    if (e) {
      e.expiresAt = this.now() + ttl * 1000;
      return 1;
    }
    return 0;
  }

  // ── Streams ──────────────────────────────────────────────────────────────

  async xadd(key: string, _id: string, ...fields: string[]): Promise<string> {
    const id = this.nextId();
    const stream = this.streams.get(key) ?? [];
    stream.push({ id, fields });
    this.streams.set(key, stream);
    return id;
  }

  async xlen(key: string): Promise<number> {
    return (this.streams.get(key) ?? []).length;
  }

  async xrevrange(
    key: string,
    _end: string,
    _start: string,
    _count?: string,
    n?: number,
  ): Promise<Array<[string, string[]]>> {
    const stream = this.streams.get(key) ?? [];
    const limit = n ?? stream.length;
    return [...stream]
      .reverse()
      .slice(0, limit)
      .map((e) => [e.id, e.fields]);
  }

  async xgroup(
    cmd: string,
    key: string,
    group: string,
    _from: string,
    mkstream?: string,
  ): Promise<'OK'> {
    if (cmd === 'CREATE') {
      if (mkstream === 'MKSTREAM' && !this.streams.has(key)) {
        this.streams.set(key, []);
      }
      if (!this.groups.has(key)) this.groups.set(key, new Map());
      const keyGroups = this.groups.get(key)!;
      if (!keyGroups.has(group)) keyGroups.set(group, new Map());
      return 'OK';
    }
    throw new Error(`xgroup ${cmd} not implemented in mock`);
  }

  async xreadgroup(
    _GROUP: string,
    group: string,
    consumer: string,
    _COUNT: string,
    count: string,
    _STREAMS: string,
    key: string,
    _from: string,
  ): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    const stream = this.streams.get(key) ?? [];
    const groupMap = this.groups.get(key)?.get(group);
    if (!groupMap) return null;

    const consumerPending = groupMap.get(consumer) ?? new Set<string>();
    groupMap.set(consumer, consumerPending);

    // Collect all ids already pending to any consumer
    const allPending = new Set<string>();
    for (const pending of groupMap.values()) {
      for (const id of pending) allPending.add(id);
    }

    const available = stream.filter((e) => !allPending.has(e.id));
    const batch = available.slice(0, parseInt(count, 10));
    for (const e of batch) consumerPending.add(e.id);

    if (batch.length === 0) return null;
    return [[key, batch.map((e) => [e.id, e.fields])]];
  }

  async xack(key: string, group: string, ...ids: string[]): Promise<number> {
    const groupMap = this.groups.get(key)?.get(group);
    if (!groupMap) return 0;
    let count = 0;
    for (const [, pending] of groupMap) {
      for (const id of ids) {
        if (pending.delete(id)) count++;
      }
    }
    return count;
  }

  async xpending(
    key: string,
    group: string,
    _start: string,
    _end: string,
    count: number,
  ): Promise<Array<[string, string, number, number]>> {
    const groupMap = this.groups.get(key)?.get(group);
    if (!groupMap) return [];
    const result: Array<[string, string, number, number]> = [];
    for (const [consumer, pending] of groupMap) {
      for (const id of pending) {
        if (result.length >= count) break;
        result.push([id, consumer, 0, 1]);
      }
    }
    return result;
  }

  async xclaim(
    _key: string,
    _group: string,
    _consumer: string,
    _minIdle: number,
    ..._ids: string[]
  ): Promise<any[]> {
    return [];
  }

  // ── Sets ─────────────────────────────────────────────────────────────────

  async sadd(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        added++;
      }
    }
    this.sets.set(key, s);
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set())];
  }

  // ── Sorted Sets / Pipeline ────────────────────────────────────────────────

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    return 1;
  }

  async duplicate(): Promise<RedisMock> {
    return this;
  }

  pipeline() {
    const ops: Array<() => Promise<any>> = [];
    const pipe: any = {
      zremrangebyscore: (key: string, min: number, max: number) => {
        ops.push(async () => {
          const zset = this.zsets.get(key) ?? new Map();
          for (const [m, s] of zset) if (s >= min && s <= max) zset.delete(m);
          this.zsets.set(key, zset);
          return 0;
        });
        return pipe;
      },
      zcard: (key: string) => {
        ops.push(async () => (this.zsets.get(key) ?? new Map()).size);
        return pipe;
      },
      zadd: (key: string, score: number, member: string) => {
        ops.push(async () => {
          const zset = this.zsets.get(key) ?? new Map();
          zset.set(member, score);
          this.zsets.set(key, zset);
          return 1;
        });
        return pipe;
      },
      expire: () => {
        ops.push(async () => 1);
        return pipe;
      },
      exec: async () => {
        const results: Array<[null, any]> = [];
        for (const op of ops) results.push([null, await op()]);
        return results;
      },
    };
    return pipe;
  }
}

// ─── Repo factory ──────────────────────────────────────────────────────────────

function makeInsertQb() {
  const qb: any = {
    insert: jest.fn().mockReturnThis(),
    into: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    onConflict: jest.fn().mockReturnThis(),
    orIgnore: jest.fn().mockReturnThis(),
    returning: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ raw: [], identifiers: [] }),
  };
  return qb;
}

function makeSelectQb(rows: any[] = []) {
  const qb: any = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
    getOne: jest.fn().mockResolvedValue(rows[0] ?? null),
  };
  return qb;
}

function makeRepo(overrides: Partial<any> = {}) {
  const insertQb = makeInsertQb();
  const selectQb = makeSelectQb();
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn((v: any) => v),
    delete: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(insertQb),
    _insertQb: insertQb,
    _selectQb: selectQb,
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ChatService', () => {
  let service: ChatService;
  let redis: RedisMock;
  let messagesRepo: ReturnType<typeof makeRepo>;
  let reactionsRepo: ReturnType<typeof makeRepo>;
  let participantsRepo: ReturnType<typeof makeRepo>;
  let communityMembersRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    redis = new RedisMock();
    messagesRepo = makeRepo();
    reactionsRepo = makeRepo();
    participantsRepo = makeRepo();
    communityMembersRepo = makeRepo();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: getRepositoryToken(ChatMessage), useValue: messagesRepo },
        {
          provide: getRepositoryToken(MessageReaction),
          useValue: reactionsRepo,
        },
        {
          provide: getRepositoryToken(TripParticipant),
          useValue: participantsRepo,
        },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembersRepo,
        },
        { provide: CHAT_REDIS, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(ChatService);
    jest.clearAllMocks();
  });

  // ── checkRoomAccess ──────────────────────────────────────────────────────────

  describe('checkRoomAccess', () => {
    it('returns false for unknown room_type', async () => {
      expect(await service.checkRoomAccess('user-1', 'unknown', 'room-1')).toBe(
        false,
      );
    });

    it('returns true for community room when user is a member', async () => {
      communityMembersRepo.findOne.mockResolvedValue({ user_id: 'user-1', community_id: 'comm-1' });
      expect(
        await service.checkRoomAccess('user-1', 'community', 'comm-1'),
      ).toBe(true);
    });

    it('returns false for community room when user is not a member', async () => {
      communityMembersRepo.findOne.mockResolvedValue(null);
      expect(
        await service.checkRoomAccess('user-1', 'community', 'comm-1'),
      ).toBe(false);
    });

    it('caches community result for 5 min (300s)', async () => {
      communityMembersRepo.findOne.mockResolvedValue({ user_id: 'user-1', community_id: 'comm-1' });
      await service.checkRoomAccess('user-1', 'community', 'comm-1');
      const entry = redis.store.get('chat:access:community:comm-1:user-1');
      expect(entry?.expiresAt).toBeGreaterThan(Date.now() + 290_000);
    });

    it('caches denied result for only 30s (FIX #10)', async () => {
      participantsRepo.findOne.mockResolvedValue(null);
      await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      const entry = redis.store.get('chat:access:trip:trip-1:user-1');
      // TTL should be ~30s, not ~300s
      expect(entry?.expiresAt).toBeLessThan(Date.now() + 35_000);
      expect(entry?.expiresAt).toBeGreaterThan(Date.now() + 25_000);
    });

    it('returns true for approved trip participant', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      expect(await service.checkRoomAccess('user-1', 'trip', 'trip-1')).toBe(
        true,
      );
    });

    it('returns false when participant not found', async () => {
      participantsRepo.findOne.mockResolvedValue(null);
      expect(await service.checkRoomAccess('user-1', 'trip', 'trip-1')).toBe(
        false,
      );
    });

    it('uses cache on second call', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      expect(participantsRepo.findOne).toHaveBeenCalledTimes(1);
    });
  });

  // ── invalidateRoomAccessCache ────────────────────────────────────────────────

  describe('invalidateRoomAccessCache', () => {
    it('forces DB re-check after invalidation', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      await service.invalidateRoomAccessCache('user-1', 'trip', 'trip-1');
      await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      expect(participantsRepo.findOne).toHaveBeenCalledTimes(2);
    });
  });

  // ── checkRateLimit ────────────────────────────────────────────────────────────

  describe('checkRateLimit', () => {
    it('allows 60 reactions', async () => {
      for (let i = 0; i < 60; i++)
        expect(await service.checkRateLimit('user-1', 'react')).toBe(true);
    });

    it('rejects the 61st reaction', async () => {
      for (let i = 0; i < 60; i++)
        await service.checkRateLimit('user-1', 'react');
      expect(await service.checkRateLimit('user-1', 'react')).toBe(false);
    });

    it('limits are per-user', async () => {
      for (let i = 0; i < 60; i++)
        await service.checkRateLimit('user-1', 'react');
      expect(await service.checkRateLimit('user-1', 'react')).toBe(false);
      expect(await service.checkRateLimit('user-2', 'react')).toBe(true);
    });
  });

  // ── checkFloodControl (FIX #4) ────────────────────────────────────────────────

  describe('checkFloodControl', () => {
    it('allows up to 10 sends per second', async () => {
      for (let i = 0; i < 10; i++)
        expect(await service.checkFloodControl('user-1')).toBe(true);
    });

    it('blocks the 11th send within the same second', async () => {
      for (let i = 0; i < 10; i++) await service.checkFloodControl('user-1');
      expect(await service.checkFloodControl('user-1')).toBe(false);
    });

    it('flood limits are per-user', async () => {
      for (let i = 0; i < 10; i++) await service.checkFloodControl('user-1');
      expect(await service.checkFloodControl('user-1')).toBe(false);
      expect(await service.checkFloodControl('user-2')).toBe(true);
    });
  });

  // ── queueMessage (Redis Streams, FIX #5 + #6) ────────────────────────────────

  describe('queueMessage', () => {
    const dto = {
      room_type: 'trip' as const,
      room_id: 'trip-1',
      content: 'Hello',
    };

    it('returns formatted message immediately without DB save', async () => {
      const result = await service.queueMessage(makeUser(), dto);
      expect(result.content).toBe('Hello');
      expect(result.room_type).toBe('trip');
      expect(result.reactions).toEqual({});
      expect(messagesRepo.save).not.toHaveBeenCalled();
    });

    it('writes to per-room stream key (FIX #6 — no global hot key)', async () => {
      await service.queueMessage(makeUser(), dto);
      const expectedKey = chatStreamKey('trip', 'trip-1');
      const stream = redis.streams.get(expectedKey);
      expect(stream).toHaveLength(1);
      // Verify different rooms go to different keys
      await service.queueMessage(makeUser(), { ...dto, room_id: 'trip-2' });
      expect(redis.streams.get(chatStreamKey('trip', 'trip-2'))).toHaveLength(
        1,
      );
      expect(redis.streams.get(chatStreamKey('trip', 'trip-1'))).toHaveLength(
        1,
      ); // unchanged
    });

    it('assigns a stable UUID consistent between broadcast and DB write', async () => {
      const result = await service.queueMessage(makeUser(), dto);
      const streamKey = chatStreamKey('trip', 'trip-1');
      const entry = redis.streams.get(streamKey)![0];
      const dataIdx = entry.fields.indexOf('data');
      const q: QueuedMessage = JSON.parse(entry.fields[dataIdx + 1]);
      expect(q.id).toBe(result.id);
    });

    it('sanitizes HTML in content', async () => {
      const result = await service.queueMessage(makeUser(), {
        ...dto,
        content: '<script>xss</script>',
      });
      expect(result.content).not.toContain('<script>');
    });

    it('resolves reply_to from in-flight Redis stream (FIX #1)', async () => {
      // First message not yet in Postgres
      const first = await service.queueMessage(makeUser({ name: 'Bob' }), dto);
      messagesRepo.findOne.mockResolvedValue(null); // Postgres doesn't have it yet

      const reply = await service.queueMessage(makeUser(), {
        ...dto,
        reply_to_id: first.id,
      });
      expect(reply.reply_to).not.toBeNull();
      expect(reply.reply_to!.id).toBe(first.id);
      expect(reply.reply_to!.sender_name).toBe('Bob');
    });

    it('falls back to Postgres for reply_to when not in stream', async () => {
      const parent = makeMessage({ id: 'old-msg', isDeleted: false });
      parent.sender = makeUser({ name: 'Charlie' });
      messagesRepo.findOne.mockResolvedValue(parent);

      const result = await service.queueMessage(makeUser(), {
        ...dto,
        reply_to_id: 'old-msg',
      });
      expect(result.reply_to?.sender_name).toBe('Charlie');
    });

    it('sets reply_to to null if parent is deleted', async () => {
      messagesRepo.findOne.mockResolvedValue(makeMessage({ isDeleted: true }));
      const result = await service.queueMessage(makeUser(), {
        ...dto,
        reply_to_id: 'gone',
      });
      expect(result.reply_to).toBeNull();
    });
  });

  // ── flushStream (FIX #5) ───────────────────────────────────────────────────────

  describe('flushStream', () => {
    const streamKey = chatStreamKey('trip', 'trip-1');

    async function seedMessages(count: number) {
      // Ensure consumer group exists
      await service.ensureConsumerGroup(streamKey);
      for (let i = 0; i < count; i++) {
        await service.queueMessage(makeUser(), {
          room_type: 'trip',
          room_id: 'trip-1',
          content: `msg ${i}`,
        });
      }
    }

    it('returns 0 and skips DB when stream is empty', async () => {
      await service.ensureConsumerGroup(streamKey);
      const flushed = await service.flushStream(streamKey, 'w1');
      expect(flushed).toBe(0);
    });

    it('inserts messages in a single batch query', async () => {
      await seedMessages(3);
      const flushed = await service.flushStream(streamKey, 'w1');
      expect(flushed).toBe(3);
      expect(messagesRepo._insertQb.values).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ roomType: 'trip' })]),
      );
    });

    it('ACKs entries after successful INSERT (FIX #5)', async () => {
      await seedMessages(2);
      await service.flushStream(streamKey, 'w1');
      // After ACK, no pending entries
      const pending = await redis.xpending(
        streamKey,
        CHAT_STREAM_GROUP,
        '-',
        '+',
        10,
      );
      expect(pending).toHaveLength(0);
    });

    it('does NOT remove entries before INSERT succeeds', async () => {
      await seedMessages(2);
      messagesRepo._insertQb.execute.mockRejectedValueOnce(
        new Error('DB down'),
      );
      await expect(service.flushStream(streamKey, 'w1')).rejects.toThrow(
        'DB down',
      );
      // Entries still in PEL — recoverable
      const pending = await redis.xpending(
        streamKey,
        CHAT_STREAM_GROUP,
        '-',
        '+',
        10,
      );
      expect(pending.length).toBeGreaterThan(0);
    });

    it('respects batchSize', async () => {
      await seedMessages(10);
      const flushed = await service.flushStream(streamKey, 'w1', 3);
      expect(flushed).toBe(3);
    });

    it('uses orIgnore for idempotent retries', async () => {
      await seedMessages(1);
      await service.flushStream(streamKey, 'w1');
      expect(messagesRepo._insertQb.orIgnore).toHaveBeenCalled();
    });

    it('preserves per-message createdAt timestamps (FIX #2)', async () => {
      await seedMessages(2);
      await service.flushStream(streamKey, 'w1');
      const insertedValues = messagesRepo._insertQb.values.mock.calls[0][0];
      // Each message should have its own Date object, not the same DB timestamp
      const timestamps = insertedValues.map((v: any) =>
        v.createdAt?.getTime?.(),
      );
      expect(timestamps[0]).toBeDefined();
      expect(timestamps[1]).toBeDefined();
    });
  });

  // ── getHistory cursor pagination (FIX #2) ────────────────────────────────────

  describe('getHistory', () => {
    it('throws ForbiddenException for non-member', async () => {
      participantsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.getHistory('user-1', 'trip', 'trip-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('uses compound cursor (createdAt, id) to prevent pagination skips (FIX #2)', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      const cursor = makeMessage({
        id: 'c1',
        createdAt: new Date('2024-01-01T12:00:00Z'),
      });
      messagesRepo.findOne.mockResolvedValueOnce(cursor);

      const selectQb = makeSelectQb([]);
      messagesRepo.createQueryBuilder.mockReturnValue(selectQb);
      reactionsRepo.find = jest.fn().mockResolvedValue([]);

      await service.getHistory('user-1', 'trip', 'trip-1', 'c1');

      expect(selectQb.andWhere).toHaveBeenCalledWith(
        '(m.createdAt < :cursorTime OR (m.createdAt = :cursorTime AND m.id < :cursorId))',
        expect.objectContaining({
          cursorTime: cursor.createdAt,
          cursorId: 'c1',
        }),
      );
    });

    it('uses addOrderBy for compound sort', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      const selectQb = makeSelectQb([]);
      messagesRepo.createQueryBuilder.mockReturnValue(selectQb);
      reactionsRepo.find = jest.fn().mockResolvedValue([]);

      await service.getHistory('user-1', 'trip', 'trip-1');
      expect(selectQb.addOrderBy).toHaveBeenCalledWith('m.id', 'DESC');
    });

    it('caps limit at 100', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      const selectQb = makeSelectQb([]);
      messagesRepo.createQueryBuilder.mockReturnValue(selectQb);
      reactionsRepo.find = jest.fn().mockResolvedValue([]);

      await service.getHistory('user-1', 'trip', 'trip-1', undefined, 999);
      expect(selectQb.limit).toHaveBeenCalledWith(100);
    });
  });

  // ── toggleReaction (FIX #3 + #7) ─────────────────────────────────────────────

  describe('toggleReaction', () => {
    it('throws NotFoundException when message not found', async () => {
      messagesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.toggleReaction('user-1', 'bad-id', '👍'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('adds reaction using INSERT ON CONFLICT DO NOTHING (FIX #3)', async () => {
      messagesRepo.findOne.mockResolvedValue(
        makeMessage({ roomType: 'trip', roomId: 'trip-1' }),
      );
      reactionsRepo._insertQb.execute.mockResolvedValue({
        raw: [{ id: 'r1' }],
      });
      reactionsRepo.find.mockResolvedValue([
        { emoji: '👍', userId: 'user-1', messageId: 'msg-1' },
      ]);

      const result = await service.toggleReaction('user-1', 'msg-1', '👍');
      expect(reactionsRepo._insertQb.onConflict).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT'),
      );
      expect(result.reactions['👍']).toContain('user-1');
    });

    it('removes reaction when INSERT returns empty (toggle off, FIX #3)', async () => {
      messagesRepo.findOne.mockResolvedValue(
        makeMessage({ roomType: 'trip', roomId: 'trip-1' }),
      );
      reactionsRepo._insertQb.execute.mockResolvedValue({ raw: [] }); // conflict = exists
      reactionsRepo.delete.mockResolvedValue({});
      reactionsRepo.find.mockResolvedValue([]);

      const result = await service.toggleReaction('user-1', 'msg-1', '👍');
      expect(reactionsRepo.delete).toHaveBeenCalledWith({
        messageId: 'msg-1',
        userId: 'user-1',
        emoji: '👍',
      });
      expect(result.reactions['👍']).toBeUndefined();
    });

    it('uses cached message room to skip DB SELECT (FIX #7)', async () => {
      // Prime the cache
      await redis.set(
        'chat:msg:room:msg-1',
        JSON.stringify({ roomType: 'trip', roomId: 'trip-1' }),
      );
      reactionsRepo._insertQb.execute.mockResolvedValue({
        raw: [{ id: 'r1' }],
      });
      reactionsRepo.find.mockResolvedValue([]);

      await service.toggleReaction('user-1', 'msg-1', '👍');
      // messagesRepo.findOne should NOT be called — used cache
      expect(messagesRepo.findOne).not.toHaveBeenCalled();
    });
  });

  // ── getMessageRoom cache (FIX #7) ─────────────────────────────────────────────

  describe('getMessageRoom', () => {
    it('caches result after first DB call', async () => {
      messagesRepo.findOne.mockResolvedValue(
        makeMessage({ roomType: 'trip', roomId: 'trip-1' }),
      );
      await service.getMessageRoom('msg-1');
      await service.getMessageRoom('msg-1');
      expect(messagesRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('returns null for non-existent message', async () => {
      messagesRepo.findOne.mockResolvedValue(null);
      expect(await service.getMessageRoom('bad-id')).toBeNull();
    });
  });

  // ── ensureConsumerGroup ────────────────────────────────────────────────────────

  describe('ensureConsumerGroup', () => {
    it('creates consumer group without throwing', async () => {
      const key = chatStreamKey('trip', 'new-trip');
      await expect(service.ensureConsumerGroup(key)).resolves.not.toThrow();
    });

    it('is idempotent — safe to call multiple times', async () => {
      const key = chatStreamKey('trip', 'trip-1');
      await service.ensureConsumerGroup(key);
      await expect(service.ensureConsumerGroup(key)).resolves.not.toThrow();
    });
  });
});
