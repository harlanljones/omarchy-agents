# Evidence-backed Experiments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Experiments workflow that turns a cited analyst suggestion into an explicitly selected baseline/trial comparison and an immutable, human-authored review.

**Architecture:** A deep `experiments.ts` module owns additive SQLite initialization, metric definitions, cohort validation, lifecycle transitions, transactions, and review snapshots behind an injected `Database`. `server.ts` stays a thin Hono adapter, shared Zod/TypeScript contracts keep the server and client aligned, and a focused React screen implements setup, active-trial, and review states inside the existing Evidence Control Room shell.

**Tech Stack:** Bun 1.4, TypeScript 5.9, `bun:sqlite`, Hono 4, Zod 4, React 19, Vite 7, existing CSS design tokens, and `@phosphor-icons/react` for the flask navigation icon.

**Spec:** `docs/superpowers/specs/2026-08-30-evidence-backed-experiments-design.md`

## Global Constraints

- Keep the product local-first and read-only with respect to agent, provider, model, prompt, and tool configuration.
- Cohort membership is explicit; never infer, preselect, or silently remove a session.
- Results are descriptive only; never claim causality or statistical significance and never choose an outcome automatically.
- The only v1 metrics are `tool_failure_rate`, `tokens_per_session`, `average_duration_minutes`, and `cache_read_ratio`, all at metric-definition version `1`.
- `small_sample` takes precedence when either cohort has fewer than five valid sessions; otherwise use `uneven_cohorts` when the larger cohort is more than twice the smaller; otherwise use `descriptive_only`.
- Preserve the selected mock at `docs/screenshots/experiment-review-concept.png` as the visual source of truth while using the existing tokens in `apps/web/DESIGN.md` and rules in `apps/web/COMPOSITIONS.md`.
- The `/experiments` screen never opens or renders the persistent analyst rail.
- Store no raw transcripts, source paths, credentials, or external payloads in experiment tables; persist only IDs, numeric contributions, lifecycle data, notes, and already-redacted citations.
- Keep every database mutation transactional and map domain failures to `{ error, code, details? }` with HTTP `400`, `404`, `409`, or `422` as specified.
- Use the user's chosen browser for visual QA. If no browser has been selected when execution reaches visual QA, ask before using Playwright or a browser-control tool.
- Direct `git commit` is disabled in the current workspace. At each commit gate, use the workspace's automated PR workflow if available; do not bypass that policy or include unrelated dirty-worktree files.

## Scope Decision

Keep one plan. Analyst generation, the experiment aggregate root, its API, and the review screen share one versioned contract and do not produce useful independently deployable features. The task boundaries below still produce independently testable review gates.

## File Structure

| Path | Responsibility |
| --- | --- |
| `apps/web/src/shared/schemas.ts` | Zod input validation and shared experiment DTO/types. |
| `apps/web/src/server/experiments.ts` | Additive schema initialization, metric registry, storage queries, lifecycle rules, transactions, and immutable review snapshots. |
| `apps/web/src/server/db.ts` | Creates the existing core tables, then invokes idempotent experiment initialization. |
| `apps/web/src/server/analyst.ts` | Builds cited findings and deterministic experimentable suggestions, then persists a report and its suggestions atomically. |
| `apps/web/src/server.ts` | Thin Hono routes and HTTP/domain error translation. |
| `apps/web/src/client/experiments.tsx` | Experiment data container plus setup, active-trial, history, ledger, and review presentation. |
| `apps/web/src/client/main.tsx` | Navigation registration, Analyst entry CTA, Logs deep links, and screen mounting only. |
| `apps/web/src/client/styles.css` | Experiment-specific ruled layout, responsive behavior, focus, scroll, and state styling using existing tokens. |
| `apps/web/package.json`, `bun.lock` | Phosphor React icon dependency and its resolved lock entry. |
| `apps/web/tests/helpers/experiment-db.ts` | Reusable strict in-memory SQLite fixture for experiment and analyst tests. |
| `apps/web/tests/experiments-schema.test.ts` | Citation contract and idempotent additive migration tests. |
| `apps/web/tests/experiments-metrics.test.ts` | Pure metric math, formatting, exclusions, direction, and sample-note tests. |
| `apps/web/tests/experiments-domain.test.ts` | Create/query/cohort/lifecycle/rebuild/snapshot transaction tests. |
| `apps/web/tests/analyst.test.ts` | Finding evidence, deterministic suggestion, redaction, and atomic persistence tests. |
| `apps/web/tests/experiments-api.test.ts` | Hono payload and status-code contract tests. |
| `apps/web/tests/experiments-ui.test.tsx` | Reducer and server-rendered semantic markup tests without a browser DOM. |
| `apps/web/tests/fixtures/seed-experiment-review.ts` | Deterministic review-state fixture for isolated visual QA only. |

---

### Task 1: Shared Contracts and Idempotent Schema

**Files:**
- Create: `apps/web/src/server/experiments.ts`
- Create: `apps/web/tests/helpers/experiment-db.ts`
- Create: `apps/web/tests/experiments-schema.test.ts`
- Modify: `apps/web/src/shared/schemas.ts:52-69`
- Modify: `apps/web/src/server/db.ts:1-34`

**Interfaces:**
- Consumes: `Database` from `bun:sqlite`; existing `reports`, `suggestions`, and `sessions` tables.
- Produces: `initializeExperimentSchema(database: Database): void`; `MetricKind`, `ExperimentState`, `CohortKind`, `ExperimentOutcome`, `ExperimentDefaults`, `CreateExperimentInput`, `ReplaceCohortInput`, `ReviewExperimentInput`, `ExperimentDetail`, and related shared types.

- [ ] **Step 1: Write the failing schema and citation tests**

```ts
// apps/web/tests/experiments-schema.test.ts
import { describe, expect, test } from "bun:test";
import { EvidenceCitation } from "../src/shared/schemas";
import { initializeExperimentSchema } from "../src/server/experiments";
import { experimentDatabase } from "./helpers/experiment-db";

describe("experiment schema", () => {
  test("accepts event and session anchors while preserving legacy event citations", () => {
    expect(EvidenceCitation.parse({
      id: "ev_1", provider: "codex", sessionId: "s1", eventId: "e1",
      timestamp: "2026-08-30T00:00:00Z", excerpt: "redacted",
    }).anchor).toBe("event");
    expect(EvidenceCitation.parse({
      id: "session_s1", provider: "codex", sessionId: "s1", anchor: "session",
      eventId: null, timestamp: "2026-08-30T00:00:00Z", excerpt: "Session s1",
    }).eventId).toBeNull();
    expect(() => EvidenceCitation.parse({
      id: "bad", provider: "codex", sessionId: "s1", anchor: "event",
      eventId: null, timestamp: "2026-08-30T00:00:00Z", excerpt: "bad",
    })).toThrow();
  });

  test("adds experiment tables and suggestion columns exactly once", () => {
    const database = experimentDatabase({ initializeExperiments: false });
    initializeExperimentSchema(database);
    initializeExperimentSchema(database);
    const columns = database.query("PRAGMA table_info(suggestions)").all() as Array<{ name: string }>;
    expect(columns.filter((column) => column.name === "finding_key")).toHaveLength(1);
    expect(columns.filter((column) => column.name === "experiment_json")).toHaveLength(1);
    const tables = database.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual(expect.arrayContaining([
      "experiments", "experiment_sessions", "experiment_reviews",
    ]));
    const membershipFks = database.query("PRAGMA foreign_key_list(experiment_sessions)").all() as Array<{ table: string }>;
    expect(membershipFks.some((row) => row.table === "sessions")).toBe(false);
  });
});
```

```ts
// apps/web/tests/helpers/experiment-db.ts
import { Database } from "bun:sqlite";
import { initializeExperimentSchema } from "../../src/server/experiments";

export function experimentDatabase(options: { initializeExperiments?: boolean } = {}) {
  const database = new Database(":memory:", { strict: true });
  database.run("PRAGMA foreign_keys=ON");
  database.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT, project TEXT, title TEXT, started_at TEXT NOT NULL, ended_at TEXT, source_path TEXT NOT NULL DEFAULT '', source_key TEXT NOT NULL UNIQUE, token_input INTEGER NOT NULL DEFAULT 0, token_output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, tool_count INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}', indexed_at TEXT NOT NULL);
    CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, timestamp TEXT NOT NULL, text TEXT NOT NULL, tool_name TEXT, source_locator TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}', UNIQUE(session_id, ordinal));
    CREATE TABLE reports (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, model TEXT NOT NULL, summary TEXT NOT NULL, detectors_json TEXT NOT NULL);
    CREATE TABLE suggestions (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, title TEXT NOT NULL, impact TEXT NOT NULL, effort TEXT NOT NULL, confidence REAL NOT NULL, rationale TEXT NOT NULL, evidence_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
  `);
  if (options.initializeExperiments !== false) initializeExperimentSchema(database);
  return database;
}

export function seedSession(database: Database, id: string, overrides: Record<string, unknown> = {}) {
  const row = {
    id, provider: "codex", model: "gpt-5", project: "omarchy-agents", title: id,
    startedAt: "2026-08-30T10:00:00Z", endedAt: "2026-08-30T11:00:00Z",
    sourceKey: `source-${id}`, input: 100, output: 50, read: 20, write: 10,
    errors: 1, tools: 10, indexedAt: "2026-08-30T11:00:00Z", ...overrides,
  };
  database.query(`INSERT INTO sessions(id,provider,model,project,title,started_at,ended_at,source_path,source_key,token_input,token_output,cache_read,cache_write,error_count,tool_count,metadata_json,indexed_at)
    VALUES ($id,$provider,$model,$project,$title,$startedAt,$endedAt,'',$sourceKey,$input,$output,$read,$write,$errors,$tools,'{}',$indexedAt)`).run(row);
}

export function seedSuggestion(database: Database, overrides: Record<string, unknown> = {}) {
  const now = "2026-08-30T12:00:00Z";
  database.query("INSERT INTO reports VALUES (?,?,?,?,?,?,?)").run(
    "report-1", now, "2026-08-23T12:00:00Z", now, "deterministic", "summary", "[]",
  );
  const defaults = { hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", metricVersion: 1, targetValue: 0.1 };
  database.query(`INSERT INTO suggestions(id,report_id,title,impact,effort,confidence,rationale,evidence_json,status,created_at,finding_key,experiment_json)
    VALUES ($id,'report-1',$title,'high','low',0.8,$rationale,$evidence,'open',$createdAt,$findingKey,$experiment)`).run({
      id: "suggestion-1", title: "Reduce repeated tool retries", rationale: "Retry less and compare explicit cohorts.",
      evidence: "[]", createdAt: now, findingKey: "failed_tools:codex", experiment: JSON.stringify(defaults), ...overrides,
    });
}
```

- [ ] **Step 2: Run the focused test and verify that it fails**

Run from `apps/web`:

```bash
bun test tests/experiments-schema.test.ts
```

Expected: FAIL because the expanded citation contract, experiment schemas, and `initializeExperimentSchema` do not exist.

- [ ] **Step 3: Replace the finding, citation, suggestion, and experiment contracts**

```ts
// apps/web/src/shared/schemas.ts
export const MetricKind = z.enum([
  "tool_failure_rate", "tokens_per_session", "average_duration_minutes", "cache_read_ratio",
]);
export const ExperimentState = z.enum(["draft", "active", "ready_for_review", "completed"]);
export const CohortKind = z.enum(["baseline", "trial"]);
export const ExperimentOutcome = z.enum(["adopt_change", "extend_trial", "no_improvement"]);
export const SampleNote = z.enum(["small_sample", "uneven_cohorts", "descriptive_only"]);

export const EvidenceCitation = z.object({
  id: z.string(), provider: z.string(), sessionId: z.string(),
  anchor: z.enum(["session", "event"]).default("event"),
  eventId: z.string().nullable().default(null), timestamp: z.string(), excerpt: z.string(),
}).superRefine((citation, context) => {
  if (citation.anchor === "event" && citation.eventId === null) {
    context.addIssue({ code: "custom", path: ["eventId"], message: "event citations require eventId" });
  }
  if (citation.anchor === "session" && citation.eventId !== null) {
    context.addIssue({ code: "custom", path: ["eventId"], message: "session citations require a null eventId" });
  }
});

export const Finding = z.object({
  key: z.string(), type: z.string(), provider: z.string().nullable().default(null),
  severity: z.enum(["info", "warning", "critical"]), message: z.string(),
  value: z.number().optional(), evidence: z.array(EvidenceCitation),
});
export const ExperimentDefaults = z.object({
  hypothesis: z.string().trim().min(1).max(1000), metricKind: MetricKind,
  metricVersion: z.literal(1), targetValue: z.number().finite().nonnegative(),
});
export const Suggestion = z.object({
  id: z.string(), reportId: z.string(), findingKey: z.string().nullable(), title: z.string(),
  impact: z.enum(["low", "medium", "high"]), effort: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1), rationale: z.string(), evidence: z.array(EvidenceCitation),
  status: z.enum(["open", "accepted", "dismissed"]), createdAt: z.string(),
  experiment: ExperimentDefaults.nullable(), experimentId: z.string().nullable(),
});
export const AnalysisReport = z.object({
  id: z.string(), createdAt: z.string(), periodStart: z.string(), periodEnd: z.string(), model: z.string(),
  summary: z.string(), detectors: z.array(Finding), suggestions: z.array(Suggestion),
});

const uniqueIds = (ids: string[], context: z.RefinementCtx) => {
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "session IDs must be unique" });
};
export const CreateExperimentInput = z.object({
  suggestionId: z.string().min(1), hypothesis: z.string().trim().min(1).max(1000),
  metricKind: MetricKind, targetValue: z.number().finite().nonnegative(),
  baselineSessionIds: z.array(z.string().min(1)).min(1),
}).superRefine((value, context) => uniqueIds(value.baselineSessionIds, context));
export const ReplaceCohortInput = z.object({
  sessionIds: z.array(z.string().min(1)),
}).superRefine((value, context) => uniqueIds(value.sessionIds, context));
export const ReviewExperimentInput = z.object({
  outcome: ExperimentOutcome, note: z.string().trim().min(1).max(1000),
});

export type MetricKind = z.infer<typeof MetricKind>;
export type ExperimentState = z.infer<typeof ExperimentState>;
export type CohortKind = z.infer<typeof CohortKind>;
export type ExperimentOutcome = z.infer<typeof ExperimentOutcome>;
export type SampleNote = z.infer<typeof SampleNote>;
export type Citation = z.infer<typeof EvidenceCitation>;
export type Finding = z.infer<typeof Finding>;
export type ExperimentDefaults = z.infer<typeof ExperimentDefaults>;
export type Suggestion = z.infer<typeof Suggestion>;
export type AnalysisReport = z.infer<typeof AnalysisReport>;
export type CreateExperimentInput = z.infer<typeof CreateExperimentInput>;
export type ReplaceCohortInput = z.infer<typeof ReplaceCohortInput>;
export type ReviewExperimentInput = z.infer<typeof ReviewExperimentInput>;
export type ExclusionReason = "session_missing" | "zero_denominator" | "invalid_duration";
export type SessionContribution = {
  sessionId: string; cohort: CohortKind; provider: string; startedAt: string; endedAt: string | null;
  value: number; numerator: number | null; denominator: number | null;
};
export type ExcludedSession = { sessionId: string; reason: ExclusionReason };
export type CohortCalculation = {
  value: number | null; formatted: string; validCount: number;
  contributions: SessionContribution[]; excluded: ExcludedSession[];
};
export type ExperimentCalculation = {
  metricKind: MetricKind; metricVersion: 1; direction: "lower" | "higher"; targetValue: number;
  baseline: CohortCalculation; trial: CohortCalculation; absoluteDelta: number | null;
  directionalDelta: number | null; targetMet: boolean | null; improved: boolean | null;
  sampleNote: SampleNote; calculatedAt: string;
};
export type ExperimentSourceSnapshot = {
  findingKey: string; finding: Finding | null;
  suggestion: { title: string; rationale: string; evidence: z.infer<typeof EvidenceCitation>[]; defaults: ExperimentDefaults };
};
export type ExperimentReviewRecord = {
  id: string; outcome: ExperimentOutcome; note: string; calculation: ExperimentCalculation; createdAt: string;
};
export type ExperimentSummary = {
  id: string; title: string; state: ExperimentState; metricKind: MetricKind;
  sourceSuggestionId: string; createdAt: string; updatedAt: string;
};
export type ExperimentDetail = ExperimentSummary & {
  sourceReportId: string; source: ExperimentSourceSnapshot; hypothesis: string;
  metricVersion: 1; targetValue: number; cohorts: Record<CohortKind, string[]>;
  currentCalculation: ExperimentCalculation; reviews: ExperimentReviewRecord[];
  availableActions: { replaceBaseline: boolean; replaceTrial: boolean; start: boolean; markReady: boolean; review: boolean };
};
```

- [ ] **Step 4: Add the idempotent schema initializer**

```ts
// apps/web/src/server/experiments.ts
import type { Database } from "bun:sqlite";

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
```

- [ ] **Step 5: Invoke experiment initialization after the existing core DDL**

```ts
// apps/web/src/server/db.ts
import { initializeExperimentSchema } from "./experiments";

initializeExperimentSchema(db);
```

Place `initializeExperimentSchema(db)` immediately after the existing core `db.exec(...)` block; do not move or rewrite that core DDL.

- [ ] **Step 6: Run schema tests and type checking**

Run from `apps/web`:

```bash
bun test tests/experiments-schema.test.ts
bun run typecheck
```

Expected: both commands PASS; invoking initialization twice leaves exactly one copy of each nullable suggestion column.

- [ ] **Step 7: Stage the schema checkpoint**

```bash
git add apps/web/src/shared/schemas.ts apps/web/src/server/experiments.ts apps/web/src/server/db.ts apps/web/tests/helpers/experiment-db.ts apps/web/tests/experiments-schema.test.ts
```

Submit the staged checkpoint through the workspace's automated PR workflow with title `feat(web): add experiment contracts and schema`. Do not invoke `git commit` directly.

### Task 2: Versioned Metric Registry

**Files:**
- Create: `apps/web/tests/experiments-metrics.test.ts`
- Modify: `apps/web/src/server/experiments.ts`

**Interfaces:**
- Consumes: `MetricKind`, `ExperimentCalculation`, `CohortKind`, and contribution/exclusion types from Task 1.
- Produces: `MetricSessionRow`; `SelectedMetricSession`; `calculateExperiment(metricKind, targetValue, baseline, trial, calculatedAt): ExperimentCalculation`; `metricLabel(metricKind): string`.

- [ ] **Step 1: Write failing tests for all four metrics and confidence notes**

```ts
// apps/web/tests/experiments-metrics.test.ts
import { describe, expect, test } from "bun:test";
import { calculateExperiment, type MetricSessionRow } from "../src/server/experiments";

const row = (id: string, values: Partial<MetricSessionRow> = {}): MetricSessionRow => ({
  id, provider: "codex", startedAt: "2026-08-30T10:00:00Z", endedAt: "2026-08-30T11:00:00Z",
  tokenInput: 100, tokenOutput: 50, cacheRead: 20, cacheWrite: 10, errorCount: 1, toolCount: 10,
  ...values,
});
const selected = (value: MetricSessionRow | null) => ({ sessionId: value?.id ?? "missing", row: value });
const at = "2026-08-30T12:00:00Z";

describe("experiment metric registry", () => {
  test("aggregates tool failures by summed numerator and denominator", () => {
    const result = calculateExperiment("tool_failure_rate", 0.1,
      [selected(row("b1", { errorCount: 2, toolCount: 10 })), selected(row("b2", { errorCount: 1, toolCount: 10 }))],
      [selected(row("t1", { errorCount: 1, toolCount: 20 }))], at);
    expect(result.baseline.value).toBeCloseTo(0.15);
    expect(result.trial.value).toBeCloseTo(0.05);
    expect(result.targetMet).toBe(true);
    expect(result.improved).toBe(true);
    expect(result.directionalDelta).toBeCloseTo(0.1);
    expect(result.trial.formatted).toBe("5.0%");
  });

  test("computes token means, positive durations, and cache ratios", () => {
    const tokens = calculateExperiment("tokens_per_session", 120,
      [selected(row("b", { tokenInput: 100, tokenOutput: 50, cacheRead: 20, cacheWrite: 10 }))],
      [selected(row("t", { tokenInput: 60, tokenOutput: 30, cacheRead: 10, cacheWrite: 0 }))], at);
    expect(tokens.baseline.value).toBe(180);
    expect(tokens.trial.value).toBe(100);
    const duration = calculateExperiment("average_duration_minutes", 45,
      [selected(row("b"))],
      [selected(row("t", { endedAt: "2026-08-30T10:30:00Z" }))], at);
    expect(duration.baseline.value).toBe(60);
    expect(duration.trial.value).toBe(30);
    const cache = calculateExperiment("cache_read_ratio", 0.2,
      [selected(row("b", { tokenInput: 100, cacheRead: 10 }))],
      [selected(row("t", { tokenInput: 100, cacheRead: 25 }))], at);
    expect(cache.targetMet).toBe(true);
    expect(cache.direction).toBe("higher");
  });

  test("keeps missing and invalid sessions explicit", () => {
    const result = calculateExperiment("tool_failure_rate", 0.1,
      [selected(null), selected(row("zero", { toolCount: 0 }))],
      [selected(row("t"))], at);
    expect(result.baseline.value).toBeNull();
    expect(result.baseline.excluded).toEqual([
      { sessionId: "missing", reason: "session_missing" },
      { sessionId: "zero", reason: "zero_denominator" },
    ]);
    expect(result.targetMet).toBe(true);
    expect(result.improved).toBeNull();
  });

  test("applies small-sample precedence, then uneven, then descriptive-only", () => {
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => selected(row(`${prefix}-${index}`)));
    expect(calculateExperiment("tokens_per_session", 200, many("b", 4), many("t", 12), at).sampleNote).toBe("small_sample");
    expect(calculateExperiment("tokens_per_session", 200, many("b", 5), many("t", 11), at).sampleNote).toBe("uneven_cohorts");
    expect(calculateExperiment("tokens_per_session", 200, many("b", 5), many("t", 10), at).sampleNote).toBe("descriptive_only");
  });
});
```

- [ ] **Step 2: Run the metric tests and verify that they fail**

Run from `apps/web`:

```bash
bun test tests/experiments-metrics.test.ts
```

Expected: FAIL because the registry and calculator exports do not exist.

- [ ] **Step 3: Add the typed metric definitions and contribution rules**

```ts
// apps/web/src/server/experiments.ts
import type {
  CohortCalculation, CohortKind, ExperimentCalculation, ExcludedSession,
  ExclusionReason, MetricKind, SessionContribution,
} from "../shared/schemas";

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
```

- [ ] **Step 4: Add cohort and comparison calculation**

```ts
// apps/web/src/server/experiments.ts
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
```

- [ ] **Step 5: Run the focused tests and type checking**

Run from `apps/web`:

```bash
bun test tests/experiments-metrics.test.ts
bun run typecheck
```

Expected: PASS with ratio values left unclamped and all missing/invalid sessions named explicitly.

- [ ] **Step 6: Stage the metric checkpoint**

```bash
git add apps/web/src/server/experiments.ts apps/web/tests/experiments-metrics.test.ts
```

Submit the staged checkpoint through the automated PR workflow with title `feat(web): calculate experiment metrics`.

### Task 3: Experiment Creation, Queries, and Cohort Replacement

**Files:**
- Create: `apps/web/tests/experiments-domain.test.ts`
- Modify: `apps/web/src/server/experiments.ts`
- Modify: `apps/web/tests/helpers/experiment-db.ts`

**Interfaces:**
- Consumes: Task 1 input/detail types, Task 2 calculator, injected strict `Database`.
- Produces: `ExperimentError`; `ExperimentService`; `createExperimentService(database, dependencies)` with `createExperiment`, `replaceCohort`, `getExperiment`, and `listExperiments` fully operational.

- [ ] **Step 1: Add deterministic ID/clock support to the shared test fixture**

```ts
// append to apps/web/tests/helpers/experiment-db.ts
export const fixedNow = () => new Date("2026-08-30T12:00:00Z");
export const ids = (...values: string[]) => {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (!value) throw new Error("test ID queue exhausted");
    return value;
  };
};
```

- [ ] **Step 2: Write failing create, query, and cohort tests**

```ts
// apps/web/tests/experiments-domain.test.ts
import { describe, expect, test } from "bun:test";
import { createExperimentService, ExperimentError } from "../src/server/experiments";
import { experimentDatabase, fixedNow, ids, seedSession, seedSuggestion } from "./helpers/experiment-db";

const setup = () => {
  const database = experimentDatabase();
  seedSession(database, "baseline-1");
  seedSession(database, "baseline-2");
  seedSession(database, "trial-1", { errors: 0 });
  seedSuggestion(database);
  const service = createExperimentService(database, { now: fixedNow, id: ids("experiment-1", "review-1") });
  return { database, service };
};

describe("experiment storage", () => {
  test("creates a draft, snapshots its source, and accepts the suggestion atomically", () => {
    const { database, service } = setup();
    const detail = service.createExperiment({
      suggestionId: "suggestion-1", hypothesis: "One retry lowers failures",
      metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"],
    });
    expect(detail).toMatchObject({
      id: "experiment-1", state: "draft", metricVersion: 1,
      cohorts: { baseline: ["baseline-1"], trial: [] },
      availableActions: { replaceBaseline: true, replaceTrial: false, start: true },
    });
    expect(detail.source.findingKey).toBe("failed_tools:codex");
    expect((database.query("SELECT status FROM suggestions WHERE id='suggestion-1'").get() as any).status).toBe("accepted");
  });

  test("lists newest experiments and rejects a duplicate source suggestion", () => {
    const { service } = setup();
    service.createExperiment({ suggestionId: "suggestion-1", hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] });
    expect(service.listExperiments()).toHaveLength(1);
    expect(() => service.createExperiment({ suggestionId: "suggestion-1", hypothesis: "Again", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] }))
      .toThrow(new ExperimentError(409, "experiment_exists", "An experiment already exists for this suggestion"));
  });

  test("replaces only an editable cohort and rejects overlap or missing sessions", () => {
    const { service } = setup();
    const created = service.createExperiment({ suggestionId: "suggestion-1", hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] });
    expect(service.replaceCohort(created.id, "baseline", ["baseline-2"]).cohorts.baseline).toEqual(["baseline-2"]);
    expect(() => service.replaceCohort(created.id, "trial", ["baseline-2"])).toThrow();
    expect(() => service.replaceCohort(created.id, "baseline", ["not-indexed"])).toThrow();
  });
});
```

- [ ] **Step 3: Run the domain test and verify that it fails**

Run from `apps/web`:

```bash
bun test tests/experiments-domain.test.ts
```

Expected: FAIL because the service and domain errors do not exist.

- [ ] **Step 4: Define the domain error and complete service contract**

```ts
// apps/web/src/server/experiments.ts
import { randomUUID } from "node:crypto";
import {
  CreateExperimentInput, ExperimentDefaults, ReplaceCohortInput,
  type CohortKind, type ExperimentDetail, type ExperimentState,
  type ExperimentSummary,
} from "../shared/schemas";

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
  getExperiment(experimentId: string): ExperimentDetail;
  listExperiments(filter?: { state?: ExperimentState }): ExperimentSummary[];
};
export type ExperimentServiceDependencies = { now?: () => Date; id?: () => string };
```

Keep the local `parseJson` helper shown above. Do not import `json` from `db.ts`, because `db.ts` already imports `initializeExperimentSchema` and the reverse import would create a cycle.

- [ ] **Step 5: Add the concrete read-model helpers**

Start `createExperimentService` with the clock/ID boundary, then add these helpers before any mutation or return statement:

```ts
export function createExperimentService(
  database: Database,
  dependencies: ExperimentServiceDependencies = {},
): ExperimentService {
const now = dependencies.now ?? (() => new Date());
const id = dependencies.id ?? randomUUID;

type ExperimentRow = {
  id: string; source_suggestion_id: string; source_report_id: string; source_snapshot_json: string;
  title: string; hypothesis: string; metric_kind: import("../shared/schemas").MetricKind;
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

const getExperiment = (experimentId: string): ExperimentDetail => {
  const row = requireExperiment(experimentId);
  const baseline = selectedRows(experimentId, "baseline");
  const trial = selectedRows(experimentId, "trial");
  const source = parseJson<import("../shared/schemas").ExperimentSourceSnapshot | null>(row.source_snapshot_json, null);
  if (!source) throw new ExperimentError(409, "invalid_source_snapshot", "Experiment source snapshot is invalid");
  const reviews = (database.query("SELECT * FROM experiment_reviews WHERE experiment_id=? ORDER BY created_at").all(experimentId) as any[])
    .map((review) => {
      const calculation = parseJson<import("../shared/schemas").ExperimentCalculation | null>(review.calculation_json, null);
      if (!calculation) throw new ExperimentError(409, "invalid_review_snapshot", "Experiment review snapshot is invalid", { reviewId: review.id });
      return { id: review.id, outcome: review.outcome, note: review.note, calculation, createdAt: review.created_at };
    });
  return {
    id: row.id, title: row.title, state: row.state, metricKind: row.metric_kind,
    sourceSuggestionId: row.source_suggestion_id, sourceReportId: row.source_report_id,
    source, hypothesis: row.hypothesis,
    metricVersion: row.metric_version, targetValue: Number(row.target_value),
    createdAt: row.created_at, updatedAt: row.updated_at,
    cohorts: { baseline: baseline.map((item) => item.sessionId), trial: trial.map((item) => item.sessionId) },
    currentCalculation: calculateExperiment(row.metric_kind, Number(row.target_value), baseline, trial, now().toISOString()),
    reviews, availableActions: availableActions(row.state),
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
```

- [ ] **Step 6: Implement atomic creation and cohort replacement**

```ts
// inside createExperimentService
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

return { createExperiment, replaceCohort, getExperiment, listExperiments };
}
```

- [ ] **Step 7: Run domain, schema, and metric tests**

Run from `apps/web`:

```bash
bun test tests/experiments-domain.test.ts tests/experiments-schema.test.ts tests/experiments-metrics.test.ts
```

Expected: PASS with atomic suggestion acceptance, explicit membership, and typed source snapshots.

- [ ] **Step 8: Stage the storage checkpoint**

```bash
git add apps/web/src/server/experiments.ts apps/web/tests/helpers/experiment-db.ts apps/web/tests/experiments-domain.test.ts
```

Submit the staged checkpoint through the automated PR workflow with title `feat(web): create and query experiments`.

### Task 4: Lifecycle Transitions and Immutable Reviews

**Files:**
- Modify: `apps/web/src/server/experiments.ts`
- Modify: `apps/web/tests/experiments-domain.test.ts`

**Interfaces:**
- Consumes: `getExperiment`, `calculateExperiment`, `ExperimentError`, and injected clock/ID functions from Tasks 2–3.
- Produces: working `startExperiment`, `markReadyForReview`, and `reviewExperiment`; completed reads use the latest stored snapshot while active reads remain live.

- [ ] **Step 1: Add failing lifecycle, rebuild, and snapshot tests**

```ts
// append to apps/web/tests/experiments-domain.test.ts
describe("experiment lifecycle", () => {
  test("locks baseline at start and requires valid sessions on both sides before review", () => {
    const { service } = setup();
    const created = service.createExperiment({ suggestionId: "suggestion-1", hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] });
    expect(service.startExperiment(created.id).state).toBe("active");
    expect(() => service.replaceCohort(created.id, "baseline", ["baseline-2"]))
      .toThrow(new ExperimentError(409, "cohort_locked", "baseline cohort is locked"));
    expect(() => service.markReadyForReview(created.id))
      .toThrow(new ExperimentError(422, "insufficient_metric_data", "Each cohort needs a metric-valid session"));
    service.replaceCohort(created.id, "trial", ["trial-1"]);
    expect(service.markReadyForReview(created.id).state).toBe("ready_for_review");
  });

  test("records an extension review and returns only trial membership to editable", () => {
    const { service } = setup();
    const created = service.createExperiment({ suggestionId: "suggestion-1", hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] });
    service.startExperiment(created.id);
    service.replaceCohort(created.id, "trial", ["trial-1"]);
    service.markReadyForReview(created.id);
    const extended = service.reviewExperiment(created.id, { outcome: "extend_trial", note: "Collect four more sessions." });
    expect(extended.state).toBe("active");
    expect(extended.reviews).toHaveLength(1);
    expect(extended.availableActions.replaceBaseline).toBe(false);
    expect(extended.availableActions.replaceTrial).toBe(true);
  });

  test("completes from a saved snapshot and never recalculates that conclusion", () => {
    const { database, service } = setup();
    const created = service.createExperiment({ suggestionId: "suggestion-1", hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] });
    service.startExperiment(created.id);
    service.replaceCohort(created.id, "trial", ["trial-1"]);
    service.markReadyForReview(created.id);
    const completed = service.reviewExperiment(created.id, { outcome: "adopt_change", note: "Target met; keep monitoring abandonment." });
    const savedValue = completed.currentCalculation.trial.value;
    database.query("UPDATE sessions SET error_count=9,tool_count=10 WHERE id='trial-1'").run();
    const reread = service.getExperiment(created.id);
    expect(reread.state).toBe("completed");
    expect(reread.currentCalculation.trial.value).toBe(savedValue);
    expect(() => service.replaceCohort(created.id, "trial", ["trial-1"])).toThrow();
    expect(() => service.reviewExperiment(created.id, { outcome: "no_improvement", note: "second verdict" })).toThrow();
  });

  test("preserves cohort IDs while indexed sessions disappear and reappear", () => {
    const { database, service } = setup();
    const created = service.createExperiment({ suggestionId: "suggestion-1", hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] });
    service.startExperiment(created.id);
    service.replaceCohort(created.id, "trial", ["trial-1"]);
    database.query("DELETE FROM sessions WHERE id='trial-1'").run();
    expect(service.getExperiment(created.id).currentCalculation.trial.excluded)
      .toContainEqual({ sessionId: "trial-1", reason: "session_missing" });
    seedSession(database, "trial-1", { errors: 0 });
    expect(service.getExperiment(created.id).currentCalculation.trial.validCount).toBe(1);
  });

  test("keeps the source snapshot after its report and suggestion are removed", () => {
    const { database, service } = setup();
    const created = service.createExperiment({ suggestionId: "suggestion-1", hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] });
    database.query("DELETE FROM reports WHERE id='report-1'").run();
    const reread = service.getExperiment(created.id);
    expect(reread.source.findingKey).toBe("failed_tools:codex");
    expect(reread.source.suggestion.title).toBe("Reduce repeated tool retries");
  });

  test("rolls back review writes when note or cohort validation fails", () => {
    const { database, service } = setup();
    const created = service.createExperiment({ suggestionId: "suggestion-1", hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] });
    service.startExperiment(created.id);
    service.replaceCohort(created.id, "trial", ["trial-1"]);
    service.markReadyForReview(created.id);
    database.query("DELETE FROM sessions WHERE id='trial-1'").run();
    expect(() => service.reviewExperiment(created.id, { outcome: "adopt_change", note: "Cannot save without trial data." })).toThrow();
    expect((database.query("SELECT COUNT(*) count FROM experiment_reviews").get() as any).count).toBe(0);
    expect(service.getExperiment(created.id).state).toBe("ready_for_review");
  });
});
```

- [ ] **Step 2: Run the lifecycle tests and verify that they fail**

Run from `apps/web`:

```bash
bun test tests/experiments-domain.test.ts
```

Expected: FAIL because the transition methods are not implemented and completed reads are still live calculations.

- [ ] **Step 3: Add a single metric-validity guard and state-transition helper**

First extend the existing shared-schema import in `experiments.ts` with the review validator and its inferred input type:

```ts
import {
  ReviewExperimentInput,
  type ReviewExperimentInput as ReviewInput,
} from "../shared/schemas";
```

```ts
// inside createExperimentService in apps/web/src/server/experiments.ts
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
```

- [ ] **Step 4: Implement start and readiness transitions transactionally**

```ts
// inside createExperimentService
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
```

- [ ] **Step 5: Implement immutable review creation and completed snapshot reads**

```ts
// inside createExperimentService
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
```

Extend the Task 3 service contract and factory return only after the three lifecycle functions above exist, so every intermediate type-check remains valid:

```ts
export type ExperimentService = {
  createExperiment(input: unknown): ExperimentDetail;
  replaceCohort(experimentId: string, cohort: CohortKind, sessionIds: string[]): ExperimentDetail;
  startExperiment(experimentId: string): ExperimentDetail;
  markReadyForReview(experimentId: string): ExperimentDetail;
  reviewExperiment(experimentId: string, input: ReviewInput): ExperimentDetail;
  getExperiment(experimentId: string): ExperimentDetail;
  listExperiments(filter?: { state?: ExperimentState }): ExperimentSummary[];
};

// Final statement inside createExperimentService:
return {
  createExperiment, replaceCohort, startExperiment, markReadyForReview,
  reviewExperiment, getExperiment, listExperiments,
};
```

Change `getExperiment` so it parses reviews before choosing the displayed calculation:

```ts
const liveCalculation = calculateExperiment(
  row.metric_kind, Number(row.target_value), baseline, trial, now().toISOString(),
);
const latestReview = reviews.at(-1);
const currentCalculation = row.state === "completed" && latestReview
  ? latestReview.calculation
  : liveCalculation;
```

Return `currentCalculation` from the detail object. Keep all prior reviews ordered oldest-to-newest so an extension history remains inspectable.

- [ ] **Step 6: Run the complete domain suite**

Run from `apps/web`:

```bash
bun test tests/experiments-domain.test.ts tests/experiments-metrics.test.ts tests/experiments-schema.test.ts
bun run typecheck
```

Expected: PASS. The review count remains zero after a failed review and completed results do not change after session rows change.

- [ ] **Step 7: Stage the lifecycle checkpoint**

```bash
git add apps/web/src/server/experiments.ts apps/web/tests/experiments-domain.test.ts
```

Submit the staged checkpoint through the automated PR workflow with title `feat(web): enforce experiment lifecycle`.

### Task 5: Cited Findings and Deterministic Suggestions

**Files:**
- Create: `apps/web/tests/analyst.test.ts`
- Modify: `apps/web/src/server/analyst.ts:1-87`
- Modify: `apps/web/src/shared/schemas.ts:52-69`

**Interfaces:**
- Consumes: existing redaction, indexed `sessions`/`events`, `Finding`, `ExperimentDefaults`, and injected database/clock/ID/model-health dependencies.
- Produces: `detect(database?, current?): Finding[]`; `buildSuggestion(finding, database, createdAt, id): SuggestionInsert | null`; `runNightly(dependencies?): Promise<AnalysisReport>` that persists reports and suggestions in one transaction.

- [ ] **Step 1: Write failing analyst evidence and persistence tests**

```ts
// apps/web/tests/analyst.test.ts
import { describe, expect, test } from "bun:test";
import { buildSuggestion, detect, runNightly } from "../src/server/analyst";
import type { Finding } from "../src/shared/schemas";
import { experimentDatabase, fixedNow, ids, seedSession } from "./helpers/experiment-db";

const ready = async () => ({ ready: true, selected: "deterministic" });

describe("nightly experiment suggestions", () => {
  test("cites exact error events and proposes the fixed failure target", () => {
    const database = experimentDatabase();
    seedSession(database, "s1", { provider: "codex", errors: 4, tools: 10 });
    database.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)").run(
      "error-1", "s1", 0, "error", "2026-08-30T10:10:00Z",
      "Authorization: Bearer secret-token-value", null, "source:1", "{}",
    );
    const finding = detect(database, fixedNow()).find((item) => item.key === "failed_tools:codex")!;
    expect(finding.evidence.some((citation) => citation.anchor === "event" && citation.eventId === "error-1")).toBe(true);
    expect(finding.evidence[0].excerpt).not.toContain("secret-token-value");
    const suggestion = buildSuggestion(finding, database, fixedNow().toISOString(), "suggestion-1")!;
    expect(suggestion.experiment).toMatchObject({ metricKind: "tool_failure_rate", metricVersion: 1, targetValue: 0.1 });
  });

  test("uses session anchors for duration and cache evidence", () => {
    const database = experimentDatabase();
    seedSession(database, "long", { provider: "codex", endedAt: "2026-08-30T15:00:00Z", input: 100, read: 0 });
    const findings = detect(database, fixedNow());
    expect(findings.find((item) => item.type === "long_sessions")?.evidence[0]).toMatchObject({ anchor: "session", eventId: null });
    expect(findings.find((item) => item.type === "cache_ratio")?.evidence[0]).toMatchObject({ anchor: "session", eventId: null });
  });

  test("maps repeated prompts to token reduction and leaves concentration unsupported", () => {
    const database = experimentDatabase();
    seedSession(database, "repeated", { input: 100, output: 50, read: 0, write: 0 });
    const evidence = [{ id: "ev_prompt", provider: "codex", sessionId: "repeated", anchor: "event" as const, eventId: "prompt-1", timestamp: fixedNow().toISOString(), excerpt: "redacted repeated instruction" }];
    const repeated: Finding = { key: "repeated_prompts", type: "repeated_prompts", provider: null, severity: "info", message: "Repeated prompts", evidence };
    const suggestion = buildSuggestion(repeated, database, fixedNow().toISOString(), "suggestion-repeat")!;
    expect(suggestion.rationale).toContain("hypothesis");
    expect(suggestion.experiment).toMatchObject({ metricKind: "tokens_per_session", metricVersion: 1, targetValue: 135 });
    const concentration: Finding = { key: "token_concentration:codex", type: "token_concentration", provider: "codex", severity: "warning", message: "Concentrated", evidence: [] };
    expect(buildSuggestion(concentration, database, fixedNow().toISOString(), "unused")).toBeNull();
  });

  test("persists one supported suggestion per finding in the report transaction", async () => {
    const database = experimentDatabase();
    seedSession(database, "s1", { provider: "codex", errors: 4, tools: 10, input: 100, read: 0 });
    const report = await runNightly({ database, now: fixedNow, id: ids("report-1", "suggestion-a", "suggestion-b"), health: ready });
    expect(report.suggestions.map((item) => item.findingKey).sort()).toEqual(["cache_ratio:codex", "failed_tools:codex"]);
    expect((database.query("SELECT COUNT(*) count FROM reports").get() as any).count).toBe(1);
    expect((database.query("SELECT COUNT(*) count FROM suggestions").get() as any).count).toBe(2);
  });

  test("rolls back the report if suggestion persistence fails", async () => {
    const database = experimentDatabase();
    seedSession(database, "s1", { provider: "codex", errors: 4, tools: 10 });
    database.exec("CREATE TRIGGER fail_suggestion BEFORE INSERT ON suggestions BEGIN SELECT RAISE(ABORT, 'forced'); END;");
    await expect(runNightly({ database, now: fixedNow, id: ids("report-1", "suggestion-1"), health: ready })).rejects.toThrow("forced");
    expect((database.query("SELECT COUNT(*) count FROM reports").get() as any).count).toBe(0);
  });
});
```

- [ ] **Step 2: Run the analyst test and verify that it fails**

Run from `apps/web`:

```bash
bun test tests/analyst.test.ts
```

Expected: FAIL because detector evidence is empty, suggestion mapping is absent, and `runNightly` cannot accept dependencies.

- [ ] **Step 3: Add stable finding keys and redacted citation builders**

```ts
// apps/web/src/server/analyst.ts
import type { Database } from "bun:sqlite";
import type { AnalysisReport, ExperimentDefaults, Finding } from "../shared/schemas";

const eventCitation = (row: any) => ({
  id: `ev_${row.id}`, provider: row.provider, sessionId: row.session_id,
  anchor: "event" as const, eventId: row.id, timestamp: row.timestamp,
  excerpt: redact(String(row.text ?? "")).slice(0, 240),
});
const sessionCitation = (row: any, excerpt: string) => ({
  id: `session_${row.id}`, provider: row.provider, sessionId: row.id,
  anchor: "session" as const, eventId: null, timestamp: row.started_at,
  excerpt: redact(excerpt).slice(0, 240),
});
```

Change the existing chat-tool `citation(row)` to call `eventCitation(row)` so existing citations gain `anchor: "event"` without changing IDs.

- [ ] **Step 4: Replace `detect()` with evidence-producing queries**

Use these exact bounded queries and keys:

```ts
export function detect(database: Database = db, current: Date = new Date()): Finding[] {
  const findings: Finding[] = [];
  const since = new Date(current.valueOf() - 7 * 86_400_000).toISOString();
  const totals = database.query(`SELECT provider,
    SUM(token_input+token_output+cache_read+cache_write) tokens,
    COUNT(*) sessions,SUM(error_count) errors,SUM(tool_count) tools,
    SUM(cache_read) cache_read,SUM(token_input) input
    FROM sessions WHERE started_at>=? GROUP BY provider`).all(since) as any[];
  const totalTokens = totals.reduce((sum, row) => sum + Number(row.tokens), 0);
  const providerSessions = database.query(`SELECT id,provider,started_at,ended_at,
    token_input,token_output,cache_read,cache_write,error_count,tool_count
    FROM sessions WHERE provider=? AND started_at>=?
    ORDER BY error_count DESC,started_at DESC LIMIT 8`);
  const errorEvents = database.query(`SELECT e.id,e.session_id,e.timestamp,e.text,s.provider
    FROM events e JOIN sessions s ON s.id=e.session_id
    WHERE s.provider=? AND e.kind='error' AND e.timestamp>=?
    ORDER BY e.timestamp DESC LIMIT 8`);
  for (const aggregate of totals) {
    const sessions = providerSessions.all(aggregate.provider, since) as any[];
    if (totalTokens > 0 && aggregate.tokens / totalTokens > 0.65) findings.push({
      key: `token_concentration:${aggregate.provider}`, type: "token_concentration", provider: aggregate.provider,
      severity: "warning", message: `${aggregate.provider} accounts for ${Math.round(aggregate.tokens / totalTokens * 100)}% of indexed tokens.`,
      value: aggregate.tokens / totalTokens,
      evidence: sessions.slice(0, 5).map((row) => sessionCitation(row, `${row.provider} session contributing to the seven-day token total`)),
    });
    if (aggregate.tools > 0 && aggregate.errors / aggregate.tools > 0.15) findings.push({
      key: `failed_tools:${aggregate.provider}`, type: "failed_tools", provider: aggregate.provider,
      severity: "warning", message: `${aggregate.provider} has an elevated tool error ratio.`,
      value: aggregate.errors / aggregate.tools,
      evidence: [
        ...(errorEvents.all(aggregate.provider, since) as any[]).map(eventCitation),
        ...sessions.filter((row) => row.error_count > 0).slice(0, 5).map((row) => sessionCitation(row, `${row.error_count} errors across ${row.tool_count} tool calls`)),
      ].slice(0, 10),
    });
    if (aggregate.input > 0 && aggregate.cache_read / aggregate.input < 0.1) findings.push({
      key: `cache_ratio:${aggregate.provider}`, type: "cache_ratio", provider: aggregate.provider,
      severity: "info", message: `${aggregate.provider} cache reads are low relative to input.`,
      value: aggregate.cache_read / aggregate.input,
      evidence: sessions.slice(0, 8).map((row) => sessionCitation(row, `${row.cache_read} cache-read tokens / ${row.token_input} input tokens`)),
    });
  }
  const long = database.query(`SELECT id,provider,started_at,ended_at FROM sessions
    WHERE started_at>=? AND ended_at IS NOT NULL AND (julianday(ended_at)-julianday(started_at))*24>4
    ORDER BY started_at DESC LIMIT 8`).all(since) as any[];
  if (long.length) findings.push({
    key: "long_sessions", type: "long_sessions", provider: null, severity: "info",
    message: `${long.length} unusually long sessions were observed.`, value: long.length,
    evidence: long.map((row) => sessionCitation(row, `Session ran from ${row.started_at} to ${row.ended_at}`)),
  });
  const repeats = database.query(`SELECT e.id,e.session_id,e.timestamp,e.text,s.provider
    FROM events e JOIN sessions s ON s.id=e.session_id
    WHERE e.kind='prompt' AND e.timestamp>=? AND length(e.text)>30 AND substr(e.text,1,180) IN (
      SELECT substr(text,1,180) FROM events WHERE kind='prompt' AND timestamp>=? AND length(text)>30
      GROUP BY substr(text,1,180) HAVING COUNT(*)>2
    ) ORDER BY e.timestamp DESC LIMIT 10`).all(since, since) as any[];
  if (repeats.length) findings.push({
    key: "repeated_prompts", type: "repeated_prompts", provider: null, severity: "info",
    message: "Repeated prompt patterns appear across indexed sessions.", value: repeats.length,
    evidence: repeats.map(eventCitation),
  });
  return findings;
}
```

- [ ] **Step 5: Add the deterministic suggestion mapping**

```ts
type SuggestionInsert = {
  id: string; reportId: string; findingKey: string; title: string;
  impact: "low" | "medium" | "high"; effort: "low" | "medium" | "high";
  confidence: number; rationale: string; evidence: Finding["evidence"];
  status: "open"; createdAt: string; experiment: ExperimentDefaults;
};

export function buildSuggestion(
  finding: Finding,
  database: Database,
  createdAt: string,
  suggestionId: string,
): SuggestionInsert | null {
  const base = { id: suggestionId, reportId: "", findingKey: finding.key, evidence: finding.evidence, status: "open" as const, createdAt };
  if (finding.type === "failed_tools") return {
    ...base, title: "Reduce repeated tool retries", impact: "high", effort: "low", confidence: 0.8,
    rationale: "Compare the current retry policy with a one-retry trial using explicitly selected sessions.",
    experiment: { hypothesis: "Reducing retry attempts to one lowers tool failures without increasing task abandonment.", metricKind: "tool_failure_rate", metricVersion: 1, targetValue: 0.1 },
  };
  if (finding.type === "long_sessions") return {
    ...base, title: "Split unusually long agent sessions", impact: "medium", effort: "medium", confidence: 0.7,
    rationale: "Compare long-running work with sessions split at clearer task boundaries.",
    experiment: { hypothesis: "Smaller task boundaries reduce average session duration.", metricKind: "average_duration_minutes", metricVersion: 1, targetValue: 240 },
  };
  if (finding.type === "cache_ratio") return {
    ...base, title: "Increase reusable prompt context", impact: "medium", effort: "medium", confidence: 0.65,
    rationale: "Compare the current prompt structure with a stable-prefix trial and inspect cache-read ratio.",
    experiment: { hypothesis: "A stable reusable prefix raises cache-read ratio.", metricKind: "cache_read_ratio", metricVersion: 1, targetValue: 0.2 },
  };
  if (finding.type === "repeated_prompts") {
    const sessionIds = [...new Set(finding.evidence.map((citation) => citation.sessionId))];
    const binds = sessionIds.map(() => "?").join(",");
    const rows = sessionIds.length ? database.query(`SELECT token_input+token_output+cache_read+cache_write total FROM sessions WHERE id IN (${binds})`).all(...sessionIds) as Array<{ total: number }> : [];
    const observedMean = rows.length ? rows.reduce((sum, row) => sum + Number(row.total), 0) / rows.length : 0;
    return {
      ...base, title: "Consolidate repeated prompt instructions", impact: "medium", effort: "low", confidence: 0.7,
      rationale: "Token reduction is the trial hypothesis; repetition alone does not prove a saving.",
      experiment: { hypothesis: "Consolidating repeated instructions lowers tokens per session by at least 10%.", metricKind: "tokens_per_session", metricVersion: 1, targetValue: Math.max(0, Math.round(observedMean * 0.9)) },
    };
  }
  return null;
}
```

`token_concentration` deliberately returns `null` and remains a cited finding without a **Start experiment** action.

- [ ] **Step 6: Persist the report and suggestions in one transaction**

```ts
export async function runNightly(dependencies: {
  database?: Database; now?: () => Date; id?: () => string;
  health?: () => Promise<{ ready: boolean; selected: string }>;
} = {}): Promise<AnalysisReport> {
  const database = dependencies.database ?? db;
  const clock = dependencies.now ?? (() => new Date());
  const nextId = dependencies.id ?? randomUUID;
  const healthCheck = dependencies.health ?? modelHealth;
  const current = clock();
  const periodStart = new Date(current.valueOf() - 7 * 86_400_000);
  const reportId = nextId();
  const detectors = detect(database, current);
  const health = await healthCheck();
  let summary = detectors.length
    ? `Found ${detectors.length} evidence-backed patterns in the last seven days.`
    : "No material deterministic anomalies were found in the indexed period.";
  if (!health.ready) summary += " Local model interpretation was unavailable; this report contains deterministic results only.";
  const createdAt = current.toISOString();
  const supported = new Set(["failed_tools", "long_sessions", "cache_ratio", "repeated_prompts"]);
  const suggestions = detectors.filter((finding) => supported.has(finding.type)).flatMap((finding) => {
    const suggestion = buildSuggestion(finding, database, createdAt, nextId());
    return suggestion ? [{ ...suggestion, reportId }] : [];
  });
  database.transaction(() => {
    database.query("INSERT INTO reports(id,created_at,period_start,period_end,model,summary,detectors_json) VALUES (?,?,?,?,?,?,?)")
      .run(reportId, createdAt, periodStart.toISOString(), createdAt, health.selected, summary, JSON.stringify(detectors));
    const insert = database.query(`INSERT INTO suggestions(id,report_id,title,impact,effort,confidence,rationale,evidence_json,status,created_at,finding_key,experiment_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const suggestion of suggestions) insert.run(
      suggestion.id, reportId, suggestion.title, suggestion.impact, suggestion.effort,
      suggestion.confidence, suggestion.rationale, JSON.stringify(suggestion.evidence), suggestion.status,
      suggestion.createdAt, suggestion.findingKey, JSON.stringify(suggestion.experiment),
    );
  })();
  return {
    id: reportId, createdAt, periodStart: periodStart.toISOString(), periodEnd: createdAt,
    model: health.selected, summary, detectors,
    suggestions: suggestions.map((suggestion) => ({ ...suggestion, experimentId: null })),
  };
}
```

Replace `tools.recommendations` with the concrete joined projection:

```ts
recommendations: (_args: any) => db.query(`SELECT s.*,e.id experiment_id
  FROM suggestions s LEFT JOIN experiments e ON e.source_suggestion_id=s.id
  ORDER BY s.created_at DESC LIMIT 20`).all().map((row: any) => ({
    id: row.id, reportId: row.report_id, findingKey: row.finding_key,
    title: row.title, impact: row.impact, effort: row.effort, confidence: Number(row.confidence),
    rationale: row.rationale, evidence: json(row.evidence_json, []), status: row.status,
    createdAt: row.created_at, experiment: json(row.experiment_json, null), experimentId: row.experiment_id ?? null,
  })),
```

- [ ] **Step 7: Run analyst and domain regressions**

Run from `apps/web`:

```bash
bun test tests/analyst.test.ts tests/experiments-domain.test.ts tests/experiments-schema.test.ts
bun run typecheck
```

Expected: PASS; forced suggestion insertion failure leaves both tables empty, and all stored excerpts are redacted.

- [ ] **Step 8: Stage the analyst checkpoint**

```bash
git add apps/web/src/server/analyst.ts apps/web/src/shared/schemas.ts apps/web/tests/analyst.test.ts
```

Submit the staged checkpoint through the automated PR workflow with title `feat(web): generate experimentable analyst suggestions`.

### Task 6: Thin HTTP Interface and Error Contract

**Files:**
- Create: `apps/web/tests/experiments-api.test.ts`
- Modify: `apps/web/src/server.ts:1-20,162-188`
- Modify: `apps/web/tests/security.test.ts:1-20`

**Interfaces:**
- Consumes: `createExperimentService(db)`, Task 1 Zod inputs, and `ExperimentError`.
- Produces: all seven `/api/experiments` endpoints; camel-cased report suggestions with `experiment` and `experimentId`; exact JSON error envelope.

- [ ] **Step 1: Write failing end-to-end API status tests**

```ts
// apps/web/tests/experiments-api.test.ts
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

let app: typeof import("../src/server").default;
let database: typeof import("../src/server/db").db;
let seedSession: typeof import("./helpers/experiment-db").seedSession;
let seedSuggestion: typeof import("./helpers/experiment-db").seedSuggestion;

beforeAll(async () => {
  process.env.OMARCHY_AGENTS_DB = join(tmpdir(), `omarchy-agents-experiment-api-${process.pid}.sqlite`);
  ({ default: app } = await import("../src/server"));
  ({ db: database } = await import("../src/server/db"));
  ({ seedSession, seedSuggestion } = await import("./helpers/experiment-db"));
});
beforeEach(() => {
  database.run("DELETE FROM experiment_reviews");
  database.run("DELETE FROM experiment_sessions");
  database.run("DELETE FROM experiments");
  database.run("DELETE FROM suggestions");
  database.run("DELETE FROM reports");
  database.run("DELETE FROM sessions");
  seedSession(database, "baseline-1");
  seedSession(database, "trial-1", { errors: 0 });
  seedSuggestion(database);
});
const jsonRequest = (path: string, method: string, body?: unknown) => app.request(`http://127.0.0.1${path}`, {
  method, headers: { host: "127.0.0.1", "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("experiment API", () => {
  test("creates, lists, reads, advances, and reviews an experiment", async () => {
    const createdResponse = await jsonRequest("/api/experiments", "POST", {
      suggestionId: "suggestion-1", hypothesis: "One retry lowers failures",
      metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"],
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as any;
    expect((await app.request("http://127.0.0.1/api/experiments", { headers: { host: "127.0.0.1" } })).status).toBe(200);
    expect((await app.request(`http://127.0.0.1/api/experiments/${created.id}`, { headers: { host: "127.0.0.1" } })).status).toBe(200);
    expect((await jsonRequest(`/api/experiments/${created.id}/start`, "POST", {})).status).toBe(200);
    expect((await jsonRequest(`/api/experiments/${created.id}/cohorts/trial`, "PUT", { sessionIds: ["trial-1"] })).status).toBe(200);
    expect((await jsonRequest(`/api/experiments/${created.id}/ready`, "POST", {})).status).toBe(200);
    const reviewed = await jsonRequest(`/api/experiments/${created.id}/reviews`, "POST", { outcome: "adopt_change", note: "The target was met descriptively." });
    expect(reviewed.status).toBe(201);
    expect((await reviewed.json() as any).state).toBe("completed");
  });

  test("maps malformed, missing, conflicting, and insufficient requests", async () => {
    const invalid = await jsonRequest("/api/experiments", "POST", { suggestionId: "suggestion-1", hypothesis: "x", metricKind: "tool_failure_rate", targetValue: -1, baselineSessionIds: ["baseline-1"] });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_request" });
    const invalidState = await app.request("http://127.0.0.1/api/experiments?state=unknown", { headers: { host: "127.0.0.1" } });
    expect(invalidState.status).toBe(400);
    expect(await invalidState.json()).toMatchObject({ code: "invalid_request" });
    expect((await app.request("http://127.0.0.1/api/experiments/missing", { headers: { host: "127.0.0.1" } })).status).toBe(404);
    const missingSession = await jsonRequest("/api/experiments", "POST", { suggestionId: "suggestion-1", hypothesis: "x", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["missing"] });
    expect(missingSession.status).toBe(404);
    expect(await missingSession.json()).toMatchObject({ code: "session_not_found" });
    const created = await (await jsonRequest("/api/experiments", "POST", { suggestionId: "suggestion-1", hypothesis: "x", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] })).json() as any;
    expect((await jsonRequest("/api/experiments", "POST", { suggestionId: "suggestion-1", hypothesis: "x", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] })).status).toBe(409);
    await jsonRequest(`/api/experiments/${created.id}/start`, "POST", {});
    const locked = await jsonRequest(`/api/experiments/${created.id}/cohorts/baseline`, "PUT", { sessionIds: ["trial-1"] });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ code: "cohort_locked" });
    const overlap = await jsonRequest(`/api/experiments/${created.id}/cohorts/trial`, "PUT", { sessionIds: ["baseline-1"] });
    expect(overlap.status).toBe(409);
    expect(await overlap.json()).toMatchObject({ code: "cohort_overlap" });
    const invalidCohort = await jsonRequest(`/api/experiments/${created.id}/cohorts/control`, "PUT", { sessionIds: [] });
    expect(invalidCohort.status).toBe(400);
    expect(await invalidCohort.json()).toMatchObject({ code: "invalid_request" });
    const insufficient = await jsonRequest(`/api/experiments/${created.id}/ready`, "POST", {});
    expect(insufficient.status).toBe(422);
    expect(await insufficient.json()).toMatchObject({ code: "insufficient_metric_data" });
  });
});
```

- [ ] **Step 2: Extend the request-boundary tests**

```ts
// append inside the request boundary describe block in apps/web/tests/security.test.ts
test("applies the existing trust tier and JSON requirement to experiment mutations", async () => {
  expect((await app.request("http://127.0.0.1/api/experiments", {
    method: "POST", headers: { host: "127.0.0.1" }, body: "{}",
  })).status).toBe(415);
  expect((await app.request("https://agents.example.com/api/experiments", {
    headers: { host: "agents.example.com" },
  })).status).toBe(401);
});
```

- [ ] **Step 3: Run the API tests and verify that they fail**

Run from `apps/web`:

```bash
bun test tests/experiments-api.test.ts tests/security.test.ts
```

Expected: FAIL with missing routes.

- [ ] **Step 4: Add one service instance and one domain-error adapter**

```ts
// apps/web/src/server.ts
import { createExperimentService, ExperimentError } from "./server/experiments";
import { CohortKind, ExperimentState } from "./shared/schemas";

const experimentService = createExperimentService(db);
const experimentResponse = <T,>(c: Context, operation: () => T, successStatus: 200 | 201 = 200) => {
  try { return c.json(operation(), successStatus); }
  catch (error) {
    if (error instanceof ExperimentError) {
      return c.json({ error: error.message, code: error.code, ...(error.details === undefined ? {} : { details: error.details }) }, error.status);
    }
    throw error;
  }
};
```

- [ ] **Step 5: Add the exact query and mutation routes**

```ts
app.get("/api/experiments", (c) => experimentResponse(c, () => {
  const state = c.req.query("state");
  if (!state) return { rows: experimentService.listExperiments() };
  const parsed = ExperimentState.safeParse(state);
  if (!parsed.success) throw new ExperimentError(400, "invalid_request", "state is not a valid experiment state", parsed.error.flatten());
  return { rows: experimentService.listExperiments({ state: parsed.data }) };
}));
app.get("/api/experiments/:id", (c) => experimentResponse(c, () => experimentService.getExperiment(c.req.param("id"))));
app.post("/api/experiments", async (c) => {
  const body = await c.req.json().catch(() => null);
  return experimentResponse(c, () => experimentService.createExperiment(body), 201);
});
app.put("/api/experiments/:id/cohorts/:cohort", async (c) => {
  const cohort = CohortKind.safeParse(c.req.param("cohort"));
  if (!cohort.success) return c.json({ error: "cohort must be baseline or trial", code: "invalid_request" }, 400);
  const body = await c.req.json().catch(() => null) as any;
  return experimentResponse(c, () => experimentService.replaceCohort(c.req.param("id"), cohort.data, body?.sessionIds));
});
app.post("/api/experiments/:id/start", (c) => experimentResponse(c, () => experimentService.startExperiment(c.req.param("id"))));
app.post("/api/experiments/:id/ready", (c) => experimentResponse(c, () => experimentService.markReadyForReview(c.req.param("id"))));
app.post("/api/experiments/:id/reviews", async (c) => {
  const body = await c.req.json().catch(() => null) as any;
  return experimentResponse(c, () => experimentService.reviewExperiment(c.req.param("id"), body), 201);
});
```

- [ ] **Step 6: Normalize `/api/reports` suggestion DTOs**

Replace the nested suggestion mapper with an explicit camel-case projection and left join:

```ts
const reportSuggestionRows = db.query(`SELECT s.*,e.id experiment_id
  FROM suggestions s LEFT JOIN experiments e ON e.source_suggestion_id=s.id
  WHERE s.report_id=? ORDER BY s.created_at,s.id`);

const suggestionDto = (row: any) => ({
  id: row.id, reportId: row.report_id, findingKey: row.finding_key,
  title: row.title, impact: row.impact, effort: row.effort, confidence: Number(row.confidence),
  rationale: row.rationale, evidence: json(row.evidence_json, []), status: row.status,
  createdAt: row.created_at, experiment: json(row.experiment_json, null), experimentId: row.experiment_id ?? null,
});
```

Replace the compact report route with the complete camel-case projection:

```ts
app.get("/api/reports", (c) => c.json({
  rows: (db.query("SELECT * FROM reports ORDER BY created_at DESC LIMIT 50").all() as any[]).map((report) => ({
    id: report.id, createdAt: report.created_at, periodStart: report.period_start,
    periodEnd: report.period_end, model: report.model, summary: report.summary,
    detectors: json(report.detectors_json, []),
    suggestions: reportSuggestionRows.all(report.id).map(suggestionDto),
  })),
}));
```

- [ ] **Step 7: Run API, security, and domain tests**

Run from `apps/web`:

```bash
bun test tests/experiments-api.test.ts tests/security.test.ts tests/experiments-domain.test.ts tests/analyst.test.ts
bun run typecheck
```

Expected: PASS with `201` only for create/review, `200` for other successes, and the exact error envelope on every domain failure.

- [ ] **Step 8: Stage the HTTP checkpoint**

```bash
git add apps/web/src/server.ts apps/web/tests/experiments-api.test.ts apps/web/tests/security.test.ts
```

Submit the staged checkpoint through the automated PR workflow with title `feat(web): expose experiment API`.

### Task 7: Client Data State, Setup, and Active Trial

**Files:**
- Create: `apps/web/src/client/experiments.tsx`
- Create: `apps/web/tests/experiments-ui.test.tsx`

**Interfaces:**
- Consumes: `ExperimentDetail`, `ExperimentSummary`, `Suggestion`, and session DTOs from the existing `/api/sessions`; request injection with the same signature as `main.tsx`'s `api` helper.
- Produces: `Experiments`, `ExperimentSetupView`, `ExperimentActiveView`, `SessionPicker`, `experimentReducer`, and `ExperimentRequest` for Task 9 shell integration.

- [ ] **Step 1: Write failing reducer and setup-markup tests**

```tsx
// apps/web/tests/experiments-ui.test.tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ExperimentSetupView, SessionPicker, experimentReducer, initialExperimentUiState,
} from "../src/client/experiments";
import type { Suggestion } from "../src/shared/schemas";

const suggestion = {
  id: "suggestion-1", reportId: "report-1", findingKey: "failed_tools:codex",
  title: "Reduce repeated tool retries", impact: "high", effort: "low", confidence: 0.8,
  rationale: "Compare retry settings.", evidence: [], status: "open", createdAt: "2026-08-30T12:00:00Z",
  experiment: { hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", metricVersion: 1, targetValue: 0.1 },
  experimentId: null,
} as Suggestion;
const sessions = [{
  id: "s1", provider: "codex", model: "gpt-5", project: "omarchy-agents", title: "Retry investigation",
  startedAt: "2026-08-30T10:00:00Z", endedAt: "2026-08-30T11:00:00Z",
  tokenInput: 100, tokenOutput: 50, cacheRead: 20, cacheWrite: 10, errorCount: 2, toolCount: 10,
}];

describe("experiment client state", () => {
  test("preserves explicit selections and review text across a save error", () => {
    const edited = experimentReducer(initialExperimentUiState, {
      type: "patch_draft", value: { baselineSessionIds: ["s1"], note: "Keep this note" },
    });
    const failed = experimentReducer(edited, { type: "save_failed", message: "network unavailable" });
    expect(failed.draft.baselineSessionIds).toEqual(["s1"]);
    expect(failed.draft.note).toBe("Keep this note");
    expect(failed.saveError).toBe("network unavailable");
  });

  test("renders an unselected, labeled session picker", () => {
    const html = renderToStaticMarkup(<SessionPicker legend="Baseline sessions" rows={sessions} selectedIds={[]} onChange={() => {}} />);
    expect(html).toContain("Baseline sessions");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("checked=\"\"");
  });

  test("renders the confirmed metric and Start trial action", () => {
    const html = renderToStaticMarkup(<ExperimentSetupView
      suggestion={suggestion} sessions={sessions} draft={{
        hypothesis: suggestion.experiment!.hypothesis, metricKind: suggestion.experiment!.metricKind,
        targetValue: suggestion.experiment!.targetValue, baselineSessionIds: [], trialSessionIds: [], note: "", outcome: null,
      }} busy={false} error="" onPatch={() => {}} onStart={() => {}} onLoadMore={() => {}} hasMore={false}
    />);
    expect(html).toContain("Finding");
    expect(html).toContain("Metric");
    expect(html).toContain("Baseline");
    expect(html).toContain("Start trial");
  });
});
```

- [ ] **Step 2: Run the UI test and verify that it fails**

Run from `apps/web`:

```bash
bun test tests/experiments-ui.test.tsx
```

Expected: FAIL because the client module does not exist.

- [ ] **Step 3: Define the injected request boundary and reducer**

```tsx
// apps/web/src/client/experiments.tsx
import React, { useEffect, useReducer, useState } from "react";
import type {
  ExperimentDetail, ExperimentOutcome, ExperimentSummary, MetricKind, Suggestion,
} from "../shared/schemas";

export type ExperimentRequest = <T,>(path: string, init?: RequestInit) => Promise<T>;
export type SessionRow = {
  id: string; provider: string; model: string | null; project: string | null; title: string | null;
  startedAt: string; endedAt: string | null; tokenInput: number; tokenOutput: number;
  cacheRead: number; cacheWrite: number; errorCount: number; toolCount: number;
};
export type ExperimentDraft = {
  hypothesis: string; metricKind: MetricKind; targetValue: number;
  baselineSessionIds: string[]; trialSessionIds: string[];
  note: string; outcome: ExperimentOutcome | null;
};
export type ExperimentUiState = {
  phase: "loading" | "ready" | "empty" | "error";
  summaries: ExperimentSummary[]; detail: ExperimentDetail | null; suggestion: Suggestion | null;
  sessions: SessionRow[]; sessionsTotal: number; loadError: string; saveError: string; busy: boolean;
  draft: ExperimentDraft;
};
export const initialExperimentUiState: ExperimentUiState = {
  phase: "loading", summaries: [], detail: null, suggestion: null, sessions: [], sessionsTotal: 0,
  loadError: "", saveError: "", busy: false,
  draft: { hypothesis: "", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: [], trialSessionIds: [], note: "", outcome: null },
};
type Action =
  | { type: "loading" }
  | { type: "loaded"; summaries: ExperimentSummary[]; detail: ExperimentDetail | null; suggestion: Suggestion | null; sessions: SessionRow[]; sessionsTotal: number }
  | { type: "load_failed"; message: string }
  | { type: "patch_draft"; value: Partial<ExperimentDraft> }
  | { type: "saving" }
  | { type: "persisted"; detail: ExperimentDetail }
  | { type: "saved"; detail: ExperimentDetail }
  | { type: "save_failed"; message: string }
  | { type: "append_sessions"; rows: SessionRow[]; total: number };

export function experimentReducer(state: ExperimentUiState, action: Action): ExperimentUiState {
  if (action.type === "loading") return { ...state, phase: "loading", loadError: "" };
  if (action.type === "loaded") {
    const defaults = action.suggestion?.experiment;
    return {
      ...state, phase: action.detail || action.suggestion ? "ready" : "empty",
      summaries: action.summaries, detail: action.detail, suggestion: action.suggestion,
      sessions: action.sessions, sessionsTotal: action.sessionsTotal, loadError: "", saveError: "",
      draft: action.detail ? {
        ...state.draft, hypothesis: action.detail.hypothesis, metricKind: action.detail.metricKind,
        targetValue: action.detail.targetValue, baselineSessionIds: action.detail.cohorts.baseline,
        trialSessionIds: action.detail.cohorts.trial,
      } : defaults ? {
        ...state.draft, hypothesis: defaults.hypothesis, metricKind: defaults.metricKind,
        targetValue: defaults.targetValue, baselineSessionIds: [], trialSessionIds: [],
      } : state.draft,
    };
  }
  if (action.type === "load_failed") return { ...state, phase: "error", loadError: action.message };
  if (action.type === "patch_draft") return { ...state, draft: { ...state.draft, ...action.value } };
  if (action.type === "saving") return { ...state, busy: true, saveError: "" };
  if (action.type === "persisted") return {
    ...state, detail: action.detail,
    draft: { ...state.draft, baselineSessionIds: action.detail.cohorts.baseline, trialSessionIds: action.detail.cohorts.trial },
  };
  if (action.type === "saved") return {
    ...state, busy: false, saveError: "", detail: action.detail,
    suggestion: action.detail.state === "draft" ? state.suggestion : null,
    draft: { ...state.draft, baselineSessionIds: action.detail.cohorts.baseline, trialSessionIds: action.detail.cohorts.trial },
  };
  if (action.type === "save_failed") return { ...state, busy: false, saveError: action.message };
  const known = new Set(state.sessions.map((session) => session.id));
  return { ...state, sessions: [...state.sessions, ...action.rows.filter((session) => !known.has(session.id))], sessionsTotal: action.total };
}
```

- [ ] **Step 4: Implement explicit session selection with pagination**

```tsx
export function SessionPicker({
  legend, rows, selectedIds, onChange, onLoadMore, hasMore = false,
}: {
  legend: string; rows: SessionRow[]; selectedIds: string[];
  onChange: (ids: string[]) => void; onLoadMore?: () => void; hasMore?: boolean;
}) {
  const selected = new Set(selectedIds);
  const toggle = (sessionId: string) => onChange(
    selected.has(sessionId) ? selectedIds.filter((id) => id !== sessionId) : [...selectedIds, sessionId],
  );
  return <fieldset className="experiment-picker">
    <legend>{legend}</legend>
    <p>Only checked sessions belong to this cohort.</p>
    <div className="experiment-picker-list">
      {rows.map((session) => <label key={session.id}>
        <input type="checkbox" checked={selected.has(session.id)} onChange={() => toggle(session.id)} />
        <span><strong>{session.title || "Untitled session"}</strong><small>{session.provider} · {new Date(session.startedAt).toLocaleString()}</small></span>
        <em>{session.toolCount} tools · {session.errorCount} errors</em>
      </label>)}
    </div>
    {hasMore && <button type="button" className="button" onClick={onLoadMore}>Load more sessions</button>}
  </fieldset>;
}
```

Do not initialize `selectedIds` from suggestion citations. The only initial selection for a new experiment is `[]`.

- [ ] **Step 5: Implement the setup and active pure views**

```tsx
export type ExperimentSetupSource = Pick<Suggestion, "title" | "rationale" | "findingKey">;

export function ExperimentSetupView({ suggestion, sessions, draft, definitionLocked = false, busy, error, onPatch, onStart, onLoadMore, hasMore }: {
  suggestion: ExperimentSetupSource; sessions: SessionRow[]; draft: ExperimentDraft; definitionLocked?: boolean; busy: boolean; error: string;
  onPatch: (value: Partial<ExperimentDraft>) => void; onStart: () => void; onLoadMore: () => void; hasMore: boolean;
}) {
  return <section className="experiment-setup" aria-labelledby="experiment-setup-title">
    <header className="experiment-pagehead"><div><span>New experiment</span><h1 id="experiment-setup-title">{suggestion.title}</h1><p>{suggestion.rationale}</p></div></header>
    <ol className="experiment-steps" aria-label="Experiment setup steps"><li>Finding</li><li>Metric</li><li>Baseline</li><li>Trial</li></ol>
    <section><h2>Finding</h2><p>{suggestion.findingKey}</p></section>
    {definitionLocked && <p className="notice">The experiment definition was already saved. You can repair its baseline selection and retry Start trial.</p>}
    <label className="experiment-field">Hypothesis<textarea value={draft.hypothesis} disabled={definitionLocked} maxLength={1000} onChange={(event) => onPatch({ hypothesis: event.target.value })} /></label>
    <div className="experiment-fields">
      <label>Metric<select value={draft.metricKind} disabled={definitionLocked} onChange={(event) => onPatch({ metricKind: event.target.value as MetricKind })}>
        <option value="tool_failure_rate">Tool failure rate</option><option value="tokens_per_session">Tokens per session</option>
        <option value="average_duration_minutes">Average session duration</option><option value="cache_read_ratio">Cache-read ratio</option>
      </select></label>
      <label>Target<input type="number" min="0" step="any" value={draft.targetValue} disabled={definitionLocked} onChange={(event) => onPatch({ targetValue: Number(event.target.value) })} /></label>
    </div>
    <SessionPicker legend="Baseline sessions" rows={sessions} selectedIds={draft.baselineSessionIds} onChange={(baselineSessionIds) => onPatch({ baselineSessionIds })} onLoadMore={onLoadMore} hasMore={hasMore} />
    {error && <p className="notice error" role="alert">{error}</p>}
    <button type="button" className="button primary" disabled={busy || !draft.hypothesis.trim() || !draft.baselineSessionIds.length || !Number.isFinite(draft.targetValue) || draft.targetValue < 0} onClick={onStart}>
      {busy ? "Starting…" : "Start trial"}
    </button>
  </section>;
}

export function ExperimentActiveView({ detail, sessions, draft, busy, error, onPatch, onSaveTrial, onReview, onLoadMore, hasMore }: {
  detail: ExperimentDetail; sessions: SessionRow[]; draft: ExperimentDraft; busy: boolean; error: string;
  onPatch: (value: Partial<ExperimentDraft>) => void; onSaveTrial: () => void; onReview: () => void; onLoadMore: () => void; hasMore: boolean;
}) {
  const valid = detail.currentCalculation.baseline.validCount > 0 && detail.currentCalculation.trial.validCount > 0;
  const missingCount = [...detail.currentCalculation.baseline.excluded, ...detail.currentCalculation.trial.excluded]
    .filter((item) => item.reason === "session_missing").length;
  return <section className="experiment-active" aria-labelledby="experiment-active-title">
    <header className="experiment-pagehead"><div><span>Active experiment</span><h1 id="experiment-active-title">{detail.title}</h1><p>{detail.hypothesis}</p></div></header>
    <div className="experiment-live-metric" aria-live="polite"><strong>{detail.currentCalculation.baseline.formatted}</strong><span>baseline</span><strong>{detail.currentCalculation.trial.formatted}</strong><span>trial · descriptive</span></div>
    <p>Baseline is locked. Trial membership changes only when you save the checked set.</p>
    {missingCount > 0 && <p className="notice" role="status">{missingCount} selected session{missingCount === 1 ? " is" : "s are"} temporarily unavailable in the index. Membership is preserved; review stays disabled until metric-valid rows return.</p>}
    <SessionPicker legend="Trial sessions" rows={sessions} selectedIds={draft.trialSessionIds} onChange={(trialSessionIds) => onPatch({ trialSessionIds })} onLoadMore={onLoadMore} hasMore={hasMore} />
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="experiment-actions"><button type="button" className="button" disabled={busy} onClick={onSaveTrial}>Save trial sessions</button><button type="button" className="button primary" disabled={busy || !valid} onClick={onReview}>Review experiment</button></div>
  </section>;
}
```

The normal setup remains fully editable until `POST /api/experiments`. A persisted `draft` is only the recoverable intermediate state after create succeeded but start failed; the approved HTTP contract has no definition-update endpoint, so that recovery view locks hypothesis/metric/target while leaving baseline repair available.

- [ ] **Step 6: Implement the data-loading and setup/active mutations**

```tsx
export function Experiments({ request, search, onOpenSession, onOpenAnalyst }: {
  request: ExperimentRequest; search?: string;
  onOpenSession: (sessionId: string, eventId?: string | null) => void; onOpenAnalyst: () => void;
}) {
  const [state, dispatch] = useReducer(experimentReducer, initialExperimentUiState);
  const [routeSearch, setRouteSearch] = useState(search ?? (typeof window === "undefined" ? "" : window.location.search));
  useEffect(() => {
    if (search !== undefined) { setRouteSearch(search); return; }
    const sync = () => setRouteSearch(window.location.search);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [search]);

  const load = async (requestedSearch = routeSearch) => {
    dispatch({ type: "loading" });
    try {
      const requested = new URLSearchParams(requestedSearch);
      const selectedId = requested.get("id");
      const suggestionId = requested.get("suggestion");
      const [list, reports, sessionPage] = await Promise.all([
        request<{ rows: ExperimentSummary[] }>("/api/experiments"),
        request<{ rows: Array<{ suggestions: Suggestion[] }> }>("/api/reports"),
        request<{ rows: SessionRow[]; total: number }>("/api/sessions?limit=100&offset=0"),
      ]);
      const allSuggestions = reports.rows.flatMap((report) => report.suggestions);
      let suggestion = allSuggestions.find((item) => item.id === suggestionId) ?? null;
      const targetId = selectedId ?? (!suggestionId ? list.rows.find((item) => item.state === "active")?.id ?? list.rows[0]?.id : null);
      const detail = targetId ? await request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(targetId)}`) : null;
      if (!suggestion && detail?.state === "draft") suggestion = allSuggestions.find((item) => item.id === detail.sourceSuggestionId) ?? null;
      dispatch({ type: "loaded", summaries: list.rows, detail, suggestion, sessions: sessionPage.rows, sessionsTotal: sessionPage.total });
    } catch (error) {
      dispatch({ type: "load_failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  useEffect(() => { void load(routeSearch); }, [routeSearch]);

  const sourceFromSnapshot = (detail: ExperimentDetail): ExperimentSetupSource => ({
    title: detail.source.suggestion.title,
    rationale: detail.source.suggestion.rationale,
    findingKey: detail.source.findingKey,
  });

  const mutate = async (operation: () => Promise<ExperimentDetail>) => {
    dispatch({ type: "saving" });
    try { dispatch({ type: "saved", detail: await operation() }); }
    catch (error) { dispatch({ type: "save_failed", message: error instanceof Error ? error.message : String(error) }); }
  };
  const start = async () => {
    dispatch({ type: "saving" });
    try {
      let draft = state.detail?.state === "draft" ? state.detail : null;
      if (!draft) {
        draft = await request<ExperimentDetail>("/api/experiments", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
            suggestionId: state.suggestion!.id, hypothesis: state.draft.hypothesis,
            metricKind: state.draft.metricKind, targetValue: state.draft.targetValue,
            baselineSessionIds: state.draft.baselineSessionIds,
          }),
        });
        dispatch({ type: "persisted", detail: draft });
        const nextSearch = `?id=${encodeURIComponent(draft.id)}`;
        if (typeof window !== "undefined") window.history.replaceState({}, "", `/experiments${nextSearch}`);
      } else {
        draft = await request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(draft.id)}/cohorts/baseline`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionIds: state.draft.baselineSessionIds }),
        });
        dispatch({ type: "persisted", detail: draft });
      }
      const active = await request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(draft.id)}/start`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      dispatch({ type: "saved", detail: active });
      const nextSearch = `?id=${encodeURIComponent(active.id)}`;
      setRouteSearch(nextSearch);
    } catch (error) {
      dispatch({ type: "save_failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const saveTrial = () => mutate(() => request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(state.detail!.id)}/cohorts/trial`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionIds: state.draft.trialSessionIds }),
  }));
  const ready = () => mutate(() => request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(state.detail!.id)}/ready`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  const loadMore = async () => {
    try {
      const page = await request<{ rows: SessionRow[]; total: number }>(`/api/sessions?limit=100&offset=${state.sessions.length}`);
      dispatch({ type: "append_sessions", rows: page.rows, total: page.total });
    } catch (error) {
      dispatch({ type: "save_failed", message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (state.phase === "loading") return <section className="experiment-loading" aria-busy="true"><h1>Experiments</h1><p>Loading explicitly selected evidence…</p></section>;
  if (state.phase === "error") return <section><h1>Experiments</h1><p className="notice error" role="alert">{state.loadError}</p><button className="button" type="button" onClick={() => void load()}>Retry</button></section>;
  if (state.phase === "empty") return <section className="empty"><strong>No experiments yet</strong><span>Start from a supported cited suggestion in Analyst.</span><button className="text-button" type="button" onClick={onOpenAnalyst}>Open Analyst</button></section>;
  if (state.suggestion || state.detail?.state === "draft") {
    const setupSource = state.suggestion ?? sourceFromSnapshot(state.detail!);
    return <ExperimentSetupView
      suggestion={setupSource} sessions={state.sessions} draft={state.draft} definitionLocked={Boolean(state.detail)}
      busy={state.busy} error={state.saveError} onPatch={(value) => dispatch({ type: "patch_draft", value })}
      onStart={() => void start()} onLoadMore={() => void loadMore()} hasMore={state.sessions.length < state.sessionsTotal}
    />;
  }
  if (state.detail?.state === "active") return <ExperimentActiveView
    detail={state.detail} sessions={state.sessions} draft={state.draft} busy={state.busy} error={state.saveError}
    onPatch={(value) => dispatch({ type: "patch_draft", value })} onSaveTrial={() => void saveTrial()}
    onReview={() => void ready()} onLoadMore={() => void loadMore()} hasMore={state.sessions.length < state.sessionsTotal}
  />;
  return <section className="experiment-review-ready" aria-live="polite"><h1>{state.detail!.title}</h1><p>The explicit cohorts are locked and ready for human review.</p></section>;
}
```

- [ ] **Step 7: Run UI tests and type checking**

Run from `apps/web`:

```bash
bun test tests/experiments-ui.test.tsx
bun run typecheck
```

Expected: PASS. The server-rendered picker contains no checked input until the user selects one.

- [ ] **Step 8: Stage the setup and active-trial checkpoint**

```bash
git add apps/web/src/client/experiments.tsx apps/web/tests/experiments-ui.test.tsx
```

Submit the staged checkpoint through the automated PR workflow with title `feat(web): add experiment setup and trial views`.

### Task 8: Review Screen, History, and Evidence Ledger

**Files:**
- Modify: `apps/web/src/shared/schemas.ts`
- Modify: `apps/web/src/server/experiments.ts`
- Modify: `apps/web/src/client/experiments.tsx`
- Modify: `apps/web/tests/experiments-domain.test.ts`
- Modify: `apps/web/tests/experiments-ui.test.tsx`

**Interfaces:**
- Consumes: `ExperimentDetail.currentCalculation`, stored review history, source citations, and explicit cohort membership.
- Produces: `ExperimentSessionView[]` on detail responses; `ExperimentReviewView`; `EvidenceLedger`; filter/history state; review save behavior.

- [ ] **Step 1: Add the session-ledger DTO to the shared detail contract**

```ts
// apps/web/src/shared/schemas.ts
export type ExperimentSessionView = {
  sessionId: string; cohort: CohortKind; available: boolean;
  provider: string | null; title: string | null; startedAt: string | null; endedAt: string | null;
  tokenTotal: number | null; errorCount: number | null; toolCount: number | null;
  evidenceEventId: string | null;
};

// Add this property to ExperimentDetail:
sessions: ExperimentSessionView[];
```

- [ ] **Step 2: Write failing read-model and semantic review tests**

```ts
// append to apps/web/tests/experiments-domain.test.ts
test("returns available and missing ledger rows without removing membership", () => {
  const { database, service } = setup();
  const created = service.createExperiment({ suggestionId: "suggestion-1", hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: ["baseline-1"] });
  service.startExperiment(created.id);
  service.replaceCohort(created.id, "trial", ["trial-1"]);
  database.query("DELETE FROM sessions WHERE id='trial-1'").run();
  expect(service.getExperiment(created.id).sessions).toContainEqual(expect.objectContaining({
    sessionId: "trial-1", cohort: "trial", available: false,
  }));
});
```

```tsx
// append to apps/web/tests/experiments-ui.test.tsx
import { EvidenceLedger, ExperimentHistory, ExperimentReviewView } from "../src/client/experiments";
import type { ExperimentDetail } from "../src/shared/schemas";

const reviewDetail = {
  id: "experiment-1", title: "Reduce repeated tool retries", state: "ready_for_review",
  metricKind: "tool_failure_rate", metricVersion: 1, targetValue: 0.1,
  sourceSuggestionId: "suggestion-1", sourceReportId: "report-1",
  source: { findingKey: "failed_tools:codex", finding: null, suggestion: { title: "Reduce repeated tool retries", rationale: "Compare retry settings.", evidence: [], defaults: { hypothesis: "One retry lowers failures", metricKind: "tool_failure_rate", metricVersion: 1, targetValue: 0.1 } } },
  hypothesis: "One retry lowers failures", createdAt: "2026-08-30T12:00:00Z", updatedAt: "2026-08-30T13:00:00Z",
  cohorts: { baseline: ["b1"], trial: ["t1"] },
  sessions: [
    { sessionId: "b1", cohort: "baseline", available: true, provider: "codex", title: "Baseline", startedAt: "2026-08-24T10:00:00Z", endedAt: "2026-08-24T11:00:00Z", tokenTotal: 1000, errorCount: 2, toolCount: 10, evidenceEventId: null },
    { sessionId: "t1", cohort: "trial", available: true, provider: "codex", title: "Trial", startedAt: "2026-08-30T10:00:00Z", endedAt: "2026-08-30T11:00:00Z", tokenTotal: 900, errorCount: 1, toolCount: 20, evidenceEventId: "e1" },
  ],
  currentCalculation: {
    metricKind: "tool_failure_rate", metricVersion: 1, direction: "lower", targetValue: 0.1,
    baseline: { value: 0.2, formatted: "20.0%", validCount: 1, contributions: [], excluded: [] },
    trial: { value: 0.05, formatted: "5.0%", validCount: 1, contributions: [], excluded: [] },
    absoluteDelta: -0.15, directionalDelta: 0.15, targetMet: true, improved: true,
    sampleNote: "small_sample", calculatedAt: "2026-08-30T13:00:00Z",
  },
  reviews: [], availableActions: { replaceBaseline: false, replaceTrial: false, start: false, markReady: false, review: true },
} as ExperimentDetail;

test("renders the review as a semantic ledger and human decision", () => {
  const html = renderToStaticMarkup(<ExperimentReviewView detail={reviewDetail} draft={initialExperimentUiState.draft} busy={false} error="" onPatch={() => {}} onSave={() => {}} onOpenSession={() => {}} />);
  expect(html).toContain("Finding");
  expect(html).toContain("Hypothesis");
  expect(html).toContain("Baseline");
  expect(html).toContain("Trial");
  expect(html).toContain("Conclusion");
  expect(html).toContain("<table");
  expect(html).toContain("Your decision");
  expect(html).not.toContain("Your recommendation");
  expect(html).toContain('type="radio"');
  expect(html).toContain("No causal attribution");
  expect(html).toContain("≤10%");
});

test("marks the selected ledger filter with aria-pressed", () => {
  const html = renderToStaticMarkup(<EvidenceLedger detail={reviewDetail} filter="trial" onFilter={() => {}} onOpenSession={() => {}} />);
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("t1");
  expect(html).not.toContain(">b1<");
  expect(html).toContain('href="/logs?session=t1&amp;event=e1"');
});

test("renders completed reviews read-only and keeps history controls text-backed", () => {
  const completed = {
    ...reviewDetail, state: "completed",
    reviews: [{ id: "review-1", outcome: "adopt_change", note: "Keep one retry and monitor abandonment.", calculation: reviewDetail.currentCalculation, createdAt: "2026-08-30T14:00:00Z" }],
  } as ExperimentDetail;
  const reviewHtml = renderToStaticMarkup(<ExperimentReviewView detail={completed} draft={initialExperimentUiState.draft} busy={false} error="" onPatch={() => {}} onSave={() => {}} onOpenSession={() => {}} />);
  expect(reviewHtml).toContain("Saved conclusion");
  expect(reviewHtml).toContain("Keep one retry and monitor abandonment.");
  expect(reviewHtml).not.toContain("<textarea");
  const historyHtml = renderToStaticMarkup(<ExperimentHistory summaries={[completed]} selectedId={completed.id} onChoose={() => {}} />);
  expect(historyHtml).toContain("Experiment history");
  expect(historyHtml).toContain('aria-haspopup="menu"');
});
```

- [ ] **Step 3: Run the focused tests and verify that they fail**

Run from `apps/web`:

```bash
bun test tests/experiments-domain.test.ts tests/experiments-ui.test.tsx
```

Expected: FAIL because detail responses have no ledger rows and review components do not exist.

- [ ] **Step 4: Add ledger rows to `getExperiment`**

```ts
// inside createExperimentService in apps/web/src/server/experiments.ts
const experimentSessions = (experimentId: string, source: import("../shared/schemas").ExperimentSourceSnapshot) => {
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
```

Parse `source_snapshot_json` once near the top of `getExperiment`, pass it to `experimentSessions`, and return both `source` and `sessions`.

- [ ] **Step 5: Implement the filterable semantic ledger**

```tsx
export type EvidenceFilter = "all" | "baseline" | "trial";
const metricLabels: Record<MetricKind, string> = {
  tool_failure_rate: "Tool failure rate", tokens_per_session: "Tokens per session",
  average_duration_minutes: "Average duration", cache_read_ratio: "Cache-read ratio",
};
const metricDescriptions: Record<MetricKind, string> = {
  tool_failure_rate: "tool errors ÷ tool calls", tokens_per_session: "input + output + cache tokens",
  average_duration_minutes: "positive end − start minutes", cache_read_ratio: "cache-read ÷ input tokens",
};
const formatContribution = (metricKind: MetricKind, value: number) => {
  if (metricKind === "tool_failure_rate" || metricKind === "cache_read_ratio") return `${(value * 100).toFixed(1)}%`;
  if (metricKind === "average_duration_minutes") return `${value.toFixed(1)} min`;
  return Math.round(value).toLocaleString("en-US");
};
const providerNames: Record<string, string> = {
  claude: "Claude Code", opencode: "opencode", antigravity: "Antigravity", codex: "Codex",
};
function ProviderIdentity({ provider }: { provider: string | null }) {
  if (!provider) return <>Unavailable</>;
  return <span className="experiment-provider"><img src={`/provider-assets/${encodeURIComponent(provider)}.svg`} alt="" onError={(event) => { event.currentTarget.hidden = true; }} /><strong>{providerNames[provider] ?? provider}</strong></span>;
}

export function EvidenceLedger({ detail, filter, onFilter, onOpenSession }: {
  detail: ExperimentDetail; filter: EvidenceFilter; onFilter: (filter: EvidenceFilter) => void;
  onOpenSession: (sessionId: string, eventId?: string | null) => void;
}) {
  const rows = filter === "all" ? detail.sessions : detail.sessions.filter((session) => session.cohort === filter);
  const contributionBySession = new Map(
    [...detail.currentCalculation.baseline.contributions, ...detail.currentCalculation.trial.contributions]
      .map((contribution) => [contribution.sessionId, contribution.value]),
  );
  return <section className="experiment-evidence" aria-labelledby="experiment-evidence-title">
    <header><div><h2 id="experiment-evidence-title">Evidence ledger—explicitly selected sessions</h2><p>{detail.sessions.length} sessions across both cohorts</p></div>
      <div className="segmented" aria-label="Filter evidence sessions">{(["all", "baseline", "trial"] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => onFilter(value)}>{value[0].toUpperCase() + value.slice(1)} ({value === "all" ? detail.sessions.length : detail.sessions.filter((row) => row.cohort === value).length})</button>)}</div>
    </header>
    <div className="experiment-table-scroll" role="region" aria-label="Experiment evidence sessions" tabIndex={0}>
      <table><thead><tr><th scope="col">Cohort</th><th scope="col">Provider</th><th scope="col">Session ID</th><th scope="col">Date (UTC)</th><th scope="col">Tokens</th><th scope="col">Tool failures</th><th scope="col">{metricLabels[detail.metricKind]}</th><th scope="col">Evidence anchor</th></tr></thead>
        <tbody>{rows.map((session) => {
          const contribution = contributionBySession.get(session.sessionId);
          const eventQuery = session.evidenceEventId ? `&event=${encodeURIComponent(session.evidenceEventId)}` : "";
          const evidenceHref = `/logs?session=${encodeURIComponent(session.sessionId)}${eventQuery}`;
          return <tr key={session.sessionId} className={session.available ? "" : "missing"}>
            <td>{session.cohort}</td><td><ProviderIdentity provider={session.provider} /></td><th scope="row">{session.sessionId}</th>
            <td>{session.startedAt ? new Date(session.startedAt).toISOString() : "Session missing"}</td>
            <td>{session.tokenTotal?.toLocaleString("en-US") ?? "—"}</td><td>{session.errorCount ?? "—"}</td><td>{contribution === undefined ? "—" : formatContribution(detail.metricKind, contribution)}</td>
            <td>{session.available ? <a className="text-button" href={evidenceHref} onClick={(event) => {
              event.preventDefault();
              onOpenSession(session.sessionId, session.evidenceEventId);
            }}>{session.evidenceEventId ? "Open event" : "Open session"}</a> : <span>Evidence unavailable</span>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}
```

- [ ] **Step 6: Implement the evidence thread, metric band, and decision form**

```tsx
const outcomeLabels: Record<ExperimentOutcome, string> = {
  adopt_change: "Adopt change", extend_trial: "Extend trial", no_improvement: "No improvement",
};

export function formatTarget(metricKind: MetricKind, targetValue: number, direction: "lower" | "higher") {
  const comparator = direction === "lower" ? "≤" : "≥";
  const numeric = targetValue.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (metricKind === "tool_failure_rate" || metricKind === "cache_read_ratio") {
    return `${comparator}${(targetValue * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  }
  if (metricKind === "average_duration_minutes") return `${comparator}${numeric} min`;
  return `${comparator}${numeric}`;
}

export function SavedConclusion({ detail }: { detail: ExperimentDetail }) {
  const review = detail.reviews.at(-1);
  if (!review) return <section className="experiment-conclusion saved" aria-labelledby="saved-conclusion-title">
    <div><h2 id="saved-conclusion-title">Saved conclusion unavailable</h2><p>The completed experiment has no readable review snapshot.</p></div>
  </section>;
  return <section className="experiment-conclusion saved" aria-labelledby="saved-conclusion-title">
    <div><h2 id="saved-conclusion-title">Saved conclusion</h2><p>Recorded {new Date(review.createdAt).toLocaleString()}</p></div>
    <div><strong>{outcomeLabels[review.outcome]}</strong><p>{review.note}</p></div>
  </section>;
}

export function ReviewHistory({ reviews }: { reviews: ExperimentDetail["reviews"] }) {
  if (!reviews.length) return null;
  return <details className="experiment-review-history">
    <summary>Review history ({reviews.length})</summary>
    <ol>{reviews.map((review) => <li key={review.id}>
      <strong>{outcomeLabels[review.outcome]}</strong><time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleString()}</time><p>{review.note}</p>
    </li>)}</ol>
  </details>;
}

export function ExperimentReviewView({ detail, draft, busy, error, onPatch, onSave, onOpenSession }: {
  detail: ExperimentDetail; draft: ExperimentDraft; busy: boolean; error: string;
  onPatch: (value: Partial<ExperimentDraft>) => void; onSave: () => void;
  onOpenSession: (sessionId: string, eventId?: string | null) => void;
}) {
  const [filter, setFilter] = useState<EvidenceFilter>("all");
  const calculation = detail.currentCalculation;
  return <section className="experiment-review" aria-labelledby="experiment-review-title">
    <header className="experiment-pagehead"><div><span>Experiment review</span><h1 id="experiment-review-title">{detail.title}</h1><p>{detail.id} · Created {new Date(detail.createdAt).toLocaleString()}</p></div><span className="status"><i aria-hidden="true" />{detail.state.replaceAll("_", " ")}</span></header>
    <ol className="experiment-thread" aria-label="Evidence thread">
      <li><span>Finding</span><strong>{detail.source.finding?.type.replaceAll("_", " ") ?? detail.source.findingKey}</strong><p>{detail.source.finding?.message ?? detail.source.suggestion.rationale}</p></li>
      <li><span>Hypothesis</span><strong>{detail.hypothesis}</strong></li>
      <li><span>Baseline</span><strong>{detail.cohorts.baseline.length} sessions</strong></li>
      <li><span>Trial</span><strong>{detail.cohorts.trial.length} sessions</strong></li>
      <li><span>Conclusion</span><strong>{detail.state === "completed" ? "Recorded" : "Human review required"}</strong></li>
    </ol>
    <dl className="experiment-metric-band">
      <div><dt>Primary metric</dt><dd>{metricLabels[detail.metricKind]}</dd><small>{metricDescriptions[detail.metricKind]} · {calculation.direction === "lower" ? "Lower is better" : "Higher is better"}</small></div>
      <div><dt>Baseline</dt><dd>{calculation.baseline.formatted}</dd><small>{calculation.baseline.validCount} valid sessions</small></div>
      <div><dt>Trial</dt><dd>{calculation.trial.formatted}</dd><small>{calculation.trial.validCount} valid sessions</small></div>
      <div><dt>Target</dt><dd>{formatTarget(detail.metricKind, detail.targetValue, calculation.direction)}</dd></div>
      <div><dt>Result</dt><dd>{calculation.targetMet === null ? "Not enough data" : calculation.targetMet ? "Target met · descriptive result" : "Target not met · descriptive result"}</dd><small>No causal attribution</small></div>
      <div><dt>Confidence</dt><dd>{calculation.sampleNote.replaceAll("_", " ")}</dd><small>{detail.sessions.length} sessions total</small></div>
    </dl>
    <EvidenceLedger detail={detail} filter={filter} onFilter={setFilter} onOpenSession={onOpenSession} />
    <ReviewHistory reviews={detail.reviews} />
    {detail.state === "completed" ? <SavedConclusion detail={detail} /> : <section className="experiment-conclusion"><div><h2>What did you learn?</h2><p>Summarize the take-away from this descriptive comparison.</p></div>
      <label><span className="sr-only">Review note</span><textarea value={draft.note} minLength={1} maxLength={1000} onChange={(event) => onPatch({ note: event.target.value })} /><small>{draft.note.length} / 1000 characters</small></label>
      <fieldset><legend>Your decision</legend>{([
        ["adopt_change", "Adopt change", "Implement the trial setting."],
        ["extend_trial", "Extend trial", "Collect more data before deciding."],
        ["no_improvement", "No improvement", "Do not adopt; end experiment."],
      ] as const).map(([value, label, description]) => <label key={value}><input type="radio" name="experiment-outcome" value={value} checked={draft.outcome === value} onChange={() => onPatch({ outcome: value })} /><span><strong>{label}</strong><small>{description}</small></span></label>)}</fieldset>
      <div>{error && <p className="notice error" role="alert">{error}</p>}<button type="button" className="experiment-save" disabled={busy || !draft.note.trim() || !draft.outcome} onClick={onSave}>{busy ? "Saving…" : "Save conclusion"}</button></div>
    </section>}
    <footer className="experiment-provenance">Provenance: {detail.sessions.length} explicitly selected sessions · metric computed from indexed session metrics · calculated {new Date(calculation.calculatedAt).toLocaleString()} · No causal attribution</footer>
  </section>;
}
```

- [ ] **Step 7: Add history selection and review mutations to `Experiments`**

Extend the React import with `useRef`, then add a self-contained history popover whose trigger visibly names the control and shows the selected experiment ID:

```tsx
import React, { useEffect, useReducer, useRef, useState } from "react";

export function ExperimentHistory({ summaries, selectedId, onChoose }: {
  summaries: ExperimentSummary[]; selectedId: string; onChoose: (experimentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeAndFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return <div className="experiment-history" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); closeAndFocus(); }
  }}>
    <button ref={trigger} type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
      <span>Experiment history</span><code>{selectedId}</code>
    </button>
    {open && <div className="experiment-history-menu" role="menu" aria-label="Experiment history">
      {summaries.map((summary) => <button type="button" role="menuitem" key={summary.id} onClick={() => {
        onChoose(summary.id);
        closeAndFocus();
      }}>
        <strong>{summary.title}</strong><span>{summary.state.replaceAll("_", " ")}</span>
        <small>{summary.id}</small><time dateTime={summary.updatedAt}>{new Date(summary.updatedAt).toLocaleString()}</time>
      </button>)}
    </div>}
  </div>;
}
```

Inside `Experiments`, route selection through `routeSearch`, wire review save through the existing `mutate` helper, and replace the three ready-state returns from Task 7 with this complete block:

```tsx
const chooseExperiment = (experimentId: string) => {
  const nextSearch = `?id=${encodeURIComponent(experimentId)}`;
  if (typeof window !== "undefined") window.history.pushState({}, "", `/experiments${nextSearch}`);
  setRouteSearch(nextSearch);
};
const saveReview = () => mutate(() => request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(state.detail!.id)}/reviews`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ outcome: state.draft.outcome, note: state.draft.note }),
}));

const withHistory = (content: React.ReactNode) => <>
  {state.detail && <ExperimentHistory summaries={state.summaries} selectedId={state.detail.id} onChoose={chooseExperiment} />}
  {content}
</>;

if (state.suggestion || state.detail?.state === "draft") {
  const setupSource = state.suggestion ?? sourceFromSnapshot(state.detail!);
  return withHistory(<ExperimentSetupView
    suggestion={setupSource} sessions={state.sessions} draft={state.draft} definitionLocked={Boolean(state.detail)}
    busy={state.busy} error={state.saveError} onPatch={(value) => dispatch({ type: "patch_draft", value })}
    onStart={() => void start()} onLoadMore={() => void loadMore()} hasMore={state.sessions.length < state.sessionsTotal}
  />);
}
if (state.detail?.state === "active") return withHistory(<>
  <ExperimentActiveView
    detail={state.detail} sessions={state.sessions} draft={state.draft} busy={state.busy} error={state.saveError}
    onPatch={(value) => dispatch({ type: "patch_draft", value })} onSaveTrial={() => void saveTrial()}
    onReview={() => void ready()} onLoadMore={() => void loadMore()} hasMore={state.sessions.length < state.sessionsTotal}
  />
  <ReviewHistory reviews={state.detail.reviews} />
</>);
return withHistory(<ExperimentReviewView
  detail={state.detail!} draft={state.draft} busy={state.busy} error={state.saveError}
  onPatch={(value) => dispatch({ type: "patch_draft", value })} onSave={() => void saveReview()}
  onOpenSession={onOpenSession}
/>);
```

If the outcome is `extend_trial`, the returned detail renders `ExperimentActiveView`; otherwise it renders the completed saved snapshot. Do not clear `draft.note` or `draft.outcome` until the request succeeds.

- [ ] **Step 8: Run domain and UI tests**

Run from `apps/web`:

```bash
bun test tests/experiments-domain.test.ts tests/experiments-ui.test.tsx
bun run typecheck
```

Expected: PASS. The markup contains a real table, labeled radio inputs, text-backed status, and no “Your recommendation” copy.

- [ ] **Step 9: Stage the review checkpoint**

```bash
git add apps/web/src/shared/schemas.ts apps/web/src/server/experiments.ts apps/web/src/client/experiments.tsx apps/web/tests/experiments-domain.test.ts apps/web/tests/experiments-ui.test.tsx
```

Submit the staged checkpoint through the automated PR workflow with title `feat(web): add evidence-backed experiment review`.

### Task 9: Shell Navigation, Analyst Entry, and Logs Deep Links

**Files:**
- Modify: `apps/web/package.json`
- Modify: `bun.lock`
- Modify: `apps/web/src/client/main.tsx:1-23,99-138,539-909,2117-2321`
- Modify: `apps/web/src/server.ts:143-161`
- Modify: `apps/web/tests/experiments-api.test.ts`

**Interfaces:**
- Consumes: `Experiments`, `ExperimentRequest`, Analyst suggestion DTOs, existing `Nav`, `Logs`, and shell behavior.
- Produces: `/experiments` navigation, shortcuts `1`–`6`, Start/Open Experiment CTAs, full-width screen mounting, and `/logs?session=<id>&event=<id>` resolution.

- [ ] **Step 1: Add the Phosphor React icon dependency**

Run from `apps/web`:

```bash
bun add @phosphor-icons/react
```

Expected: `apps/web/package.json` and root `bun.lock` change; no other dependency is added.

- [ ] **Step 2: Extend session querying with an exact ID filter and test it**

```ts
// append to apps/web/tests/experiments-api.test.ts
test("resolves an explicitly linked session outside the normal ledger page", async () => {
  const response = await app.request("http://127.0.0.1/api/sessions?id=trial-1&limit=1", { headers: { host: "127.0.0.1" } });
  expect(response.status).toBe(200);
  expect((await response.json() as any).rows.map((row: any) => row.id)).toEqual(["trial-1"]);
});
```

In the `/api/sessions` handler, add an exact, parameterized ID predicate before the fuzzy provider/model/project loop:

```ts
if (c.req.query("id")) { clauses.push("id=?"); args.push(c.req.query("id")); }
```

- [ ] **Step 3: Register Experiments and use the real flask icon**

```tsx
// apps/web/src/client/main.tsx
import { Flask } from "@phosphor-icons/react";
import { Experiments } from "./experiments";

type Nav = "overview" | "logs" | "analyst" | "experiments" | "settings" | "limits";
const navPaths: Record<Nav, string> = {
  overview: "/overview", logs: "/logs", analyst: "/analyst",
  experiments: "/experiments", settings: "/settings", limits: "/limits",
};

function NavIcon({ id }: { id: Nav }) {
  if (id === "experiments") return <Flask aria-hidden="true" weight="regular" />;
  const paths: Record<Exclude<Nav, "experiments">, React.ReactNode> = {
    overview: <><path d="M4 5h16v4H4z" /><path d="M4 13h7v7H4zM15 13h5v7h-5z" /></>,
    logs: <><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
    analyst: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><circle cx="12" cy="12" r="5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></>,
    limits: <><path d="M4 20a8 8 0 1 1 16 0" /><path d="M12 20L15.5 9.5" /><circle cx="12" cy="20" r="1.6" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[id]}</svg>;
}
```

- [ ] **Step 4: Update labels, keyboard shortcuts, and full-width shell rules**

```tsx
const labels: { id: Nav; label: string }[] = [
  { id: "overview", label: "Overview" }, { id: "logs", label: "Logs" },
  { id: "analyst", label: "Analyst" }, { id: "experiments", label: "Experiments" },
  { id: "settings", label: "Settings" }, { id: "limits", label: "Limits" },
];
const map: Record<string, Nav> = {
  "1": "overview", "2": "logs", "3": "analyst",
  "4": "experiments", "5": "settings", "6": "limits",
};
```

Define one shell predicate so Experiments is full width and never mounts the analyst rail:

```tsx
const ownsFullWidth = nav === "analyst" || nav === "experiments";
className={`shell ${ownsFullWidth || railCollapsed ? "without-rail" : ""} ${nav === "limits" ? "limits-shell" : ""}`}
```

Replace both existing `nav !== "analyst"` rail guards with `!ownsFullWidth`; keep the inner toggle condition `(nav !== "overview" || railCollapsed)` unchanged. Keep Limits out of the existing mobile-bar filter; Experiments remains included automatically.

- [ ] **Step 5: Mount the screen and route Analyst suggestions**

Add a query-aware callback inside `App`:

```tsx
const openExperiment = (value: { id?: string | null; suggestionId?: string | null }) => {
  const search = value.id ? `?id=${encodeURIComponent(value.id)}` : value.suggestionId ? `?suggestion=${encodeURIComponent(value.suggestionId)}` : "";
  window.history.pushState({}, "", `/experiments${search}`);
  setNav("experiments");
  setRail(false);
};
```

Mount the screen:

```tsx
{nav === "experiments" && <Experiments request={api} onOpenAnalyst={() => navigate("analyst")} onOpenSession={(sessionId, eventId) => {
  const params = new URLSearchParams({ session: sessionId });
  if (eventId) params.set("event", eventId);
  window.history.pushState({}, "", `/logs?${params}`);
  setNav("logs");
}} />}
```

Replace the `Analyst` function declaration so it accepts the experiment callback:

```tsx
function Analyst({ compact = false, onOpenExperiment }: {
  compact?: boolean;
  onOpenExperiment?: (value: { id?: string | null; suggestionId?: string | null }) => void;
}) {
```

In the existing detector list, replace `key={d.type}` with the stable key:

```tsx
<div className="finding" key={d.key}>
```

Place this suggestion list immediately after the nightly brief:

```tsx
{!compact && report?.suggestions?.map((suggestion: any) => <article className="analyst-suggestion" key={suggestion.id}>
  <div><strong>{suggestion.title}</strong><p>{suggestion.rationale}</p></div>
  {suggestion.experiment ? <Button onClick={() => onOpenExperiment?.({
    id: suggestion.experimentId, suggestionId: suggestion.experimentId ? null : suggestion.id,
  })}>{suggestion.experimentId ? "Open experiment" : "Start experiment"}</Button> : <Status tone="warn">Finding only</Status>}
</article>)}
```

Mount the full Analyst with `openExperiment`; the compact analyst rail stays advisory and does not gain experiment controls:

```tsx
{nav === "analyst" && <Analyst onOpenExperiment={openExperiment} />}
```

- [ ] **Step 6: Resolve session and event links in Logs**

At the start of `Logs`, read the current query:

```tsx
const linkedSessionId = new URLSearchParams(window.location.search).get("session") ?? "";
const linkedEventId = new URLSearchParams(window.location.search).get("event") ?? "";
```

Add the exact ID without weakening the existing filters, include it in the session-loading effect dependencies, and select the linked row after loading:

```tsx
if (linkedSessionId) query.set("id", linkedSessionId);

if (linkedSessionId) setSelected(result.rows.find((row: any) => row.id === linkedSessionId) ?? null);
else setSelected((current: any) => result.rows.some((row: any) => row.id === current?.id) ? current : null);

// Session-loading effect dependencies:
[filters.provider, filters.project, filters.errors, linkedSessionId, reload]
```

After events render, focus and scroll the exact evidence article from a dedicated effect:

```tsx
useEffect(() => {
  if (!linkedEventId || !events.some((event) => event.id === linkedEventId)) return;
  const frame = requestAnimationFrame(() => {
    const target = document.getElementById(`e-${linkedEventId}`);
    target?.scrollIntoView({ block: "center" });
    target?.focus();
  });
  return () => cancelAnimationFrame(frame);
}, [events, linkedEventId]);
```

Add `tabIndex={-1}` to each event `<article>` so programmatic focus works without adding it to normal tab order.

- [ ] **Step 7: Run API, UI, build, and type checks**

Run from `apps/web`:

```bash
bun test tests/experiments-api.test.ts tests/experiments-ui.test.tsx
bun run typecheck
bun run build
```

Expected: PASS. The build resolves the Phosphor package, and the experiment route compiles without rendering the analyst rail.

- [ ] **Step 8: Stage the shell-integration checkpoint**

```bash
git add apps/web/package.json bun.lock apps/web/src/client/main.tsx apps/web/src/server.ts apps/web/tests/experiments-api.test.ts
```

Submit the staged checkpoint through the automated PR workflow with title `feat(web): integrate experiments into the console`.

### Task 10: Visual System, Responsive Behavior, and Acceptance QA

**Files:**
- Create: `apps/web/tests/fixtures/seed-experiment-review.ts`
- Modify: `apps/web/src/client/styles.css`
- Modify: `apps/web/src/client/experiments.tsx`
- Modify: `apps/web/tests/experiments-ui.test.tsx`

**Interfaces:**
- Consumes: the selected 1487×1058 mock, existing `--base`/`--surface`/`--lift`/`--line`/`--accent`/status/focus tokens, and all prior functionality.
- Produces: a visually matched desktop review, usable 1100px/tablet and 720px/mobile layouts, horizontal ledger region, visible focus, reduced-motion compliance, and a repeatable realistic QA fixture.

- [ ] **Step 1: Add a deterministic visual-QA fixture**

```ts
// apps/web/tests/fixtures/seed-experiment-review.ts
import { db } from "../../src/server/db";
import { createExperimentService } from "../../src/server/experiments";
import { seedSession, seedSuggestion } from "../helpers/experiment-db";

db.run("DELETE FROM experiment_reviews");
db.run("DELETE FROM experiment_sessions");
db.run("DELETE FROM experiments");
db.run("DELETE FROM suggestions");
db.run("DELETE FROM reports");
db.run("DELETE FROM sessions");
const baseline = [
  ["b_9f4a2d6c", "claude", 312884, 58, 312], ["b_2c8e7f19", "opencode", 298431, 51, 298],
  ["b_4a1b3e77", "antigravity", 326119, 66, 327], ["b_7d3f8a51", "codex", 308178, 47, 307],
] as const;
const trial = [
  ["t_1a6c4d91", "claude", 301552, 18, 300], ["t_8b3e6f22", "opencode", 286347, 17, 288],
  ["t_5c7a1b90", "antigravity", 317960, 25, 316], ["t_2d9e4c73", "codex", 312024, 21, 313],
] as const;
const visualSessions = [...baseline, ...trial];
const visualDates = ["2026-08-24T09:14:00Z", "2026-08-25T10:05:00Z", "2026-08-26T13:41:00Z", "2026-08-27T11:32:00Z", "2026-08-28T09:09:00Z", "2026-08-28T15:27:00Z", "2026-08-29T10:12:00Z", "2026-08-30T11:18:00Z"];
for (const [index, [id, provider, tokens, errors, tools]] of visualSessions.entries()) {
  seedSession(db, id, { provider, startedAt: visualDates[index], endedAt: visualDates[index], input: tokens, output: 0, read: 0, write: 0, errors, tools, title: `${provider} retry session` });
}
const citations = visualSessions.map(([sessionId, provider], index) => {
  const eventId = `e_retry_${index + 1}`;
  const timestamp = visualDates[index];
  db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)").run(
    eventId, sessionId, 0, "error", timestamp, "Redacted tool retry failure", "tool", `session:${sessionId}`, "{}",
  );
  return { id: `ev_${eventId}`, provider, sessionId, anchor: "event", eventId, timestamp, excerpt: "Redacted tool retry failure" };
});
seedSuggestion(db, { evidence: JSON.stringify(citations) });
db.query("UPDATE reports SET detectors_json=? WHERE id='report-1'").run(JSON.stringify([{
  key: "failed_tools:codex", type: "failed_tools", provider: "codex", severity: "warning",
  message: "Review repeated tool retry behavior.", value: 0.18, evidence: citations,
}]));
const service = createExperimentService(db);
const created = service.createExperiment({
  suggestionId: "suggestion-1", hypothesis: "Reducing retry attempts from 3 to 1 lowers tool failure rate without increasing task abandonment.",
  metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: baseline.map(([id]) => id),
});
service.startExperiment(created.id);
service.replaceCohort(created.id, "trial", trial.map(([id]) => id));
service.markReadyForReview(created.id);
console.log(created.id);
```

The fixture writes only to the database selected by `OMARCHY_AGENTS_DB`; never run it against the user's normal database.

- [ ] **Step 2: Add the desktop ruled-field layout**

```css
/* apps/web/src/client/styles.css */
.experiment-review,
.experiment-setup,
.experiment-active { width: 100%; min-width: 0; }
.experiment-pagehead { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding-bottom: 22px; border-bottom: 1px solid var(--line); }
.experiment-pagehead > div > span { color: var(--dim); font: 10px "IBM Plex Mono", monospace; text-transform: uppercase; letter-spacing: .05em; }
.experiment-pagehead h1 { margin: 8px 0; font: 400 clamp(26px, 3vw, 38px)/1 "IBM Plex Mono", monospace; letter-spacing: -.035em; }
.experiment-pagehead p { margin: 0; color: var(--muted); font-size: 12px; }
.experiment-thread { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 0; list-style: none; margin: 0; padding: 20px 0 22px; border-bottom: 1px solid var(--line); }
.experiment-thread li { position: relative; min-height: 88px; padding: 0 24px 0 0; }
.experiment-thread li + li { padding-left: 24px; border-left: 1px solid var(--line); }
.experiment-thread li:not(:last-child)::after { content: ""; position: absolute; right: 10px; top: 6px; width: 34px; border-top: 1px solid var(--accent); }
.experiment-thread span,
.experiment-metric-band dt { display: block; color: var(--dim); font: 10px "IBM Plex Mono", monospace; text-transform: uppercase; letter-spacing: .04em; }
.experiment-thread strong { display: block; margin: 10px 0 5px; font: 500 13px "IBM Plex Mono", monospace; }
.experiment-thread p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.experiment-metric-band { display: grid; grid-template-columns: 1.15fr repeat(2, .9fr) .65fr 1.55fr .8fr; margin: 0; padding: 22px 0; border-bottom: 1px solid var(--line); }
.experiment-metric-band > div { min-width: 0; padding: 0 22px; }
.experiment-metric-band > div:first-child { padding-left: 0; }
.experiment-metric-band > div + div { border-left: 1px solid var(--line); }
.experiment-metric-band dd { margin: 8px 0 4px; font: 500 18px "IBM Plex Mono", monospace; overflow-wrap: anywhere; }
.experiment-metric-band small { color: var(--muted); font-size: 11px; }
.experiment-evidence { padding-top: 18px; border-bottom: 1px solid var(--line); }
.experiment-evidence > header { display: flex; align-items: end; justify-content: space-between; gap: 20px; padding-bottom: 10px; }
.experiment-evidence h2 { margin: 0 0 4px; font-size: 14px; }
.experiment-evidence p { margin: 0; color: var(--muted); font-size: 11px; }
.experiment-table-scroll { overflow-x: auto; border-top: 1px solid var(--line); }
.experiment-table-scroll table { width: 100%; min-width: 1050px; border-collapse: collapse; font-size: 12px; }
.experiment-table-scroll th,
.experiment-table-scroll td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
.experiment-table-scroll thead th { color: var(--dim); font: 9px "IBM Plex Mono", monospace; text-transform: uppercase; letter-spacing: .04em; }
.experiment-table-scroll tbody th { font: 500 11px "IBM Plex Mono", monospace; }
.experiment-table-scroll tr.missing { color: var(--muted); }
.experiment-provider { display: inline-flex; align-items: center; gap: 8px; }
.experiment-provider img { width: 18px; height: 18px; object-fit: contain; }
.experiment-provider strong { font-weight: 600; }
.experiment-conclusion { display: grid; grid-template-columns: minmax(180px, .7fr) minmax(320px, 1.4fr) minmax(270px, 1fr) minmax(190px, .7fr); gap: 24px; padding: 24px 0; border-bottom: 1px solid var(--line); }
.experiment-conclusion h2 { margin: 0 0 5px; font-size: 14px; }
.experiment-conclusion p { margin: 0; color: var(--muted); font-size: 11px; }
.experiment-conclusion textarea { width: 100%; min-height: 120px; resize: vertical; }
.experiment-conclusion fieldset,
.experiment-picker { min-width: 0; margin: 0; padding: 0; border: 0; }
.experiment-conclusion legend,
.experiment-picker legend { margin-bottom: 8px; font: 500 11px "IBM Plex Mono", monospace; }
.experiment-conclusion fieldset label { display: grid; grid-template-columns: auto 1fr; align-items: start; padding: 7px 8px; border: 1px solid var(--line); }
.experiment-conclusion fieldset label + label { margin-top: 5px; }
.experiment-conclusion fieldset label:has(input:checked) { border-color: var(--accent); background: var(--lift); }
.experiment-conclusion fieldset small { display: block; color: var(--muted); }
.experiment-save { width: 100%; border: 1px solid color-mix(in srgb, var(--accent) 85%, white); border-radius: 8px; padding: 10px 12px; background: var(--accent); color: var(--base); cursor: pointer; }
.experiment-save:disabled { cursor: not-allowed; opacity: .45; }
.experiment-provenance { padding-top: 16px; color: var(--dim); font: 9px "IBM Plex Mono", monospace; text-transform: uppercase; letter-spacing: .04em; }
```

The selected mock's single gold **Save conclusion** action is the only experiment-body accent fill; all setup, active, filter, and secondary controls retain the existing ink/lift button styles.

- [ ] **Step 3: Add setup, picker, active, history, and empty/error styling**

```css
.experiment-steps { display: grid; grid-template-columns: repeat(4, 1fr); list-style: none; margin: 0 0 24px; padding: 18px 0; border-bottom: 1px solid var(--line); color: var(--muted); font: 11px "IBM Plex Mono", monospace; }
.experiment-steps li + li { padding-left: 18px; border-left: 1px solid var(--line); }
.experiment-field { display: grid; gap: 7px; margin: 20px 0; max-width: 800px; }
.experiment-field textarea { min-height: 100px; resize: vertical; }
.experiment-fields { display: flex; gap: 16px; margin-bottom: 20px; }
.experiment-fields label { display: grid; gap: 7px; }
.experiment-picker { padding: 18px 0; border-top: 1px solid var(--line); }
.experiment-picker > p { color: var(--muted); font-size: 11px; }
.experiment-picker-list { max-height: 360px; overflow: auto; border-top: 1px solid var(--line); margin-bottom: 12px; }
.experiment-picker-list label { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--line); }
.experiment-picker-list span { display: grid; }
.experiment-picker-list small,
.experiment-picker-list em { color: var(--muted); font-size: 10px; font-style: normal; }
.experiment-live-metric { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 10px; align-items: baseline; padding: 22px 0; border-bottom: 1px solid var(--line); }
.experiment-live-metric strong { font: 500 22px "IBM Plex Mono", monospace; }
.experiment-live-metric span { color: var(--muted); font-size: 11px; }
.experiment-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 18px; }
.experiment-history { position: relative; }
.experiment-history-menu { position: absolute; z-index: 30; top: calc(100% + 8px); right: 0; width: min(360px, 90vw); padding: 6px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: -14px 0 36px rgba(0,0,0,.32); }
.experiment-history-menu button { display: grid; width: 100%; grid-template-columns: 1fr auto; gap: 4px 12px; padding: 9px; border: 0; background: transparent; text-align: left; }
.experiment-history-menu button:hover { background: var(--lift); }
.experiment-review-history { padding: 14px 0; border-bottom: 1px solid var(--line); }
.experiment-review-history summary { cursor: pointer; font: 500 11px "IBM Plex Mono", monospace; }
.experiment-review-history ol { margin: 12px 0 0; padding-left: 22px; }
.experiment-review-history li { padding: 8px 0; color: var(--muted); }
.experiment-review-history strong { color: var(--ink); margin-right: 10px; }
.experiment-review-history time { font: 10px "IBM Plex Mono", monospace; }
.experiment-review-history p { margin: 4px 0 0; }
```

- [ ] **Step 4: Add tablet, mobile, and reduced-motion behavior**

```css
@media (max-width: 1100px) {
  .experiment-thread { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .experiment-thread li:nth-child(4) { padding-left: 0; border-left: 0; }
  .experiment-metric-band { grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 20px; }
  .experiment-metric-band > div:nth-child(4) { padding-left: 0; border-left: 0; }
  .experiment-conclusion { grid-template-columns: minmax(200px, .7fr) minmax(320px, 1.3fr); }
}
@media (max-width: 720px) {
  .experiment-pagehead { align-items: start; flex-direction: column; }
  .experiment-thread,
  .experiment-metric-band,
  .experiment-conclusion,
  .experiment-steps { grid-template-columns: 1fr; }
  .experiment-thread li,
  .experiment-thread li + li { min-height: 0; padding: 12px 0; border-left: 0; border-bottom: 1px solid var(--line); }
  .experiment-thread li::after { display: none; }
  .experiment-metric-band > div,
  .experiment-metric-band > div:first-child,
  .experiment-metric-band > div:nth-child(4) { padding: 12px 0; border-left: 0; border-bottom: 1px solid var(--line); }
  .experiment-evidence > header,
  .experiment-fields,
  .experiment-actions { align-items: stretch; flex-direction: column; }
  .experiment-evidence .segmented { max-width: 100%; overflow-x: auto; }
  .experiment-picker-list label { grid-template-columns: auto minmax(0, 1fr); }
  .experiment-picker-list em { grid-column: 2; }
  .experiment-conclusion { gap: 18px; }
  .experiment-save { min-height: 44px; }
}
@media (prefers-reduced-motion: reduce) {
  .experiment-review *, .experiment-setup *, .experiment-active *, .experiment-history * { scroll-behavior: auto; transition-duration: .01ms !important; }
}
```

- [ ] **Step 5: Run automated regressions before browser QA**

Run from `apps/web`:

```bash
bun test
bun run typecheck
bun run build
```

Expected: all PASS.

- [ ] **Step 6: Seed an isolated QA database and start the built app**

Run from `apps/web`, using this exact non-user database path:

```bash
OMARCHY_AGENTS_DB=/tmp/omarchy-agents-experiment-qa.sqlite bun tests/fixtures/seed-experiment-review.ts
OMARCHY_AGENTS_DB=/tmp/omarchy-agents-experiment-qa.sqlite bun run start
```

Expected: the seed command prints an experiment ID and the server listens on loopback. Keep the server process running for the next steps.

- [ ] **Step 7: Compare the desktop implementation to the selected mock**

After confirming the user's browser choice, capture `/experiments` at exactly 1487×1058. Create one comparison image containing both:

- reference: `docs/screenshots/experiment-review-concept.png`
- implementation capture: the running `/experiments` screen at 1487×1058

Inspect the combined comparison for page geometry, nav width, title scale, row density, evidence-thread alignment, metric separators, table clipping, decision spacing, button color, borders, focus visibility, and text weights. Fix every material mismatch in `experiments.tsx` or `styles.css`, rebuild, recapture at the same viewport, and repeat the combined comparison until no material mismatch remains.

- [ ] **Step 8: Verify standard desktop, tablet, and mobile states**

Using the same chosen browser, verify:

- 1440×1024: full review, history popover, All/Baseline/Trial filters, evidence links, and save-error retention.
- 1100×900: no analyst drawer, no clipped metric content, and a usable two-row conclusion layout.
- 720×900 and 390×844: stacked thread/metrics, labeled horizontal ledger scroll, 44px primary action, mobile bottom navigation, no Limits destination, and no document-level horizontal overflow.
- Keyboard only: skip link, experiment history trigger/menu/Escape return, filters, ledger scroll region, note, radio group, Save conclusion, and Logs evidence focus.
- Reduced motion: no nonessential animated transitions.
- Missing-session state: delete one selected session from the isolated QA database and confirm the row remains visible as unavailable.
- Save failure: temporarily make the review request fail in the browser network tool and confirm note/outcome stay intact.

- [ ] **Step 9: Run the repository-wide acceptance gate**

Run from the repository root:

```bash
bun run check
git diff --check
```

Expected: all tests, type checks, and builds PASS; the diff check prints no whitespace errors.

- [ ] **Step 10: Stage the visual-finish checkpoint**

```bash
git add apps/web/src/client/styles.css apps/web/src/client/experiments.tsx apps/web/tests/experiments-ui.test.tsx apps/web/tests/fixtures/seed-experiment-review.ts
```

Submit the staged checkpoint through the automated PR workflow with title `feat(web): finish experiment review experience`.

## Final Acceptance Checklist

- [ ] A supported cited suggestion opens setup; an unsupported finding has no experiment action.
- [ ] No session is selected without an explicit checkbox action.
- [ ] Baseline locks at `active`; trial locks at `ready_for_review`; completed experiments cannot reopen.
- [ ] `extend_trial` stores a review, returns to `active`, and leaves baseline locked.
- [ ] Prior extension reviews remain inspectable, and the completed conclusion is read-only.
- [ ] A full session rebuild preserves cohort IDs and missing rows remain visible.
- [ ] Completed pages use their stored snapshot even after session metrics change.
- [ ] Source snapshots remain readable after their report/suggestion rows are removed.
- [ ] Every metric, target comparison, exclusion, and confidence note matches metric version `1`.
- [ ] The user—not the system—selects Adopt change, Extend trial, or No improvement.
- [ ] Experiment storage contains no raw transcripts, source paths, credentials, or external payloads and the flow changes no agent/provider configuration.
- [ ] The experiment route has no analyst rail at desktop, tablet, or mobile sizes.
- [ ] Session and event links land on the requested Logs evidence.
- [ ] Loading, empty, missing-index, insufficient-data, save-error, success, and keyboard/focus states have all been exercised without losing form state.
- [ ] The final desktop comparison has been judged from a combined reference/implementation image at 1487×1058.
- [ ] `bun run check` and `git diff --check` pass.
