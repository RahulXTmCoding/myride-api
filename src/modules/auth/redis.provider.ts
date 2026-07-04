import { Provider } from '@nestjs/common';
import { AnyRedis, createRedisClient } from '../../shared/redis.factory';

export const REDIS_CLIENT = 'AUTH_REDIS_CLIENT';

export const RedisProvider: Provider = {
  provide: REDIS_CLIENT,
  useFactory: (): AnyRedis => createRedisClient(),
};
