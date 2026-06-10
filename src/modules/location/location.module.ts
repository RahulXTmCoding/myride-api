import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { LocationGateway, LOC_ADAPTER_REDIS } from './location.gateway';
import { LocationService, LOC_REDIS } from './location.service';
import { LocationController } from './location.controller';
import { ChatModule } from '../chat/chat.module';
import { WsJwtGuard } from '../chat/guards/ws-jwt.guard';

function makeRedis(name: string): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    connectionName: name,
  });
}

@Module({
  imports: [
    // Reuse ChatModule so LocationService can call chatService.checkRoomAccess
    ChatModule,

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
    LocationGateway,
    LocationService,
    WsJwtGuard,

    /**
     * LOC_REDIS — commands (position store, rate-limit INCR).
     * LOC_ADAPTER_REDIS — dedicated Socket.IO pub/sub adapter connection.
     */
    {
      provide: LOC_REDIS,
      useFactory: (): Redis => makeRedis('myride-location'),
    },
    {
      provide: LOC_ADAPTER_REDIS,
      useFactory: (): Redis => makeRedis('myride-location-adapter'),
    },
  ],
  controllers: [LocationController],
})
export class LocationModule {}
