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
