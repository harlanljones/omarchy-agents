import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  CreateExperimentInput, ExperimentDefaults, ReplaceCohortInput, ReviewExperimentInput,
  type CohortCalculation, type CohortKind, type ExperimentCalculation, type ExperimentDetail,
  type ExperimentSourceSnapshot, type ExperimentState, type ExperimentSummary,
  type ExcludedSession, type ExclusionReason, type MetricKind,
  type ReviewExperimentInput as ReviewInput, type SessionContribution,
} from "../shared/schemas";

export function initializeExperimentSchema(database: Database) {
  const columns = new Set(
    (database.query("PRAGMA table_info(suggestions)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!columns.has("finding_key")) database.run("ALTER TABLE suggestions ADD COLUMN finding_key TEXT");
  if (!columns.has("experiment_json")) database.run("ALTER TABLE suggestions ADD COLUMN experiment_json TEXT");
  database.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      source_suggestion_id TEXT NOT NULL UNIQUE,
      source_report_id TEXT NOT NULL,
      source_snapshot_json TEXT NOT NULL,
      title TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      metric_kind TEXT NOT NULL,
      metric_version INTEGER NOT NULL CHECK(metric_version = 1),
      target_value REAL NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('draft','active','ready_for_review','completed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS experiments_state_updated ON experiments(state, updated_at DESC);
    CREATE TABLE IF NOT EXISTS experiment_sessions (
      experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      cohort TEXT NOT NULL CHECK(cohort IN ('baseline','trial')),
      added_at TEXT NOT NULL,
      PRIMARY KEY (experiment_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS experiment_sessions_cohort ON experiment_sessions(experiment_id, cohort, added_at);
    CREATE TABLE IF NOT EXISTS experiment_reviews (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      outcome TEXT NOT NULL CHECK(outcome IN ('adopt_change','extend_trial','no_improvement')),
      note TEXT NOT NULL,
      calculation_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS experiment_reviews_experiment ON experiment_reviews(experiment_id, created_at DESC);
    CREATE TRIGGER IF NOT EXISTS experiment_reviews_immutable
      BEFORE UPDATE ON experiment_reviews BEGIN SELECT RAISE(ABORT, 'experiment reviews are immutable'); END;
  `);
}

export type MetricSessionRow = {
  id: string; provider: string; startedAt: string; endedAt: string | null;
  tokenInput: number; tokenOutput: number; cacheRead: number; cacheWrite: number;
  errorCount: number; toolCount: number;
};
export type SelectedMetricSession = { sessionId: string; row: MetricSessionRow | null };
type ValidValue = { value: number; numerator: number | null; denominator: number | null };
type MetricDefinition = {
  label: string; direction: "lower" | "higher";
  value(row: MetricSessionRow): ValidValue | ExclusionReason;
  aggregate(values: ValidValue[]): number;
  format(value: number): string;
};

const ratio = (numerator: number, denominator: number): ValidValue | ExclusionReason =>
  denominator > 0 ? { value: numerator / denominator, numerator, denominator } : "zero_denominator";
const mean = (values: ValidValue[]) => values.reduce((sum, item) => sum + item.value, 0) / values.length;
const summedRatio = (values: ValidValue[]) => {
  const numerator = values.reduce((sum, item) => sum + Number(item.numerator), 0);
  const denominator = values.reduce((sum, item) => sum + Number(item.denominator), 0);
  return numerator / denominator;
};
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

const METRICS: Record<MetricKind, MetricDefinition> = {
  tool_failure_rate: {
    label: "Tool failure rate", direction: "lower",
    value: (row) => ratio(row.errorCount, row.toolCount), aggregate: summedRatio, format: percent,
  },
  tokens_per_session: {
    label: "Tokens per session", direction: "lower",
    value: (row) => ({ value: row.tokenInput + row.tokenOutput + row.cacheRead + row.cacheWrite, numerator: null, denominator: null }),
    aggregate: mean, format: (value) => Math.round(value).toLocaleString("en-US"),
  },
  average_duration_minutes: {
    label: "Average session duration", direction: "lower",
    value: (row) => {
      const duration = row.endedAt ? (Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 60_000 : Number.NaN;
      return Number.isFinite(duration) && duration > 0
        ? { value: duration, numerator: null, denominator: null }
        : "invalid_duration";
    },
    aggregate: mean, format: (value) => `${value.toFixed(1)} min`,
  },
  cache_read_ratio: {
    label: "Cache-read ratio", direction: "higher",
    value: (row) => ratio(row.cacheRead, row.tokenInput), aggregate: summedRatio, format: percent,
  },
};

export const metricLabel = (kind: MetricKind) => METRICS[kind].label;

function calculateCohort(
  kind: MetricKind,
  cohort: CohortKind,
  selected: SelectedMetricSession[],
): CohortCalculation {
  const definition = METRICS[kind];
  const contributions: SessionContribution[] = [];
  const excluded: ExcludedSession[] = [];
  const values: ValidValue[] = [];
  for (const selectedSession of selected) {
    if (!selectedSession.row) {
      excluded.push({ sessionId: selectedSession.sessionId, reason: "session_missing" });
      continue;
    }
    const candidate = definition.value(selectedSession.row);
    if (typeof candidate === "string") {
      excluded.push({ sessionId: selectedSession.sessionId, reason: candidate });
      continue;
    }
    values.push(candidate);
    contributions.push({
      sessionId: selectedSession.sessionId, cohort, provider: selectedSession.row.provider,
      startedAt: selectedSession.row.startedAt, endedAt: selectedSession.row.endedAt,
      value: candidate.value, numerator: candidate.numerator, denominator: candidate.denominator,
    });
  }
  const value = values.length ? definition.aggregate(values) : null;
  return { value, formatted: value === null ? "—" : definition.format(value), validCount: values.length, contributions, excluded };
}

export function calculateExperiment(
  metricKind: MetricKind,
  targetValue: number,
  baselineRows: SelectedMetricSession[],
  trialRows: SelectedMetricSession[],
  calculatedAt: string,
): ExperimentCalculation {
  const definition = METRICS[metricKind];
  const baseline = calculateCohort(metricKind, "baseline", baselineRows);
  const trial = calculateCohort(metricKind, "trial", trialRows);
  const comparable = baseline.value !== null && trial.value !== null;
  const absoluteDelta = comparable ? trial.value! - baseline.value! : null;
  const directionalDelta = absoluteDelta === null ? null : definition.direction === "lower" ? -absoluteDelta : absoluteDelta;
  const smaller = Math.min(baseline.validCount, trial.validCount);
  const larger = Math.max(baseline.validCount, trial.validCount);
  const sampleNote = smaller < 5 ? "small_sample" : larger > smaller * 2 ? "uneven_cohorts" : "descriptive_only";
  return {
    metricKind, metricVersion: 1, direction: definition.direction, targetValue, baseline, trial,
    absoluteDelta, directionalDelta,
    targetMet: trial.value === null ? null : definition.direction === "lower" ? trial.value <= targetValue : trial.value >= targetValue,
    improved: comparable ? directionalDelta! > 0 : null,
    sampleNote, calculatedAt,
  };
}

const parseJson = <T,>(value: string | null, fallback: T): T => {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
};

export class ExperimentError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 422,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) { super(message); }
}

export type ExperimentService = {
  createExperiment(input: unknown): ExperimentDetail;
  replaceCohort(experimentId: string, cohort: CohortKind, sessionIds: string[]): ExperimentDetail;
  startExperiment(experimentId: string): ExperimentDetail;
  markReadyForReview(experimentId: string): ExperimentDetail;
  reviewExperiment(experimentId: string, input: ReviewInput): ExperimentDetail;
  getExperiment(experimentId: string): ExperimentDetail;
  listExperiments(filter?: { state?: ExperimentState }): ExperimentSummary[];
};
export type ExperimentServiceDependencies = { now?: () => Date; id?: () => string };

export function createExperimentService(
  database: Database,
  dependencies: ExperimentServiceDependencies = {},
): ExperimentService {
const now = dependencies.now ?? (() => new Date());
const id = dependencies.id ?? randomUUID;

type ExperimentRow = {
  id: string; source_suggestion_id: string; source_report_id: string; source_snapshot_json: string;
  title: string; hypothesis: string; metric_kind: MetricKind;
  metric_version: 1; target_value: number; state: ExperimentState; created_at: string; updated_at: string;
};

const requireExperiment = (experimentId: string): ExperimentRow => {
  const row = database.query("SELECT * FROM experiments WHERE id=?").get(experimentId) as ExperimentRow | null;
  if (!row) throw new ExperimentError(404, "experiment_not_found", "Experiment not found");
  return row;
};

const selectedRows = (experimentId: string, cohort: CohortKind): SelectedMetricSession[] =>
  (database.query(`SELECT es.session_id,
      s.id, s.provider, s.started_at, s.ended_at, s.token_input, s.token_output,
      s.cache_read, s.cache_write, s.error_count, s.tool_count
    FROM experiment_sessions es LEFT JOIN sessions s ON s.id=es.session_id
    WHERE es.experiment_id=? AND es.cohort=? ORDER BY es.added_at, es.session_id`).all(experimentId, cohort) as any[])
    .map((row) => ({
      sessionId: row.session_id,
      row: row.id ? {
        id: row.id, provider: row.provider, startedAt: row.started_at, endedAt: row.ended_at,
        tokenInput: Number(row.token_input), tokenOutput: Number(row.token_output),
        cacheRead: Number(row.cache_read), cacheWrite: Number(row.cache_write),
        errorCount: Number(row.error_count), toolCount: Number(row.tool_count),
      } : null,
    }));

const availableActions = (state: ExperimentState) => ({
  replaceBaseline: state === "draft", replaceTrial: state === "active", start: state === "draft",
  markReady: state === "active", review: state === "ready_for_review",
});

const experimentSessions = (experimentId: string, source: ExperimentSourceSnapshot) => {
  const evidenceBySession = new Map<string, string>();
  for (const citation of [...(source.finding?.evidence ?? []), ...source.suggestion.evidence]) {
    if (citation.anchor === "event" && citation.eventId && !evidenceBySession.has(citation.sessionId)) {
      evidenceBySession.set(citation.sessionId, citation.eventId);
    }
  }
  return (database.query(`SELECT es.session_id,es.cohort,
      s.id,s.provider,s.title,s.started_at,s.ended_at,s.token_input,s.token_output,
      s.cache_read,s.cache_write,s.error_count,s.tool_count
    FROM experiment_sessions es LEFT JOIN sessions s ON s.id=es.session_id
    WHERE es.experiment_id=? ORDER BY CASE es.cohort WHEN 'baseline' THEN 0 ELSE 1 END,es.added_at,es.session_id`)
    .all(experimentId) as any[]).map((row) => ({
      sessionId: row.session_id, cohort: row.cohort, available: Boolean(row.id),
      provider: row.provider ?? null, title: row.title ?? null, startedAt: row.started_at ?? null, endedAt: row.ended_at ?? null,
      tokenTotal: row.id ? Number(row.token_input) + Number(row.token_output) + Number(row.cache_read) + Number(row.cache_write) : null,
      errorCount: row.id ? Number(row.error_count) : null, toolCount: row.id ? Number(row.tool_count) : null,
      evidenceEventId: evidenceBySession.get(row.session_id) ?? null,
    }));
};

const getExperiment = (experimentId: string): ExperimentDetail => {
  const row = requireExperiment(experimentId);
  const baseline = selectedRows(experimentId, "baseline");
  const trial = selectedRows(experimentId, "trial");
  const source = parseJson<ExperimentSourceSnapshot | null>(row.source_snapshot_json, null);
  if (!source) throw new ExperimentError(409, "invalid_source_snapshot", "Experiment source snapshot is invalid");
  const reviews = (database.query("SELECT * FROM experiment_reviews WHERE experiment_id=? ORDER BY created_at").all(experimentId) as any[])
    .map((review) => {
      const calculation = parseJson<ExperimentCalculation | null>(review.calculation_json, null);
      if (!calculation) throw new ExperimentError(409, "invalid_review_snapshot", "Experiment review snapshot is invalid", { reviewId: review.id });
      return { id: review.id, outcome: review.outcome, note: review.note, calculation, createdAt: review.created_at };
    });
  const liveCalculation = calculateExperiment(
    row.metric_kind, Number(row.target_value), baseline, trial, now().toISOString(),
  );
  const latestReview = reviews.at(-1);
  const currentCalculation = row.state === "completed" && latestReview
    ? latestReview.calculation
    : liveCalculation;
  return {
    id: row.id, title: row.title, state: row.state, metricKind: row.metric_kind,
    sourceSuggestionId: row.source_suggestion_id, sourceReportId: row.source_report_id,
    source, hypothesis: row.hypothesis,
    metricVersion: row.metric_version, targetValue: Number(row.target_value),
    createdAt: row.created_at, updatedAt: row.updated_at,
    cohorts: { baseline: baseline.map((item) => item.sessionId), trial: trial.map((item) => item.sessionId) },
    sessions: experimentSessions(experimentId, source),
    currentCalculation, reviews, availableActions: availableActions(row.state),
  };
};

const listExperiments = (filter: { state?: ExperimentState } = {}): ExperimentSummary[] => {
  const rows = filter.state
    ? database.query("SELECT id,title,state,metric_kind,source_suggestion_id,created_at,updated_at FROM experiments WHERE state=? ORDER BY updated_at DESC").all(filter.state)
    : database.query("SELECT id,title,state,metric_kind,source_suggestion_id,created_at,updated_at FROM experiments ORDER BY updated_at DESC").all();
  return (rows as any[]).map((row) => ({
    id: row.id, title: row.title, state: row.state, metricKind: row.metric_kind,
    sourceSuggestionId: row.source_suggestion_id, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
};

const requireSessions = (sessionIds: string[]) => {
  if (!sessionIds.length) return;
  const binds = sessionIds.map(() => "?").join(",");
  const rows = database.query(`SELECT id FROM sessions WHERE id IN (${binds})`).all(...sessionIds) as Array<{ id: string }>;
  const found = new Set(rows.map((row) => row.id));
  const missing = sessionIds.filter((sessionId) => !found.has(sessionId));
  if (missing.length) throw new ExperimentError(404, "session_not_found", "One or more sessions were not found", { sessionIds: missing });
};

const createExperiment = database.transaction((unknownInput: unknown) => {
  const parsed = CreateExperimentInput.safeParse(unknownInput);
  if (!parsed.success) throw new ExperimentError(400, "invalid_request", "Experiment input is invalid", parsed.error.flatten());
  const input = parsed.data;
  const suggestion = database.query(`SELECT s.*, r.detectors_json
    FROM suggestions s JOIN reports r ON r.id=s.report_id WHERE s.id=?`).get(input.suggestionId) as any;
  if (!suggestion) throw new ExperimentError(404, "suggestion_not_found", "Suggestion not found");
  if (!suggestion.finding_key) throw new ExperimentError(409, "suggestion_not_experimentable", "Suggestion has no cited finding");
  if (!suggestion.experiment_json) throw new ExperimentError(409, "suggestion_not_experimentable", "Suggestion has no experiment defaults");
  if (!["open", "accepted"].includes(suggestion.status)) throw new ExperimentError(409, "suggestion_closed", "Suggestion is not open or accepted");
  const existing = database.query("SELECT id FROM experiments WHERE source_suggestion_id=?").get(input.suggestionId) as { id: string } | null;
  if (existing) throw new ExperimentError(409, "experiment_exists", "An experiment already exists for this suggestion", { experimentId: existing.id });
  requireSessions(input.baselineSessionIds);
  const defaultsResult = ExperimentDefaults.safeParse(parseJson(suggestion.experiment_json, null));
  if (!defaultsResult.success) throw new ExperimentError(409, "invalid_suggestion_defaults", "Suggestion experiment defaults are invalid", defaultsResult.error.flatten());
  const defaults = defaultsResult.data;
  const finding = (parseJson<any[]>(suggestion.detectors_json, [])).find((item) => item.key === suggestion.finding_key) ?? null;
  const source = {
    findingKey: suggestion.finding_key,
    finding,
    suggestion: {
      title: suggestion.title, rationale: suggestion.rationale,
      evidence: parseJson(suggestion.evidence_json, []), defaults,
    },
  };
  const createdAt = now().toISOString();
  const experimentId = id();
  database.query(`INSERT INTO experiments(id,source_suggestion_id,source_report_id,source_snapshot_json,title,hypothesis,metric_kind,metric_version,target_value,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'draft',?,?)`).run(
      experimentId, suggestion.id, suggestion.report_id, JSON.stringify(source), suggestion.title,
      input.hypothesis, input.metricKind, 1, input.targetValue, createdAt, createdAt,
    );
  const insertMembership = database.query("INSERT INTO experiment_sessions(experiment_id,session_id,cohort,added_at) VALUES (?,?,?,?)");
  for (const sessionId of input.baselineSessionIds) insertMembership.run(experimentId, sessionId, "baseline", createdAt);
  database.query("UPDATE suggestions SET status='accepted' WHERE id=?").run(suggestion.id);
  return getExperiment(experimentId);
});

const replaceCohort = database.transaction((experimentId: string, cohort: CohortKind, sessionIds: string[]) => {
  const parsed = ReplaceCohortInput.safeParse({ sessionIds });
  if (!parsed.success) throw new ExperimentError(400, "invalid_request", "Cohort input is invalid", parsed.error.flatten());
  const experiment = requireExperiment(experimentId);
  const editable = cohort === "baseline" ? experiment.state === "draft" : experiment.state === "active";
  if (!editable) throw new ExperimentError(409, "cohort_locked", `${cohort} cohort is locked`);
  requireSessions(parsed.data.sessionIds);
  const other = cohort === "baseline" ? "trial" : "baseline";
  const overlap = parsed.data.sessionIds.filter((sessionId) => database.query(
    "SELECT 1 FROM experiment_sessions WHERE experiment_id=? AND cohort=? AND session_id=?",
  ).get(experimentId, other, sessionId));
  if (overlap.length) throw new ExperimentError(409, "cohort_overlap", "A session cannot belong to both cohorts", { sessionIds: overlap });
  database.query("DELETE FROM experiment_sessions WHERE experiment_id=? AND cohort=?").run(experimentId, cohort);
  const addedAt = now().toISOString();
  const insert = database.query("INSERT INTO experiment_sessions(experiment_id,session_id,cohort,added_at) VALUES (?,?,?,?)");
  for (const sessionId of parsed.data.sessionIds) insert.run(experimentId, sessionId, cohort, addedAt);
  database.query("UPDATE experiments SET updated_at=? WHERE id=?").run(addedAt, experimentId);
  return getExperiment(experimentId);
});

const requireComparableCohorts = (row: ExperimentRow, calculatedAt: string) => {
  const calculation = calculateExperiment(
    row.metric_kind, Number(row.target_value),
    selectedRows(row.id, "baseline"), selectedRows(row.id, "trial"), calculatedAt,
  );
  if (calculation.baseline.validCount < 1 || calculation.trial.validCount < 1) {
    throw new ExperimentError(
      422, "insufficient_metric_data", "Each cohort needs a metric-valid session",
      { baseline: calculation.baseline.excluded, trial: calculation.trial.excluded },
    );
  }
  return calculation;
};

const transition = (experimentId: string, from: ExperimentState, to: ExperimentState) => {
  const changedAt = now().toISOString();
  const result = database.query("UPDATE experiments SET state=?,updated_at=? WHERE id=? AND state=?")
    .run(to, changedAt, experimentId, from);
  if (!result.changes) {
    requireExperiment(experimentId);
    throw new ExperimentError(409, "illegal_transition", `Experiment must be ${from} before moving to ${to}`);
  }
};

const startExperiment = database.transaction((experimentId: string) => {
  const row = requireExperiment(experimentId);
  if (row.state !== "draft") throw new ExperimentError(409, "illegal_transition", "Experiment must be draft before starting");
  const baseline = calculateExperiment(
    row.metric_kind, Number(row.target_value), selectedRows(row.id, "baseline"), [], now().toISOString(),
  ).baseline;
  if (baseline.validCount < 1) {
    throw new ExperimentError(422, "insufficient_metric_data", "Baseline needs a metric-valid session", { baseline: baseline.excluded });
  }
  transition(experimentId, "draft", "active");
  return getExperiment(experimentId);
});

const markReadyForReview = database.transaction((experimentId: string) => {
  const row = requireExperiment(experimentId);
  if (row.state !== "active") throw new ExperimentError(409, "illegal_transition", "Experiment must be active before review");
  requireComparableCohorts(row, now().toISOString());
  transition(experimentId, "active", "ready_for_review");
  return getExperiment(experimentId);
});

const reviewExperiment = database.transaction((experimentId: string, unknownInput: unknown) => {
  const parsed = ReviewExperimentInput.safeParse(unknownInput);
  if (!parsed.success) throw new ExperimentError(400, "invalid_request", "Review input is invalid", parsed.error.flatten());
  const row = requireExperiment(experimentId);
  if (row.state !== "ready_for_review") throw new ExperimentError(409, "illegal_transition", "Experiment is not ready for review");
  const createdAt = now().toISOString();
  const calculation = requireComparableCohorts(row, createdAt);
  database.query("INSERT INTO experiment_reviews(id,experiment_id,outcome,note,calculation_json,created_at) VALUES (?,?,?,?,?,?)")
    .run(id(), experimentId, parsed.data.outcome, parsed.data.note, JSON.stringify(calculation), createdAt);
  const nextState = parsed.data.outcome === "extend_trial" ? "active" : "completed";
  database.query("UPDATE experiments SET state=?,updated_at=? WHERE id=?").run(nextState, createdAt, experimentId);
  return getExperiment(experimentId);
});

return { createExperiment, replaceCohort, startExperiment, markReadyForReview, reviewExperiment, getExperiment, listExperiments };
}
