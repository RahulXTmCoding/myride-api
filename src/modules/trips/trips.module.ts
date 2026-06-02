import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Trip } from './entities/trip.entity';
import { TripStop } from './entities/trip-stop.entity';
import { TripParticipant } from './entities/trip-participant.entity';

import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Trip, TripStop, TripParticipant]),
    AuthModule, // provides JwtAuthGuard
  ],
  controllers: [TripsController],
  providers: [TripsService],
  exports: [TripsService],
})
export class TripsModule {}
