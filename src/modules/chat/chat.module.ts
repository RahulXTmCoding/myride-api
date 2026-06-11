import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { ChatGateway } from './chat.gateway';
import { ChatService, CHAT_REDIS, CHAT_ADAPTER_REDIS } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatFlushWorker } from './chat-flush.worker';
import { WsJwtGuard } from './guards/ws-jwt.guard';
import { ChatMessage } from './entities/chat-message.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';
import { CommunityMember } from '../community/entities/community-member.entity';
import Redis from 'ioredis';

function makeRedis(name: string): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    connectionName: name,
  });
}

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatMessage, MessageReaction, TripParticipant, CommunityMember]),

    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: configService.get('JWT_ACCESS_EXPIRATION') ?? '15m',
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    ChatGateway,
    ChatService,
    ChatFlushWorker,
    WsJwtGuard,

    /**
     * FIX #9: Two separate Redis clients.
     *
     * CHAT_REDIS — used by ChatService for:
     *   - Write-ahead streams (XADD / XREADGROUP / XACK)
     *   - Rate limiting (sorted sets)
     *   - Access cache (GET / SET)
     *   - Flood control (INCR)
     *   - Kick pub/sub subscription (dedicated duplicate connection inside gateway)
     *
     * CHAT_ADAPTER_REDIS — used exclusively by the Socket.IO Redis adapter
     * (pub/sub for cross-instance message fanout). Socket.IO adapter requires
     * a dedicated connection that stays in subscribe mode — it cannot share a
     * connection used for regular commands.
     */
    {
      provide: CHAT_REDIS,
      useFactory: (): Redis => makeRedis('myride-chat'),
    },
    {
      provide: CHAT_ADAPTER_REDIS,
      useFactory: (): Redis => makeRedis('myride-chat-adapter'),
    },
  ],
  controllers: [ChatController],
  exports: [ChatService, CHAT_REDIS],
})
export class ChatModule {}
