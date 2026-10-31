import { describe, expect, it } from "vitest";
import { parseRedisConnection } from "@dealdock/core";
import { RedisGraphRateBudget } from "../src/instagram/graph-rate-budget";
import { RateBudgetExceededError } from "../src/provider";
const enabled=process.env.RUN_REDIS_INTEGRATION==="1";
if(enabled&&!process.env.REDIS_URL) throw new Error("Redis integration gate requires REDIS_URL");
describe.runIf(enabled)("shared Graph rate budget",()=>{
  it("shares an atomic budget across API replicas and supports repeated calls",async()=>{
    const connection=parseRedisConnection(process.env.REDIS_URL!);
    const a=new RedisGraphRateBudget(connection,2),b=new RedisGraphRateBudget(connection,2);
    try {
      const account=`budget-test-${crypto.randomUUID()}`;
      const results=await Promise.allSettled([a.consume(account),b.consume(account),a.consume(account),b.consume(account)]);
      expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(2);
      const failures=results.filter(r=>r.status==="rejected");
      expect(failures).toHaveLength(2);
      for(const failure of failures) if(failure.status==="rejected") expect(failure.reason).toBeInstanceOf(RateBudgetExceededError);
    } finally { await Promise.all([a.close(),b.close()]); }
  });
});
