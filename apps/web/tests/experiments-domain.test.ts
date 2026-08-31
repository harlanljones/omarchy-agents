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
});
