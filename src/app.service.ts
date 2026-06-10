import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  private readonly redis = new Redis(
    process.env.REDIS_URL ?? 'redis://localhost:6379',
    {
      maxRetriesPerRequest: 2,
    },
  );

  async onModuleInit() {
    await this.pool.query('SELECT 1');
    await this.redis.ping();
  }

  async onModuleDestroy() {
    await Promise.all([this.pool.end(), this.redis.quit()]);
  }

  async getHealth() {
    const [databaseProbe, redisProbe] = await Promise.allSettled([
      this.pool.query('SELECT 1'),
      this.redis.ping(),
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
