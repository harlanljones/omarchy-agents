import { z } from "zod";

const tokenBucket = z.object({
  inputTokens: z.coerce.number().optional(), outputTokens: z.coerce.number().optional(),
  cacheReadInputTokens: z.coerce.number().optional(), cacheCreationInputTokens: z.coerce.number().optional()
}).passthrough();

export const LimitWindowRecord = z.object({
  label: z.string(), percent: z.coerce.number(),
  resetsAt: z.string().optional(), title: z.string().optional()
}).passthrough();

export const BalanceRecord = z.object({
  remaining: z.coerce.number(), funded: z.coerce.number().optional(), spent: z.coerce.number().optional(),
  currency: z.string().optional(), estimated: z.boolean().optional()
}).passthrough();

export const UsageRecordV1 = z.object({
  id: z.string(), name: z.string().optional(), todayTotalTokens: z.coerce.number().optional(),
  todayPrompts: z.coerce.number().optional(), todaySessions: z.coerce.number().optional(),
  totalPrompts: z.coerce.number().optional(), totalSessions: z.coerce.number().optional(), activeDays: z.coerce.number().optional(),
  recentDays: z.array(z.object({ date: z.string(), messageCount: z.coerce.number().default(0) }).passthrough()).optional(),
  modelUsage: z.record(z.string(), tokenBucket).optional(), todayTokensByModel: z.record(z.string(), z.coerce.number()).optional(),
  hasPromptStats: z.boolean().optional(), updatedAt: z.string().optional(),
  limits: z.array(LimitWindowRecord).optional(), balance: BalanceRecord.optional(),
  tierLabel: z.string().optional(), ready: z.boolean().optional(), scope: z.string().optional(),
  usageStatusText: z.string().optional(), authHelpText: z.string().optional()
}).passthrough();

export const NormalizedSession = z.object({
  id: z.string(), provider: z.string(), model: z.string().nullable().default(null), project: z.string().nullable().default(null),
  title: z.string().nullable().default(null), startedAt: z.string(), endedAt: z.string().nullable().default(null),
  sourcePath: z.string(), sourceKey: z.string(), tokenInput: z.number().int().nonnegative().default(0),
  tokenOutput: z.number().int().nonnegative().default(0), cacheRead: z.number().int().nonnegative().default(0),
  cacheWrite: z.number().int().nonnegative().default(0), errorCount: z.number().int().nonnegative().default(0),
  toolCount: z.number().int().nonnegative().default(0), metadata: z.record(z.string(), z.unknown()).default({})
});

export const LogEvent = z.object({
  id: z.string(), sessionId: z.string(), ordinal: z.number().int().nonnegative(),
  kind: z.enum(["prompt", "response", "tool_call", "tool_result", "error", "system", "unknown"]),
  timestamp: z.string(), text: z.string(), toolName: z.string().nullable().default(null), sourceLocator: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

export const EvidenceCitation = z.object({
  id: z.string(), provider: z.string(), sessionId: z.string(), eventId: z.string(), timestamp: z.string(), excerpt: z.string()
});
export const Suggestion = z.object({
  id: z.string(), reportId: z.string(), title: z.string(), impact: z.enum(["low", "medium", "high"]),
  effort: z.enum(["low", "medium", "high"]), confidence: z.number().min(0).max(1), rationale: z.string(),
  evidence: z.array(EvidenceCitation), status: z.enum(["open", "accepted", "dismissed"]), createdAt: z.string()
});
export const AnalysisReport = z.object({
  id: z.string(), createdAt: z.string(), periodStart: z.string(), periodEnd: z.string(), model: z.string(),
  summary: z.string(), detectors: z.array(z.object({ type: z.string(), severity: z.enum(["info", "warning", "critical"]), message: z.string(), value: z.number().optional(), evidence: z.array(EvidenceCitation) })),
  suggestions: z.array(Suggestion)
});
export type UsageRecord = z.infer<typeof UsageRecordV1>;
export type Session = z.infer<typeof NormalizedSession>;
export type Event = z.infer<typeof LogEvent>;
export type Citation = z.infer<typeof EvidenceCitation>;

export type LimitKind = "session" | "weekly" | "monthly" | "other";
export type LimitWindowView = {
  kind: LimitKind, title: string, label: string,
  used: number, resetsAt: string | null
};
export type BalanceView = {
  remaining: number, funded: number | null, spent: number | null,
  currency: string, estimated: boolean
};
export type PlatformStatus = "ready" | "auth-needed" | "stale" | "no-data";
export type PlatformLimits = {
  providerId: string, providerName: string, tier: string,
  status: PlatformStatus, statusText: string,
  windows: LimitWindowView[], binding: LimitWindowView | null,
  balance: BalanceView | null,
  updatedAt: string | null, coverage: string
};
export type LimitsBoard = {
  generatedAt: string, platforms: PlatformLimits[],
  index: { state: string, scanned: number, indexed: number, total: number, current: string, startedAt: string, finishedAt: string, errors: number }
};
export type AdviceVerdict = "recommended" | "usable" | "tight" | "wait" | "unavailable";
export type AdviceRow = {
  providerId: string, providerName: string,
  verdict: AdviceVerdict, score: number,
  headroom: number | null, fitsTask: boolean | null,
  estCostUsd: number | null, unpricedModels: string[],
  reasons: string[], bindingResetsAt: string | null
};
export type AdviceResponse = {
  generatedAt: string, mode: "general" | "task", verdictLine: string,
  taskTokens: { input: number, output: number, cacheRead: number } | null,
  fallbackProviderId: string | null, fallbackProviderName: string | null,
  recommendationResetsAt: string | null,
  confidence: "high" | "medium" | "low",
  rows: AdviceRow[]
};
export type PricingSource = "built-in" | "override";
export type PricingEntry = {
  model: string, match: string,
  inputPerMtok: number, outputPerMtok: number,
  cacheReadPerMtok: number, cacheWritePerMtok: number,
  currency: string, asOf: string, source: PricingSource
};
export const ProductivitySourceStatus = z.enum(["fresh", "empty", "stale", "rate-limited", "unconfigured", "error"]);
export const ProductivityResponseV1 = z.object({
  range: z.object({ from: z.string(), to: z.string(), timeZone: z.string() }),
  generatedAt: z.string(),
  tokens: z.object({ total: z.number(), daily: z.array(z.object({ day: z.string(), tokens: z.number() })) }),
  commits: z.object({
    total: z.number(),
    daily: z.array(z.object({ day: z.string(), count: z.number() })),
    repos: z.array(z.object({ repository: z.string(), count: z.number() })),
  }),
  tasks: z.object({
    total: z.number(),
    daily: z.array(z.object({ day: z.string(), count: z.number() })),
    teams: z.array(z.object({ id: z.string(), team: z.string(), count: z.number() })),
  }),
  ratios: z.object({ tokensPerCommit: z.number().nullable(), tokensPerTask: z.number().nullable() }),
  filters: z.object({ repo: z.string().nullable(), team: z.string().nullable() }),
  sources: z.array(z.object({
    id: z.enum(["github", "linear"]),
    name: z.string(),
    status: ProductivitySourceStatus,
    lastSyncedAt: z.string().nullable(),
    error: z.string().nullable(),
    recordCount: z.number().int().nonnegative(),
    coverage: z.object({ from: z.string(), to: z.string() }).nullable(),
  })),
});
export type ProductivitySourceState = z.infer<typeof ProductivityResponseV1>["sources"][number];
export type ProductivityResponse = z.infer<typeof ProductivityResponseV1>;
export type PromptComplexity = "low" | "medium" | "high";
export type PromptAnalysis = {
  redactedPrompt: string, complexity: PromptComplexity, score: number,
  dimensions: Array<{ name: string, score: number, evidence: string }>,
  requiredCapabilities: string[], unknowns: string[], warnings: string[],
  recommendations: Array<{ model: string, provider: string | null, fit: "recommended" | "fallback" | "caution", rationale: string, estimatedCostUsd: number | null, estimatedLatencyMs: number | null, confidence: "high" | "medium" | "low" }>,
  source: "prompt" | "session", analyzedAt: string
};
