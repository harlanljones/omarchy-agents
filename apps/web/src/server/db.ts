import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const home = process.env.HOME ?? "/tmp";
export const DB_PATH = process.env.OMARCHY_AGENTS_DB ?? `${home}/.local/state/omarchy-agents/index.sqlite`;
mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new Database(DB_PATH, { create: true, strict: true });
db.run("PRAGMA journal_mode=WAL");
db.run("PRAGMA foreign_keys=ON");
db.run("PRAGMA busy_timeout=5000");
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT, project TEXT, title TEXT, started_at TEXT NOT NULL, ended_at TEXT, source_path TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE, token_input INTEGER NOT NULL DEFAULT 0, token_output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0, tool_count INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}', indexed_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_provider ON sessions(provider, started_at DESC);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, kind TEXT NOT NULL, timestamp TEXT NOT NULL, text TEXT NOT NULL, tool_name TEXT, source_locator TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', UNIQUE(session_id, ordinal));
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ordinal);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(event_id UNINDEXED, session_id UNINDEXED, text, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS usage_records (provider TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (source_path TEXT PRIMARY KEY, provider TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, indexed_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY AUTOINCREMENT, source_path TEXT, provider TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, model TEXT NOT NULL, summary TEXT NOT NULL, detectors_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE, title TEXT NOT NULL, impact TEXT NOT NULL, effort TEXT NOT NULL, confidence REAL NOT NULL, rationale TEXT NOT NULL, evidence_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, citations_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS limit_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, window_label TEXT NOT NULL, window_kind TEXT NOT NULL, resets_at TEXT, used REAL NOT NULL, recorded_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS limit_snapshots_cycle ON limit_snapshots(provider, window_label, resets_at, recorded_at);
CREATE TABLE IF NOT EXISTS usage_alerts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, rule TEXT NOT NULL, window_label TEXT NOT NULL, resets_at TEXT, severity TEXT NOT NULL, message TEXT NOT NULL, fired_at TEXT NOT NULL, resolved_at TEXT, notified_at TEXT, recovery_notified_at TEXT);
CREATE INDEX IF NOT EXISTS usage_alerts_active ON usage_alerts(resolved_at, fired_at DESC);
`);

export function json<T>(value: string | null | undefined, fallback: T): T { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
