import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Trip } from './entities/trip.entity';
import { TripStop } from './entities/trip-stop.entity';
import { TripParticipant } from './entities/trip-participant.entity';
import { UserStopProgress } from './entities/user-stop-progress.entity';

import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { StopProgressService } from './stop-progress.service';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Trip, TripStop, TripParticipant, UserStopProgress]),
    AuthModule, // provides JwtAuthGuard
    ChatModule, // provides ChatService + CHAT_REDIS for membership-change invalidation
  ],
  controllers: [TripsController],
  providers: [TripsService, StopProgressService],
  exports: [TripsService, StopProgressService],
})
export class TripsModule {}
