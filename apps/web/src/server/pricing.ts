import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PricingEntry } from "../shared/schemas";

export type TokenMix = { input: number; output: number; cacheRead: number };
export type Rates = { inputPerMtok: number; outputPerMtok: number; cacheReadPerMtok: number; cacheWritePerMtok: number };
type TableEntry = Rates & { match: string; asOf: string };

export const PRICING_AS_OF = "2026-08-01";

const BUILT_IN: TableEntry[] = [
  { match: "claude-opus", inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25, asOf: PRICING_AS_OF },
  { match: "claude-sonnet", inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75, asOf: PRICING_AS_OF },
  { match: "claude-haiku", inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.1, cacheWritePerMtok: 1.25, asOf: PRICING_AS_OF },
  { match: "gpt-5", inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 0.25, cacheWritePerMtok: 2.5, asOf: PRICING_AS_OF },
  { match: "gpt-4", inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 0.25, cacheWritePerMtok: 2.5, asOf: PRICING_AS_OF },
  { match: "codex", inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 0.25, cacheWritePerMtok: 2.5, asOf: PRICING_AS_OF },
  { match: "deepseek", inputPerMtok: 0.28, outputPerMtok: 1.12, cacheReadPerMtok: 0.028, cacheWritePerMtok: 0.28, asOf: PRICING_AS_OF },
  { match: "kimi", inputPerMtok: 0.6, outputPerMtok: 2.5, cacheReadPerMtok: 0.06, cacheWritePerMtok: 0.6, asOf: PRICING_AS_OF },
  { match: "glm", inputPerMtok: 0.6, outputPerMtok: 2.2, cacheReadPerMtok: 0.11, cacheWritePerMtok: 0.6, asOf: PRICING_AS_OF },
  { match: "qwen", inputPerMtok: 0.55, outputPerMtok: 2.2, cacheReadPerMtok: 0.055, cacheWritePerMtok: 0.55, asOf: PRICING_AS_OF },
  { match: "grok", inputPerMtok: 2, outputPerMtok: 6, cacheReadPerMtok: 0.5, cacheWritePerMtok: 2.5, asOf: PRICING_AS_OF },
  { match: "hy3", inputPerMtok: 0.15, outputPerMtok: 0.6, cacheReadPerMtok: 0.015, cacheWritePerMtok: 0.1875, asOf: PRICING_AS_OF },
  { match: "gemini", inputPerMtok: 0.5, outputPerMtok: 3, cacheReadPerMtok: 0.05, cacheWritePerMtok: 0.625, asOf: PRICING_AS_OF },
  { match: "minimax", inputPerMtok: 0.3, outputPerMtok: 1.2, cacheReadPerMtok: 0.03, cacheWritePerMtok: 0.375, asOf: PRICING_AS_OF },
  { match: "solar", inputPerMtok: 0.5, outputPerMtok: 1.5, cacheReadPerMtok: 0.05, cacheWritePerMtok: 0.625, asOf: PRICING_AS_OF },
  { match: "o4", inputPerMtok: 1.1, outputPerMtok: 4.4, cacheReadPerMtok: 0.11, cacheWritePerMtok: 1.375, asOf: PRICING_AS_OF },
  { match: "muse-spark", inputPerMtok: 1.25, outputPerMtok: 4.25, cacheReadPerMtok: 0.15, cacheWritePerMtok: 1.5625, asOf: PRICING_AS_OF },
  { match: "coding-kimi", inputPerMtok: 0.95, outputPerMtok: 4, cacheReadPerMtok: 0.19, cacheWritePerMtok: 1.1875, asOf: PRICING_AS_OF },
  { match: "gpt-oss", inputPerMtok: 0.2, outputPerMtok: 0.3, cacheReadPerMtok: 0.02, cacheWritePerMtok: 0.25, asOf: PRICING_AS_OF },
  { match: "ox-alpha", inputPerMtok: 2.4, outputPerMtok: 12, cacheReadPerMtok: 0.24, cacheWritePerMtok: 3, asOf: PRICING_AS_OF },
  { match: "x-preview", inputPerMtok: 2.4, outputPerMtok: 12, cacheReadPerMtok: 0.24, cacheWritePerMtok: 3, asOf: PRICING_AS_OF },
  { match: "big-pickle", inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 0.25, cacheWritePerMtok: 2.5, asOf: PRICING_AS_OF },
];

// OpenCode (and other routers) store usage per provider/model, so a model key
// arrives as `opencode-go/deepseek-v4-flash`, `openrouter/openai/o4-mini`, or
// `@cf/deepseek-ai/deepseek-v4-flash-0731`. Strip the leading provider segment
// (repeatedly, in case providers nest) before matching against the rate table.
// Longer names must precede shorter ones so `opencode-go/` wins over `opencode/`.
const PROVIDER_PREFIXES = [
  "cloudflare-workers-ai", "opencode-go", "bai-gpt", "bai-glm", "bai-google", "aihubmix", "antigravity",
  "openrouter", "gmicloud", "aerolink", "gorouter", "orcarouter", "nano-gpt", "openai", "anthropic",
  "microsoft", "google", "meta", "models", "freetoken", "opencode", "venice", "nous", "groq", "x-ai",
  "upstage", "tencent", "bai", "@cf",
];
const PROVIDER_PREFIX = new RegExp(`^(?:${PROVIDER_PREFIXES.join("|")})/`);

// Free-tier variants of paid models (e.g. `hy3-free`, `tencent/hy3:free`,
// `coding-kimi-k3-free`, `muse-spark-1.2-contributor-free`) carry the same
// model id as their paid base. Strip the free marker so the rate table prices
// them at the underlying market rate — the estimate then reflects what the
// usage would cost if it were not free.
const FREE_MARKER = /(?:-contributor)?[-:]?free$/;

const OverrideRates = z.object({
  inputPerMtok: z.coerce.number().min(0), outputPerMtok: z.coerce.number().min(0),
  cacheReadPerMtok: z.coerce.number().min(0), cacheWritePerMtok: z.coerce.number().min(0),
});
const OverridesFile = z.record(z.string(), OverrideRates.nullable());

const configPath = () => {
  const base = process.env.OMARCHY_AGENTS_CONFIG ?? `${process.env.HOME ?? "/tmp"}/.config/omarchy-agents`;
  return join(base, "pricing.json");
};

let cached: { path: string; mtimeMs: number; overrides: z.infer<typeof OverridesFile> | null; error: string | null } = { path: "", mtimeMs: -1, overrides: null, error: null };

function loadOverrides() {
  const path = configPath();
  if (!existsSync(path)) return { path, mtimeMs: -1, overrides: null, error: null };
  const mtimeMs = Math.round(statSync(path).mtimeMs);
  if (cached.path === path && cached.mtimeMs === mtimeMs) return cached;
  try {
    cached = { path, mtimeMs, overrides: OverridesFile.parse(JSON.parse(readFileSync(path, "utf8"))), error: null };
  } catch (error) {
    cached = { path, mtimeMs, overrides: null, error: String(error) };
  }
  return cached;
}

export function pricingOverrideError() { return loadOverrides().error; }

export const normalizeModel = (model: string) => {
  let normalized = String(model ?? "").toLowerCase();
  while (PROVIDER_PREFIX.test(normalized)) normalized = normalized.replace(PROVIDER_PREFIX, "");
  normalized = normalized.replace(/^stealth-/, "");
  return normalized.replace(FREE_MARKER, "");
};

function longestMatch(normalized: string, matches: string[]) {
  return matches.filter(m => normalized.startsWith(m)).sort((a, b) => b.length - a.length)[0] ?? null;
}

export function ratesForModel(model: string): { rates: Rates | null; source: "built-in" | "override"; match: string; asOf: string } | null {
  const normalized = normalizeModel(model);
  const overrides = loadOverrides().overrides ?? {};
  const overrideKeys = Object.keys(overrides);
  const overrideKey = overrideKeys.includes(normalized) ? normalized : longestMatch(normalized, overrideKeys.map(k => normalizeModel(k)));
  if (overrideKey) {
    const raw = overrides[overrideKey];
    if (!raw) return null;
    const original = overrideKeys.find(k => normalizeModel(k) === overrideKey) ?? overrideKey;
    return { rates: OverrideRates.parse(raw), source: "override", match: original, asOf: "override" };
  }
  const match = longestMatch(normalized, BUILT_IN.map(e => e.match));
  if (!match) return null;
  const entry = BUILT_IN.find(e => e.match === match)!;
  return { rates: { inputPerMtok: entry.inputPerMtok, outputPerMtok: entry.outputPerMtok, cacheReadPerMtok: entry.cacheReadPerMtok, cacheWritePerMtok: entry.cacheWritePerMtok }, source: "built-in", match, asOf: entry.asOf };
}

export function dominantModel(record: { modelUsage?: Record<string, any>; todayTokensByModel?: Record<string, any> }) {
  const bucketTotal = (b: any) => Number(b?.inputTokens ?? 0) + Number(b?.outputTokens ?? 0) + Number(b?.cacheReadInputTokens ?? 0) + Number(b?.cacheCreationInputTokens ?? 0);
  const buckets = Object.entries(record.modelUsage ?? {});
  if (buckets.length) {
    return buckets.sort((a, b) => bucketTotal(b[1]) - bucketTotal(a[1]))[0][0];
  }
  // todayTokensByModel may carry either a flat per-model token total or a full
  // token bucket object (Cline's collector emits the latter). Normalize both so
  // the dominant model is always the heaviest today.
  const todayTotal = (v: any) => v && typeof v === "object" ? bucketTotal(v) : Number(v) || 0;
  const todays = Object.entries(record.todayTokensByModel ?? {}).filter(([, v]) => todayTotal(v) > 0);
  if (todays.length) return todays.sort((a, b) => todayTotal(b[1]) - todayTotal(a[1]))[0][0];
  return null;
}

export function estimateCostUsd(rates: Rates, mix: TokenMix) {
  return (mix.input * rates.inputPerMtok + mix.output * rates.outputPerMtok + mix.cacheRead * rates.cacheReadPerMtok + ((mix as any).cacheWrite ?? 0) * rates.cacheWritePerMtok) / 1e6;
}

export function bucketCost(model: string, bucket: any): number {
  if (!bucket || typeof bucket !== "object") return 0;
  const rates = ratesForModel(model);
  if (!rates?.rates) return 0;
  const r = rates.rates;
  const input = Number(bucket.inputTokens ?? 0);
  const output = Number(bucket.outputTokens ?? 0);
  const cacheRead = Number(bucket.cacheReadInputTokens ?? 0);
  const cacheWrite = Number(bucket.cacheCreationInputTokens ?? 0);
  return (input * r.inputPerMtok + output * r.outputPerMtok + cacheRead * r.cacheReadPerMtok + cacheWrite * r.cacheWritePerMtok) / 1e6;
}

export function estimateTokensCost(model: string, tokens: number): number {
  const n = Number(tokens ?? 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const rates = ratesForModel(model);
  if (!rates?.rates) return 0;
  const blended = rates.rates.inputPerMtok * 0.75 + rates.rates.outputPerMtok * 0.25;
  return (n * blended) / 1e6;
}

export function allTimeRecordCost(record: any): number {
  const usage = record?.modelUsage ?? {};
  let totalCost = 0;
  let modelTokensSum = 0;
  for (const [modelId, bucket] of Object.entries(usage)) {
    totalCost += bucketCost(modelId, bucket);
    modelTokensSum += Number((bucket as any)?.inputTokens ?? 0) + Number((bucket as any)?.outputTokens ?? 0) + Number((bucket as any)?.cacheReadInputTokens ?? 0) + Number((bucket as any)?.cacheCreationInputTokens ?? 0);
  }
  const allTokens = Math.max(modelTokensSum, (record?.recentDays ?? []).reduce((s: number, d: any) => s + Number(d?.messageCount ?? 0), 0), Number(record?.todayTotalTokens ?? 0));
  if (modelTokensSum > 0 && allTokens > modelTokensSum) {
    totalCost = (totalCost / modelTokensSum) * allTokens;
  } else if (modelTokensSum === 0 && allTokens > 0) {
    const dom = dominantModel(record);
    if (dom) totalCost = estimateTokensCost(dom, allTokens);
  }
  return totalCost;
}

export function todayRecordCost(record: any): number {
  const todayByModel = record?.todayTokensByModel ?? {};
  const entries = Object.entries(todayByModel);
  if (entries.length > 0) {
    let cost = 0;
    for (const [modelId, val] of entries) {
      if (val && typeof val === "object") {
        cost += bucketCost(modelId, val);
      } else {
        const t = Number(val ?? 0);
        if (t <= 0) continue;
        const histBucket = record?.modelUsage?.[modelId];
        const histTokens = histBucket ? Number(histBucket.inputTokens ?? 0) + Number(histBucket.outputTokens ?? 0) + Number(histBucket.cacheReadInputTokens ?? 0) + Number(histBucket.cacheCreationInputTokens ?? 0) : 0;
        if (histTokens > 0) {
          const histCost = bucketCost(modelId, histBucket);
          cost += (histCost / histTokens) * t;
        } else {
          cost += estimateTokensCost(modelId, t);
        }
      }
    }
    return cost;
  }
  const todayTokens = Number(record?.todayTotalTokens ?? 0);
  if (todayTokens <= 0) return 0;
  const allCost = allTimeRecordCost(record);
  const allTokens = Math.max(1, Number(record?.todayTotalTokens ?? 0), (record?.recentDays ?? []).reduce((s: number, d: any) => s + Number(d?.messageCount ?? 0), 0));
  if (allCost > 0 && allTokens > 0) {
    return (allCost / allTokens) * todayTokens;
  }
  const dom = dominantModel(record);
  if (dom) return estimateTokensCost(dom, todayTokens);
  return 0;
}

export function estimateRecordCost(record: any, period: string): number {
  if (!record) return 0;
  if (period === "today") return todayRecordCost(record);
  if (period === "all") return allTimeRecordCost(record);
  const weekTokens = (record?.recentDays ?? []).reduce((s: number, d: any) => s + Number(d?.messageCount ?? 0), 0);
  if (weekTokens <= 0) return 0;
  const allCost = allTimeRecordCost(record);
  const allTokens = Math.max(weekTokens, Number(record?.todayTotalTokens ?? 0), Object.values(record?.modelUsage ?? {}).reduce((sum: number, b: any) => sum + Number((b as any)?.inputTokens ?? 0) + Number((b as any)?.outputTokens ?? 0) + Number((b as any)?.cacheReadInputTokens ?? 0) + Number((b as any)?.cacheCreationInputTokens ?? 0), 0));
  if (allCost > 0 && allTokens > 0) {
    return (allCost / allTokens) * weekTokens;
  }
  const dom = dominantModel(record);
  if (dom) return estimateTokensCost(dom, weekTokens);
  return 0;
}

export function effectivePricingTable(): PricingEntry[] {
  const overrides = loadOverrides().overrides ?? {};
  const entries: PricingEntry[] = [];
  const covered = new Set<string>();
  for (const [key, raw] of Object.entries(overrides)) {
    if (!raw) continue;
    entries.push({ model: key, match: key, source: "override", asOf: "override", currency: "USD", ...raw });
  }
  for (const entry of BUILT_IN) {
    const overridden = Object.keys(overrides).some(k => normalizeModel(k) === entry.match && overrides[k]);
    if (overridden) continue;
    covered.add(entry.match);
    entries.push({ model: entry.match, match: entry.match, source: "built-in", asOf: entry.asOf, currency: "USD", inputPerMtok: entry.inputPerMtok, outputPerMtok: entry.outputPerMtok, cacheReadPerMtok: entry.cacheReadPerMtok, cacheWritePerMtok: entry.cacheWritePerMtok });
  }
  return entries.sort((a, b) => a.model.localeCompare(b.model));
}
