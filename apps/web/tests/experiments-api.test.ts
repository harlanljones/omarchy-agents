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

  test("resolves an explicitly linked session outside the normal ledger page", async () => {
    const response = await app.request("http://127.0.0.1/api/sessions?id=trial-1&limit=1", { headers: { host: "127.0.0.1" } });
    expect(response.status).toBe(200);
    expect((await response.json() as any).rows.map((row: any) => row.id)).toEqual(["trial-1"]);
  });
});
