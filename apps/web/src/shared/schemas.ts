import { z } from "zod";

const tokenBucket = z.object({
  inputTokens: z.coerce.number().optional(), outputTokens: z.coerce.number().optional(),
  cacheReadInputTokens: z.coerce.number().optional(), cacheCreationInputTokens: z.coerce.number().optional()
}).passthrough();

export const UsageRecordV1 = z.object({
  id: z.string(), name: z.string().optional(), todayTotalTokens: z.coerce.number().optional(),
  todayPrompts: z.coerce.number().optional(), todaySessions: z.coerce.number().optional(),
  totalPrompts: z.coerce.number().optional(), totalSessions: z.coerce.number().optional(), activeDays: z.coerce.number().optional(),
  recentDays: z.array(z.object({ date: z.string(), messageCount: z.coerce.number().default(0) }).passthrough()).optional(),
  modelUsage: z.record(z.string(), tokenBucket).optional(), todayTokensByModel: z.record(z.string(), z.coerce.number()).optional(),
  hasPromptStats: z.boolean().optional(), updatedAt: z.string().optional()
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
