/**
 * Shared Redis client factory.
 *
 * Azure Redis Enterprise uses OSSCluster policy — ioredis must use Cluster
 * mode to handle MOVED redirects. All shard connections (including after
 * MOVED redirects) need TLS enabled.
 *
 * Cluster topology: master at 4.224.133.107:8503 (reachable within Azure).
 * Public endpoint: attars.centralindia.redis.azure.net:10000 (entry point).
 *
 * Local dev (redis://): plain ioredis Redis client.
 */
import Redis, { Cluster, ClusterOptions, RedisOptions } from 'ioredis';

export type AnyRedis = Redis | Cluster;

export function createRedisClient(url?: string, _opts: RedisOptions = {}): AnyRedis {
  const redisUrl = url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';

  // Azure Redis Enterprise: rediss://:<key>@host:port  → Cluster mode
  if (redisUrl.startsWith('rediss://')) {
    const parsed = new URL(redisUrl);
    const host = parsed.hostname;
    const port = parseInt(parsed.port, 10) || 10000;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;

    const clusterOpts: ClusterOptions = {
      redisOptions: {
        // TLS must be on for EVERY node connection — both the entry point and
        // shard connections after MOVED redirects
        tls: { rejectUnauthorized: false },
        password,
        maxRetriesPerRequest: 3,
        connectTimeout: 10000,
      },
      enableReadyCheck: false,
      // Don't auto-refresh topology — avoid unnecessary CLUSTER SLOTS calls
      slotsRefreshTimeout: 5000,
      slotsRefreshInterval: 0,
      clusterRetryStrategy: (times: number) => {
        if (times > 5) return null;
        return Math.min(times * 300, 3000);
      },
    };

    const cluster = new Cluster([{ host, port }], clusterOpts);
    cluster.on('error', () => {}); // prevent unhandled error crash
    return cluster;
  }

  // Local dev / standard Redis: plain client
  return new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
}
