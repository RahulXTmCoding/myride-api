import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { ChatGateway } from './chat.gateway';
import { ChatService, CHAT_REDIS } from './chat.service';
import { ChatController } from './chat.controller';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { ChatMessage } from './entities/chat-message.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';
import Redis from 'ioredis';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatMessage, MessageReaction, TripParticipant]),

    // JwtModule needed by WsJwtGuard to verify tokens
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: (configService.get('JWT_ACCESS_EXPIRATION') ?? '15m') as `${number}${'s'|'m'|'h'|'d'}`,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    ChatGateway,
    ChatService,
    WsJwtGuard,

    // Dedicated Redis client for chat (rate limiting, access cache, kick pub/sub)
    // Separate from the auth Redis client to avoid cross-concern interference
    {
      provide: CHAT_REDIS,
      useFactory: (): Redis => {
        return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
          maxRetriesPerRequest: 2,
          lazyConnect: false,
          // Add connection name for debugging in Redis CLI
          connectionName: 'myride-chat',
        });
      },
    },
  ],
  controllers: [ChatController],
  exports: [ChatService], // Export so TripService/CommunityService can call invalidateRoomAccessCache
})
export class ChatModule {}
