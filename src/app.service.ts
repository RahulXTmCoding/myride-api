import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { AnyRedis, createRedisClient } from './shared/redis.factory';

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  private readonly redis: AnyRedis = createRedisClient();

  async onModuleInit() {
    await this.pool.query('SELECT 1');
    await (this.redis as Redis).ping();
  }

  async onModuleDestroy() {
    await Promise.all([this.pool.end(), (this.redis as any).quit()]);
  }

  async getHealth() {
    const [databaseProbe, redisProbe] = await Promise.allSettled([
      this.pool.query('SELECT 1'),
      (this.redis as Redis).ping(),
    ]);

    const database = databaseProbe.status === 'fulfilled';
    const redis =
      redisProbe.status === 'fulfilled' && redisProbe.value === 'PONG';

    return {
      service: 'myride-api',
      status: database && redis ? 'ok' : 'degraded',
      database: database ? 'ok' : 'down',
      redis: redis ? 'ok' : 'down',
      timestamp: new Date().toISOString(),
    };
  }
}
