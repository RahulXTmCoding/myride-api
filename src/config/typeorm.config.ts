import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const getTypeOrmConfig = (
  configService: ConfigService,
): TypeOrmModuleOptions => {
  const databaseUrl = configService.get('DATABASE_URL');
  const isSQLite = databaseUrl?.startsWith('file:');

  if (isSQLite) {
    // SQLite configuration for local development (no Docker needed!)
    return {
      type: 'better-sqlite3',
      database: databaseUrl.replace('file:', ''),
      entities: [__dirname + '/../**/*.entity{.ts,.js}'],
      synchronize: true, // Auto-create tables in dev
      logging: configService.get('NODE_ENV') === 'development',
    } as TypeOrmModuleOptions;
  }

  // PostgreSQL configuration for production
  return {
    type: 'postgres',
    url: databaseUrl,
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/../migrations/*{.ts,.js}'],
    synchronize: configService.get('NODE_ENV') === 'development', // Only for development!
    logging: configService.get('NODE_ENV') === 'development',
    ssl: configService.get('NODE_ENV') === 'production' ? {
      rejectUnauthorized: false, // Required for Azure/AWS managed databases
    } : false,
  };
};
