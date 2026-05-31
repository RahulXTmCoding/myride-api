import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Socket } from 'socket.io';

/**
 * WsJwtGuard
 * Validates JWT for WebSocket events.
 * Applied per-event as defense-in-depth (connection already validates in handleConnection).
 *
 * Client must send token in handshake:
 *   io(url, { auth: { token: 'Bearer eyJ...' } })
 *   OR io(url, { auth: { token: 'eyJ...' } })   ← with or without 'Bearer' prefix
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const socket: Socket = context.switchToWs().getClient();

    // If user already attached to socket (from handleConnection), trust it
    if (socket.data?.user) return true;

    const token = this.extractToken(socket);
    if (!token) {
      socket.emit('chat:error', { code: 'UNAUTHENTICATED', message: 'No token provided' });
      return false;
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
      socket.data.user = payload;
      return true;
    } catch {
      socket.emit('chat:error', { code: 'TOKEN_INVALID', message: 'Token expired or invalid' });
      return false;
    }
  }

  static extractTokenStatic(socket: Socket): string | null {
    const raw =
      socket.handshake.auth?.token ??
      socket.handshake.headers?.authorization;
    if (!raw) return null;
    return raw.startsWith('Bearer ') ? raw.slice(7) : raw;
  }

  private extractToken(socket: Socket): string | null {
    return WsJwtGuard.extractTokenStatic(socket);
  }
}
