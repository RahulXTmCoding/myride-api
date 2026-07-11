import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Get config service
  const configService = app.get(ConfigService);

  // Security middleware
  app.use(helmet());

  // CORS configuration
  // React Native mobile apps don't send an Origin header (or send "null"),
  // so we must allow all origins. REST API is protected by JWT; Socket.IO
  // is protected by WsJwtGuard — CORS is not the security boundary here.
  app.enableCors({
    origin: true, // reflect any origin — safe because auth is JWT-gated
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip props that don't have decorators
      forbidNonWhitelisted: true, // Throw error if non-whitelisted props
      transform: true, // Auto-transform payloads to DTO instances
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // API prefix
  app.setGlobalPrefix('api/v1');

  const port = configService.get('PORT') || 3000;
  await app.listen(port);

  console.log(`🚀 myRide API is running on: http://localhost:${port}/api/v1`);
  console.log(`📝 Environment: ${configService.get('NODE_ENV')}`);
  console.log(
    `🗄️  Database: ${configService.get('DATABASE_URL')?.split('@')[1]}`,
  );
}

bootstrap();
