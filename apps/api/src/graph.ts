import {
  InMemoryGraphRateBudget,
  InstagramGraphAdapter,
  RedisGraphRateBudget,
} from "@dealdock/messaging";
import { parseRedisConnection } from "@dealdock/core";

let adapter: InstagramGraphAdapter | undefined;

/** The API is the only process permitted to pair Graph tokens with Graph I/O. */
export function getGraphAdapter(): InstagramGraphAdapter {
  if (adapter) return adapter;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl && process.env.NODE_ENV === "production") {
    throw new Error("REDIS_URL is required for shared Graph rate limits");
  }
  adapter = new InstagramGraphAdapter({
    rateBudget: redisUrl
      ? new RedisGraphRateBudget(parseRedisConnection(redisUrl))
      : new InMemoryGraphRateBudget(),
  });
  return adapter;
}
