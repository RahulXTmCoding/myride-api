import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validationSchema } from './config/validation.schema';
import { getTypeOrmConfig } from './config/typeorm.config';
import { AuthModule } from './modules/auth/auth.module';
import { ChatModule } from './modules/chat/chat.module';
import { TripsModule } from './modules/trips/trips.module';
import { SosModule } from './modules/sos/sos.module';
import { ShareLinksModule } from './modules/share-links/share-links.module';
import { VoiceCallModule } from './modules/voice-call/voice-call.module';
import { LocationModule } from './modules/location/location.module';
import { CommunityModule } from './modules/community/community.module';
import { UsersModule } from './modules/users/users.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { VersionModule } from './modules/version/version.module';

@Module({
  imports: [
    // Configuration module with validation
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema,
      envFilePath: '.env',
    }),

    // Database module
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: getTypeOrmConfig,
      inject: [ConfigService],
    }),

    // Feature modules
    AuthModule,
    ChatModule,
    TripsModule,
    SosModule,
    ShareLinksModule,
    VoiceCallModule,
    LocationModule,
    CommunityModule,
    UsersModule,
    NotificationsModule,
    VersionModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
