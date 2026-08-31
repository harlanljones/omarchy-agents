import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { db, json } from "./db";
import { redact } from "./redact";
import type { AnalysisReport, Citation, ExperimentDefaults, Finding } from "../shared/schemas";

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

const eventCitation = (row: any) => ({
  id: `ev_${row.id}`, provider: row.provider, sessionId: row.session_id,
  anchor: "event" as const, eventId: row.id, timestamp: row.timestamp,
  excerpt: redact(String(row.text ?? "")).slice(0, 240),
});
const sessionCitation = (row: any, excerpt: string) => ({
  id: `session_${row.id}`, provider: row.provider, sessionId: row.id,
  anchor: "session" as const, eventId: null, timestamp: row.started_at,
  excerpt: redact(excerpt).slice(0, 240),
});
function citation(row: any): Citation { return eventCitation(row); }
export const tools = {
  overview: (_args: any) => db.query("SELECT provider,COUNT(*) sessions,SUM(token_input+token_output+cache_read+cache_write) tokens,SUM(error_count) errors FROM sessions GROUP BY provider ORDER BY tokens DESC").all(),
  compare_periods: (_args: any) => db.query("SELECT provider,strftime('%Y-%m-%d',started_at) day,SUM(token_input+token_output+cache_read+cache_write) tokens,COUNT(*) sessions FROM sessions WHERE started_at >= datetime('now','-30 days') GROUP BY provider,day ORDER BY day").all(),
  search_logs: (args: any) => {
    const q = String(args?.query ?? "").replace(/["']/g, " ").trim(); if (!q) return [];
    return (db.query("SELECT e.id,e.session_id,e.timestamp,e.text,s.provider FROM events_fts f JOIN events e ON e.id=f.event_id JOIN sessions s ON s.id=e.session_id WHERE events_fts MATCH ? LIMIT 12").all(q) as any[]).map(citation);
  },
  inspect_session: (args: any) => (db.query("SELECT e.id,e.session_id,e.timestamp,e.text,s.provider FROM events e JOIN sessions s ON s.id=e.session_id WHERE e.session_id=? ORDER BY ordinal LIMIT 30").all(String(args?.sessionId ?? "")) as any[]).map(citation),
  anomalies: (_args: any) => detect(),
  recommendations: (_args: any) => db.query(`SELECT s.*,e.id experiment_id
  FROM suggestions s LEFT JOIN experiments e ON e.source_suggestion_id=s.id
  ORDER BY s.created_at DESC LIMIT 20`).all().map((row: any) => ({
    id: row.id, reportId: row.report_id, findingKey: row.finding_key,
    title: row.title, impact: row.impact, effort: row.effort, confidence: Number(row.confidence),
    rationale: row.rationale, evidence: json(row.evidence_json, []), status: row.status,
    createdAt: row.created_at, experiment: json(row.experiment_json, null), experimentId: row.experiment_id ?? null,
  })),
};

function toolArguments(value: unknown) {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseTextToolCall(content: unknown) {
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const wrapped = trimmed.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i)?.[1]
    ?? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidate = wrapped.match(/\{[\s\S]*\}/)?.[0] ?? wrapped;
  let parsed: any;
  try { parsed = JSON.parse(candidate); } catch { return null; }
  const name = parsed?.name ?? parsed?.function?.name;
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(tools, name)) return null;
  const args = parsed?.arguments ?? parsed?.parameters ?? parsed?.function?.arguments ?? {};
  return {
    type: "function",
    function: { name, arguments: JSON.stringify(toolArguments(args)) },
  };
}

export function detect(database: Database = db, current: Date = new Date()): Finding[] {
  const findings: Finding[] = [];
  const since = new Date(current.valueOf() - 7 * 86_400_000).toISOString();
  const totals = database.query(`SELECT provider,
    SUM(token_input+token_output+cache_read+cache_write) tokens,
    COUNT(*) sessions,SUM(error_count) errors,SUM(tool_count) tools,
    SUM(cache_read) cache_read,SUM(token_input) input
    FROM sessions WHERE started_at>=? GROUP BY provider`).all(since) as any[];
  const totalTokens = totals.reduce((sum, row) => sum + Number(row.tokens), 0);
  const providerSessions = database.query(`SELECT id,provider,started_at,ended_at,
    token_input,token_output,cache_read,cache_write,error_count,tool_count
    FROM sessions WHERE provider=? AND started_at>=?
    ORDER BY error_count DESC,started_at DESC LIMIT 8`);
  const errorEvents = database.query(`SELECT e.id,e.session_id,e.timestamp,e.text,s.provider
    FROM events e JOIN sessions s ON s.id=e.session_id
    WHERE s.provider=? AND e.kind='error' AND e.timestamp>=?
    ORDER BY e.timestamp DESC LIMIT 8`);
  for (const aggregate of totals) {
    const sessions = providerSessions.all(aggregate.provider, since) as any[];
    if (totalTokens > 0 && aggregate.tokens / totalTokens > 0.65) findings.push({
      key: `token_concentration:${aggregate.provider}`, type: "token_concentration", provider: aggregate.provider,
      severity: "warning", message: `${aggregate.provider} accounts for ${Math.round(aggregate.tokens / totalTokens * 100)}% of indexed tokens.`,
      value: aggregate.tokens / totalTokens,
      evidence: sessions.slice(0, 5).map((row) => sessionCitation(row, `${row.provider} session contributing to the seven-day token total`)),
    });
    if (aggregate.tools > 0 && aggregate.errors / aggregate.tools > 0.15) findings.push({
      key: `failed_tools:${aggregate.provider}`, type: "failed_tools", provider: aggregate.provider,
      severity: "warning", message: `${aggregate.provider} has an elevated tool error ratio.`,
      value: aggregate.errors / aggregate.tools,
      evidence: [
        ...(errorEvents.all(aggregate.provider, since) as any[]).map(eventCitation),
        ...sessions.filter((row) => row.error_count > 0).slice(0, 5).map((row) => sessionCitation(row, `${row.error_count} errors across ${row.tool_count} tool calls`)),
      ].slice(0, 10),
    });
    if (aggregate.input > 0 && aggregate.cache_read / aggregate.input < 0.1) findings.push({
      key: `cache_ratio:${aggregate.provider}`, type: "cache_ratio", provider: aggregate.provider,
      severity: "info", message: `${aggregate.provider} cache reads are low relative to input.`,
      value: aggregate.cache_read / aggregate.input,
      evidence: sessions.slice(0, 8).map((row) => sessionCitation(row, `${row.cache_read} cache-read tokens / ${row.token_input} input tokens`)),
    });
  }
  const long = database.query(`SELECT id,provider,started_at,ended_at FROM sessions
    WHERE started_at>=? AND ended_at IS NOT NULL AND (julianday(ended_at)-julianday(started_at))*24>4
    ORDER BY started_at DESC LIMIT 8`).all(since) as any[];
  if (long.length) findings.push({
    key: "long_sessions", type: "long_sessions", provider: null, severity: "info",
    message: `${long.length} unusually long sessions were observed.`, value: long.length,
    evidence: long.map((row) => sessionCitation(row, `Session ran from ${row.started_at} to ${row.ended_at}`)),
  });
  const repeats = database.query(`SELECT e.id,e.session_id,e.timestamp,e.text,s.provider
    FROM events e JOIN sessions s ON s.id=e.session_id
    WHERE e.kind='prompt' AND e.timestamp>=? AND length(e.text)>30 AND substr(e.text,1,180) IN (
      SELECT substr(text,1,180) FROM events WHERE kind='prompt' AND timestamp>=? AND length(text)>30
      GROUP BY substr(text,1,180) HAVING COUNT(*)>2
    ) ORDER BY e.timestamp DESC LIMIT 10`).all(since, since) as any[];
  if (repeats.length) findings.push({
    key: "repeated_prompts", type: "repeated_prompts", provider: null, severity: "info",
    message: "Repeated prompt patterns appear across indexed sessions.", value: repeats.length,
    evidence: repeats.map(eventCitation),
  });
  return findings;
}

type SuggestionInsert = {
  id: string; reportId: string; findingKey: string; title: string;
  impact: "low" | "medium" | "high"; effort: "low" | "medium" | "high";
  confidence: number; rationale: string; evidence: Finding["evidence"];
  status: "open"; createdAt: string; experiment: ExperimentDefaults;
};

export function buildSuggestion(
  finding: Finding,
  database: Database,
  createdAt: string,
  suggestionId: string,
): SuggestionInsert | null {
  const base = { id: suggestionId, reportId: "", findingKey: finding.key, evidence: finding.evidence, status: "open" as const, createdAt };
  if (finding.type === "failed_tools") return {
    ...base, title: "Reduce repeated tool retries", impact: "high", effort: "low", confidence: 0.8,
    rationale: "Compare the current retry policy with a one-retry trial using explicitly selected sessions.",
    experiment: { hypothesis: "Reducing retry attempts to one lowers tool failures without increasing task abandonment.", metricKind: "tool_failure_rate", metricVersion: 1, targetValue: 0.1 },
  };
  if (finding.type === "long_sessions") return {
    ...base, title: "Split unusually long agent sessions", impact: "medium", effort: "medium", confidence: 0.7,
    rationale: "Compare long-running work with sessions split at clearer task boundaries.",
    experiment: { hypothesis: "Smaller task boundaries reduce average session duration.", metricKind: "average_duration_minutes", metricVersion: 1, targetValue: 240 },
  };
  if (finding.type === "cache_ratio") return {
    ...base, title: "Increase reusable prompt context", impact: "medium", effort: "medium", confidence: 0.65,
    rationale: "Compare the current prompt structure with a stable-prefix trial and inspect cache-read ratio.",
    experiment: { hypothesis: "A stable reusable prefix raises cache-read ratio.", metricKind: "cache_read_ratio", metricVersion: 1, targetValue: 0.2 },
  };
  if (finding.type === "repeated_prompts") {
    const sessionIds = [...new Set(finding.evidence.map((citation) => citation.sessionId))];
    const binds = sessionIds.map(() => "?").join(",");
    const rows = sessionIds.length ? database.query(`SELECT token_input+token_output+cache_read+cache_write total FROM sessions WHERE id IN (${binds})`).all(...sessionIds) as Array<{ total: number }> : [];
    const observedMean = rows.length ? rows.reduce((sum, row) => sum + Number(row.total), 0) / rows.length : 0;
    return {
      ...base, title: "Consolidate repeated prompt instructions", impact: "medium", effort: "low", confidence: 0.7,
      rationale: "Token reduction is the trial hypothesis; repetition alone does not prove a saving.",
      experiment: { hypothesis: "Consolidating repeated instructions lowers tokens per session by at least 10%.", metricKind: "tokens_per_session", metricVersion: 1, targetValue: Math.max(0, Math.round(observedMean * 0.9)) },
    };
  }
  return null;
}

export async function runNightly(dependencies: {
  database?: Database; now?: () => Date; id?: () => string;
  health?: () => Promise<{ ready: boolean; selected: string }>;
} = {}): Promise<AnalysisReport> {
  const database = dependencies.database ?? db;
  const clock = dependencies.now ?? (() => new Date());
  const nextId = dependencies.id ?? randomUUID;
  const healthCheck = dependencies.health ?? modelHealth;
  const current = clock();
  const periodStart = new Date(current.valueOf() - 7 * 86_400_000);
  const reportId = nextId();
  const detectors = detect(database, current);
  const health = await healthCheck();
  let summary = detectors.length
    ? `Found ${detectors.length} evidence-backed patterns in the last seven days.`
    : "No material deterministic anomalies were found in the indexed period.";
  if (!health.ready) summary += " Local model interpretation was unavailable; this report contains deterministic results only.";
  const createdAt = current.toISOString();
  const supported = new Set(["failed_tools", "long_sessions", "cache_ratio", "repeated_prompts"]);
  const suggestions = detectors.filter((finding) => supported.has(finding.type)).flatMap((finding) => {
    const suggestion = buildSuggestion(finding, database, createdAt, nextId());
    return suggestion ? [{ ...suggestion, reportId }] : [];
  });
  database.transaction(() => {
    database.query("INSERT INTO reports(id,created_at,period_start,period_end,model,summary,detectors_json) VALUES (?,?,?,?,?,?,?)")
      .run(reportId, createdAt, periodStart.toISOString(), createdAt, health.selected, summary, JSON.stringify(detectors));
    const insert = database.query(`INSERT INTO suggestions(id,report_id,title,impact,effort,confidence,rationale,evidence_json,status,created_at,finding_key,experiment_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const suggestion of suggestions) insert.run(
      suggestion.id, reportId, suggestion.title, suggestion.impact, suggestion.effort,
      suggestion.confidence, suggestion.rationale, JSON.stringify(suggestion.evidence), suggestion.status,
      suggestion.createdAt, suggestion.findingKey, JSON.stringify(suggestion.experiment),
    );
  })();
  return {
    id: reportId, createdAt, periodStart: periodStart.toISOString(), periodEnd: createdAt,
    model: health.selected, summary, detectors,
    suggestions: suggestions.map((suggestion) => ({ ...suggestion, experimentId: null })),
  };
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
      const originalPrompt = redact(prompt);
      const systemPrompt = "You are the read-only Omarchy Agents analyst. Use tools before claims. Cite only evidence IDs returned by tools, formatted [ev_x]. Be concise and never imply you changed configuration.";
      let messages: any[] = [{ role: "system", content: systemPrompt }, { role: "user", content: originalPrompt }];
      let promptToolFallback = false;
      for (let iteration = 0; iteration < 8; iteration++) {
        emit("thinking", { iteration: iteration + 1 });
        const request: any = { model: health.selected, messages, stream: false };
        if (!promptToolFallback) request.tools = toolDefs;
        const response = await fetch(`${ollama()}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(90_000) });
        if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
        const result = await response.json() as any, message = result.message ?? {};
        const nativeCalls = message.tool_calls?.length ? message.tool_calls : null;
        const textCall = nativeCalls ? null : parseTextToolCall(message.content);
        const calls = nativeCalls ?? (textCall ? [textCall] : []);
        if (!calls.length) {
          messages.push(message);
          const content = redact(message.content ?? "").replace(/\[(ev_[a-f0-9]+)\]/g, (all, key) => valid.has(key) ? all : "[invalid citation removed]");
          emit("content", content);
          for (const item of valid.values()) if (content.includes(`[${item.id}]`)) emit("citation", item);
          db.query("INSERT INTO chats VALUES (?,?,?,?,?)").run(randomUUID(), "assistant", content, JSON.stringify([...valid.values()]), new Date().toISOString());
          emit("done", { model: health.selected }); return;
        }
        const normalizedCalls = calls.map((call: any) => ({
          type: "function",
          function: {
            name: call?.function?.name,
            arguments: toolArguments(call?.function?.arguments),
          },
        }));
        if (textCall) {
          promptToolFallback = true;
          messages = [
            { role: "system", content: `${systemPrompt} Native function calling is unavailable. Use the supplied tool result and answer directly in plain language; do not output JSON or another tool call.` },
            { role: "user", content: originalPrompt },
          ];
        } else {
          messages.push({ role: "assistant", content: "", tool_calls: normalizedCalls });
        }
        for (const call of normalizedCalls) {
          const name = call?.function?.name as keyof typeof tools, fn = tools[name]; if (!fn) continue;
          const output = fn(toolArguments(call.function?.arguments)); for (const c of (Array.isArray(output) ? output : []) as any[]) if (c?.id?.startsWith?.("ev_")) valid.set(c.id, c);
          emit("tool", { name, count: Array.isArray(output) ? output.length : 1 });
          if (textCall) {
            messages.push({ role: "user", content: `Tool result from ${name}:\n${JSON.stringify(output)}\nAnswer the original request directly.` });
          } else {
            messages.push({ role: "tool", content: JSON.stringify(output) });
          }
        }
      }
      emit("error", "The analyst reached its eight-iteration safety limit."); emit("done", {});
    } catch (error) { emit("error", redact(String(error))); emit("done", {}); }
    finally { controller.close(); }
  }});
}
