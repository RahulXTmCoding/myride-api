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
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Trip,
      TripStop,
      TripParticipant,
      UserStopProgress,
    ]),
    AuthModule,
    ChatModule,
    NotificationsModule,
    UsersModule,
  ],
  controllers: [TripsController],
  providers: [TripsService, StopProgressService],
  exports: [TripsService, StopProgressService],
})
export class TripsModule {}
