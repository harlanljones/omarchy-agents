import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { Database as SourceDatabase } from "bun:sqlite";
import { db } from "./db";
import { redact } from "./redact";
import { LogEvent, NormalizedSession, UsageRecordV1, type Event, type Session } from "../shared/schemas";

const home = process.env.HOME ?? "";
const roots = [
  { provider: "claude", path: `${home}/.claude/projects`, kinds: [".jsonl"] },
  { provider: "codex", path: `${home}/.codex/sessions`, kinds: [".jsonl"] },
  { provider: "cline", path: `${home}/.local/share/cline`, kinds: [".json", ".jsonl"] },
  { provider: "antigravity", path: `${home}/.gemini/antigravity-cli`, kinds: [".json", ".jsonl"] },
  { provider: "opencode", path: `${home}/.local/share/opencode`, kinds: [".json", ".jsonl"] }
];
const usageDir = process.env.AGENT_USAGE_DIR ?? `${home}/.local/state/omarchy/agents/usage`;
let active = false;
let progress = { state: "idle", scanned: 0, indexed: 0, total: 0, current: "", startedAt: "", finishedAt: "", errors: 0 };

const id = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const iso = (value: unknown, fallback: string) => { const d = new Date(String(value ?? "")); return Number.isNaN(d.valueOf()) ? fallback : d.toISOString(); };
const first = (...values: unknown[]) => values.find(v => typeof v === "string" && v.length) as string | undefined;
const obj = (v: unknown): Record<string, any> => v && typeof v === "object" ? v as Record<string, any> : {};

function walk(root: string, extensions: string[], out: string[], limit = 100_000) {
  if (!existsSync(root) || out.length >= limit) return;
  let entries; try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= limit) break;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, extensions, out, limit);
    else if (extensions.includes(extname(entry.name))) out.push(path);
  }
}

function eventFrom(raw: any, sessionId: string, ordinal: number, path: string, fallbackTime: string): Event | null {
  const payload = obj(raw.message ?? raw.payload ?? raw.data ?? raw);
  const role = first(raw.role, payload.role, raw.type, payload.type) ?? "unknown";
  const kind = role.includes("tool_result") || role === "toolResult" ? "tool_result"
    : role.includes("tool") || payload.tool_use ? "tool_call"
    : role.includes("error") ? "error" : role === "user" || role.includes("prompt") ? "prompt"
    : role === "assistant" || role.includes("response") ? "response" : role === "system" ? "system" : "unknown";
  const content = payload.content ?? raw.content ?? payload.text ?? raw.text ?? payload.message ?? raw.message;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map(p => typeof p === "string" ? p : first(p?.text, p?.content) ?? JSON.stringify(p)).join("\n");
  else if (content && typeof content === "object") text = JSON.stringify(content);
  if (!text || /"(?:image|audio|binary)"\s*:/i.test(text) && text.length > 200_000) return null;
  const eventId = id(`${sessionId}:${ordinal}`);
  return LogEvent.parse({ id: eventId, sessionId, ordinal, kind, timestamp: iso(raw.timestamp ?? payload.timestamp ?? raw.created_at, fallbackTime), text: redact(text), toolName: first(raw.tool_name, raw.name, payload.name) ?? null, sourceLocator: `${path}:${ordinal + 1}`, metadata: {} });
}

export function parseJsonl(provider: string, path: string, content: string): { session: Session; events: Event[] } {
  const fallbackTime = statSync(path).mtime.toISOString();
  const lines = content.split(/\r?\n/).filter(Boolean);
  const raws: any[] = [];
  for (const line of lines) { try { raws.push(JSON.parse(line)); } catch { /* diagnostic handled by caller */ } }
  const meta = raws.map(obj).find(r => r.session_id || r.sessionId || r.cwd || r.model) ?? {};
  const sourceKey = `${provider}:${path}`;
  const sessionId = String(meta.session_id ?? meta.sessionId ?? meta.conversation_id ?? id(sourceKey));
  const events = raws.map((r, i) => eventFrom(r, sessionId, i, path, fallbackTime)).filter(Boolean) as Event[];
  const startedAt = events[0]?.timestamp ?? fallbackTime;
  const endedAt = events.at(-1)?.timestamp ?? startedAt;
  const models = raws.map(r => first(r.model, r?.message?.model, r?.payload?.model)).filter(Boolean);
  const project = first(meta.cwd, meta.project, dirname(path).split("/").at(-1));
  const session = NormalizedSession.parse({ id: sessionId, provider, model: models.at(-1) ?? null, project: project ?? null, title: events.find(e => e.kind === "prompt")?.text.slice(0, 120) ?? basename(path), startedAt, endedAt, sourcePath: path, sourceKey, errorCount: events.filter(e => e.kind === "error").length, toolCount: events.filter(e => e.kind === "tool_call").length, metadata: { format: "jsonl", parseableLines: raws.length, totalLines: lines.length } });
  return { session, events };
}

function persist(session: Session, events: Event[]) {
  db.transaction(() => {
    db.query(`INSERT INTO sessions VALUES ($id,$provider,$model,$project,$title,$started,$ended,$path,$key,$input,$output,$read,$write,$errors,$tools,$meta,$now)
      ON CONFLICT(id) DO UPDATE SET model=excluded.model,project=excluded.project,title=excluded.title,started_at=excluded.started_at,ended_at=excluded.ended_at,token_input=excluded.token_input,token_output=excluded.token_output,cache_read=excluded.cache_read,cache_write=excluded.cache_write,error_count=excluded.error_count,tool_count=excluded.tool_count,metadata_json=excluded.metadata_json,indexed_at=excluded.indexed_at`).run({
      $id: session.id, $provider: session.provider, $model: session.model, $project: session.project, $title: session.title, $started: session.startedAt, $ended: session.endedAt, $path: session.sourcePath, $key: session.sourceKey, $input: session.tokenInput, $output: session.tokenOutput, $read: session.cacheRead, $write: session.cacheWrite, $errors: session.errorCount, $tools: session.toolCount, $meta: JSON.stringify(session.metadata), $now: new Date().toISOString()
    });
    db.query("DELETE FROM events_fts WHERE session_id = ?").run(session.id);
    db.query("DELETE FROM events WHERE session_id = ?").run(session.id);
    const insert = db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?)");
    const insertFts = db.query("INSERT INTO events_fts(event_id,session_id,text) VALUES (?,?,?)");
    for (const e of events) { insert.run(e.id, e.sessionId, e.ordinal, e.kind, e.timestamp, e.text, e.toolName, e.sourceLocator, JSON.stringify(e.metadata)); insertFts.run(e.id, e.sessionId, e.text); }
  })();
}

function refreshUsage() {
  if (!existsSync(usageDir)) return;
  for (const name of readdirSync(usageDir).filter(n => n.endsWith(".json"))) {
    const path = join(usageDir, name);
    try { const record = UsageRecordV1.parse(JSON.parse(readFileSync(path, "utf8"))); db.query("INSERT INTO usage_records VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET record_json=excluded.record_json,updated_at=excluded.updated_at").run(record.id, JSON.stringify(record), new Date().toISOString()); }
    catch (error) { db.query("INSERT INTO diagnostics(source_path,provider,message,created_at) VALUES (?,?,?,?)").run(path, name.slice(0, -5), String(error), new Date().toISOString()); }
  }
}

function indexOpenCode() {
  const path = `${home}/.local/share/opencode/opencode.db`;
  if (!existsSync(path)) return;
  const stat = statSync(path), checkpoint = db.query("SELECT size,mtime_ms FROM checkpoints WHERE source_path=?").get(path) as any;
  if (checkpoint?.size === stat.size && checkpoint?.mtime_ms === Math.round(stat.mtimeMs)) return;
  const source = new SourceDatabase(path, { readonly: true, strict: true });
  try {
    const sessions = source.query("SELECT id,directory,title,model,time_created,time_updated,tokens_input,tokens_output,tokens_cache_read,tokens_cache_write FROM session ORDER BY time_created").all() as any[];
    for (const raw of sessions) {
      const messageRoles = new Map((source.query("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id").all(raw.id) as any[]).map(m => { const data = JSON.parse(m.data); return [m.id, data.role ?? "unknown"]; }));
      const parts = source.query("SELECT id,message_id,time_created,data FROM part WHERE session_id=? ORDER BY time_created,id").all(raw.id) as any[];
      const events: Event[] = [];
      for (const part of parts) {
        let data: any; try { data = JSON.parse(part.data); } catch { continue; }
        const type = String(data.type ?? "unknown"), role = messageRoles.get(part.message_id);
        const text = typeof data.text === "string" ? data.text : data.output ? JSON.stringify(data.output) : data.error ? JSON.stringify(data.error) : data.state ? JSON.stringify(data.state) : "";
        if (!text) continue;
        const kind = type.includes("error") || data.state?.status === "error" ? "error" : type === "tool" ? (data.state?.status === "completed" ? "tool_result" : "tool_call") : type === "reasoning" ? "response" : role === "user" ? "prompt" : role === "assistant" ? "response" : "unknown";
        events.push(LogEvent.parse({ id: part.id, sessionId: raw.id, ordinal: events.length, kind, timestamp: new Date(Number(part.time_created)).toISOString(), text: redact(text), toolName: data.tool ?? null, sourceLocator: `${path}:part/${part.id}`, metadata: { partType: type } }));
      }
      persist(NormalizedSession.parse({ id: raw.id, provider: "opencode", model: raw.model ?? null, project: raw.directory ?? null, title: raw.title ?? null, startedAt: new Date(Number(raw.time_created)).toISOString(), endedAt: new Date(Number(raw.time_updated)).toISOString(), sourcePath: path, sourceKey: `opencode:${raw.id}`, tokenInput: Number(raw.tokens_input ?? 0), tokenOutput: Number(raw.tokens_output ?? 0), cacheRead: Number(raw.tokens_cache_read ?? 0), cacheWrite: Number(raw.tokens_cache_write ?? 0), errorCount: events.filter(e => e.kind === "error").length, toolCount: events.filter(e => e.kind === "tool_call").length, metadata: { format: "opencode-sqlite" } }), events);
      progress.indexed++;
    }
    db.query("INSERT INTO checkpoints VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(source_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,indexed_at=excluded.indexed_at,status='ok',error=NULL").run(path, "opencode", stat.size, Math.round(stat.mtimeMs), new Date().toISOString(), "ok");
  } finally { source.close(); }
}

export async function runIndex(options: { rebuild?: boolean } = {}) {
  if (active) return progress;
  active = true; progress = { state: "scanning", scanned: 0, indexed: 0, total: 0, current: "", startedAt: new Date().toISOString(), finishedAt: "", errors: 0 };
  try {
    if (options.rebuild) db.transaction(() => { db.run("DELETE FROM events_fts"); db.run("DELETE FROM events"); db.run("DELETE FROM sessions"); db.run("DELETE FROM checkpoints"); })();
    refreshUsage();
    try { indexOpenCode(); } catch (error) { progress.errors++; db.query("INSERT INTO diagnostics(source_path,provider,message,created_at) VALUES (?,?,?,?)").run(`${home}/.local/share/opencode/opencode.db`, "opencode", String(error), new Date().toISOString()); }
    const files: Array<{ provider: string; path: string }> = [];
    for (const root of roots) { const found: string[] = []; walk(root.path, root.kinds, found); files.push(...found.map(path => ({ provider: root.provider, path }))); }
    progress.total = files.length; progress.state = "indexing";
    const seen = new Set<string>();
    for (const file of files) {
      progress.scanned++; progress.current = file.path; seen.add(file.path);
      try {
        const stat = statSync(file.path); const checkpoint = db.query("SELECT size,mtime_ms FROM checkpoints WHERE source_path=?").get(file.path) as any;
        if (!options.rebuild && checkpoint?.size === stat.size && checkpoint?.mtime_ms === Math.round(stat.mtimeMs)) continue;
        if (extname(file.path) !== ".jsonl" || stat.size > 50_000_000) continue;
        const parsed = parseJsonl(file.provider, file.path, readFileSync(file.path, "utf8")); persist(parsed.session, parsed.events);
        db.query("INSERT INTO checkpoints VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(source_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,indexed_at=excluded.indexed_at,status='ok',error=NULL").run(file.path, file.provider, stat.size, Math.round(stat.mtimeMs), new Date().toISOString(), "ok");
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

export function indexProgress() { return { ...progress }; }
let watchers: FSWatcher[] = [], timer: Timer | undefined;
export function startWatching() {
  if (watchers.length) return;
  for (const root of [...roots, { provider: "usage", path: usageDir, kinds: [".json"] }]) if (existsSync(root.path)) {
    try { watchers.push(watch(root.path, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(() => void runIndex(), 750); })); } catch {}
  }
  setInterval(() => void runIndex(), 15 * 60_000).unref();
}
