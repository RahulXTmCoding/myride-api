/**
 * Unit tests for ChatGateway.
 *
 * Strategy: mock Socket, Server, ChatService, JwtService, ConfigService, Redis.
 * We call gateway methods directly (as NestJS/WS does) and assert:
 *  - what socket.emit / socket.disconnect receive
 *  - what server.to().emit receives
 *  - that guarded operations (rate limit, access) gate correctly
 */
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { ChatGateway } from './chat.gateway';
import { ChatService, CHAT_REDIS } from './chat.service';
import { WsJwtGuard } from './guards/ws-jwt.guard';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSocket(userId = 'user-1', token = 'valid-token'): any {
  return {
    id: 'sock-1',
    data: { user: { sub: userId, name: 'Alice' } },
    handshake: { auth: { token }, query: {} },
    emit: jest.fn(),
    join: jest.fn().mockResolvedValue(undefined),
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
    saveMessage: jest.fn(),
    findMessageById: jest.fn(),
    getHistory: jest.fn(),
    toggleReaction: jest.fn(),
    getReactionsForMessage: jest.fn(),
    invalidateRoomAccessCache: jest.fn(),
  } as any;
}

class RedisMock {
  async duplicate() { return this; }
  async subscribe() {}
  on() {}
  pipeline() {
    return {
      zremrangebyscore: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[null, 0], [null, 0]]),
    };
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let chatService: jest.Mocked<ChatService>;
  let jwtService: jest.Mocked<JwtService>;
  let server: ReturnType<typeof makeServer>;

  beforeEach(async () => {
    chatService = makeChatService();
    jwtService = {
      verify: jest.fn(),
      sign: jest.fn(),
    } as any;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ChatGateway,
        { provide: ChatService, useValue: chatService },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-secret') },
        },
        { provide: CHAT_REDIS, useValue: new RedisMock() },
      ],
    }).compile();

    gateway = moduleRef.get(ChatGateway);
    server = makeServer();
    gateway.server = server;
    jest.clearAllMocks();
  });

  // ── handleConnection ─────────────────────────────────────────────────────────

  describe('handleConnection', () => {
    it('disconnects socket with no token', async () => {
      const socket = makeSocket();
      socket.handshake = { auth: {}, query: {} };

      await gateway.handleConnection(socket);

      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'UNAUTHENTICATED' }),
      );
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('disconnects socket with invalid/expired token', async () => {
      jwtService.verify.mockImplementation(() => { throw new Error('expired'); });
      const socket = makeSocket();

      await gateway.handleConnection(socket);

      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'TOKEN_INVALID' }),
      );
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    });

    it('sets socket.data.user on valid token', async () => {
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
    it('denies join if user is not a room member', async () => {
      chatService.checkRoomAccess.mockResolvedValue(false);
      const socket = makeSocket();

      await gateway.handleJoin(socket, { room_type: 'trip', room_id: 'trip-1' });

      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'ACCESS_DENIED' }),
      );
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('joins room and emits chat:joined on success', async () => {
      chatService.checkRoomAccess.mockResolvedValue(true);
      const socket = makeSocket();

      await gateway.handleJoin(socket, { room_type: 'trip', room_id: 'trip-1' });

      expect(socket.join).toHaveBeenCalledWith('trip:trip-1');
      expect(socket.emit).toHaveBeenCalledWith('chat:joined', {
        room_type: 'trip',
        room_id: 'trip-1',
      });
    });

    it('rejects invalid room_type', async () => {
      const socket = makeSocket();

      await gateway.handleJoin(socket, { room_type: 'invalid', room_id: 'room-1' });

      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
      expect(socket.join).not.toHaveBeenCalled();
    });

    it('rejects when userId is missing from socket.data', async () => {
      const socket = makeSocket();
      socket.data = {};

      await gateway.handleJoin(socket, { room_type: 'trip', room_id: 'trip-1' });

      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    });
  });

  // ── handleLeave ───────────────────────────────────────────────────────────────

  describe('handleLeave', () => {
    it('leaves the room and emits chat:left', async () => {
      const socket = makeSocket();

      await gateway.handleLeave(socket, { room_type: 'trip', room_id: 'trip-1' });

      expect(socket.leave).toHaveBeenCalledWith('trip:trip-1');
      expect(socket.emit).toHaveBeenCalledWith('chat:left', {
        room_type: 'trip',
        room_id: 'trip-1',
      });
    });
  });

  // ── handleSend ────────────────────────────────────────────────────────────────

  describe('handleSend', () => {
    const dto = { room_type: 'trip' as const, room_id: 'trip-1', content: 'Hello' };

    it('emits RATE_LIMITED when rate limit is exceeded', async () => {
      chatService.checkRateLimit.mockResolvedValue(false);
      const socket = makeSocket();

      await gateway.handleSend(socket, dto);

      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'RATE_LIMITED' }),
      );
      expect(chatService.checkRoomAccess).not.toHaveBeenCalled();
      expect(chatService.saveMessage).not.toHaveBeenCalled();
    });

    it('emits ACCESS_DENIED when user is not a room member', async () => {
      chatService.checkRateLimit.mockResolvedValue(true);
      chatService.checkRoomAccess.mockResolvedValue(false);
      const socket = makeSocket();

      await gateway.handleSend(socket, dto);

      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'ACCESS_DENIED' }),
      );
      expect(chatService.saveMessage).not.toHaveBeenCalled();
    });

    it('saves message and broadcasts to room on success', async () => {
      chatService.checkRateLimit.mockResolvedValue(true);
      chatService.checkRoomAccess.mockResolvedValue(true);
      const savedMsg = { id: 'msg-1', room_type: 'trip', room_id: 'trip-1', content: 'Hello' };
      chatService.saveMessage.mockResolvedValue(savedMsg as any);
      const socket = makeSocket();

      await gateway.handleSend(socket, dto);

      expect(server.to).toHaveBeenCalledWith('trip:trip-1');
      expect(server.emit).toHaveBeenCalledWith('chat:message', savedMsg);
    });

    it('emits UNAUTHENTICATED when socket has no user', async () => {
      const socket = makeSocket();
      socket.data = {};

      await gateway.handleSend(socket, dto);

      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'UNAUTHENTICATED' }),
      );
    });

    it('rate limit is checked before access (cheap-first order)', async () => {
      const callOrder: string[] = [];
      chatService.checkRateLimit.mockImplementation(async () => {
        callOrder.push('rateLimit');
        return false; // fail early
      });
      chatService.checkRoomAccess.mockImplementation(async () => {
        callOrder.push('roomAccess');
        return true;
      });
      const socket = makeSocket();

      await gateway.handleSend(socket, dto);

      expect(callOrder).toEqual(['rateLimit']); // roomAccess never called
    });
  });

  // ── handleReact ───────────────────────────────────────────────────────────────

  describe('handleReact', () => {
    const dto = { message_id: 'msg-1', emoji: '👍' };

    it('emits RATE_LIMITED when reaction rate limit exceeded', async () => {
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
      chatService.findMessageById.mockResolvedValue(null);
      const socket = makeSocket();

      await gateway.handleReact(socket, dto);

      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'MESSAGE_NOT_FOUND' }),
      );
    });

    it('verifies membership of the MESSAGE\'s room (cross-room security)', async () => {
      chatService.checkRateLimit.mockResolvedValue(true);
      // Message belongs to trip-2, but user is only in trip-1
      chatService.findMessageById.mockResolvedValue({
        id: 'msg-1',
        roomType: 'trip',
        roomId: 'trip-2',
      } as any);
      chatService.checkRoomAccess.mockResolvedValue(false);
      const socket = makeSocket();

      await gateway.handleReact(socket, dto);

      // Must check access on trip-2 specifically
      expect(chatService.checkRoomAccess).toHaveBeenCalledWith('user-1', 'trip', 'trip-2');
      expect(socket.emit).toHaveBeenCalledWith(
        'chat:error',
        expect.objectContaining({ code: 'ACCESS_DENIED' }),
      );
    });

    it('toggles reaction and broadcasts to correct room on success', async () => {
      chatService.checkRateLimit.mockResolvedValue(true);
      chatService.findMessageById.mockResolvedValue({
        id: 'msg-1',
        roomType: 'trip',
        roomId: 'trip-1',
      } as any);
      chatService.checkRoomAccess.mockResolvedValue(true);
      chatService.toggleReaction.mockResolvedValue({
        roomType: 'trip',
        roomId: 'trip-1',
        reactions: { '👍': ['user-1'] },
      });
      const socket = makeSocket();

      await gateway.handleReact(socket, dto);

      expect(server.to).toHaveBeenCalledWith('trip:trip-1');
      expect(server.emit).toHaveBeenCalledWith('chat:reaction_update', {
        message_id: 'msg-1',
        reactions: { '👍': ['user-1'] },
      });
    });
  });

  // ── handleTyping ──────────────────────────────────────────────────────────────

  describe('handleTyping', () => {
    it('silently ignores typing if user is not a room member', async () => {
      chatService.checkRoomAccess.mockResolvedValue(false);
      const socket = makeSocket();
      socket.to = jest.fn().mockReturnThis();
      socket.emit = jest.fn();

      await gateway.handleTyping(socket, { room_type: 'trip', room_id: 'trip-1' });

      expect(socket.to).not.toHaveBeenCalled(); // no broadcast
    });

    it('silently ignores typing for invalid room_type', async () => {
      const socket = makeSocket();
      socket.to = jest.fn().mockReturnThis();

      await gateway.handleTyping(socket, { room_type: 'invalid', room_id: 'room-1' });

      expect(socket.to).not.toHaveBeenCalled();
    });

    it('broadcasts typing to room (excluding sender) on success', async () => {
      chatService.checkRoomAccess.mockResolvedValue(true);
      const socket = makeSocket();
      const toMock = jest.fn().mockReturnValue({ emit: jest.fn() });
      socket.to = toMock;

      await gateway.handleTyping(socket, { room_type: 'trip', room_id: 'trip-1' });

      expect(toMock).toHaveBeenCalledWith('trip:trip-1');
      expect(toMock('trip:trip-1').emit).toHaveBeenCalledWith(
        'chat:typing',
        expect.objectContaining({ user_id: 'user-1', room_type: 'trip', room_id: 'trip-1' }),
      );
    });
  });
});
