import Redis from "ioredis";
import type { RedisConnection } from "@dealdock/core";
import { RateBudgetExceededError } from "../provider";

export interface GraphRateBudget {
  consume(accountId: string): Promise<void>;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/** Deterministic local limiter for tests and deliberate offline development. */
export class InMemoryGraphRateBudget implements GraphRateBudget {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity = 180,
    private readonly windowMs = 60 * 60_000,
    private readonly now: () => number = Date.now
  ) {}

  async consume(accountId: string): Promise<void> {
    const now = this.now();
    const bucket = this.buckets.get(accountId) ?? { tokens: this.capacity, lastRefill: now };
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((now - bucket.lastRefill) / this.windowMs) * this.capacity
    );
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      this.buckets.set(accountId, bucket);
      throw new RateBudgetExceededError(
        accountId,
        Math.ceil(((1 - bucket.tokens) / this.capacity) * this.windowMs)
      );
    }
    bucket.tokens -= 1;
    this.buckets.set(accountId, bucket);
  }
}

const CONSUME_TOKEN_LUA = `
local capacity = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local saved = redis.call('HMGET', KEYS[1], 'tokens', 'lastRefill')
local tokens = tonumber(saved[1]) or capacity
local lastRefill = tonumber(saved[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - lastRefill) / windowMs * capacity)
local allowed, retryAfterMs = 0, 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1
else retryAfterMs = math.ceil((1 - tokens) / capacity * windowMs) end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'lastRefill', now)
redis.call('PEXPIRE', KEYS[1], windowMs * 2)
return {allowed, retryAfterMs}
`;

/** Atomic per-account Graph budget shared by all API replicas through Redis. */
export class RedisGraphRateBudget implements GraphRateBudget {
  private readonly redis: Redis;

  constructor(
    redisConnection: RedisConnection,
    private readonly capacity = 180,
    private readonly windowMs = 60 * 60_000,
    private readonly now: () => number = Date.now
  ) {
    this.redis = new Redis({ ...redisConnection, lazyConnect: true, maxRetriesPerRequest: 1,
      connectTimeout: 5_000, commandTimeout: 5_000,
      retryStrategy: attempts => attempts > 3 ? null : Math.min(attempts * 100, 1000),
    });
  }

  async consume(accountId: string): Promise<void> {
    // ioredis connects on the first command; calling connect() for each token
    // would reject every request after the first with 'already connecting'.
    const result = (await this.redis.eval(
      CONSUME_TOKEN_LUA,
      1,
      `dealdock:graph-budget:${accountId}`,
      String(this.capacity),
      String(this.windowMs),
      String(this.now())
    )) as [number | string, number | string];
    if (Number(result[0]) !== 1) {
      throw new RateBudgetExceededError(accountId, Number(result[1]) || 1_000);
    }
  }
  async close() { await this.redis.quit(); }
}
