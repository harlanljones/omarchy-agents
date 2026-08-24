import { createHash } from "node:crypto";
import { db } from "./db";
import type { AlertRule, AlertSeverity, AlertView, AlertsResponse, ForecastView, IncidentView, IncidentsResponse, LimitKind, LimitWindowView, PlatformStatus, UsageRecord } from "../shared/schemas";

// Observation primitives shared by the limits board (limits.ts) and the
// indexer's collector-refresh hook. This module must not import limits.ts or
// indexer.ts: both of them sit above it in the dependency graph.

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

export function deriveStatus(record: UsageRecord, now: number): PlatformStatus {
  if (record.ready === false) return "auth-needed";
  const updated = record.updatedAt ? new Date(record.updatedAt).valueOf() : NaN;
  if (!Number.isNaN(updated) && now - updated > 26 * 3600_000) return "stale";
  const hasSignals = (record.limits?.length ?? 0) > 0 || !!record.balance || Number(record.todayTotalTokens ?? 0) > 0 || (record.recentDays ?? []).some(d => d.messageCount > 0);
  return hasSignals ? "ready" : "no-data";
}

export function formatDuration(ms: number) {
  if (!(ms > 0)) return "now";
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${(minutes % 60)}m`;
  return `${Math.max(1, minutes)}m`;
}

export type Notifier = (title: string, body: string) => Promise<boolean>;

export const notifyDesktop: Notifier = async (title, body) => {
  try {
    const proc = Bun.spawn(["notify-send", "-a", "omarchy-agents", "-t", "10000", title, body], { stdout: "ignore", stderr: "ignore" });
    return await proc.exited === 0;
  } catch {
    return false;
  }
};

export const RETENTION_MS = 90 * 24 * 3600_000;
const SNAPSHOT_THROTTLE_MS = 60_000;

type WindowObservation = { label: string; title: string; kind: LimitKind; used: number; resetsAt: string | null };
type FiringAlert = { id: string; provider: string; providerName: string; rule: AlertRule; severity: AlertSeverity; windowLabel: string | null; resetsAt: string | null; message: string };

const alertId = (...parts: (string | null)[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
const pct = (used: number) => Math.round(used * 100);

function windowsOf(record: UsageRecord): WindowObservation[] {
  return (record.limits ?? [])
    .map(entry => ({
      label: String(entry.label ?? ""),
      title: String(entry.title ?? entry.label ?? "Limit"),
      kind: classifyWindow(String(entry.label ?? ""), entry.title),
      used: Math.max(0, Number(entry.percent ?? 0)),
      resetsAt: entry.resetsAt && !Number.isNaN(new Date(entry.resetsAt).valueOf()) ? new Date(entry.resetsAt).toISOString() : null,
    }))
    .filter(w => Number.isFinite(w.used));
}

const awaitingRefresh = (w: WindowObservation, now: number) => w.resetsAt != null && new Date(w.resetsAt).valueOf() <= now;

function firingAlerts(records: UsageRecord[], now: number, forecasts: Map<string, { providerName: string; forecasts: ForecastView[] }>): FiringAlert[] {
  const fired: FiringAlert[] = [];
  for (const record of records) {
    const providerName = record.name ?? record.id;
    const status = deriveStatus(record, now);
    if (status === "auth-needed")
      fired.push({ id: alertId(record.id, "-", "-", "auth-needed"), provider: record.id, providerName, rule: "auth-needed", severity: "critical", windowLabel: null, resetsAt: null, message: record.authHelpText || record.usageStatusText || "Needs authentication before it can report limits." });
    else if (status === "stale")
      fired.push({ id: alertId(record.id, "-", "-", "collector-stale"), provider: record.id, providerName, rule: "collector-stale", severity: "warning", windowLabel: null, resetsAt: null, message: `Collector has not reported since ${record.updatedAt ? new Date(record.updatedAt).toLocaleString() : "an unknown time"} — figures may be out of date.` });

    const windowRules = (w: WindowObservation): Array<{ rule: AlertRule; severity: AlertSeverity }> => {
      // Satisfied thresholds stack so crossing 90% does not resolve-and-refire
      // the 80% watch; exhaustion stands alone above them.
      if (awaitingRefresh(w, now)) return [];
      if (w.used >= 1) return [{ rule: "exhausted", severity: "critical" }];
      if (w.used >= 0.9) return [{ rule: "threshold-20", severity: "warning" }, { rule: "threshold-10", severity: "warning" }];
      if (w.used >= 0.8) return [{ rule: "threshold-20", severity: "warning" }];
      return [];
    };
    for (const w of windowsOf(record))
      for (const { rule, severity } of windowRules(w)) {
        const resetIn = w.resetsAt ? ` — resets in ${formatDuration(new Date(w.resetsAt).valueOf() - now)}` : "";
        const message = rule === "exhausted"
          ? `${w.title} is exhausted${resetIn}.`
          : `${w.title} is at ${pct(w.used)}% used — under ${rule === "threshold-10" ? "10" : "20"}% remains${resetIn}.`;
        fired.push({ id: alertId(record.id, w.label, w.resetsAt, rule), provider: record.id, providerName, rule, severity, windowLabel: w.label, resetsAt: w.resetsAt, message });
      }

    for (const forecast of forecasts.get(record.id)?.forecasts ?? []) {
      if (!forecast.sufficient || !forecast.projectedExhaustionAt || !forecast.resetsAt) continue;
      if (new Date(forecast.projectedExhaustionAt).valueOf() >= new Date(forecast.resetsAt).valueOf()) continue;
      const w = windowsOf(record).find(x => x.label === forecast.windowLabel);
      if (!w || awaitingRefresh(w, now) || w.used >= 1) continue;
      fired.push({
        id: alertId(record.id, forecast.windowLabel, forecast.resetsAt, "projected-exhaustion"),
        provider: record.id, providerName,
        rule: "projected-exhaustion", severity: "warning",
        windowLabel: forecast.windowLabel, resetsAt: forecast.resetsAt,
        message: `${w.title} projects 100% by ${new Date(forecast.projectedExhaustionAt).toLocaleString()} (${pct(forecast.ratePerHour ?? 0)}%/h over ${forecast.samples} samples) — before its reset.`,
      });
    }
  }
  return fired;
}

export function recordSnapshots(records: UsageRecord[], now = Date.now()): number {
  let written = 0;
  const recordedAt = new Date(now).toISOString();
  for (const record of records)
    for (const w of windowsOf(record)) {
      const latest = db.query("SELECT used,recorded_at FROM limit_snapshots WHERE provider=? AND window_label=? AND resets_at IS ? ORDER BY recorded_at DESC LIMIT 1").get(record.id, w.label, w.resetsAt) as any;
      if (latest && now - new Date(latest.recorded_at).valueOf() < SNAPSHOT_THROTTLE_MS && Number(latest.used) === w.used) continue;
      db.query("INSERT INTO limit_snapshots(provider,window_label,window_kind,resets_at,used,recorded_at) VALUES (?,?,?,?,?,?)").run(record.id, w.label, w.kind, w.resetsAt, w.used, recordedAt);
      written++;
    }
  return written;
}

export function forecastsFor(records: UsageRecord[], now = Date.now()): ForecastView[] {
  const out: ForecastView[] = [];
  for (const record of records) {
    const windows = windowsOf(record);
    const seen = new Set<string>();
    for (const w of windows) {
      const cycleKey = `${w.label}|${w.resetsAt}`;
      if (seen.has(cycleKey)) continue;
      seen.add(cycleKey);
      const base = { providerId: record.id, providerName: record.name ?? record.id, windowLabel: w.label, kind: w.kind, resetsAt: w.resetsAt };
      if (!w.resetsAt || new Date(w.resetsAt).valueOf() <= now) { out.push({ ...base, samples: 0, sufficient: false, ratePerHour: null, projectedExhaustionAt: null }); continue; }
      const samples = db.query("SELECT used,recorded_at FROM limit_snapshots WHERE provider=? AND window_label=? AND resets_at=? ORDER BY recorded_at ASC").all(record.id, w.label, w.resetsAt) as Array<{ used: number; recorded_at: string }>;
      if (samples.length < 2) { out.push({ ...base, samples: samples.length, sufficient: false, ratePerHour: null, projectedExhaustionAt: null }); continue; }
      const firstRow = samples[0], lastRow = samples[samples.length - 1];
      const spanMs = new Date(lastRow.recorded_at).valueOf() - new Date(firstRow.recorded_at).valueOf();
      const lastUsed = Number(lastRow.used);
      const ratePerMs = spanMs > 0 ? (lastUsed - Number(firstRow.used)) / spanMs : 0;
      if (!(ratePerMs > 0)) { out.push({ ...base, samples: samples.length, sufficient: false, ratePerHour: 0, projectedExhaustionAt: null }); continue; }
      const projectedMs = new Date(lastRow.recorded_at).valueOf() + (1 - lastUsed) / ratePerMs;
      out.push({
        ...base, samples: samples.length, sufficient: true,
        ratePerHour: ratePerMs * 3600_000,
        projectedExhaustionAt: new Date(projectedMs).toISOString(),
      });
    }
  }
  return out;
}

export type ObservationResult = { snapshotsWritten: number; alertsFired: number; alertsResolved: number; notificationsSent: number; notificationsFailed: number };

export async function observeUsageRecords(records: UsageRecord[], now = Date.now(), notify: Notifier = notifyDesktop): Promise<ObservationResult> {
  const snapshotsWritten = recordSnapshots(records, now);
  const cutoff = new Date(now - RETENTION_MS).toISOString();
  db.query("DELETE FROM limit_snapshots WHERE recorded_at < ?").run(cutoff);
  db.query("DELETE FROM usage_alerts WHERE resolved_at IS NOT NULL AND resolved_at < ?").run(cutoff);

  const forecastList = forecastsFor(records, now);
  const byProvider = new Map<string, { providerName: string; forecasts: ForecastView[] }>();
  for (const f of forecastList) {
    const entry = byProvider.get(f.providerId) ?? { providerName: f.providerName, forecasts: [] };
    entry.forecasts.push(f);
    byProvider.set(f.providerId, entry);
  }

  const result: ObservationResult = { snapshotsWritten, alertsFired: 0, alertsResolved: 0, notificationsSent: 0, notificationsFailed: 0 };
  const active = new Map((db.query("SELECT * FROM usage_alerts WHERE resolved_at IS NULL").all() as any[]).map(row => [String(row.id), row]));
  const seen = new Set<string>();
  const nowIso = new Date(now).toISOString();
  const deliver = async (title: string, body: string): Promise<boolean> => {
    const sent = await notify(title, body);
    sent ? result.notificationsSent++ : result.notificationsFailed++;
    return sent;
  };

  for (const fire of firingAlerts(records, now, byProvider)) {
    seen.add(fire.id);
    const existing = active.get(fire.id);
    // Provider-level rules carry no window: the "-" sentinel keeps the NOT NULL
    // column satisfied and maps back to null for display.
    db.query("INSERT OR IGNORE INTO usage_alerts(id,provider,rule,window_label,resets_at,severity,message,fired_at,resolved_at,notified_at,recovery_notified_at) VALUES (?,?,?,?,?,?,?,?,NULL,NULL,NULL)").run(fire.id, fire.provider, fire.rule, fire.windowLabel ?? "-", fire.resetsAt, fire.severity, fire.message, nowIso);
    if (!existing) result.alertsFired++;
    // Retry semantics: notified_at stays NULL until a delivery succeeds, so a
    // failed desktop notification is retried on the next observation pass.
    if (!existing?.notified_at && await deliver(`${fire.providerName}: ${fire.rule}`, fire.message))
      db.query("UPDATE usage_alerts SET notified_at=? WHERE id=? AND notified_at IS NULL").run(new Date(now).toISOString(), fire.id);
  }

  for (const [alertKey, row] of active) {
    if (seen.has(alertKey)) continue;
    db.query("UPDATE usage_alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL").run(nowIso, alertKey);
    result.alertsResolved++;
    if (row.notified_at && !row.recovery_notified_at) {
      const providerName = String(row.provider);
      const subject = records.find(r => r.id === row.provider)?.name ?? providerName;
      const scope = row.window_label && row.window_label !== "-" ? `${row.window_label}` : "collector";
      if (await deliver(`${subject}: recovered`, `${scope} is back under watch (${String(row.rule)} cleared).`))
        db.query("UPDATE usage_alerts SET recovery_notified_at=? WHERE id=? AND recovery_notified_at IS NULL").run(nowIso, alertKey);
    }
  }
  return result;
}

export function alertsInbox(records?: UsageRecord[], now = Date.now()): AlertsResponse {
  const current = records ?? (db.query("SELECT record_json FROM usage_records").all() as any[])
    .flatMap(row => { try { return [JSON.parse(row.record_json) as UsageRecord]; } catch { return []; } });
  const names = new Map(current.map(r => [r.id, r.name ?? r.id] as const));
  const view = (row: any): AlertView => ({
    id: String(row.id), providerId: String(row.provider), providerName: names.get(String(row.provider)) ?? String(row.provider),
    rule: row.rule as AlertRule, severity: row.severity as AlertSeverity,
    windowLabel: row.window_label && row.window_label !== "-" ? String(row.window_label) : null,
    resetsAt: row.resets_at ?? null,
    message: String(row.message), firedAt: String(row.fired_at), resolvedAt: row.resolved_at ?? null,
  });
  return {
    generatedAt: new Date(now).toISOString(),
    active: (db.query("SELECT * FROM usage_alerts WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, fired_at DESC").all() as any[]).map(view),
    recent: (db.query("SELECT * FROM usage_alerts WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 50").all() as any[]).map(view),
    forecasts: forecastsFor(current, now),
  };
}

// Provider-switch tracking (Phase 3 incident view). Callers with routing
// authority (advise() in limits.ts, via the indexer's collector-refresh hook)
// report who the top recommendation is; we only persist real transitions.
export type RecommendedProvider = { providerId: string; providerName: string };

export function lastRecommendation(): RecommendedProvider | null {
  const row = db.query("SELECT provider,provider_name FROM recommendation_log ORDER BY id DESC LIMIT 1").get() as any;
  return row ? { providerId: row.provider, providerName: row.provider_name } : null;
}

export function recordRecommendationChange(current: RecommendedProvider | null, previous: RecommendedProvider | null, now = Date.now()): boolean {
  if (current?.providerId === previous?.providerId) return false;
  db.query("INSERT INTO recommendation_log(provider,provider_name,previous_provider,previous_provider_name,changed_at) VALUES (?,?,?,?,?)")
    .run(current?.providerId ?? "none", current?.providerName ?? "None ready", previous?.providerId ?? null, previous?.providerName ?? null, new Date(now).toISOString());
  return true;
}

type SnapshotRow = { provider: string; window_label: string; window_kind: LimitKind; resets_at: string | null; used: number; recorded_at: string };
export type ActualReset = { providerId: string; windowLabel: string; windowKind: LimitKind; occurredAt: string; predictedResetsAt: string | null; driftMs: number | null; fromUsed: number; toUsed: number };

// A window's usage does not count down; it only resets. A sharp drop between
// consecutive snapshots is the observable signature of that reset actually
// happening, independent of whatever resetsAt the collector predicted.
const RESET_DROP_THRESHOLD = 0.3;

export function actualResets(limit = 50): ActualReset[] {
  const rows = db.query("SELECT provider,window_label,window_kind,resets_at,used,recorded_at FROM limit_snapshots ORDER BY provider,window_label,recorded_at").all() as SnapshotRow[];
  const out: ActualReset[] = [];
  const prevByKey = new Map<string, SnapshotRow>();
  for (const row of rows) {
    const key = `${row.provider} ${row.window_label}`;
    const prev = prevByKey.get(key);
    if (prev && row.used < prev.used - RESET_DROP_THRESHOLD) {
      const driftMs = prev.resets_at ? new Date(row.recorded_at).valueOf() - new Date(prev.resets_at).valueOf() : null;
      out.push({ providerId: row.provider, windowLabel: row.window_label, windowKind: row.window_kind, occurredAt: row.recorded_at, predictedResetsAt: prev.resets_at, driftMs, fromUsed: prev.used, toUsed: row.used });
    }
    prevByKey.set(key, row);
  }
  return out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, limit);
}

export type ForecastAccuracy = { providerId: string; windowLabel: string; windowKind: LimitKind; predictedExhaustionAt: string | null; actualExhaustionAt: string; driftMs: number | null };

// Re-derives what forecastsFor() would have projected from only the first two
// samples of a reset cycle, then compares that early call against the sample
// where usage actually reached 100% in the same cycle.
export function forecastAccuracy(limit = 50): ForecastAccuracy[] {
  const rows = db.query("SELECT provider,window_label,window_kind,resets_at,used,recorded_at FROM limit_snapshots ORDER BY provider,window_label,resets_at,recorded_at").all() as SnapshotRow[];
  const cycles = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const key = `${row.provider} ${row.window_label} ${row.resets_at ?? ""}`;
    const bucket = cycles.get(key);
    if (bucket) bucket.push(row); else cycles.set(key, [row]);
  }
  const out: ForecastAccuracy[] = [];
  for (const samples of cycles.values()) {
    const exhaustedIndex = samples.findIndex(s => s.used >= 1);
    if (exhaustedIndex < 2) continue;
    const [firstRow, secondRow] = samples;
    const spanMs = new Date(secondRow.recorded_at).valueOf() - new Date(firstRow.recorded_at).valueOf();
    if (!(spanMs > 0)) continue;
    const ratePerMs = (secondRow.used - firstRow.used) / spanMs;
    if (!(ratePerMs > 0)) continue;
    const predictedMs = new Date(secondRow.recorded_at).valueOf() + (1 - secondRow.used) / ratePerMs;
    const actual = samples[exhaustedIndex];
    out.push({
      providerId: actual.provider, windowLabel: actual.window_label, windowKind: actual.window_kind,
      predictedExhaustionAt: new Date(predictedMs).toISOString(), actualExhaustionAt: actual.recorded_at,
      driftMs: new Date(actual.recorded_at).valueOf() - predictedMs,
    });
  }
  return out.sort((a, b) => b.actualExhaustionAt.localeCompare(a.actualExhaustionAt)).slice(0, limit);
}

export function incidentsView(records?: UsageRecord[], now = Date.now(), limit = 100): IncidentsResponse {
  const current = records ?? (db.query("SELECT record_json FROM usage_records").all() as any[])
    .flatMap(row => { try { return [JSON.parse(row.record_json) as UsageRecord]; } catch { return []; } });
  const names = new Map(current.map(r => [r.id, r.name ?? r.id] as const));
  const nameOf = (id: string) => names.get(id) ?? id;

  const inbox = alertsInbox(current, now);
  const thresholds: IncidentView[] = [...inbox.active, ...inbox.recent]
    .filter(a => a.rule !== "collector-stale" && a.rule !== "auth-needed")
    .map(a => ({ id: `threshold:${a.id}`, kind: "threshold", occurredAt: a.firedAt, providerId: a.providerId, providerName: a.providerName, summary: `${a.rule} · ${a.providerName}`, detail: a.message }));

  const switches: IncidentView[] = (db.query("SELECT * FROM recommendation_log ORDER BY id DESC LIMIT ?").all(limit) as any[])
    .map(row => ({
      id: `switch:${row.id}`, kind: "provider-switch" as const, occurredAt: row.changed_at,
      providerId: row.provider === "none" ? null : row.provider, providerName: row.provider_name,
      summary: row.previous_provider ? `Recommendation moved from ${row.previous_provider_name} to ${row.provider_name}` : `${row.provider_name} became the recommendation`,
      detail: row.previous_provider ? `Top platform switched from ${row.previous_provider_name} to ${row.provider_name}.` : "No prior recommendation on record.",
    }));

  const resets: IncidentView[] = actualResets(limit).map(r => ({
    id: `reset:${r.providerId}:${r.windowLabel}:${r.occurredAt}`, kind: "actual-reset", occurredAt: r.occurredAt,
    providerId: r.providerId, providerName: nameOf(r.providerId),
    summary: `${r.windowLabel} reset (${Math.round(r.fromUsed * 100)}% → ${Math.round(r.toUsed * 100)}%)`,
    detail: r.predictedResetsAt
      ? `Predicted reset at ${new Date(r.predictedResetsAt).toLocaleString()}; observed ${formatDuration(Math.abs(r.driftMs ?? 0))} ${(r.driftMs ?? 0) > 0 ? "after" : "before"} prediction.`
      : "No predicted reset time on record for comparison.",
  }));

  const accuracy: IncidentView[] = forecastAccuracy(limit).map(f => ({
    id: `forecast:${f.providerId}:${f.windowLabel}:${f.actualExhaustionAt}`, kind: "forecast-accuracy", occurredAt: f.actualExhaustionAt,
    providerId: f.providerId, providerName: nameOf(f.providerId),
    summary: `${f.windowLabel} exhaustion forecast drift ${formatDuration(Math.abs(f.driftMs ?? 0))}`,
    detail: `Projected exhaustion ${f.predictedExhaustionAt ? new Date(f.predictedExhaustionAt).toLocaleString() : "unknown"}; actual ${new Date(f.actualExhaustionAt).toLocaleString()}.`,
  }));

  const incidents = [...thresholds, ...switches, ...resets, ...accuracy]
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, limit);
  return { generatedAt: new Date(now).toISOString(), incidents };
}
