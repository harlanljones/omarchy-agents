import { db, json } from "./db";
import { UsageRecordV1, type AdviceResponse, type AdviceRow, type AdviceVerdict, type LimitKind, type LimitWindowView, type LimitsBoard, type PlatformLimits, type PlatformStatus, type UsageRecord } from "../shared/schemas";
import { indexProgress } from "./indexer";
import { dominantModel, estimateCostUsd, ratesForModel, type TokenMix } from "./pricing";

export function loadUsageRecords(): UsageRecord[] {
  return (db.query("SELECT record_json FROM usage_records").all() as any[])
    .flatMap(row => { const parsed = UsageRecordV1.safeParse(json(row.record_json, {})); return parsed.success ? [parsed.data] : []; });
}

const kindFromTitle = (title: string): LimitKind | null => {
  const t = title.toLowerCase();
  if (t.includes("month")) return "monthly";
  if (t.includes("week") || t.includes("7-day")) return "weekly";
  if (t.includes("session") || /\d+\s*h/.test(t)) return "session";
  return null;
};

const kindFromLabel = (label: string): LimitKind => {
  const t = label.toLowerCase();
  if (t.includes("month") || t.includes("30-day")) return "monthly";
  if (t.includes("week") || t.includes("7-day") || t.includes("seven")) return "weekly";
  if (t.includes("session") || /\d+\s*-?\s*h(our)?\b/.test(t)) return "session";
  return "other";
};

export function classifyWindow(label: string, title?: string): LimitKind {
  return (title ? kindFromTitle(title) : null) ?? kindFromLabel(label);
}

export function formatDuration(ms: number) {
  if (!(ms > 0)) return "now";
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${(minutes % 60)}m`;
  return `${Math.max(1, minutes)}m`;
}

function normalizeWindows(record: UsageRecord): LimitWindowView[] {
  return (record.limits ?? [])
    .map(entry => ({
      kind: classifyWindow(String(entry.label ?? ""), entry.title),
      title: String(entry.title ?? entry.label ?? "Limit"),
      label: String(entry.label ?? ""),
      used: Math.max(0, Number(entry.percent ?? 0)),
      resetsAt: entry.resetsAt && !Number.isNaN(new Date(entry.resetsAt).valueOf()) ? new Date(entry.resetsAt).toISOString() : null,
    }))
    .filter(w => Number.isFinite(w.used));
}

function deriveStatus(record: UsageRecord): PlatformStatus {
  if (record.ready === false) return "auth-needed";
  const updated = record.updatedAt ? new Date(record.updatedAt).valueOf() : NaN;
  if (!Number.isNaN(updated) && Date.now() - updated > 26 * 3600_000) return "stale";
  const hasSignals = (record.limits?.length ?? 0) > 0 || !!record.balance || Number(record.todayTotalTokens ?? 0) > 0 || (record.recentDays ?? []).some(d => d.messageCount > 0);
  return hasSignals ? "ready" : "no-data";
}

export function buildPlatformLimits(record: UsageRecord, now = Date.now()): PlatformLimits {
  const windows = normalizeWindows(record);
  const binding = windows.length ? windows.reduce((best, w) => (w.used > best.used ? w : best)) : null;
  const balance = record.balance
    ? { remaining: Math.max(0, Number(record.balance.remaining)), funded: record.balance.funded != null ? Number(record.balance.funded) : null, spent: record.balance.spent != null ? Number(record.balance.spent) : null, currency: String(record.balance.currency ?? "USD"), estimated: record.balance.estimated === true }
    : null;
  return {
    providerId: record.id,
    providerName: record.name ?? record.id,
    tier: String(record.tierLabel ?? ""),
    status: deriveStatus(record),
    statusText: String(record.usageStatusText ?? record.authHelpText ?? ""),
    windows,
    binding,
    balance,
    updatedAt: record.updatedAt ?? null,
    coverage: ["claude", "codex", "opencode"].includes(record.id) ? "indexed" : "metrics-only",
  };
}

export function headroomOf(platform: PlatformLimits): number | null {
  if (platform.balance && platform.balance.funded && platform.balance.funded > 0)
    return Math.max(0, Math.min(1, platform.balance.remaining / platform.balance.funded));
  if (platform.binding) return Math.max(0, 1 - platform.binding.used);
  return null;
}

const weeklyBurnEstimate = (record: UsageRecord): number | null => {
  const active = (record.recentDays ?? []).slice(-7).filter(d => d.messageCount > 0).map(d => d.messageCount);
  if (active.length) return Math.round((active.reduce((a, b) => a + b, 0) / active.length) * 7);
  if (Number(record.todayTotalTokens ?? 0) > 0) return Math.round(Number(record.todayTotalTokens) * 7);
  return null;
};

export const TASK_PRESETS: Record<string, TokenMix> = {
  small: { input: 70_000, output: 12_500, cacheRead: 167_500 },
  medium: { input: 420_000, output: 75_000, cacheRead: 1_005_000 },
  large: { input: 1_680_000, output: 300_000, cacheRead: 4_020_000 },
};
const mixTotal = (mix: TokenMix) => mix.input + mix.output + mix.cacheRead;

const VERDICT_ORDER: AdviceVerdict[] = ["recommended", "usable", "tight", "wait", "unavailable"];

export function advise(records: UsageRecord[], taskMix: TokenMix | null, now = Date.now()): AdviceResponse {
  const platforms = records.map(r => buildPlatformLimits(r, now));
  const rows: AdviceRow[] = platforms.map(platform => {
    const record = records.find(r => r.id === platform.providerId)!;
    const reasons: string[] = [];
    let verdict: AdviceVerdict, score: number;
    const headroom = headroomOf(platform);

    if (platform.status !== "ready") {
      verdict = "unavailable"; score = 0;
      reasons.push(platform.status === "auth-needed" ? "Needs attention before it can be used" : platform.status === "stale" ? "Data is stale (over a day old)" : "No usage recorded yet");
      if (platform.statusText) reasons.push(platform.statusText);
    } else if (headroom == null) {
      verdict = "usable"; score = 75;
      reasons.push("No reported limits — assume fair use");
      if (!platform.windows.length && !platform.balance) reasons.push(platform.tier ? `${platform.tier}: no rate-limit feed` : "Collector reports no limit windows");
    } else {
      score = Math.round(headroom * 100);
      verdict = headroom >= 0.5 ? "recommended" : headroom >= 0.25 ? "usable" : headroom > 0 ? "tight" : "wait";
      if (verdict === "wait") {
        const nextReset = platform.windows.filter(w => w.resetsAt && new Date(w.resetsAt).valueOf() > now).sort((a, b) => new Date(a.resetsAt!).valueOf() - new Date(b.resetsAt!).valueOf())[0];
        reasons.push(nextReset ? `Exhausted — resets in ${formatDuration(new Date(nextReset.resetsAt!).valueOf() - now)}` : "Exhausted");
      } else if (headroom < 0.25) reasons.push(`Only ${Math.round(headroom * 100)}% left before cutoff`);
      for (const w of platform.windows) reasons.push(`${w.title} ${Math.round(w.used * 100)}% used${w.resetsAt ? ` · resets in ${formatDuration(new Date(w.resetsAt).valueOf() - now)}` : ""}`);
      if (platform.balance) reasons.push(`Prepaid $${platform.balance.remaining.toFixed(2)} of $${(platform.balance.funded ?? 0).toFixed(2)} left${platform.balance.estimated ? " · estimated" : ""}`);
    }

    let fitsTask: boolean | null = null;
    let estCostUsd: number | null = null;
    const unpricedModels: string[] = [];
    if (taskMix) {
      const total = mixTotal(taskMix);
      if (headroom != null) {
        const burn = weeklyBurnEstimate(record);
        if (burn != null && burn > 0) {
          const share = total / burn;
          fitsTask = headroom <= 0 ? false : share <= headroom * 0.9;
          reasons.push(fitsTask ? `≈${Math.round(share * 100)}% of this platform's weekly volume — fits (est.)` : `≈${Math.round(share * 100)}% of weekly volume — exceeds the ${Math.round(headroom * 100)}% left (est.)`);
        } else reasons.push("Fit unknown — no local burn history");
      } else reasons.push("Fit unknown — no cap data");
      const model = dominantModel(record);
      const priced = model ? ratesForModel(model) : null;
      if (priced?.rates) estCostUsd = estimateCostUsd(priced.rates, taskMix);
      else if (model) unpricedModels.push(model);
      if (estCostUsd != null) reasons.push(`≈$${estCostUsd.toFixed(2)} est. API cost`);
      else if (unpricedModels.length) reasons.push(`${unpricedModels[0]} is unpriced — API cost unknown`);
    }

    return { providerId: platform.providerId, providerName: platform.providerName, verdict, score, headroom, fitsTask, estCostUsd, unpricedModels, reasons, bindingResetsAt: platform.binding?.resetsAt ?? null };
  }).sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict) || b.score - a.score || a.providerName.localeCompare(b.providerName));

  const available = rows.filter(r => r.verdict !== "unavailable");
  const waits = rows.filter(r => r.verdict === "wait");
  const earliestWait = waits.flatMap(r => r.bindingResetsAt ? [new Date(r.bindingResetsAt).valueOf()] : []).sort((a, b) => a - b)[0];
  const top = available[0];
  const verdictLine = !top
    ? "Every platform needs attention — none are ready to take work."
    : waits.length && (!top || top.verdict === "wait")
      ? `Everything is constrained; the soonest refresh frees capacity in ${formatDuration((earliestWait ?? now) - now)}.`
      : `${top.providerName} first — ${top.reasons[0]?.toLowerCase() ?? "cleared for work"}${taskMix ? (top.fitsTask === true ? "; it fits this task (est.)" : top.fitsTask === false ? "; it does not fit this task (est.)" : "") : ""}.`;

  return {
    generatedAt: new Date(now).toISOString(),
    mode: taskMix ? "task" : "general",
    verdictLine,
    taskTokens: taskMix,
    rows,
  };
}

export function limitsBoard(): LimitsBoard {
  return { generatedAt: new Date().toISOString(), platforms: loadUsageRecords().map(r => buildPlatformLimits(r)), index: indexProgress() };
}
