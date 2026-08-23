import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { estimateCostUsd, normalizeModel, ratesForModel, dominantModel, effectivePricingTable, pricingOverrideError } from "../src/server/pricing";

const savedEnv = process.env.OMARCHY_AGENTS_CONFIG;
const configRoot = join(tmpdir(), `omarchy-agents-pricing-${process.pid}`);
const setConfigDir = (name: string | null) => {
  if (!name) { delete process.env.OMARCHY_AGENTS_CONFIG; return; }
  const dir = join(configRoot, name);
  mkdirSync(dir, { recursive: true });
  process.env.OMARCHY_AGENTS_CONFIG = dir;
};

beforeAll(() => {
  mkdirSync(configRoot, { recursive: true });
  delete process.env.OMARCHY_AGENTS_CONFIG;
});
afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.OMARCHY_AGENTS_CONFIG;
  else process.env.OMARCHY_AGENTS_CONFIG = savedEnv;
});

describe("built-in rates", () => {
  test("exact and prefix matching pick the most specific entry", () => {
    expect(ratesForModel("claude-opus-5")?.match).toBe("claude-opus");
    expect(ratesForModel("claude-haiku-4-5-20251001")?.match).toBe("claude-haiku");
    expect(ratesForModel("gpt-5.6-luna")?.match).toBe("gpt-5");
    expect(ratesForModel("deepseek-v4-flash")?.source).toBe("built-in");
  });
  test("vendor prefixes and casings are normalized away", () => {
    expect(normalizeModel("@cf/deepseek-ai/deepseek-v4-flash-0731")).toBe("deepseek-ai/deepseek-v4-flash-0731");
    expect(normalizeModel("Anthropic/Claude-Opus-5")).toBe("claude-opus-5");
    expect(ratesForModel("Claude-Sonnet-5")?.match).toBe("claude-sonnet");
  });
  test("unknown models are unpriced rather than guessed", () => {
    expect(ratesForModel("big-pickle")).toBeNull();
    expect(ratesForModel("stealth-ox-alpha")).toBeNull();
  });
});

describe("override file", () => {
  test("overrides win over built-ins for their key", () => {
    setConfigDir("win");
    writeFileSync(join(process.env.OMARCHY_AGENTS_CONFIG!, "pricing.json"), JSON.stringify({ "claude-opus": { inputPerMtok: 9, outputPerMtok: 45, cacheReadPerMtok: 0.9, cacheWritePerMtok: 11.25 } }));
    const priced = ratesForModel("claude-opus-5")!;
    expect(priced.source).toBe("override");
    expect(priced.rates!.inputPerMtok).toBe(9);
    expect(effectivePricingTable().find(e => e.match === "claude-opus")?.source).toBe("override");
  });
  test("a null override marks a model unpriced", () => {
    setConfigDir("nulling");
    writeFileSync(join(process.env.OMARCHY_AGENTS_CONFIG!, "pricing.json"), JSON.stringify({ "gpt-5": null }));
    expect(ratesForModel("gpt-5.6-sol")).toBeNull();
  });
  test("a broken override file is reported and never blocks built-ins", () => {
    setConfigDir("broken");
    writeFileSync(join(process.env.OMARCHY_AGENTS_CONFIG!, "pricing.json"), "{not json");
    expect(pricingOverrideError()).toBeTruthy();
    expect(ratesForModel("claude-opus-5")?.source).toBe("built-in");
  });
});

describe("cost estimation", () => {
  test("blends the token mix at per-Mtok rates", () => {
    const rates = ratesForModel("claude-opus-5")!;
    const cost = estimateCostUsd(rates.rates!, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 });
    expect(cost).toBeCloseTo(5 + 25 + 0.5);
  });
  test("dominant model follows the heaviest token bucket", () => {
    const model = dominantModel({
      modelUsage: {
        small: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 },
        large: { inputTokens: 5_000_000, outputTokens: 0, cacheReadInputTokens: 0 },
      },
    });
    expect(model).toBe("large");
    expect(dominantModel({ todayTokensByModel: { solo: 42 } })).toBe("solo");
    expect(dominantModel({})).toBeNull();
  });
});
