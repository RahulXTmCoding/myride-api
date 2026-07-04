/**
 * Shared Redis client factory.
 *
 * Azure Redis Enterprise uses OSSCluster policy — ioredis must use Cluster
 * mode to handle MOVED redirects. For local dev (redis://) a plain Redis
 * client is used so no Docker cluster setup is needed.
 *
 * Detection: if REDIS_URL starts with "rediss://" → Cluster mode.
 */
import Redis, { Cluster, ClusterOptions, RedisOptions } from 'ioredis';

export type AnyRedis = Redis | Cluster;

export function createRedisClient(url?: string, opts: RedisOptions = {}): AnyRedis {
  const redisUrl = url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';

  // Azure Redis Enterprise: rediss://:<key>@host:port  → Cluster mode
  if (redisUrl.startsWith('rediss://')) {
    const parsed = new URL(redisUrl);
    const host = parsed.hostname;
    const port = parseInt(parsed.port, 10) || 10000;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;

    const clusterOpts: ClusterOptions = {
      redisOptions: {
        tls: {},
        password,
        maxRetriesPerRequest: 3,
        ...opts,
      },
      // Enterprise Redis Enterprise with OSSCluster: disable NAT mapping
      enableReadyCheck: false,
      scaleReads: 'all',
      clusterRetryStrategy: (times: number) => Math.min(times * 100, 3000),
    };

    return new Cluster([{ host, port }], clusterOpts);
  }

  // Local dev / standard Redis: plain client
  return new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
    ...opts,
  });
}
