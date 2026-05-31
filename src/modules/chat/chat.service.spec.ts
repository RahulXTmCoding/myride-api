import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ChatService, CHAT_REDIS } from './chat.service';
import { ChatMessage } from './entities/chat-message.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<any> = {}) {
  return { id: 'user-1', name: 'Alice', profile_photo_url: null, ...overrides } as any;
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

// ─── Redis Mock (pipeline + sorted set support) ────────────────────────────────

class RedisMock {
  store = new Map<string, { value: string; expiresAt?: number }>();
  // sorted sets: key → Map<member, score>
  zsets = new Map<string, Map<string, number>>();
  published: Array<{ channel: string; message: string }> = [];

  private now() { return Date.now(); }

  private purge(key: string) {
    const e = this.store.get(key);
    if (e?.expiresAt !== undefined && e.expiresAt <= this.now()) this.store.delete(key);
  }

  async get(key: string): Promise<string | null> {
    this.purge(key);
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, _mode?: string, ttl?: number): Promise<'OK'> {
    const expiresAt = ttl ? this.now() + ttl * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    this.store.delete(key);
    this.zsets.delete(key);
    return 1;
  }

  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    return 1;
  }

  async duplicate(): Promise<RedisMock> { return this; }

  pipeline() {
    const ops: Array<() => Promise<any>> = [];
    const pipe: any = {
      zremrangebyscore: (key: string, min: number, max: number) => {
        ops.push(async () => {
          const zset = this.zsets.get(key) ?? new Map();
          for (const [member, score] of zset) {
            if (score >= min && score <= max) zset.delete(member);
          }
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
      expire: (_key: string, _ttl: number) => {
        ops.push(async () => 1);
        return pipe;
      },
      exec: async () => {
        const results: Array<[null, any]> = [];
        for (const op of ops) {
          results.push([null, await op()]);
        }
        return results;
      },
    };
    return pipe;
  }
}

// ─── Repository Factories ──────────────────────────────────────────────────────

function makeQb(rows: any[] = []) {
  const qb: any = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  return qb;
}

function makeRepo(overrides: Partial<any> = {}) {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn((v: any) => v),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(),
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

  beforeEach(async () => {
    redis = new RedisMock();
    messagesRepo = makeRepo();
    reactionsRepo = makeRepo();
    participantsRepo = makeRepo();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: getRepositoryToken(ChatMessage), useValue: messagesRepo },
        { provide: getRepositoryToken(MessageReaction), useValue: reactionsRepo },
        { provide: getRepositoryToken(TripParticipant), useValue: participantsRepo },
        { provide: CHAT_REDIS, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(ChatService);
    jest.clearAllMocks();
  });

  // ── checkRoomAccess ──────────────────────────────────────────────────────────

  describe('checkRoomAccess', () => {
    it('returns false for unknown room_type', async () => {
      const result = await service.checkRoomAccess('user-1', 'unknown', 'room-1');
      expect(result).toBe(false);
    });

    it('returns true for community room (placeholder: all authenticated users)', async () => {
      const result = await service.checkRoomAccess('user-1', 'community', 'comm-1');
      expect(result).toBe(true);
      // Should be cached
      const cached = await redis.get('chat:access:community:comm-1:user-1');
      expect(cached).toBe('1');
    });

    it('returns true for trip when participant is approved', async () => {
      participantsRepo.findOne.mockResolvedValue({ id: 'p1', status: 'approved' });
      const result = await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      expect(result).toBe(true);
    });

    it('returns false for trip when user is not a participant', async () => {
      participantsRepo.findOne.mockResolvedValue(null);
      const result = await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      expect(result).toBe(false);
    });

    it('returns false for trip when participant status is not approved (e.g. pending)', async () => {
      // findOne with status='approved' filter returns null for pending participants
      participantsRepo.findOne.mockResolvedValue(null);
      const result = await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      expect(result).toBe(false);
    });

    it('returns cached result without hitting DB on second call', async () => {
      participantsRepo.findOne.mockResolvedValue({ id: 'p1', status: 'approved' });
      await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      // DB should only be hit once
      expect(participantsRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('returns cached false result without hitting DB', async () => {
      participantsRepo.findOne.mockResolvedValue(null);
      await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      await service.checkRoomAccess('user-1', 'trip', 'trip-1');
      expect(participantsRepo.findOne).toHaveBeenCalledTimes(1);
    });
  });

  // ── invalidateRoomAccessCache ────────────────────────────────────────────────

  describe('invalidateRoomAccessCache', () => {
    it('deletes the cache key so next call hits DB', async () => {
      participantsRepo.findOne.mockResolvedValue({ id: 'p1', status: 'approved' });
      await service.checkRoomAccess('user-1', 'trip', 'trip-1'); // populates cache
      await service.invalidateRoomAccessCache('user-1', 'trip', 'trip-1'); // bust cache
      await service.checkRoomAccess('user-1', 'trip', 'trip-1'); // should hit DB again
      expect(participantsRepo.findOne).toHaveBeenCalledTimes(2);
    });
  });

  // ── checkRateLimit ────────────────────────────────────────────────────────────

  describe('checkRateLimit', () => {
    it('allows first 30 sends per user per room', async () => {
      for (let i = 0; i < 30; i++) {
        const result = await service.checkRateLimit('user-1', 'send', 'room-1');
        expect(result).toBe(true);
      }
    });

    it('rejects the 31st send in the same window', async () => {
      for (let i = 0; i < 30; i++) {
        await service.checkRateLimit('user-1', 'send', 'room-1');
      }
      const result = await service.checkRateLimit('user-1', 'send', 'room-1');
      expect(result).toBe(false);
    });

    it('allows first 60 reacts per user (no room scoping)', async () => {
      for (let i = 0; i < 60; i++) {
        const result = await service.checkRateLimit('user-1', 'react');
        expect(result).toBe(true);
      }
    });

    it('rejects the 61st reaction', async () => {
      for (let i = 0; i < 60; i++) {
        await service.checkRateLimit('user-1', 'react');
      }
      const result = await service.checkRateLimit('user-1', 'react');
      expect(result).toBe(false);
    });

    it('limits are per-room for send (user-1/room-1 vs user-1/room-2 are independent)', async () => {
      for (let i = 0; i < 30; i++) {
        await service.checkRateLimit('user-1', 'send', 'room-1');
      }
      // Exhausted room-1 limit
      expect(await service.checkRateLimit('user-1', 'send', 'room-1')).toBe(false);
      // room-2 is independent — should still be allowed
      expect(await service.checkRateLimit('user-1', 'send', 'room-2')).toBe(true);
    });

    it('limits are per-user for send (user-1/room-1 vs user-2/room-1 are independent)', async () => {
      for (let i = 0; i < 30; i++) {
        await service.checkRateLimit('user-1', 'send', 'room-1');
      }
      expect(await service.checkRateLimit('user-1', 'send', 'room-1')).toBe(false);
      expect(await service.checkRateLimit('user-2', 'send', 'room-1')).toBe(true);
    });
  });

  // ── saveMessage ────────────────────────────────────────────────────────────────

  describe('saveMessage', () => {
    const dto = { room_type: 'trip' as const, room_id: 'trip-1', content: 'Hello' };

    it('saves and returns formatted message', async () => {
      const saved = makeMessage({ id: 'new-msg', content: 'Hello' });
      messagesRepo.save.mockResolvedValue(saved);
      reactionsRepo.find = jest.fn().mockResolvedValue([]);

      const result = await service.saveMessage(makeUser(), dto);
      expect(result.content).toBe('Hello');
      expect(result.room_type).toBe('trip');
      expect(result.room_id).toBe('trip-1');
    });

    it('sanitizes HTML in content', async () => {
      const saved = makeMessage({ content: '&lt;script&gt;alert(1)&lt;/script&gt;' });
      messagesRepo.save.mockResolvedValue(saved);

      const result = await service.saveMessage(makeUser(), {
        ...dto,
        content: '<script>alert(1)</script>',
      });
      expect(result.content).not.toContain('<script>');
    });

    it('trims whitespace from content', async () => {
      messagesRepo.save.mockImplementation((msg: any) => Promise.resolve({ ...makeMessage(), content: msg.content }));

      const result = await service.saveMessage(makeUser(), {
        ...dto,
        content: '   hello   ',
      });
      // html-entities will encode the trimmed string
      expect(result.content.trim()).toBeTruthy();
      expect(messagesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.not.stringContaining('   hello') }),
      );
    });

    it('builds reply_to snapshot from parent message', async () => {
      const parent = makeMessage({ id: 'parent-1', content: 'Parent content', isDeleted: false });
      parent.sender = makeUser({ name: 'Bob' });
      messagesRepo.findOne.mockResolvedValueOnce(parent);
      messagesRepo.save.mockImplementation((msg: any) =>
        Promise.resolve({ ...makeMessage(), replyTo: msg.replyTo }),
      );

      const result = await service.saveMessage(makeUser(), {
        ...dto,
        reply_to_id: 'parent-1',
      });
      expect(result.reply_to).toMatchObject({
        id: 'parent-1',
        content: 'Parent content',
        sender_name: 'Bob',
      });
    });

    it('ignores reply_to if parent message is deleted', async () => {
      const parent = makeMessage({ id: 'parent-1', isDeleted: true });
      messagesRepo.findOne.mockResolvedValueOnce(parent);
      messagesRepo.save.mockImplementation((msg: any) =>
        Promise.resolve({ ...makeMessage(), replyTo: msg.replyTo }),
      );

      const result = await service.saveMessage(makeUser(), {
        ...dto,
        reply_to_id: 'parent-1',
      });
      expect(result.reply_to).toBeNull();
    });

    it('ignores reply_to if parent message does not exist', async () => {
      messagesRepo.findOne.mockResolvedValueOnce(null);
      messagesRepo.save.mockImplementation((msg: any) =>
        Promise.resolve({ ...makeMessage(), replyTo: msg.replyTo }),
      );

      const result = await service.saveMessage(makeUser(), {
        ...dto,
        reply_to_id: 'non-existent',
      });
      expect(result.reply_to).toBeNull();
    });

    it('truncates parent content to 200 chars in snapshot', async () => {
      const longContent = 'A'.repeat(300);
      const parent = makeMessage({ id: 'parent-1', content: longContent, isDeleted: false });
      messagesRepo.findOne.mockResolvedValueOnce(parent);
      messagesRepo.save.mockImplementation((msg: any) =>
        Promise.resolve({ ...makeMessage(), replyTo: msg.replyTo }),
      );

      await service.saveMessage(makeUser(), { ...dto, reply_to_id: 'parent-1' });

      const savedCall = messagesRepo.save.mock.calls[0][0];
      expect(savedCall.replyTo.content.length).toBeLessThanOrEqual(200);
    });
  });

  // ── getHistory ─────────────────────────────────────────────────────────────────

  describe('getHistory', () => {
    it('throws ForbiddenException if user is not a room member', async () => {
      participantsRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getHistory('user-1', 'trip', 'trip-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns formatted messages in ascending order (oldest first)', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      const msgs = [
        makeMessage({ id: 'msg-1', createdAt: new Date('2024-01-01T00:00:02Z') }),
        makeMessage({ id: 'msg-2', createdAt: new Date('2024-01-01T00:00:01Z') }),
      ];
      const qb = makeQb(msgs);
      messagesRepo.createQueryBuilder.mockReturnValue(qb);
      reactionsRepo.find.mockResolvedValue([]);

      const result = await service.getHistory('user-1', 'trip', 'trip-1');
      // reverse() is called inside getHistory — oldest first
      expect(result[0].id).toBe('msg-2');
      expect(result[1].id).toBe('msg-1');
    });

    it('uses cursor when before param is provided', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      const cursor = makeMessage({ id: 'cursor-msg', createdAt: new Date('2024-01-01T12:00:00Z') });
      messagesRepo.findOne.mockResolvedValueOnce(cursor);

      const qb = makeQb([]);
      messagesRepo.createQueryBuilder.mockReturnValue(qb);
      reactionsRepo.find.mockResolvedValue([]);

      await service.getHistory('user-1', 'trip', 'trip-1', 'cursor-msg');
      expect(qb.andWhere).toHaveBeenCalledWith(
        'm.createdAt < :cursorTime',
        expect.objectContaining({ cursorTime: cursor.createdAt }),
      );
    });

    it('skips cursor filter if cursor message not found', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      messagesRepo.findOne.mockResolvedValueOnce(null);
      const qb = makeQb([]);
      messagesRepo.createQueryBuilder.mockReturnValue(qb);
      reactionsRepo.find.mockResolvedValue([]);

      await service.getHistory('user-1', 'trip', 'trip-1', 'bad-cursor');
      expect(qb.andWhere).not.toHaveBeenCalledWith(
        'm.createdAt < :cursorTime',
        expect.anything(),
      );
    });

    it('caps limit at 100', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      const qb = makeQb([]);
      messagesRepo.createQueryBuilder.mockReturnValue(qb);
      reactionsRepo.find.mockResolvedValue([]);

      await service.getHistory('user-1', 'trip', 'trip-1', undefined, 999);
      expect(qb.limit).toHaveBeenCalledWith(100);
    });

    it('does not query reactions when no messages returned', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      const qb = makeQb([]);
      messagesRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getHistory('user-1', 'trip', 'trip-1');
      expect(reactionsRepo.find).not.toHaveBeenCalled();
    });

    it('returns hidden content for deleted messages', async () => {
      participantsRepo.findOne.mockResolvedValue({ status: 'approved' });
      const msgs = [makeMessage({ id: 'msg-1', isDeleted: true, content: 'secret' })];
      const qb = makeQb(msgs);
      messagesRepo.createQueryBuilder.mockReturnValue(qb);
      reactionsRepo.find.mockResolvedValue([]);

      const result = await service.getHistory('user-1', 'trip', 'trip-1');
      expect(result[0].content).toBe('This message was deleted.');
      expect(result[0].is_deleted).toBe(true);
    });
  });

  // ── toggleReaction ─────────────────────────────────────────────────────────────

  describe('toggleReaction', () => {
    it('throws NotFoundException when message does not exist', async () => {
      messagesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.toggleReaction('user-1', 'non-existent', '👍'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('adds a reaction when none exists', async () => {
      const msg = makeMessage();
      messagesRepo.findOne.mockResolvedValue(msg);
      reactionsRepo.findOne.mockResolvedValue(null); // no existing reaction
      reactionsRepo.save.mockResolvedValue({});
      reactionsRepo.find.mockResolvedValue([{ emoji: '👍', userId: 'user-1', messageId: 'msg-1' }]);

      const result = await service.toggleReaction('user-1', 'msg-1', '👍');
      expect(reactionsRepo.save).toHaveBeenCalled();
      expect(reactionsRepo.delete).not.toHaveBeenCalled();
      expect(result.reactions['👍']).toContain('user-1');
    });

    it('removes a reaction when it already exists (toggle off)', async () => {
      const msg = makeMessage();
      messagesRepo.findOne.mockResolvedValue(msg);
      reactionsRepo.findOne.mockResolvedValue({ id: 'r1', emoji: '👍', userId: 'user-1' });
      reactionsRepo.delete.mockResolvedValue({});
      reactionsRepo.find.mockResolvedValue([]); // after delete

      const result = await service.toggleReaction('user-1', 'msg-1', '👍');
      expect(reactionsRepo.delete).toHaveBeenCalledWith('r1');
      expect(reactionsRepo.save).not.toHaveBeenCalled();
      expect(result.reactions['👍']).toBeUndefined();
    });

    it('returns correct roomType and roomId from the message', async () => {
      const msg = makeMessage({ roomType: 'community', roomId: 'comm-1' });
      messagesRepo.findOne.mockResolvedValue(msg);
      reactionsRepo.findOne.mockResolvedValue(null);
      reactionsRepo.save.mockResolvedValue({});
      reactionsRepo.find.mockResolvedValue([]);

      const result = await service.toggleReaction('user-1', 'msg-1', '❤️');
      expect(result.roomType).toBe('community');
      expect(result.roomId).toBe('comm-1');
    });
  });

  // ── findMessageById ────────────────────────────────────────────────────────────

  describe('findMessageById', () => {
    it('returns message when found', async () => {
      const msg = makeMessage();
      messagesRepo.findOne.mockResolvedValue(msg);
      expect(await service.findMessageById('msg-1')).toEqual(msg);
    });

    it('returns null when message does not exist', async () => {
      messagesRepo.findOne.mockResolvedValue(null);
      expect(await service.findMessageById('bad-id')).toBeNull();
    });
  });

  // ── groupReactions / formatting ────────────────────────────────────────────────

  describe('reaction grouping', () => {
    it('groups multiple reactions by emoji', async () => {
      const msg = makeMessage();
      messagesRepo.findOne.mockResolvedValue(msg);
      reactionsRepo.findOne.mockResolvedValue(null);
      reactionsRepo.save.mockResolvedValue({});
      reactionsRepo.find.mockResolvedValue([
        { emoji: '👍', userId: 'user-1', messageId: 'msg-1' },
        { emoji: '👍', userId: 'user-2', messageId: 'msg-1' },
        { emoji: '❤️', userId: 'user-1', messageId: 'msg-1' },
      ]);

      const result = await service.toggleReaction('user-3', 'msg-1', '🔥');
      expect(result.reactions['👍']).toHaveLength(2);
      expect(result.reactions['❤️']).toHaveLength(1);
    });
  });
});
