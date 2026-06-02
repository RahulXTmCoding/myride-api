import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AccessToken } from 'livekit-server-sdk';

import { Trip } from '../trips/entities/trip.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';

/**
 * VoiceCallService — issues short-lived LiveKit JWTs scoped to the trip room.
 *
 * Room naming: `trip-${tripId}` keeps rooms isolated per trip.
 * Identity: the user's UUID so LiveKit's participant identity matches our DB.
 * Permissions: canPublish + canSubscribe for trip members (the "voice jam").
 * Admin gets canPublishData too (data channel for future kicks/announces).
 *
 * Tokens are valid for 1 hour. The client should request a new one on
 * reconnect. We deliberately do NOT include trip metadata in the token —
 * LiveKit publishes that itself when the room is created.
 */
@Injectable()
export class VoiceCallService {
  private readonly logger = new Logger(VoiceCallService.name);

  constructor(
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
    @InjectRepository(TripParticipant)
    private readonly participantRepo: Repository<TripParticipant>,
    private readonly config: ConfigService,
  ) {}

  async issueToken(
    tripId: string,
    userId: string,
    displayName?: string,
  ): Promise<{
    token: string;
    ws_url: string;
    room: string;
    expires_in: number;
  }> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException({ error: 'TRIP_NOT_FOUND' });

    const isCreator = trip.creator_id === userId;
    if (!isCreator) {
      const participant = await this.participantRepo.findOne({
        where: { trip_id: tripId, user_id: userId, status: 'approved' },
      });
      if (!participant) {
        throw new ForbiddenException({ error: 'NOT_TRIP_MEMBER' });
      }
    }

    const apiKey = this.config.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.config.get<string>('LIVEKIT_API_SECRET');
    const wsUrl = this.config.get<string>('LIVEKIT_WS_URL');
    if (!apiKey || !apiSecret || !wsUrl) {
      this.logger.error('LiveKit env vars missing');
      throw new InternalServerErrorException({ error: 'VOICE_NOT_CONFIGURED' });
    }

    const room = `trip-${tripId}`;
    const ttlSeconds = 60 * 60;
    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: displayName ?? userId.slice(0, 8),
      ttl: ttlSeconds,
    });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: isCreator, // admin can broadcast data channel msgs
    });

    const token = await at.toJwt();

    return {
      token,
      ws_url: wsUrl,
      room,
      expires_in: ttlSeconds,
    };
  }
}
