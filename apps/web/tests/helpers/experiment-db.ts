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
    id,
    provider: "codex",
    model: "gpt-5",
    project: "omarchy-agents",
    title: id,
    startedAt: "2026-08-30T10:00:00Z",
    endedAt: "2026-08-30T11:00:00Z",
    sourceKey: `source-${id}`,
    input: 100,
    output: 50,
    read: 20,
    write: 10,
    errors: 1,
    tools: 10,
    indexedAt: "2026-08-30T11:00:00Z",
    ...overrides,
  };
  database.query(`INSERT INTO sessions(id,provider,model,project,title,started_at,ended_at,source_path,source_key,token_input,token_output,cache_read,cache_write,error_count,tool_count,metadata_json,indexed_at)
    VALUES ($id,$provider,$model,$project,$title,$startedAt,$endedAt,'',$sourceKey,$input,$output,$read,$write,$errors,$tools,'{}',$indexedAt)`).run(row);
}

export function seedSuggestion(database: Database, overrides: Record<string, unknown> = {}) {
  const now = "2026-08-30T12:00:00Z";
  database.query("INSERT INTO reports VALUES (?,?,?,?,?,?,?)").run(
    "report-1",
    now,
    "2026-08-23T12:00:00Z",
    now,
    "deterministic",
    "summary",
    "[]",
  );
  const defaults = {
    hypothesis: "One retry lowers failures",
    metricKind: "tool_failure_rate",
    metricVersion: 1,
    targetValue: 0.1,
  };
  database.query(`INSERT INTO suggestions(id,report_id,title,impact,effort,confidence,rationale,evidence_json,status,created_at,finding_key,experiment_json)
    VALUES ($id,'report-1',$title,'high','low',0.8,$rationale,$evidence,'open',$createdAt,$findingKey,$experiment)`).run({
      id: "suggestion-1",
      title: "Reduce repeated tool retries",
      rationale: "Retry less and compare explicit cohorts.",
      evidence: "[]",
      createdAt: now,
      findingKey: "failed_tools:codex",
      experiment: JSON.stringify(defaults),
      ...overrides,
    });
}

export const fixedNow = () => new Date("2026-08-30T12:00:00Z");
export const ids = (...values: string[]) => {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (!value) throw new Error("test ID queue exhausted");
    return value;
  };
};
