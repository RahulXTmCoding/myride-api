import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SOSAlert } from './entities/sos-alert.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';

import { SosController } from './sos.controller';
import { SosService } from './sos.service';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SOSAlert, Trip, TripParticipant]),
    AuthModule,
    ChatModule, // for CHAT_REDIS publisher
  ],
  controllers: [SosController],
  providers: [SosService],
  exports: [SosService],
})
export class SosModule {}
