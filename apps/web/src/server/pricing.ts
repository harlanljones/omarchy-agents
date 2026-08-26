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
];

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

export const normalizeModel = (model: string) => String(model ?? "").toLowerCase().replace(/^(@cf\/|models\/|(?:openai|anthropic|google|meta|microsoft)\/)/, "");

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
  return (mix.input * rates.inputPerMtok + mix.output * rates.outputPerMtok + mix.cacheRead * rates.cacheReadPerMtok) / 1e6;
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
