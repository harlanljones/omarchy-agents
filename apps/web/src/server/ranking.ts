import type { UsageRecord } from "../shared/schemas";
import { isIndexed } from "./providers";
import { estimateRecordCost } from "./pricing";

const n = (v: unknown) => Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0;
export const bucketTotal = (b: any) => n(b?.inputTokens) + n(b?.outputTokens) + n(b?.cacheReadInputTokens) + n(b?.cacheCreationInputTokens);
export const recentTotal = (r: UsageRecord) => (r.recentDays ?? []).reduce((sum, d) => sum + n(d.messageCount), 0);
export const allTotal = (r: UsageRecord) => Math.max(Object.values(r.modelUsage ?? {}).reduce((sum, b) => sum + bucketTotal(b), 0), recentTotal(r), n(r.todayTotalTokens));

export function rank(records: UsageRecord[], period: string) {
  const rows = records.flatMap(record => {
    let tokens = period === "today" ? n(record.todayTotalTokens) : period === "week" ? recentTotal(record) : allTotal(record);
    if (tokens <= 0) return [];
    const transcriptCoverage = isIndexed(record.id) ? "indexed" : "metrics-only";
    const estCostUsd = estimateRecordCost(record, period);
    return [{ providerId: record.id, providerName: record.name ?? record.id, tokens, estCostUsd, recentDays: record.recentDays ?? [], updatedAt: record.updatedAt ?? "", coverage: transcriptCoverage }];
  }).sort((a, b) => b.tokens - a.tokens || a.providerName.localeCompare(b.providerName));
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  const totalCostUsd = rows.reduce((s, r) => s + (r.estCostUsd ?? 0), 0);
  let last = -1, rankValue = 0;
  return { period, total, totalCostUsd, rows: rows.map((r, i) => { if (r.tokens !== last) { rankValue = i + 1; last = r.tokens; } return { ...r, rank: rankValue, share: total ? r.tokens / total : 0 }; }) };
}
