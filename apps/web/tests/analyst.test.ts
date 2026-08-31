import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Finding } from "../src/shared/schemas";
import { experimentDatabase, fixedNow, ids, seedSession } from "./helpers/experiment-db";

let buildSuggestion: typeof import("../src/server/analyst").buildSuggestion;
let detect: typeof import("../src/server/analyst").detect;
let runNightly: typeof import("../src/server/analyst").runNightly;

beforeAll(async () => {
  process.env.OMARCHY_AGENTS_DB = join(tmpdir(), `omarchy-agents-analyst-test-${process.pid}.sqlite`);
  ({ buildSuggestion, detect, runNightly } = await import("../src/server/analyst"));
});

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
