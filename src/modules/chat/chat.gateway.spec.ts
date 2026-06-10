import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { ChatGateway } from './chat.gateway';
import { ChatService, CHAT_REDIS, CHAT_ADAPTER_REDIS } from './chat.service';
import { ChatFlushWorker } from './chat-flush.worker';
import { WsJwtGuard } from './guards/ws-jwt.guard';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSocket(userId = 'user-1', token = 'valid-token'): any {
  return {
    id: 'sock-1',
    rooms: new Set<string>(),
    data: { user: { sub: userId, name: 'Alice' } },
    handshake: { auth: { token }, query: {} },
    emit: jest.fn(),
    join: jest.fn().mockImplementation(async function (
      this: any,
      room: string,
    ) {
      this.rooms.add(room);
    }),
    leave: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    to: jest.fn().mockReturnThis(),
  };
}

function makeServer() {
  const server: any = {
    to: jest.fn().mockReturnThis(),
    emit: jest.fn(),
    in: jest.fn().mockReturnThis(),
    fetchSockets: jest.fn().mockResolvedValue([]),
    adapter: jest.fn(),
  };
  return server;
}

function makeChatService(): jest.Mocked<ChatService> {
  return {
    checkRoomAccess: jest.fn(),
    checkRateLimit: jest.fn(),
    checkFloodControl: jest.fn().mockResolvedValue(true),
    queueMessage: jest.fn(),
    findMessageById: jest.fn(),
    getMessageRoom: jest.fn(),
    getHistory: jest.fn(),
    toggleReaction: jest.fn(),
    getReactionsForMessage: jest.fn(),
    invalidateRoomAccessCache: jest.fn(),
    flushStream: jest.fn(),
    ensureConsumerGroup: jest.fn(),
  } as any;
}

function makeFlushWorker(): jest.Mocked<ChatFlushWorker> {
  return {
    registerStream: jest.fn().mockResolvedValue(undefined),
  } as any;
}

class RedisMock {
  async duplicate() {
    return new RedisMockSub();
  }
  on() {}
  pipeline() {
    return {
      zremrangebyscore: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        [null, 0],
        [null, 0],
      ]),
    };
  }
}

class RedisMockSub extends RedisMock {
  subscribe = jest.fn().mockResolvedValue(undefined);
  on = jest.fn();
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let chatService: jest.Mocked<ChatService>;
  let flushWorker: jest.Mocked<ChatFlushWorker>;
  let jwtService: jest.Mocked<JwtService>;
  let server: ReturnType<typeof makeServer>;

  beforeEach(async () => {
    chatService = makeChatService();
    flushWorker = makeFlushWorker();
    jwtService = { verify: jest.fn(), sign: jest.fn() } as any;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatGateway,
        { provide: ChatService, useValue: chatService },
        { provide: ChatFlushWorker, useValue: flushWorker },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-secret') },
        },
        { provide: CHAT_REDIS, useValue: new RedisMock() },
        { provide: CHAT_ADAPTER_REDIS, useValue: new RedisMock() },
      ],
    }).compile();

    gateway = moduleRef.get(ChatGateway);
    server = makeServer();
    gateway.server = server;
    jest.clearAllMocks();
    // Re-apply defaults after clearAllMocks
    chatService.checkFloodControl.mockResolvedValue(true);
  });

  // ── handleConnection ─────────────────────────────────────────────────────────

  describe('handleConnection', () => {
    it('disconnects with no token', async () => {
      const socket = makeSocket();
      socket.handshake = { auth: {}, query: {} };
      await gateway.handleConnection(socket);
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'UNAUTHENTICATED' }),
      );
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnects with invalid token', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('expired');
      });
      const socket = makeSocket();
      await gateway.handleConnection(socket);
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'TOKEN_INVALID' }),
      );
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('attaches user payload on valid token', async () => {
      const payload = { sub: 'user-1', name: 'Alice' };
      jwtService.verify.mockReturnValue(payload);
      const socket = makeSocket();
      socket.data = {};
      await gateway.handleConnection(socket);
      expect(socket.disconnect).not.toHaveBeenCalled();
      expect(socket.data.user).toEqual(payload);
    });
  });

  // ── handleJoin ────────────────────────────────────────────────────────────────

  describe('handleJoin', () => {
    it('denies join when not a room member', async () => {
      chatService.checkRoomAccess.mockResolvedValue(false);
      const socket = makeSocket();
      await gateway.handleJoin(socket, {
        room_type: 'trip',
        room_id: 'trip-1',
      });
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'ACCESS_DENIED' }),
      );
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('joins room and registers stream on success', async () => {
      chatService.checkRoomAccess.mockResolvedValue(true);
      const socket = makeSocket();
      await gateway.handleJoin(socket, {
        room_type: 'trip',
        room_id: 'trip-1',
      });
      expect(socket.join).toHaveBeenCalledWith('trip:trip-1');
      expect(socket.emit).toHaveBeenCalledWith('chat:joined', {
        room_type: 'trip',
        room_id: 'trip-1',
      });
      expect(flushWorker.registerStream).toHaveBeenCalledWith('trip', 'trip-1');
    });

    it('rejects invalid room_type', async () => {
      const socket = makeSocket();
      await gateway.handleJoin(socket, {
        room_type: 'invalid',
        room_id: 'room-1',
      });
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    });
  });

  // ── handleLeave ───────────────────────────────────────────────────────────────

  describe('handleLeave', () => {
    it('leaves room and emits chat:left', async () => {
      const socket = makeSocket();
      await gateway.handleLeave(socket, {
        room_type: 'trip',
        room_id: 'trip-1',
      });
      expect(socket.leave).toHaveBeenCalledWith('trip:trip-1');
      expect(socket.emit).toHaveBeenCalledWith('chat:left', {
        room_type: 'trip',
        room_id: 'trip-1',
      });
    });
  });

  // ── handleSend ────────────────────────────────────────────────────────────────

  describe('handleSend', () => {
    const dto = {
      room_type: 'trip' as const,
      room_id: 'trip-1',
      content: 'Hello',
    };

    it('emits FLOOD_CONTROL when flood limit exceeded (FIX #4)', async () => {
      chatService.checkFloodControl.mockResolvedValue(false);
      const socket = makeSocket();
      await gateway.handleSend(socket, dto);
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'FLOOD_CONTROL' }),
      );
      expect(chatService.checkRoomAccess).not.toHaveBeenCalled();
    });

    it('emits ACCESS_DENIED when not a room member', async () => {
      chatService.checkRoomAccess.mockResolvedValue(false);
      const socket = makeSocket();
      await gateway.handleSend(socket, dto);
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'ACCESS_DENIED' }),
      );
      expect(chatService.queueMessage).not.toHaveBeenCalled();
    });

    it('queues and broadcasts on success', async () => {
      chatService.checkRoomAccess.mockResolvedValue(true);
      const msg = {
        id: 'msg-1',
        room_type: 'trip',
        room_id: 'trip-1',
        content: 'Hello',
      };
      chatService.queueMessage.mockResolvedValue(msg as any);
      const socket = makeSocket();
      await gateway.handleSend(socket, dto);
      expect(server.to).toHaveBeenCalledWith('trip:trip-1');
      expect(server.emit).toHaveBeenCalledWith('chat:message', msg);
    });

    it('emits UNAUTHENTICATED with no user on socket', async () => {
      const socket = makeSocket();
      socket.data = {};
      await gateway.handleSend(socket, dto);
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'UNAUTHENTICATED' }),
      );
    });

    it('flood control is checked before access (cheap-first)', async () => {
      const callOrder: string[] = [];
      chatService.checkFloodControl.mockImplementation(async () => {
        callOrder.push('flood');
        return false;
      });
      chatService.checkRoomAccess.mockImplementation(async () => {
        callOrder.push('access');
        return true;
      });
      const socket = makeSocket();
      await gateway.handleSend(socket, dto);
      expect(callOrder).toEqual(['flood']); // access never reached
    });

    it('no send rate limit — checkRateLimit is never called for send', async () => {
      chatService.checkRoomAccess.mockResolvedValue(true);
      chatService.queueMessage.mockResolvedValue({ id: 'x' } as any);
      const socket = makeSocket();
      await gateway.handleSend(socket, dto);
      expect(chatService.checkRateLimit).not.toHaveBeenCalled();
    });
  });

  // ── handleReact ───────────────────────────────────────────────────────────────

  describe('handleReact', () => {
    const dto = { message_id: 'msg-1', emoji: '👍' };

    it('emits RATE_LIMITED when over limit', async () => {
      chatService.checkRateLimit.mockResolvedValue(false);
      const socket = makeSocket();
      await gateway.handleReact(socket, dto);
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'RATE_LIMITED' }),
      );
    });

    it('emits MESSAGE_NOT_FOUND when message does not exist', async () => {
      chatService.checkRateLimit.mockResolvedValue(true);
      chatService.getMessageRoom.mockResolvedValue(null);
      const socket = makeSocket();
      await gateway.handleReact(socket, dto);
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'MESSAGE_NOT_FOUND' }),
      );
    });

    it("verifies membership of the MESSAGE'S room (cross-room security)", async () => {
      chatService.checkRateLimit.mockResolvedValue(true);
      chatService.getMessageRoom.mockResolvedValue({
        roomType: 'trip',
        roomId: 'trip-2',
      });
      chatService.checkRoomAccess.mockResolvedValue(false);
      const socket = makeSocket();
      await gateway.handleReact(socket, dto);
      expect(chatService.checkRoomAccess).toHaveBeenCalledWith(
        'user-1',
        'trip',
        'trip-2',
      );
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'ACCESS_DENIED' }),
      );
    });

    it('uses getMessageRoom cache — no findMessageById call (FIX #7)', async () => {
      chatService.checkRateLimit.mockResolvedValue(true);
      chatService.getMessageRoom.mockResolvedValue({
        roomType: 'trip',
        roomId: 'trip-1',
      });
      chatService.checkRoomAccess.mockResolvedValue(true);
      chatService.toggleReaction.mockResolvedValue({
        roomType: 'trip',
        roomId: 'trip-1',
        reactions: {},
      });
      const socket = makeSocket();
      await gateway.handleReact(socket, dto);
      expect(chatService.findMessageById).not.toHaveBeenCalled();
    });

    it('broadcasts reaction_update to correct room', async () => {
      chatService.checkRateLimit.mockResolvedValue(true);
      chatService.getMessageRoom.mockResolvedValue({
        roomType: 'trip',
        roomId: 'trip-1',
      });
      chatService.checkRoomAccess.mockResolvedValue(true);
      chatService.toggleReaction.mockResolvedValue({
        roomType: 'trip',
        roomId: 'trip-1',
        reactions: { '👍': ['user-1'] },
      });
      const socket = makeSocket();
      await gateway.handleReact(socket, dto);
      expect(server.to).toHaveBeenCalledWith('trip:trip-1');
      expect(server.emit).toHaveBeenCalledWith(
        'chat:reaction_update',
        expect.objectContaining({ reactions: { '👍': ['user-1'] } }),
      );
    });
  });

  // ── handleTyping ──────────────────────────────────────────────────────────────

  describe('handleTyping', () => {
    it('silently drops when socket is not in the room (FIX UX#6 — no Redis call)', async () => {
      const socket = makeSocket();
      // socket.rooms does NOT contain the room key
      socket.rooms = new Set<string>();
      const toMock = jest.fn().mockReturnValue({ emit: jest.fn() });
      socket.to = toMock;

      await gateway.handleTyping(socket, {
        room_type: 'trip',
        room_id: 'trip-1',
      });

      expect(toMock).not.toHaveBeenCalled();
      // CRITICAL: no Redis access check at all for typing
      expect(chatService.checkRoomAccess).not.toHaveBeenCalled();
    });

    it('broadcasts to room when socket is joined', async () => {
      const socket = makeSocket();
      socket.rooms = new Set(['trip:trip-1']);
      const emitMock = jest.fn();
      socket.to = jest.fn().mockReturnValue({ emit: emitMock });

      await gateway.handleTyping(socket, {
        room_type: 'trip',
        room_id: 'trip-1',
      });

      expect(socket.to).toHaveBeenCalledWith('trip:trip-1');
      expect(emitMock).toHaveBeenCalledWith(
        'chat:typing',
        expect.objectContaining({ user_id: 'user-1' }),
      );
      // No Redis call
      expect(chatService.checkRoomAccess).not.toHaveBeenCalled();
    });

    it('silently drops for invalid room_type', async () => {
      const socket = makeSocket();
      socket.to = jest.fn();
      await gateway.handleTyping(socket, {
        room_type: 'invalid',
        room_id: 'room-1',
      });
      expect(socket.to).not.toHaveBeenCalled();
    });
  });
});
