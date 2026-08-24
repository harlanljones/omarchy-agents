import { describe, expect, test } from "bun:test";
import { UsageRecordV1, type UsageRecord } from "../src/shared/schemas";
import { advise, buildPlatformLimits, classifyWindow, formatDuration, headroomOf, TASK_PRESETS } from "../src/server/limits";

const NOW = new Date("2026-08-23T18:00:00Z").valueOf();
const hoursFromNow = (h: number) => new Date(NOW + h * 3600_000).toISOString();
const record = (raw: any) => UsageRecordV1.parse(raw);

const claude = record({
  id: "claude", name: "Claude Code", ready: true, tierLabel: "Max 20x",
  updatedAt: "2026-08-23T17:30:00Z",
  limits: [
    { label: "Session (5-hour)", percent: 0.73, resetsAt: hoursFromNow(0.7) },
    { label: "Weekly (7-day)", percent: 0.35, resetsAt: hoursFromNow(100) },
  ],
  recentDays: [{ date: "2026-08-21", messageCount: 5_000_000 }, { date: "2026-08-22", messageCount: 9_000_000 }],
  modelUsage: { "claude-opus-5": { inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 3_000_000, cacheCreationInputTokens: 500 } },
});

const cline = record({
  id: "cline", name: "Cline", ready: true, tierLabel: "Cline Pass", updatedAt: "2026-08-23T16:00:00Z",
  limits: [
    { label: "Session", title: "Session", percent: 0.0, resetsAt: hoursFromNow(-1) },
    { label: "Weekly", title: "Weekly", percent: 0.95, resetsAt: hoursFromNow(96) },
    { label: "Monthly", title: "Monthly", percent: 0.47, resetsAt: hoursFromNow(600) },
  ],
  recentDays: [{ date: "2026-08-23", messageCount: 2_000_000 }],
  modelUsage: { "deepseek-v4-flash": { inputTokens: 40_000, outputTokens: 1_000, cacheReadInputTokens: 20_000, cacheCreationInputTokens: 0 } },
});

const fireworks = record({
  id: "fireworks", name: "Fireworks", ready: true, tierLabel: "Prepaid",
  updatedAt: "2026-08-23T12:00:00Z",
  balance: { remaining: 8, funded: 20, spent: 12, currency: "USD", estimated: true },
  todayTotalTokens: 0,
});

const codex = record({ id: "codex", name: "Codex", ready: true, updatedAt: "2026-08-23T10:00:00Z", todayTotalTokens: 123_456 });

describe("window classification", () => {
  test("collector titles win over label text", () => {
    expect(classifyWindow("Opus 5 (1M context)", "Session")).toBe("session");
    expect(classifyWindow("Anything", "Monthly")).toBe("monthly");
  });
  test("labels classify without a title", () => {
    expect(classifyWindow("Session (5-hour)")).toBe("session");
    expect(classifyWindow("Weekly (7-day)")).toBe("weekly");
    expect(classifyWindow("Current month (30-day)")).toBe("monthly");
    expect(classifyWindow("5h window")).toBe("session");
  });
  test("unrecognized labels stay other instead of guessing", () =>
    expect(classifyWindow("Opus 5 (1M context)")).toBe("other"));
});

describe("platform normalization", () => {
  test("claude windows normalize with ISO resets and binding picks the fullest", () => {
    const platform = buildPlatformLimits(claude, NOW);
    expect(platform.windows.map(w => w.kind)).toEqual(["session", "weekly"]);
    expect(platform.binding?.used).toBe(0.73);
    expect(platform.status).toBe("ready");
    expect(platform.tier).toBe("Max 20x");
    expect(headroomOf(platform)).toBeCloseTo(0.27);
  });
  test("prepaid balance converts to headroom and flags estimates", () => {
    const platform = buildPlatformLimits(fireworks, NOW);
    expect(platform.balance?.remaining).toBe(8);
    expect(platform.balance?.estimated).toBe(true);
    expect(headroomOf(platform)).toBeCloseTo(0.4);
  });
  test("a collector without limit feeds is unconstrained", () => {
    const platform = buildPlatformLimits(codex, NOW);
    expect(platform.binding).toBeNull();
    expect(headroomOf(platform)).toBeNull();
  });
  test("past resetsAt values are kept but countdown math stays honest", () => {
    const platform = buildPlatformLimits(cline, NOW);
    expect(platform.windows[0].resetsAt).toEqual(hoursFromNow(-1));
  });
  test("stale records are labeled stale", () => {
    const stale = buildPlatformLimits(record({ ...claude, updatedAt: "2026-08-20T00:00:00Z" }), NOW);
    expect(stale.status).toBe("stale");
  });
});

describe("advisor", () => {
  test("general mode ranks by headroom and explains each row", () => {
    const advice = advise([claude, cline, fireworks, codex], null, NOW);
    expect(advice.mode).toBe("general");
    expect(advice.rows[0].providerId).toBe("codex");
    expect(advice.rows[0].verdict).toBe("usable");
    expect(advice.rows.map(r => r.providerId)).not.toContain(undefined);
    const claudeRow = advice.rows.find(r => r.providerId === "claude")!;
    expect(claudeRow.verdict).toBe("usable");
    expect(claudeRow.reasons.some(r => r.startsWith("Session (5-hour) 73% used"))).toBe(true);
    const clineRow = advice.rows.find(r => r.providerId === "cline")!;
    expect(clineRow.verdict).toBe("tight");
    expect(clineRow.reasons.some(r => r.startsWith("Only 5% left"))).toBe(true);
    expect(clineRow.reasons.join(" ")).toContain("Weekly 95% used");
    expect(advice.confidence).toBe("medium");
    expect(advice.fallbackProviderName).toBe("Fireworks");
    expect(advice.recommendationResetsAt).toBeNull();
  });
  test("all-constrained boards produce a wait-for-refresh verdict line", () => {
    const exhausted = advise([record({ ...claude, limits: [{ label: "Weekly (7-day)", percent: 1, resetsAt: hoursFromNow(100) }] })], null, NOW);
    expect(exhausted.verdictLine).toContain("soonest refresh");
    expect(exhausted.rows[0].verdict).toBe("wait");
  });
  test("task mode prices the dominant model and reports fit against burn history", () => {
    const advice = advise([claude], TASK_PRESETS.small, NOW);
    const row = advice.rows[0];
    expect(row.estCostUsd).toBeGreaterThan(0);
    expect(row.unpricedModels).toEqual([]);
    const weeklyBurn = ((5_000_000 + 9_000_000) / 2) * 7;
    const share = 250_000 / weeklyBurn;
    expect(row.fitsTask).toBe(true);
    expect(row.reasons.some(r => r.includes(`${Math.round(share * 100)}%`))).toBe(true);
    expect(advice.taskTokens).toEqual(TASK_PRESETS.small);
  });
  test("a task that exceeds remaining headroom fails the fit check", () => {
    const advice = advise([cline], TASK_PRESETS.large, NOW);
    expect(advice.rows[0].fitsTask).toBe(false);
  });
  test("unpriced dominant models surface honestly", () => {
    const exotic = record({ ...codex, modelUsage: { "big-pickle": { inputTokens: 1, outputTokens: 1 } } });
    const advice = advise([exotic], TASK_PRESETS.small, NOW);
    expect(advice.rows[0].estCostUsd).toBeNull();
    expect(advice.rows[0].unpricedModels).toEqual(["big-pickle"]);
  });
  test("non-ready platforms never top the ranking", () => {
    const broken = record({ id: "broken", name: "Broken", ready: false, authHelpText: "Run `x auth login`" });
    const advice = advise([broken, claude], null, NOW);
    expect(advice.rows.at(-1)?.providerId).toBe("broken");
    expect(advice.verdictLine.startsWith("Claude Code")).toBe(true);
  });
});

describe("formatting", () => {
  test("durations match the widget's vocabulary", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(42 * 60_000)).toBe("42m");
    expect(formatDuration(5 * 3600_000 + 120_000)).toBe("5h 2m");
    expect(formatDuration(3 * 24 * 3600_000 + 2 * 3600_000)).toBe("3d 2h");
  });
});
