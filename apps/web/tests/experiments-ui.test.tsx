import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EvidenceLedger, ExperimentHistory, ExperimentReviewView, ExperimentSetupView, SessionPicker,
  experimentReducer, initialExperimentUiState,
} from "../src/client/experiments";
import type { ExperimentDetail, Suggestion } from "../src/shared/schemas";

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

describe("experiment review", () => {
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
});
