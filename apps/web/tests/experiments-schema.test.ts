import { describe, expect, test } from "bun:test";
import { EvidenceCitation } from "../src/shared/schemas";
import { initializeExperimentSchema } from "../src/server/experiments";
import { experimentDatabase } from "./helpers/experiment-db";

describe("experiment schema", () => {
  test("accepts event and session anchors while preserving legacy event citations", () => {
    expect(EvidenceCitation.parse({
      id: "ev_1",
      provider: "codex",
      sessionId: "s1",
      eventId: "e1",
      timestamp: "2026-08-30T00:00:00Z",
      excerpt: "redacted",
    }).anchor).toBe("event");
    expect(EvidenceCitation.parse({
      id: "session_s1",
      provider: "codex",
      sessionId: "s1",
      anchor: "session",
      eventId: null,
      timestamp: "2026-08-30T00:00:00Z",
      excerpt: "Session s1",
    }).eventId).toBeNull();
    expect(() => EvidenceCitation.parse({
      id: "bad",
      provider: "codex",
      sessionId: "s1",
      anchor: "event",
      eventId: null,
      timestamp: "2026-08-30T00:00:00Z",
      excerpt: "bad",
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
      "experiments",
      "experiment_sessions",
      "experiment_reviews",
    ]));
    const membershipFks = database.query("PRAGMA foreign_key_list(experiment_sessions)").all() as Array<{ table: string }>;
    expect(membershipFks.some((row) => row.table === "sessions")).toBe(false);
  });
});
