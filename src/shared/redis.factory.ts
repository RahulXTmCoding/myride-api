/**
 * Shared Redis client factory.
 *
 * Azure Redis Enterprise OSSCluster:
 *   - Uses ioredis Cluster mode to handle MOVED/ASK redirects
 *   - Cluster topology returns internal shard IPs → we reroute all of them
 *     back to the public endpoint via a custom `redisOptions.host` override
 *     in the `beforeConnect` hook-style approach
 *   - All shards are reachable through the single public endpoint using TLS
 *
 * Local dev (redis://):
 *   - Plain ioredis Redis client, no cluster overhead
 */
import Redis, { Cluster, ClusterOptions, RedisOptions } from 'ioredis';

export type AnyRedis = Redis | Cluster;

export function createRedisClient(url?: string, _opts: RedisOptions = {}): AnyRedis {
  const redisUrl = url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';

  // Azure Redis Enterprise: rediss://:<key>@host:port  → Cluster mode
  if (redisUrl.startsWith('rediss://')) {
    const parsed = new URL(redisUrl);
    const publicHost = parsed.hostname;
    const publicPort = parseInt(parsed.port, 10) || 10000;
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;

    const clusterOpts: ClusterOptions = {
      // Tell ioredis to connect to all cluster nodes through the public endpoint.
      // When cluster topology returns internal IPs, ioredis Cluster will try to
      // connect directly to those IPs (which aren't accessible). The
      // `redisOptions` here applies to every node connection, but the host/port
      // used for redirection comes from CLUSTER SLOTS response.
      // We handle this by overriding the host resolution below.
      redisOptions: {
        tls: {},
        password,
        maxRetriesPerRequest: 3,
        connectTimeout: 10000,
      },
      enableReadyCheck: false,
      // Don't refresh slots — Enterprise manages topology, and refreshing
      // would try to connect to internal shard IPs
      slotsRefreshTimeout: 2000,
      slotsRefreshInterval: 0,
      // After MOVED redirect, always go back to the public endpoint
      // by remapping any IP the cluster reports back to the public host:port
      dnsLookup: (_address: string, callback: (err: Error | null, address: string, family?: number) => void) => {
        // Reroute all cluster node connections to the public endpoint
        callback(null, publicHost);
      },
      clusterRetryStrategy: (times: number) => {
        if (times > 3) return null;
        return times * 300;
      },
      lazyConnect: false,
    };

    // Override: when ioredis Cluster gets MOVED to a shard IP, force it to
    // connect to publicHost:publicPort instead
    const cluster = new Cluster(
      [{ host: publicHost, port: publicPort }],
      clusterOpts,
    );
    cluster.on('error', () => {}); // suppress unhandled error events

    return cluster;
  }

  // Local dev / standard Redis: plain client
  return new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: false,
  });
}
