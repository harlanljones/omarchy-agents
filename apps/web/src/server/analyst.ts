import { randomUUID } from "node:crypto";
import { db, json } from "./db";
import { redact } from "./redact";
import type { Citation } from "../shared/schemas";

export const primaryModel = () => process.env.OLLAMA_MODEL ?? "qwen2.5:14b-instruct-q4_K_M";
export const fallbackModel = () => process.env.OLLAMA_FALLBACK_MODEL ?? "qwen2.5-coder:7b";
const ollama = () => process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

export async function modelHealth() {
  const started = performance.now();
  try {
    const response = await fetch(`${ollama()}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const body = await response.json() as any;
    const names = (body.models ?? []).map((m: any) => m.name);
    const selected = names.find((n: string) => n.startsWith(primaryModel())) ?? names.find((n: string) => n.startsWith(fallbackModel()));
    return { ready: Boolean(selected), selected: selected ?? primaryModel(), fallback: selected ? !selected.startsWith(primaryModel()) : false, latencyMs: Math.round(performance.now() - started), installed: names };
  } catch (error) { return { ready: false, selected: primaryModel(), fallback: false, latencyMs: Math.round(performance.now() - started), error: String(error), installed: [] }; }
}

function citation(row: any): Citation { return { id: `ev_${row.id}`, provider: row.provider, sessionId: row.session_id, eventId: row.id, timestamp: row.timestamp, excerpt: redact(row.text).slice(0, 240) }; }
export const tools = {
  overview: (_args: any) => db.query("SELECT provider,COUNT(*) sessions,SUM(token_input+token_output+cache_read+cache_write) tokens,SUM(error_count) errors FROM sessions GROUP BY provider ORDER BY tokens DESC").all(),
  compare_periods: (_args: any) => db.query("SELECT provider,strftime('%Y-%m-%d',started_at) day,SUM(token_input+token_output+cache_read+cache_write) tokens,COUNT(*) sessions FROM sessions WHERE started_at >= datetime('now','-30 days') GROUP BY provider,day ORDER BY day").all(),
  search_logs: (args: any) => {
    const q = String(args?.query ?? "").replace(/["']/g, " ").trim(); if (!q) return [];
    return (db.query("SELECT e.id,e.session_id,e.timestamp,e.text,s.provider FROM events_fts f JOIN events e ON e.id=f.event_id JOIN sessions s ON s.id=e.session_id WHERE events_fts MATCH ? LIMIT 12").all(q) as any[]).map(citation);
  },
  inspect_session: (args: any) => (db.query("SELECT e.id,e.session_id,e.timestamp,e.text,s.provider FROM events e JOIN sessions s ON s.id=e.session_id WHERE e.session_id=? ORDER BY ordinal LIMIT 30").all(String(args?.sessionId ?? "")) as any[]).map(citation),
  anomalies: (_args: any) => detect(),
  recommendations: (_args: any) => db.query("SELECT id,title,impact,effort,confidence,rationale,status,evidence_json FROM suggestions ORDER BY created_at DESC LIMIT 20").all().map((r: any) => ({ ...r, evidence: json(r.evidence_json, []) }))
};

export function detect() {
  const findings: any[] = [];
  const totals = db.query("SELECT provider,SUM(token_input+token_output+cache_read+cache_write) tokens,COUNT(*) sessions,SUM(error_count) errors,SUM(tool_count) tools,SUM(cache_read) cache_read,SUM(token_input) input FROM sessions WHERE started_at>=datetime('now','-7 days') GROUP BY provider").all() as any[];
  const total = totals.reduce((s, r) => s + Number(r.tokens), 0);
  for (const r of totals) {
    if (total && r.tokens / total > .65) findings.push({ type: "token_concentration", severity: "warning", message: `${r.provider} accounts for ${Math.round(r.tokens / total * 100)}% of indexed tokens.`, value: r.tokens / total, evidence: [] });
    if (r.tools && r.errors / r.tools > .15) findings.push({ type: "failed_tools", severity: "warning", message: `${r.provider} has an elevated tool error ratio.`, value: r.errors / r.tools, evidence: [] });
    if (r.input && r.cache_read / r.input < .1) findings.push({ type: "cache_ratio", severity: "info", message: `${r.provider} cache reads are low relative to input.`, value: r.cache_read / r.input, evidence: [] });
  }
  const long = db.query("SELECT id,provider,started_at,ended_at FROM sessions WHERE ended_at IS NOT NULL AND (julianday(ended_at)-julianday(started_at))*24>4 ORDER BY started_at DESC LIMIT 5").all();
  if (long.length) findings.push({ type: "long_sessions", severity: "info", message: `${long.length} unusually long sessions were observed.`, value: long.length, evidence: [] });
  const repeats = db.query("SELECT substr(text,1,180) text,COUNT(*) count FROM events WHERE kind='prompt' AND length(text)>30 GROUP BY substr(text,1,180) HAVING count>2 ORDER BY count DESC LIMIT 5").all();
  if (repeats.length) findings.push({ type: "repeated_prompts", severity: "info", message: `${repeats.length} prompt patterns repeat across sessions.`, value: repeats.length, evidence: [] });
  return findings;
}

export async function runNightly() {
  const now = new Date(), start = new Date(now.valueOf() - 7 * 86400000), reportId = randomUUID(), detectors = detect();
  const health = await modelHealth();
  let summary = detectors.length ? `Found ${detectors.length} evidence-backed patterns in the last seven days.` : "No material deterministic anomalies were found in the indexed period.";
  if (!health.ready) summary += " Local model interpretation was unavailable; this report contains deterministic results only.";
  db.query("INSERT INTO reports VALUES (?,?,?,?,?,?,?)").run(reportId, now.toISOString(), start.toISOString(), now.toISOString(), health.selected, summary, JSON.stringify(detectors));
  return { id: reportId, createdAt: now.toISOString(), periodStart: start.toISOString(), periodEnd: now.toISOString(), model: health.selected, summary, detectors, suggestions: [] };
}

const toolDefs = Object.keys(tools).map(name => ({ type: "function", function: { name, description: `Read-only ${name.replaceAll("_", " ")} query`, parameters: { type: "object", properties: name === "search_logs" ? { query: { type: "string" } } : name === "inspect_session" ? { sessionId: { type: "string" } } : {} } } }));

export function chatStream(prompt: string) {
  const encoder = new TextEncoder();
  return new ReadableStream({ async start(controller) {
    const emit = (type: string, data: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify({ type, data })}\n`));
    const valid = new Map<string, Citation>();
    try {
      const health = await modelHealth();
      if (!health.ready) { emit("error", "Ollama is not ready. Start the local model service and try again."); emit("done", {}); return; }
      let messages: any[] = [{ role: "system", content: "You are the read-only Omarchy Agents analyst. Use tools before claims. Cite only evidence IDs returned by tools, formatted [ev_x]. Be concise and never imply you changed configuration." }, { role: "user", content: redact(prompt) }];
      for (let iteration = 0; iteration < 8; iteration++) {
        emit("thinking", { iteration: iteration + 1 });
        const response = await fetch(`${ollama()}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: health.selected, messages, tools: toolDefs, stream: false }), signal: AbortSignal.timeout(90_000) });
        if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
        const result = await response.json() as any, message = result.message ?? {};
        messages.push(message);
        if (!message.tool_calls?.length) {
          const content = redact(message.content ?? "").replace(/\[(ev_[a-f0-9]+)\]/g, (all, key) => valid.has(key) ? all : "[invalid citation removed]");
          emit("content", content);
          for (const item of valid.values()) if (content.includes(`[${item.id}]`)) emit("citation", item);
          db.query("INSERT INTO chats VALUES (?,?,?,?,?)").run(randomUUID(), "assistant", content, JSON.stringify([...valid.values()]), new Date().toISOString());
          emit("done", { model: health.selected }); return;
        }
        for (const call of message.tool_calls) {
          const name = call.function?.name as keyof typeof tools, fn = tools[name]; if (!fn) continue;
          const output = fn(call.function?.arguments ?? {}); for (const c of Array.isArray(output) ? output : []) if (c?.id?.startsWith?.("ev_")) valid.set(c.id, c);
          emit("tool", { name, count: Array.isArray(output) ? output.length : 1 }); messages.push({ role: "tool", tool_name: name, content: JSON.stringify(output) });
        }
      }
      emit("error", "The analyst reached its eight-iteration safety limit."); emit("done", {});
    } catch (error) { emit("error", redact(String(error))); emit("done", {}); }
    finally { controller.close(); }
  }});
}
