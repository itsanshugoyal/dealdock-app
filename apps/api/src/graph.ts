import {
  InMemoryGraphRateBudget,
  InstagramGraphAdapter,
  RedisGraphRateBudget,
  UNIFIED_GRAPH_BASE,
} from "@dealdock/messaging";
import { isUnifiedLoginEnabled } from "./feature-flags";
import { parseRedisConnection } from "@dealdock/core";

let adapter: InstagramGraphAdapter | undefined;

/** The Graph host for this deployment: graph.facebook.com under Unified Login, else the Instagram Login default. */
export function instagramGraphBase(): string | undefined {
  return isUnifiedLoginEnabled() ? UNIFIED_GRAPH_BASE : undefined;
}

/** The API is the only process permitted to pair Graph tokens with Graph I/O. */
export function getGraphAdapter(): InstagramGraphAdapter {
  if (adapter) return adapter;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl && process.env.NODE_ENV === "production") {
    throw new Error("REDIS_URL is required for shared Graph rate limits");
  }
  adapter = new InstagramGraphAdapter({
    graphBase: instagramGraphBase(),
    rateBudget: redisUrl
      ? new RedisGraphRateBudget(parseRedisConnection(redisUrl))
      : new InMemoryGraphRateBudget(),
  });
  return adapter;
}
