import { z } from "zod";

// Collectors occasionally emit NaN/Infinity (scrape races, div-by-zero).
// z.coerce.number() rejects NaN, which would void the ENTIRE provider record —
// one bad counter must coerce to 0 instead of discarding every other field.
const finite = (v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? 0 : v);
const safeNumber = z.preprocess(finite, z.coerce.number());

const tokenBucket = z.object({
  inputTokens: safeNumber.optional(), outputTokens: safeNumber.optional(),
  cacheReadInputTokens: safeNumber.optional(), cacheCreationInputTokens: safeNumber.optional()
}).passthrough();

export const LimitWindowRecord = z.object({
  label: z.string(), percent: safeNumber,
  resetsAt: z.string().optional(), title: z.string().optional()
}).passthrough();

export const BalanceRecord = z.object({
  remaining: safeNumber, funded: safeNumber.optional(), spent: safeNumber.optional(),
  currency: z.string().optional(), estimated: z.boolean().optional()
}).passthrough();

export const UsageRecordV1 = z.object({
  id: z.string(), name: z.string().optional(), todayTotalTokens: safeNumber.optional(),
  todayPrompts: safeNumber.optional(), todaySessions: safeNumber.optional(),
  totalPrompts: safeNumber.optional(), totalSessions: safeNumber.optional(), activeDays: safeNumber.optional(),
  recentDays: z.array(z.object({ date: z.string(), messageCount: safeNumber.default(0) }).passthrough()).optional(),
  modelUsage: z.record(z.string(), tokenBucket).optional(), todayTokensByModel: z.record(z.string(), z.union([safeNumber, tokenBucket])).optional(),
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

export const MetricKind = z.enum([
  "tool_failure_rate",
  "tokens_per_session",
  "average_duration_minutes",
  "cache_read_ratio",
]);
export const ExperimentState = z.enum(["draft", "active", "ready_for_review", "completed"]);
export const CohortKind = z.enum(["baseline", "trial"]);
export const ExperimentOutcome = z.enum(["adopt_change", "extend_trial", "no_improvement"]);
export const SampleNote = z.enum(["small_sample", "uneven_cohorts", "descriptive_only"]);

export const EvidenceCitation = z.object({
  id: z.string(),
  provider: z.string(),
  sessionId: z.string(),
  anchor: z.enum(["session", "event"]).default("event"),
  eventId: z.string().nullable().default(null),
  timestamp: z.string(),
  excerpt: z.string(),
}).superRefine((citation, context) => {
  if (citation.anchor === "event" && citation.eventId === null) {
    context.addIssue({ code: "custom", path: ["eventId"], message: "event citations require eventId" });
  }
  if (citation.anchor === "session" && citation.eventId !== null) {
    context.addIssue({ code: "custom", path: ["eventId"], message: "session citations require a null eventId" });
  }
});

export const Finding = z.object({
  key: z.string(),
  type: z.string(),
  provider: z.string().nullable().default(null),
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string(),
  value: z.number().optional(),
  evidence: z.array(EvidenceCitation),
});
export const ExperimentDefaults = z.object({
  hypothesis: z.string().trim().min(1).max(1000),
  metricKind: MetricKind,
  metricVersion: z.literal(1),
  targetValue: z.number().finite().nonnegative(),
});
export const Suggestion = z.object({
  id: z.string(),
  reportId: z.string(),
  findingKey: z.string().nullable(),
  title: z.string(),
  impact: z.enum(["low", "medium", "high"]),
  effort: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  evidence: z.array(EvidenceCitation),
  status: z.enum(["open", "accepted", "dismissed"]),
  createdAt: z.string(),
  experiment: ExperimentDefaults.nullable(),
  experimentId: z.string().nullable(),
});
export const AnalysisReport = z.object({
  id: z.string(),
  createdAt: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  model: z.string(),
  summary: z.string(),
  detectors: z.array(Finding),
  suggestions: z.array(Suggestion),
});

const uniqueIds = (ids: string[], context: z.RefinementCtx) => {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "session IDs must be unique" });
  }
};
export const CreateExperimentInput = z.object({
  suggestionId: z.string().min(1),
  hypothesis: z.string().trim().min(1).max(1000),
  metricKind: MetricKind,
  targetValue: z.number().finite().nonnegative(),
  baselineSessionIds: z.array(z.string().min(1)).min(1),
}).superRefine((value, context) => uniqueIds(value.baselineSessionIds, context));
export const ReplaceCohortInput = z.object({
  sessionIds: z.array(z.string().min(1)),
}).superRefine((value, context) => uniqueIds(value.sessionIds, context));
export const ReviewExperimentInput = z.object({
  outcome: ExperimentOutcome,
  note: z.string().trim().min(1).max(1000),
});
export type UsageRecord = z.infer<typeof UsageRecordV1>;
export type Session = z.infer<typeof NormalizedSession>;
export type Event = z.infer<typeof LogEvent>;
export type Citation = z.infer<typeof EvidenceCitation>;
export type MetricKind = z.infer<typeof MetricKind>;
export type ExperimentState = z.infer<typeof ExperimentState>;
export type CohortKind = z.infer<typeof CohortKind>;
export type ExperimentOutcome = z.infer<typeof ExperimentOutcome>;
export type SampleNote = z.infer<typeof SampleNote>;
export type Finding = z.infer<typeof Finding>;
export type ExperimentDefaults = z.infer<typeof ExperimentDefaults>;
export type Suggestion = z.infer<typeof Suggestion>;
export type AnalysisReport = z.infer<typeof AnalysisReport>;
export type CreateExperimentInput = z.infer<typeof CreateExperimentInput>;
export type ReplaceCohortInput = z.infer<typeof ReplaceCohortInput>;
export type ReviewExperimentInput = z.infer<typeof ReviewExperimentInput>;
export type ExclusionReason = "session_missing" | "zero_denominator" | "invalid_duration";
export type SessionContribution = {
  sessionId: string;
  cohort: CohortKind;
  provider: string;
  startedAt: string;
  endedAt: string | null;
  value: number;
  numerator: number | null;
  denominator: number | null;
};
export type ExcludedSession = { sessionId: string; reason: ExclusionReason };
export type CohortCalculation = {
  value: number | null;
  formatted: string;
  validCount: number;
  contributions: SessionContribution[];
  excluded: ExcludedSession[];
};
export type ExperimentCalculation = {
  metricKind: MetricKind;
  metricVersion: 1;
  direction: "lower" | "higher";
  targetValue: number;
  baseline: CohortCalculation;
  trial: CohortCalculation;
  absoluteDelta: number | null;
  directionalDelta: number | null;
  targetMet: boolean | null;
  improved: boolean | null;
  sampleNote: SampleNote;
  calculatedAt: string;
};
export type ExperimentSourceSnapshot = {
  findingKey: string;
  finding: Finding | null;
  suggestion: {
    title: string;
    rationale: string;
    evidence: Citation[];
    defaults: ExperimentDefaults;
  };
};
export type ExperimentReviewRecord = {
  id: string;
  outcome: ExperimentOutcome;
  note: string;
  calculation: ExperimentCalculation;
  createdAt: string;
};
export type ExperimentSummary = {
  id: string;
  title: string;
  state: ExperimentState;
  metricKind: MetricKind;
  sourceSuggestionId: string;
  createdAt: string;
  updatedAt: string;
};
export type ExperimentSessionView = {
  sessionId: string; cohort: CohortKind; available: boolean;
  provider: string | null; title: string | null; startedAt: string | null; endedAt: string | null;
  tokenTotal: number | null; errorCount: number | null; toolCount: number | null;
  evidenceEventId: string | null;
};

export type ExperimentDetail = ExperimentSummary & {
  sourceReportId: string;
  source: ExperimentSourceSnapshot;
  hypothesis: string;
  metricVersion: 1;
  targetValue: number;
  cohorts: Record<CohortKind, string[]>;
  sessions: ExperimentSessionView[];
  currentCalculation: ExperimentCalculation;
  reviews: ExperimentReviewRecord[];
  availableActions: {
    replaceBaseline: boolean;
    replaceTrial: boolean;
    start: boolean;
    markReady: boolean;
    review: boolean;
  };
};

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
export type TaskProfile = { requiredCapabilities: string[], preferredProviders: string[] };
export type AdviceRow = {
  providerId: string, providerName: string,
  verdict: AdviceVerdict, score: number,
  headroom: number | null, fitsTask: boolean | null,
  estCostUsd: number | null, unpricedModels: string[],
  reasons: string[], bindingResetsAt: string | null,
  excludedByProfile: boolean
};
export type AdviceResponse = {
  generatedAt: string, mode: "general" | "task", verdictLine: string,
  taskTokens: { input: number, output: number, cacheRead: number } | null,
  fallbackProviderId: string | null, fallbackProviderName: string | null,
  recommendationResetsAt: string | null,
  confidence: "high" | "medium" | "low",
  profile: TaskProfile | null,
  rows: AdviceRow[]
};
export type PricingSource = "built-in" | "override";
export type AlertRule = "threshold-20" | "threshold-10" | "exhausted" | "projected-exhaustion" | "collector-stale" | "auth-needed";
export type AlertSeverity = "warning" | "critical";
export type AlertView = {
  id: string, providerId: string, providerName: string,
  rule: AlertRule, severity: AlertSeverity,
  windowLabel: string | null, resetsAt: string | null,
  message: string, firedAt: string, resolvedAt: string | null
};
export type ForecastView = {
  providerId: string, providerName: string, windowLabel: string, kind: LimitKind,
  samples: number, resetsAt: string | null, sufficient: boolean,
  ratePerHour: number | null, projectedExhaustionAt: string | null
};
export type AlertsResponse = {
  generatedAt: string, active: AlertView[], recent: AlertView[], forecasts: ForecastView[]
};
export type IncidentKind = "threshold" | "provider-switch" | "actual-reset" | "forecast-accuracy";
export type IncidentView = {
  id: string, kind: IncidentKind, occurredAt: string,
  providerId: string | null, providerName: string,
  summary: string, detail: string
};
export type IncidentsResponse = { generatedAt: string, incidents: IncidentView[] };
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
  correlations: z.object({
    tokensCommits: z.array(z.object({ day: z.string(), tokens: z.number(), count: z.number() })),
    tokensTasks: z.array(z.object({ day: z.string(), tokens: z.number(), count: z.number() })),
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
export const ProductivityActivityResponseV1 = z.object({
  range: z.object({ from: z.string(), to: z.string(), timeZone: z.string() }),
  generatedAt: z.string(),
  filters: z.object({ repo: z.string().nullable(), team: z.string().nullable() }),
  commits: z.array(z.object({ sha: z.string(), repository: z.string(), committedAt: z.string(), url: z.string() })),
  tasks: z.array(z.object({ issueId: z.string(), identifier: z.string(), teamId: z.string(), team: z.string(), title: z.string(), completedAt: z.string(), url: z.string() })),
});
export type ProductivityActivityResponse = z.infer<typeof ProductivityActivityResponseV1>;
export type PromptComplexity = "low" | "medium" | "high";
export type PromptAnalysis = {
  redactedPrompt: string, complexity: PromptComplexity, score: number,
  dimensions: Array<{ name: string, score: number, evidence: string }>,
  requiredCapabilities: string[], unknowns: string[], warnings: string[],
  recommendations: Array<{ model: string, provider: string | null, fit: "recommended" | "fallback" | "caution", rationale: string, estimatedCostUsd: number | null, estimatedLatencyMs: number | null, confidence: "high" | "medium" | "low" }>,
  source: "prompt" | "session", analyzedAt: string
};
