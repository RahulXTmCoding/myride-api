import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Trip } from '../trips/entities/trip.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';

import { VoiceCallController } from './voice-call.controller';
import { VoiceCallService } from './voice-call.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([Trip, TripParticipant]), AuthModule],
  controllers: [VoiceCallController],
  providers: [VoiceCallService],
  exports: [VoiceCallService],
})
export class VoiceCallModule {}
