import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TripShareableLink } from '../trips/entities/trip-shareable-link.entity';
import { Trip } from '../trips/entities/trip.entity';
import { TripStop } from '../trips/entities/trip-stop.entity';
import { TripParticipant } from '../trips/entities/trip-participant.entity';

import { ShareLinksController } from './share-links.controller';
import { ShareLinksService } from './share-links.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TripShareableLink,
      Trip,
      TripStop,
      TripParticipant,
    ]),
    AuthModule,
  ],
  controllers: [ShareLinksController],
  providers: [ShareLinksService],
  exports: [ShareLinksService],
})
export class ShareLinksModule {}
