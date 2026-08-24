import { describe, expect, test } from "bun:test";
import { analyzePrompt } from "../src/server/prompt-analysis";

const models = [{ model: "qwen2.5:7b", provider: "ollama" }, { model: "qwen2.5-coder:14b", provider: "ollama" }, { model: "claude-opus-5", provider: "claude" }, { model: "unknown-local-model", provider: "local" }];

describe("prompt analysis", () => {
  test("classifies a simple prompt as low complexity", () => {
    const result = analyzePrompt("Summarize this paragraph in three bullets.", models);
    expect(result.complexity).toBe("low");
    expect(result.requiredCapabilities).toContain("basic reasoning");
  });
  test("classifies a multi-step code task as high complexity", () => {
    const result = analyzePrompt(`Debug the production migration, inspect the repository, compare trade-offs, implement the refactor across files, run tests, and explain the root cause. ${"Include the relevant repository context and test evidence. ".repeat(220)}`, models, "prompt", { toolCount: 4 });
    expect(result.complexity).toBe("high");
    expect(result.requiredCapabilities).toEqual(expect.arrayContaining(["deep reasoning", "tool use", "code generation", "high reliability"]));
    expect(result.recommendations[0].model).toBe("claude-opus-5");
    expect(result.recommendations[0].provider).toBe("claude");
    expect(result.recommendations[0].estimatedLatencyMs).toBeGreaterThan(0);
  });
  test("redacts secrets and reports missing context uncertainty", () => {
    const result = analyzePrompt("Use OPENAI_API_KEY=sk-live-abcdefghijklmnop to answer.", models);
    expect(result.redactedPrompt).not.toContain("sk-live-");
    expect(result.unknowns).toContain("prompt context is too short for a confident estimate");
  });
  test("keeps unpriced model cost unknown", () => {
    const result = analyzePrompt("Implement a small function.", [{ model: "unknown-local-model" }]);
    expect(result.recommendations[0].estimatedCostUsd).toBeNull();
  });
  test("flags conflicting deep-reasoning and latency requirements", () => {
    const result = analyzePrompt("Quickly debug this production security incident and explain the root cause with a reliable fix.", models);
    expect(result.requiredCapabilities).toEqual(expect.arrayContaining(["deep reasoning", "low latency", "high reliability"]));
    expect(result.warnings[0]).toContain("can conflict");
  });
});
