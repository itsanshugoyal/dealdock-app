import {afterEach,expect,it,vi} from "vitest";
import {createPipeline} from "../src/index";
import {extractStyleCard} from "../src/voice";
afterEach(()=>vi.unstubAllEnvs());
it("cannot use an explicit heuristic override in production",async()=>{
  vi.stubEnv("NODE_ENV","production");vi.stubEnv("ANTHROPIC_API_KEY","");vi.stubEnv("DEALDOCK_AI_MODE","heuristic");
  expect(()=>createPipeline({allowHeuristic:true})).toThrow("not configured");
  await expect(extractStyleCard(["Hi"],{allowHeuristic:true})).rejects.toThrow("requires a configured Anthropic model");
});
it("requires explicit local fallback configuration",()=>{
  vi.stubEnv("NODE_ENV","test");vi.stubEnv("ANTHROPIC_API_KEY","");vi.stubEnv("DEALDOCK_AI_MODE","");
  expect(()=>createPipeline()).toThrow("not configured");
  expect(createPipeline({allowHeuristic:true}).constructor.name).toBe("HeuristicPipeline");
});
