import { env } from "../../config/env.js";
import type { LlmProvider } from "./llm-provider.js";
import { MockLlmProvider } from "./mock-llm-provider.js";
import { OpenAiProvider } from "./openai-provider.js";

export function createLlmProvider(): LlmProvider {
  if (env.LLM_PROVIDER === "openai") {
    return new OpenAiProvider();
  }

  return new MockLlmProvider();
}
