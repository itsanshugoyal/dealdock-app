import {afterEach,expect,it,vi} from "vitest";
import {createPipeline} from "../src/index";
import {extractStyleCard} from "../src/voice";
afterEach(()=>vi.unstubAllEnvs());
it("cannot use an explicit heuristic override in production",async()=>{
  vi.stubEnv("NODE_ENV","production");vi.stubEnv("AI_PROVIDER","");vi.stubEnv("GROQ_API_KEY","");vi.stubEnv("ANTHROPIC_API_KEY","");vi.stubEnv("OPENAI_API_KEY","");vi.stubEnv("AI_FALLBACK_PROVIDER","");vi.stubEnv("DEALDOCK_AI_MODE","heuristic");
  expect(()=>createPipeline({allowHeuristic:true})).toThrow("not configured");
  await expect(extractStyleCard(["Hi"],{allowHeuristic:true})).rejects.toThrow("requires a configured AI model");
});
it("requires explicit local fallback configuration",()=>{
  vi.stubEnv("NODE_ENV","test");vi.stubEnv("AI_PROVIDER","");vi.stubEnv("GROQ_API_KEY","");vi.stubEnv("ANTHROPIC_API_KEY","");vi.stubEnv("OPENAI_API_KEY","");vi.stubEnv("AI_FALLBACK_PROVIDER","");vi.stubEnv("DEALDOCK_AI_MODE","");
  expect(()=>createPipeline()).toThrow("not configured");
  expect(createPipeline({allowHeuristic:true}).constructor.name).toBe("HeuristicPipeline");
});
it("prefers Groq when both keys exist, but never switches a selected provider on error",()=>{
  vi.stubEnv("AI_PROVIDER","");vi.stubEnv("AI_FALLBACK_PROVIDER","");vi.stubEnv("GROQ_API_KEY","test");vi.stubEnv("ANTHROPIC_API_KEY","test");
  expect(createPipeline().constructor.name).toBe("GroqPipeline");
  vi.stubEnv("AI_PROVIDER","anthropic");vi.stubEnv("ANTHROPIC_API_KEY","");
  expect(()=>createPipeline({allowHeuristic:true})).toThrow("requires ANTHROPIC_API_KEY");
  vi.stubEnv("AI_PROVIDER","groq");vi.stubEnv("GROQ_API_KEY","");
  expect(()=>createPipeline({allowHeuristic:true})).toThrow("requires GROQ_API_KEY");
});
