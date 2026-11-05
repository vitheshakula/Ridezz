import { RedisStore } from 'rate-limit-redis';
import type { Store } from 'express-rate-limit';
import { createClient } from 'redis';
import { logger } from '../logger';
import { safeErrorDetails } from '../http';

export type RateLimitStoreFactory = (name: string) => Store | undefined;

export const memoryRateLimitStores: RateLimitStoreFactory = () => undefined;

export interface RedisConnection {
  ping(): Promise<string>;
  close(): Promise<void>;
  storeFactory: RateLimitStoreFactory;
}

const CONNECT_TIMEOUT_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 5000;

export async function connectRedis(url: string): Promise<RedisConnection> {
  const client = createClient({
    url,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: retries => Math.min(retries * 200, MAX_RECONNECT_DELAY_MS),
    },
  });
  client.on('error', error => logger().error('redis_error', safeErrorDetails(error)));
  await client.connect();
  return {
    ping: () => client.ping(),
    close: async () => {
      await client.close();
    },
    storeFactory: name =>
      new RedisStore({
        prefix: `ridezz:rl:${name}:`,
        sendCommand: (...args: string[]) => client.sendCommand(args),
      }),
  };
}
