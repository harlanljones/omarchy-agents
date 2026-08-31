# Evidence-backed Experiments Design

**Date:** 2026-08-30
**Status:** Approved
**Selected visual:** [Experiment review concept](../../screenshots/experiment-review-concept.png)

## Summary

Add an **Experiments** workflow to the Omarchy Agents web app. A user promotes a cited analyst suggestion into a measurable trial, confirms one metric and target, explicitly selects baseline and trial sessions, and records a human conclusion from a traceable before/after comparison.

The feature closes the gap between observing a pattern and learning whether a change helped. It remains local-only, read-only with respect to agent configuration, and intentionally descriptive rather than causal.

## Goals

- Turn supported nightly findings into actionable, evidence-backed suggestions.
- Let the user evaluate one suggestion with explicitly selected session cohorts.
- Make every aggregate resolvable to included sessions and available evidence.
- Preserve experiment history across normal re-indexing and full index rebuilds.
- Match the selected full-width Evidence Control Room design on desktop and remain usable on tablet and mobile.

## Non-goals

- Automatically changing agent, provider, model, or prompt configuration.
- Automatically assigning sessions to a cohort.
- Claiming statistical significance or causal attribution.
- Supporting arbitrary formulas, custom SQL, collaboration, sharing, or remote integrations.
- Creating experiments manually or directly from a session in v1; experiments originate from analyst suggestions.

## Domain Model

The canonical vocabulary is recorded in the repository `CONTEXT.md`.

- A **Finding** is an observed, cited pattern in a nightly report.
- A **Suggestion** is the analyst's proposed change for a finding.
- An **Experiment** is the user-authorized evaluation of one suggestion.
- A **Cohort** is an explicit baseline or trial session set.
- A **Review** is an immutable calculation snapshot plus the user's note and outcome.

### Lifecycle

Experiments use four states:

1. `draft`: the suggestion, hypothesis, metric, target, and baseline may be edited.
2. `active`: the baseline is locked and trial sessions may be added or removed.
3. `ready_for_review`: both cohorts are locked while the user reviews the calculation.
4. `completed`: the user chose `adopt_change` or `no_improvement`.

Saving a review with `extend_trial` creates the immutable review and returns the experiment to `active`; its baseline stays locked and trial membership becomes editable again. A completed experiment cannot be reopened in v1.

State transitions happen only through intent-specific module operations. Callers cannot assign a state directly.

## User Experience

### Entry and setup

- Each supported suggestion in the Analyst view has **Start experiment**. If that suggestion already has an experiment, the control becomes **Open experiment**.
- Starting an experiment opens a focused setup flow: Finding → Metric → Baseline → Trial.
- The analyst supplies a hypothesis, metric, and proposed target. The user may edit the hypothesis and must confirm the metric and target.
- The user selects one or more baseline sessions from the existing session ledger. Only explicit selection adds a session to the cohort.
- **Start trial** locks the baseline and moves the experiment to `active`.
- The active view lets the user add or remove trial sessions and inspect the current descriptive comparison.
- **Review experiment** becomes available only when each cohort contains at least one session valid for the selected metric.

### Review screen

The selected mock is the visual source of truth.

- `/experiments` opens the active experiment, or the most recently updated experiment when none is active. `?id=<experiment-id>` selects another experiment without adding a separate SPA route.
- The experiment ID beneath the title is a button that opens a compact, keyboard-accessible history popover. Selecting an experiment updates the `id` query parameter.
- The screen uses the full main canvas without the persistent analyst rail.
- The header shows the experiment title, lifecycle state, source suggestion, and creation time.
- A horizontal evidence thread shows Finding → Hypothesis → Baseline → Trial → Conclusion.
- The metric band shows the baseline value, trial value, target, delta, whether the target was met, and the sample note. It never labels the experiment a success automatically.
- A single semantic evidence table lists all cohort sessions. `All`, `Baseline`, and `Trial` filters change visible rows without changing membership.
- Each session row links to its session in Logs. Event citations include the event anchor.
- The conclusion area requires a note of 1–1,000 characters and one outcome: **Adopt change**, **Extend trial**, or **No improvement**.
- Label the outcome group **Your decision**; do not carry the mock's overloaded “Your recommendation” wording into the product.
- **Save conclusion** is the primary action. **Open evidence trail** is secondary.
- A provenance footer states the number of explicitly selected sessions, calculation source, calculation time, and “No causal attribution.”

### Responsive and accessible behavior

- Add Experiments to desktop navigation and the mobile bottom bar; the existing Limits destination remains excluded from the mobile bar.
- Update keyboard destination shortcuts to: `1` Overview, `2` Logs, `3` Analyst, `4` Experiments, `5` Settings, `6` Limits.
- At 1100px and below, the review remains full-width and does not open an analyst drawer automatically.
- At 720px and below, the evidence thread and metric columns stack. The evidence ledger retains all columns inside a labeled horizontal scroll region.
- The ledger uses semantic table roles and real headers. Filters expose selection with `aria-pressed`; outcome controls use a labeled radio group.
- Status always includes text, focus uses the existing blue focus ring, and reduced motion disables nonessential transitions.
- Loading, empty, save-error, missing-session, and invalid-metric states render inline without discarding current selections.

## Module Design

Create a deep server module at the experiment seam. HTTP handlers and tests use the same interface; SQL, state validation, metric definitions, transactions, and snapshot construction remain implementation details.

The external interface consists of:

- `createExperiment(input)`
- `replaceCohort(experimentId, cohort, sessionIds)`
- `startExperiment(experimentId)`
- `markReadyForReview(experimentId)`
- `reviewExperiment(experimentId, input)`
- `getExperiment(experimentId)`
- `listExperiments(filter?)`

Each mutation returns the complete experiment detail needed by the client. The module accepts the shared database adapter rather than creating a database internally, and its calculations return values rather than rendering or emitting side effects.

Implementation placement:

- `apps/web/src/server/experiments.ts` owns the server module and pure metric registry.
- `apps/web/src/client/experiments.tsx` owns setup, active, and review presentation.
- `apps/web/src/shared/schemas.ts` owns request/response validation and exported types.
- `apps/web/src/server.ts` remains a thin HTTP adapter; `apps/web/src/client/main.tsx` only gains route, navigation, and screen-mount hooks.

The new screen uses the existing design tokens and shell. Use a Phosphor flask icon for the new destination rather than adding another hand-authored SVG path.

## Data Model

Add three tables through the existing additive SQLite initialization pattern, plus nullable experiment metadata on existing suggestions. No data backfill is required.

### Existing `suggestions` extension

- `finding_key TEXT`
- `experiment_json TEXT`

`experiment_json` contains the proposed hypothesis, metric kind, target, and metric-definition version. Existing rows remain `NULL` and are not experimentable. Because `CREATE TABLE IF NOT EXISTS` does not alter an existing SQLite table, initialization checks `PRAGMA table_info(suggestions)` and adds each missing nullable column exactly once with `ALTER TABLE`.

### `experiments`

- `id TEXT PRIMARY KEY`
- `source_suggestion_id TEXT NOT NULL UNIQUE`
- `source_report_id TEXT NOT NULL`
- `source_snapshot_json TEXT NOT NULL`
- `title TEXT NOT NULL`
- `hypothesis TEXT NOT NULL`
- `metric_kind TEXT NOT NULL`
- `metric_version INTEGER NOT NULL CHECK(metric_version = 1)`
- `target_value REAL NOT NULL`
- `state TEXT NOT NULL CHECK(state IN ('draft','active','ready_for_review','completed'))`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

`source_snapshot_json` preserves the source finding, suggestion rationale, experiment defaults, and redacted citations. `metric_version` freezes the calculation contract used by an active experiment. The source IDs deliberately have no foreign keys: they remain useful for navigation and diagnostics, but the experiment does not depend on the report or suggestion rows remaining present.

### `experiment_sessions`

- `experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE`
- `session_id TEXT NOT NULL`
- `cohort TEXT NOT NULL CHECK(cohort IN ('baseline','trial'))`
- `added_at TEXT NOT NULL`
- `PRIMARY KEY (experiment_id, session_id)`

`session_id` deliberately has no foreign key to `sessions`; see ADR 0001. Membership replacement validates that every submitted session exists at write time. A session may appear in multiple experiments but cannot belong to both cohorts in one experiment.

### `experiment_reviews`

- `id TEXT PRIMARY KEY`
- `experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE`
- `outcome TEXT NOT NULL CHECK(outcome IN ('adopt_change','extend_trial','no_improvement'))`
- `note TEXT NOT NULL`
- `calculation_json TEXT NOT NULL`
- `created_at TEXT NOT NULL`

`calculation_json` is immutable and contains metric-definition version `1`, the target, baseline and trial aggregates, delta, `targetMet`, `improved`, per-session numeric contributions used in each aggregate, excluded session IDs with reasons, sample note, and calculation time. This is enough to audit the saved result without copying transcripts or relying on later index contents.

## Metric Registry

The registry exposes a fixed v1 set. The UI never accepts a formula or SQL expression. Targets must be finite, non-negative numbers; ratios may legitimately exceed `1` because source values are not clamped.

| Metric kind | Display | Cohort calculation | Direction | Valid session requirement |
| --- | --- | --- | --- | --- |
| `tool_failure_rate` | Tool failure rate | `sum(error_count) / sum(tool_count)` | Lower | `tool_count > 0` |
| `tokens_per_session` | Tokens per session | Mean of input + output + cache-read + cache-write tokens | Lower | Indexed session present |
| `average_duration_minutes` | Average session duration | Mean positive `ended_at - started_at` in minutes | Lower | Valid start and end times |
| `cache_read_ratio` | Cache-read ratio | `sum(cache_read) / sum(token_input)` | Higher | `token_input > 0` |

Ratios are not clamped. The UI explains the numerator and denominator so unusual source data remains visible rather than normalized away.

Each calculation returns:

- formatted and raw baseline/trial values;
- absolute and directional delta;
- `targetMet` based only on the confirmed target;
- `improved` based only on the metric direction;
- valid per-session contributions and excluded sessions with reasons for each cohort;
- a sample note: `small_sample` when either cohort has fewer than five valid sessions, `uneven_cohorts` when the larger valid cohort is more than twice the smaller, otherwise `descriptive_only`.

The product never converts these fields into an automatic experiment outcome. The user chooses the outcome during review.

## Analyst Integration and Citations

Nightly analysis must persist suggestions instead of returning an empty suggestion list.

- Extend findings with a stable key and optional provider scope.
- Deterministically map supported findings to a suggestion title, hypothesis, proposed metric, target, rationale, and evidence. The mapping does not require Ollama.
- `failed_tools` proposes `tool_failure_rate` and cites the highest-error sessions plus exact indexed error events.
- `long_sessions` proposes `average_duration_minutes` and cites the qualifying sessions with their observed start/end interval.
- `cache_ratio` proposes `cache_read_ratio` and cites the provider sessions used in the aggregate.
- `repeated_prompts` proposes `tokens_per_session` and cites the repeated prompt events; its rationale explicitly identifies token reduction as the hypothesis, not an observed result.
- `token_concentration` remains visible as a finding but is not experimentable in v1 because explicit session cohorts do not directly test provider concentration.
- Create at most one suggestion per finding in a report. Insert the report and suggestions in one transaction.

Broaden `EvidenceCitation` without breaking existing event citations:

```ts
{
  id: string;
  provider: string;
  sessionId: string;
  anchor: "session" | "event"; // defaults to "event" for existing records
  eventId: string | null;
  timestamp: string;
  excerpt: string;
}
```

Validation requires a non-null `eventId` when `anchor` is `event` and a null `eventId` when `anchor` is `session`. Session citations link to the session ledger; event citations link to the exact event. Excerpts remain redacted before persistence.

## HTTP Interface

All endpoints remain under the existing authenticated dashboard trust tier.

### Create and query

- `GET /api/experiments?state=<optional-state>` returns compact experiment summaries ordered by `updatedAt DESC`.
- `GET /api/experiments/:id` returns the source snapshot, cohorts, current calculation, reviews, and available actions.
- `POST /api/experiments` accepts `{ suggestionId, hypothesis, metricKind, targetValue, baselineSessionIds }`, creates a `draft`, and atomically marks the suggestion `accepted`. It returns `201` with full detail.

### Cohorts and lifecycle

- `PUT /api/experiments/:id/cohorts/:cohort` accepts `{ sessionIds }` and atomically replaces that cohort. Baseline replacement is legal only in `draft`; trial replacement is legal only in `active`.
- `POST /api/experiments/:id/start` transitions `draft → active` after validating at least one metric-valid baseline session.
- `POST /api/experiments/:id/ready` transitions `active → ready_for_review` after validating at least one metric-valid session in each cohort.
- `POST /api/experiments/:id/reviews` accepts `{ outcome, note }`. It recalculates and revalidates that each cohort still has a metric-valid session, then writes the immutable calculation snapshot in the same transaction; `extend_trial` transitions back to `active`, while the other outcomes transition to `completed`.

The existing suggestion status endpoint remains compatible. Creating an experiment is allowed for an `open` or already `accepted` suggestion that has no experiment; duplicate source suggestions return a conflict.

### Errors

- `400`: malformed body, unsupported metric, invalid target, duplicate session ID in a request, or invalid note length.
- `404`: unknown suggestion, experiment, or session at mutation time.
- `409`: duplicate experiment, session assigned to both cohorts, locked cohort edit, or illegal lifecycle transition.
- `422`: a lifecycle transition lacks a metric-valid session in either cohort.

Errors use `{ error: string, code: string, details?: unknown }`. Mutations are transactional, so a failed validation does not partially change suggestion state, cohort membership, reviews, or lifecycle state.

## Re-indexing, Privacy, and Failure Behavior

- Active experiment calculations resolve cohort IDs with a left join. Missing sessions remain listed as excluded with `session_missing`; they are never silently removed.
- A full rebuild can temporarily make every active cohort unavailable. The UI shows indexing state and disables review readiness until valid sessions return.
- Completed experiment pages render the stored review snapshot, not a newly calculated value. Current session availability is shown separately.
- Experiment tables store IDs, aggregates, lifecycle data, user-authored notes, and already-redacted citation excerpts. They do not duplicate raw transcripts, source paths, credentials, or external payloads.
- The feature adds no external network calls and never invokes agent configuration commands.

## Test Plan

### Metric and domain tests

- Verify every metric's aggregate math, direction, formatting, target comparison, and zero-denominator behavior.
- Verify excluded-session reasons, fewer-than-five sample labeling, uneven cohort labeling, and no clamping of ratios.
- Verify create, baseline lock, active trial edits, readiness validation, completed-state immutability, and `extend_trial` returning to active.
- Verify one experiment per suggestion and one cohort per session within an experiment.
- Verify failed mutations roll back all writes.
- Verify missing sessions after a simulated rebuild remain selected and become valid again when the same IDs reappear.
- Verify review snapshots remain unchanged after indexed session data changes.

### Analyst and HTTP tests

- Verify each supported finding creates one deterministic suggestion with the expected metric and redacted session/event citations.
- Verify unsupported findings do not expose **Start experiment**.
- Verify all endpoint success payloads and `400`/`404`/`409`/`422` cases.
- Verify suggestion acceptance and experiment creation are atomic.
- Verify remote requests continue through the existing dashboard authentication checks.

### UI and design acceptance

- Exercise the full flow: suggestion → setup → baseline → active trial → ready review → extend → review again → complete.
- Verify loading, empty, missing-session, insufficient-data, save-error, and success states without losing local form state.
- Verify keyboard-only navigation, focus order, skip link, segmented filters, radio group, evidence links, and table semantics.
- Verify reduced-motion behavior and text-backed statuses.
- Verify desktop, 1100px tablet, and 720px/mobile layouts.
- Run `bun test`, `bun run typecheck`, and `bun run build` for the web workspace, then the root `bun run check`.
- Capture the direct design-QA comparison at the selected mock's native 1487×1058 viewport, then separately verify the standard 1440×1024 desktop viewport. Fix all material layout, typography, spacing, color, clipping, and interaction mismatches before handoff.

## Rollout

The schema change is additive and local: three new tables and two nullable suggestion columns. Existing reports and suggestions remain readable; only newly generated supported suggestions are guaranteed to contain experiment defaults. No data backfill, feature flag, external migration, or deployment change is required.
