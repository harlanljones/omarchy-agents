import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { Database as SourceDatabase } from "bun:sqlite";
import { db } from "./db";
import { redact } from "./redact";
import { observeUsageRecords, lastRecommendation, recordRecommendationChange } from "./watch";
import { advise } from "./limits";
import { UsageRecordV1, LogEvent, NormalizedSession, type UsageRecord, type Event, type Session } from "../shared/schemas";
import { PROVIDERS, parseJsonl, walk, tokenNumber, epochIso } from "./providers";

export { parseJsonl };
const home = process.env.HOME ?? "";
const usageDir = process.env.AGENT_USAGE_DIR ?? `${home}/.local/state/omarchy/agents/usage`;
const INDEXER_VERSION = "token-usage-v3";
// Separate from INDEXER_VERSION: gates the opencode.db time_updated cursor
// stored in checkpoints.mtime_ms, without invalidating per-file jsonl checkpoints.
const OPENCODE_CURSOR_VERSION = "opencode-cursor-v1";
let active = false;
let progress = { state: "idle", scanned: 0, indexed: 0, total: 0, current: "", startedAt: "", finishedAt: "", errors: 0 };

export function persist(session: Session, events: Event[]) {
  db.transaction(() => {
    db.query(`INSERT INTO sessions VALUES ($id,$provider,$model,$project,$title,$started,$ended,$path,$key,$input,$output,$read,$write,$errors,$tools,$meta,$now)
      ON CONFLICT(id) DO UPDATE SET model=excluded.model,project=excluded.project,title=excluded.title,started_at=excluded.started_at,ended_at=excluded.ended_at,token_input=excluded.token_input,token_output=excluded.token_output,cache_read=excluded.cache_read,cache_write=excluded.cache_write,error_count=excluded.error_count,tool_count=excluded.tool_count,metadata_json=excluded.metadata_json,indexed_at=excluded.indexed_at`).run({
      id: session.id, provider: session.provider, model: session.model, project: session.project, title: session.title, started: session.startedAt, ended: session.endedAt, path: session.sourcePath, key: session.sourceKey, input: session.tokenInput, output: session.tokenOutput, read: session.cacheRead, write: session.cacheWrite, errors: session.errorCount, tools: session.toolCount, meta: JSON.stringify(session.metadata), now: new Date().toISOString()
    });
    db.query("DELETE FROM events_fts WHERE session_id = ?").run(session.id);
    db.query("DELETE FROM events WHERE session_id = ?").run(session.id);
    const insert = db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)");
    const insertFts = db.query("INSERT INTO events_fts(event_id,session_id,text) VALUES (?,?,?)");
    for (const e of events) { insert.run(e.id, e.sessionId, e.ordinal, e.kind, e.timestamp, e.text, e.toolName, e.sourceLocator, JSON.stringify(e.metadata)); insertFts.run(e.id, e.sessionId, e.text); }
  })();
}

// A concurrent writer (CLI index, another watcher pass) can hold the write
// lock past busy_timeout; retry before giving up so one busy moment does not
// leave a provider's usage record stale for a full refresh cycle.
function upsertUsageRecord(record: UsageRecord, now: string): UsageRecord | null {
  const statement = db.query("INSERT INTO usage_records VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET record_json=excluded.record_json,updated_at=excluded.updated_at");
  let lastError: unknown = null;
  for (const waitMs of [0, 500, 2500]) {
    if (waitMs) Bun.sleepSync(waitMs);
    try { statement.run(record.id, JSON.stringify(record), now); return record; }
    catch (error) { lastError = error; }
  }
  db.query("INSERT INTO diagnostics(source_path,provider,message,created_at) VALUES (?,?,?,?)").run("usage_records", record.id, String(lastError), now);
  return null;
}

function refreshUsage() {
  if (!existsSync(usageDir)) return;
  const observed: UsageRecord[] = [];
  for (const name of readdirSync(usageDir).filter(n => n.endsWith(".json"))) {
    const path = join(usageDir, name);
    try {
      const record = UsageRecordV1.parse(JSON.parse(readFileSync(path, "utf8")));
      const stored = upsertUsageRecord(record, new Date().toISOString());
      if (stored) observed.push(stored);
    }
    catch (error) { db.query("INSERT INTO diagnostics(source_path,provider,message,created_at) VALUES (?,?,?,?)").run(path, name.slice(0, -5), String(error), new Date().toISOString()); }
  }
  // Every collector refresh feeds the limit watch: snapshots, forecasts,
  // alerts, and their desktop notifications all flow from what we just read.
  try { void observeUsageRecords(observed); }
  catch (error) { db.query("INSERT INTO diagnostics(source_path,provider,message,created_at) VALUES (?,?,?,?)").run(usageDir, "watch", String(error), new Date().toISOString()); }
  // General-mode recommendation, recomputed on every refresh, feeds the
  // provider-switch incidents in the Phase 3 incident view.
  try {
    const top = advise(observed, null).rows.find(r => r.verdict !== "unavailable");
    recordRecommendationChange(top ? { providerId: top.providerId, providerName: top.providerName } : null, lastRecommendation());
  } catch (error) { db.query("INSERT INTO diagnostics(source_path,provider,message,created_at) VALUES (?,?,?,?)").run(usageDir, "recommendation", String(error), new Date().toISOString()); }
}

// OpenCode stores the session model as a JSON object
// (`{"id":"hy3","providerID":"opencode-go","variant":"high"}`). Normalize it
// to the bare model id and capture the underlying provider so the model
// breakdown is correct and the sub-provider is tracked.
function openCodeModelInfo(model: unknown): { id: string | null; providerId: string | null } {
  if (!model) return { id: null, providerId: null }
  let obj: any = null
  if (typeof model === "string") { try { obj = JSON.parse(model) } catch { return { id: null, providerId: null } } }
  else if (model && typeof model === "object") obj = model
  if (!obj || typeof obj !== "object") return { id: null, providerId: null }
  const id = typeof obj.id === "string" && obj.id.length ? obj.id : null
  const providerId = typeof obj.providerID === "string" && obj.providerID.length ? obj.providerID : null
  return { id, providerId }
}

function indexOpenCode() {
  const path = `${home}/.local/share/opencode/opencode.db`;
  if (!existsSync(path)) return;
  const checkpoint = db.query("SELECT mtime_ms,status FROM checkpoints WHERE source_path=?").get(path) as any;
  // Cursor is the highest session time_updated (epoch ms) indexed so far; the
  // 60s overlap re-touches sessions near the boundary so in-flight writes that
  // land mid-pass are picked up on the next pass.
  const cursor = checkpoint?.status === OPENCODE_CURSOR_VERSION ? Math.max(0, Number(checkpoint?.mtime_ms) || 0) : 0;
  const source = new SourceDatabase(path, { readonly: true, strict: true });
  try {
    const sessions = source.query("SELECT id,directory,title,model,time_created,time_updated,tokens_input,tokens_output,tokens_cache_read,tokens_cache_write FROM session WHERE time_updated > ? ORDER BY time_updated").all(Math.max(0, cursor - 60_000)) as any[];
    let maxUpdated = cursor;
    for (const raw of sessions) {
      maxUpdated = Math.max(maxUpdated, tokenNumber(raw.time_updated));
      if (tokenNumber(raw.time_updated) <= cursor && cursor > 0) continue;
      const messageRoles = new Map((source.query("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id").all(raw.id) as any[]).map(m => { const data = JSON.parse(m.data); return [m.id, data.role ?? "unknown"]; }));
      const parts = source.query("SELECT id,message_id,time_created,data FROM part WHERE session_id=? ORDER BY time_created,id").all(raw.id) as any[];
      const events: Event[] = [];
      for (const part of parts) {
        let data: any; try { data = JSON.parse(part.data); } catch { continue; }
        const type = String(data.type ?? "unknown"), role = messageRoles.get(part.message_id);
        const text = typeof data.text === "string" ? data.text : data.output ? JSON.stringify(data.output) : data.error ? JSON.stringify(data.error) : data.state ? JSON.stringify(data.state) : "";
        if (!text) continue;
        const kind = type.includes("error") || data.state?.status === "error" ? "error" : type === "tool" ? (data.state?.status === "completed" ? "tool_result" : "tool_call") : type === "reasoning" ? "response" : role === "user" ? "prompt" : role === "assistant" ? "response" : "unknown";
        events.push(LogEvent.parse({ id: part.id, sessionId: raw.id, ordinal: events.length, kind, timestamp: epochIso(part.time_created, new Date().toISOString()), text: redact(text), toolName: data.tool ?? null, sourceLocator: `${path}:part/${part.id}`, metadata: { partType: type } }));
      }
      const fallback = new Date().toISOString();
      const modelInfo = openCodeModelInfo(raw.model)
      persist(NormalizedSession.parse({ id: raw.id, provider: "opencode", model: modelInfo.id, project: raw.directory ?? null, title: raw.title ?? null, startedAt: epochIso(raw.time_created, fallback), endedAt: epochIso(raw.time_updated, fallback), sourcePath: path, sourceKey: `opencode:${raw.id}`, tokenInput: tokenNumber(raw.tokens_input), tokenOutput: tokenNumber(raw.tokens_output), cacheRead: tokenNumber(raw.tokens_cache_read), cacheWrite: tokenNumber(raw.tokens_cache_write), errorCount: events.filter(e => e.kind === "error").length, toolCount: events.filter(e => e.kind === "tool_call").length, metadata: { format: "opencode-sqlite", opencodeProviderId: modelInfo.providerId } }), events);
      progress.indexed++;
    }
    db.query("INSERT INTO checkpoints VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(source_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,indexed_at=excluded.indexed_at,status=excluded.status,error=NULL").run(path, "opencode", 0, maxUpdated, new Date().toISOString(), OPENCODE_CURSOR_VERSION);
  } finally { source.close(); }
}

export async function runIndex(options: { rebuild?: boolean } = {}) {
  if (active) return progress;
  active = true; progress = { state: "scanning", scanned: 0, indexed: 0, total: 0, current: "", startedAt: new Date().toISOString(), finishedAt: "", errors: 0 };
  try {
    if (options.rebuild) db.transaction(() => { db.run("DELETE FROM events_fts"); db.run("DELETE FROM events"); db.run("DELETE FROM sessions"); db.run("DELETE FROM checkpoints"); })();
    refreshUsage();
    // Cursor-based / non-file providers (e.g. OpenCode's sqlite store) index
    // themselves through their declared `index` function.
    for (const provider of PROVIDERS) {
      if (!provider.index) continue;
      try { provider.index(); }
      catch (error) { progress.errors++; db.query("INSERT INTO diagnostics(source_path,provider,message,created_at) VALUES (?,?,?,?)").run("", provider.id, String(error), new Date().toISOString()); }
    }
    // File-based providers: walk each declared root and dispatch through its parser.
    const files: Array<{ provider: string; path: string }> = [];
    for (const provider of PROVIDERS) {
      if (!provider.roots || !provider.parse) continue;
      for (const root of provider.roots) {
        const found: string[] = [];
        walk(root.path, root.kinds, found);
        files.push(...found.filter(f => !root.match || root.match(f)).map(path => ({ provider: provider.id, path })));
      }
    }
    progress.total = files.length; progress.state = "indexing";
    const seen = new Set<string>();
    for (const file of files) {
      progress.scanned++; progress.current = file.path; seen.add(file.path);
      const provider = PROVIDERS.find(p => p.id === file.provider)!;
      try {
        const stat = statSync(file.path); const checkpoint = db.query("SELECT size,mtime_ms,status FROM checkpoints WHERE source_path=?").get(file.path) as any;
        if (!options.rebuild && checkpoint?.size === stat.size && checkpoint?.mtime_ms === Math.round(stat.mtimeMs) && checkpoint?.status === INDEXER_VERSION) continue;
        if (stat.size > 50_000_000) continue;
        const parsed = provider.parse!(file.provider, file.path, readFileSync(file.path, "utf8"));
        if (!parsed) continue;
        persist(parsed.session, parsed.events);
        db.query("INSERT INTO checkpoints VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(source_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,indexed_at=excluded.indexed_at,status=excluded.status,error=NULL").run(file.path, file.provider, stat.size, Math.round(stat.mtimeMs), new Date().toISOString(), INDEXER_VERSION);
        progress.indexed++;
      } catch (error) { progress.errors++; db.query("INSERT INTO diagnostics(source_path,provider,message,created_at) VALUES (?,?,?,?)").run(file.path, file.provider, String(error), new Date().toISOString()); }
      if (progress.scanned % 50 === 0) await Bun.sleep(1);
    }
    const indexed = db.query("SELECT source_path FROM checkpoints").all() as Array<{source_path: string}>;
    for (const row of indexed) if (!seen.has(row.source_path) && !existsSync(row.source_path)) db.transaction(() => { const sessions = db.query("SELECT id FROM sessions WHERE source_path=?").all(row.source_path) as any[]; for (const s of sessions) db.query("DELETE FROM events_fts WHERE session_id=?").run(s.id); db.query("DELETE FROM sessions WHERE source_path=?").run(row.source_path); db.query("DELETE FROM checkpoints WHERE source_path=?").run(row.source_path); })();
    progress.state = "ready"; progress.finishedAt = new Date().toISOString(); progress.current = "";
  } finally { active = false; }
  return progress;
}

// OpenCode is indexed from its sqlite store, not by walking files, so it is
// wired into the registry here rather than declared inline in providers.ts.
PROVIDERS.find(p => p.id === "opencode")!.index = indexOpenCode;

export function indexProgress() { return { ...progress }; }
let watchers: FSWatcher[] = [], timer: Timer | undefined;
// fs.watch on the usage dir has proven unreliable across collector write
// patterns (renames, atomic replaces); a cheap mtime poll keeps the dashboard
// within ~a minute of the collector instead of the 15-minute interval worst case.
let lastUsageStamp = 0;
function usageStamp() {
  try {
    return readdirSync(usageDir).filter(n => n.endsWith(".json")).reduce((max, n) => Math.max(max, Math.round(statSync(join(usageDir, n)).mtimeMs)), 0);
  } catch { return 0; }
}
export function startWatching() {
  if (watchers.length) return;
  // opencode.db (+wal/shm) is rewritten continuously by live agents; reacting to
  // it triggers an endless re-index loop. Only session-file changes schedule a pass.
  const isDatabaseChurn = (file: string | null) => !file || /opencode\.db(-wal|-shm)?$/.test(file);
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void runIndex(), 15_000); };
  const roots = [
    ...PROVIDERS.flatMap(p => (p.roots ?? []).map(r => ({ ...r, provider: p.id }))),
    { provider: "usage", path: usageDir, kinds: [".json"] },
  ];
  for (const root of roots) if (existsSync(root.path)) {
    try { watchers.push(watch(root.path, { recursive: true }, (_event, filename) => {
      if (root.provider === "opencode" && isDatabaseChurn(filename)) return;
      schedule();
    })); } catch (error) {
      db.query("INSERT INTO diagnostics(source_path,provider,message,created_at) VALUES (?,?,?,?)").run(root.path, "watch", String(error), new Date().toISOString());
    }
  }
  lastUsageStamp = usageStamp();
  setInterval(() => {
    const stamp = usageStamp();
    if (stamp && stamp !== lastUsageStamp) { lastUsageStamp = stamp; schedule(); }
  }, 60_000).unref();
  setInterval(() => void runIndex(), 15 * 60_000).unref();
}
