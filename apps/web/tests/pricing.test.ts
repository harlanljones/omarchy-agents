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
    expect(ratesForModel("hy3-free")?.match).toBe("hy3");
    expect(ratesForModel("grok-4.6")?.match).toBe("grok");
    expect(ratesForModel("gpt-oss-20b")?.match).toBe("gpt-oss");
    expect(ratesForModel("o4-mini")?.match).toBe("o4");
  });
  test("vendor prefixes and casings are normalized away", () => {
    expect(normalizeModel("@cf/deepseek-ai/deepseek-v4-flash-0731")).toBe("deepseek-ai/deepseek-v4-flash-0731");
    expect(normalizeModel("Anthropic/Claude-Opus-5")).toBe("claude-opus-5");
    expect(ratesForModel("Claude-Sonnet-5")?.match).toBe("claude-sonnet");
  });
  test("opencode provider/model keys price at the underlying market rate", () => {
    expect(ratesForModel("opencode-go/deepseek-v4-flash")?.match).toBe("deepseek");
    expect(ratesForModel("opencode-go/hy3")?.match).toBe("hy3");
    expect(ratesForModel("opencode/x-preview-f-free")?.match).toBe("x-preview");
    expect(ratesForModel("venice/stealth-ox-alpha")?.match).toBe("ox-alpha");
    expect(ratesForModel("openrouter/openai/o4-mini")?.match).toBe("o4");
    expect(ratesForModel("groq/qwen/qwen3.8-27b")?.match).toBe("qwen");
    expect(ratesForModel("freetoken/gpt-oss-20b")?.match).toBe("gpt-oss");
  });
  test("free-tier markers strip so free usage prices as if it were paid", () => {
    expect(ratesForModel("hy3-free")?.rates!.inputPerMtok).toBe(0.15);
    expect(ratesForModel("tencent/hy3:free")?.match).toBe("hy3");
    expect(ratesForModel("coding-kimi-k3-free")?.match).toBe("coding-kimi");
    expect(ratesForModel("muse-spark-1.2-contributor-free")?.match).toBe("muse-spark");
    expect(ratesForModel("ox-alpha-free")?.match).toBe("ox-alpha");
  });
  test("unknown models are unpriced rather than guessed", () => {
    expect(ratesForModel("zz-unknown-model")).toBeNull();
    expect(ratesForModel("mystery-vendor-alpha")).toBeNull();
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
    expect(dominantModel({ todayTokensByModel: { a: 1, larger: 9 } })).toBe("larger");
    // Cline's collector emits per-model token buckets in todayTokensByModel,
    // not flat totals; the dominant model must still be the heaviest bucket.
    expect(dominantModel({ todayTokensByModel: { small: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 1 }, big: { inputTokens: 5_000_000, outputTokens: 0, cacheReadInputTokens: 0 } } })).toBe("big");
    expect(dominantModel({ todayTokensByModel: { a: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 }, b: { inputTokens: 3, outputTokens: 0, cacheReadInputTokens: 0 } } })).toBe("b");
    expect(dominantModel({})).toBeNull();
  });
});
