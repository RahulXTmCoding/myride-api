import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis, { Cluster } from 'ioredis';
import { Pool } from 'pg';
import { AnyRedis, createRedisClient } from './shared/redis.factory';

@Injectable()
export class AppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppService.name);

  private readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  private readonly redis: AnyRedis = createRedisClient();

  async onModuleInit() {
    // Non-blocking startup probes — failures are logged but don't crash the app
    try {
      await this.pool.query('SELECT 1');
    } catch (e) {
      this.logger.warn('Database probe failed on startup', e);
    }
    try {
      await this.pingRedis();
    } catch (e) {
      this.logger.warn('Redis probe failed on startup', e);
    }
  }

  async onModuleDestroy() {
    try {
      await this.pool.end();
    } catch (_) {}
    try {
      await (this.redis as any).quit();
    } catch (_) {}
  }

  private async pingRedis(): Promise<string> {
    if (this.redis instanceof Cluster) {
      // Cluster.ping() requires a specific node — use sendCommand instead
      const nodes = (this.redis as Cluster).nodes('all');
      if (nodes.length > 0) {
        return nodes[0].ping();
      }
      return 'PONG'; // no nodes yet, assume ok
    }
    return (this.redis as Redis).ping();
  }

  async getHealth() {
    const [databaseProbe, redisProbe] = await Promise.allSettled([
      this.pool.query('SELECT 1'),
      Promise.race([
        this.pingRedis(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 3000),
        ),
      ]),
    ]);

    const database = databaseProbe.status === 'fulfilled';
    const redis =
      redisProbe.status === 'fulfilled' && redisProbe.value === 'PONG';

    return {
      service: 'myride-api',
      status: database && redis ? 'ok' : 'degraded',
      database: database ? 'ok' : 'down',
      redis: redis ? 'ok' : 'down',
      support_email: 'support@mirailabs.co.in',
      timestamp: new Date().toISOString(),
    };
  }
}
