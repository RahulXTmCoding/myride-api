import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SOSAlert } from './entities/sos-alert.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';

import { SosController } from './sos.controller';
import { SosService } from './sos.service';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SOSAlert, Trip, TripParticipant]),
    AuthModule,
    ChatModule,
    NotificationsModule,
    UsersModule,
  ],
  controllers: [SosController],
  providers: [SosService],
  exports: [SosService],
})
export class SosModule {}
