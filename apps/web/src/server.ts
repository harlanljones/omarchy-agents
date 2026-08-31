import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import type { Context, Next } from "hono";
import { compress } from "hono/compress";
import { randomUUID } from "node:crypto";
import { db, json } from "./server/db";
import { security, requireAdmin, localHosts, identityVerified } from "./server/auth";
import { rank } from "./server/ranking";
import { runIndex, indexProgress, startWatching } from "./server/indexer";
import { isIndexed } from "./server/providers";
import { chatStream, modelHealth, runNightly } from "./server/analyst";
import { limitsBoard, advise, loadUsageRecords, TASK_PRESETS } from "./server/limits";
import { alertsInbox, incidentsView } from "./server/watch";
import type { TaskProfile } from "./shared/schemas";
import { effectivePricingTable, pricingOverrideError, ratesForModel, estimateCostUsd } from "./server/pricing";
import { UsageRecordV1, CohortKind, ExperimentState } from "./shared/schemas";
import { analyzePrompt } from "./server/prompt-analysis";
import { productivityActivity, productivityResponse, startProductivitySync, syncProductivitySources } from "./server/productivity";
import { createExperimentService, ExperimentError } from "./server/experiments";

const app = new Hono();
const experimentService = createExperimentService(db);
const experimentResponse = <T,>(c: Context, operation: () => T, successStatus: 200 | 201 = 200) => {
  try { return c.json(operation(), successStatus); }
  catch (error) {
    if (error instanceof ExperimentError) {
      return c.json({ error: error.message, code: error.code, ...(error.details === undefined ? {} : { details: error.details }) }, error.status);
    }
    throw error;
  }
};
app.use(compress());
app.use("*", security);
app.use("/limits", requireAdmin);
app.use("/limits/*", requireAdmin);
// Cache-Control: hashed build assets are content-addressed and immutable;
// HTML and JSON must always revalidate so releases and live data propagate.
app.use("*", async (c, next) => {
  await next();
  const ct = (c.res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (ct === "text/html" || ct === "application/json") {
    c.header("Cache-Control", "no-cache");
  } else if (
    /^(text\/javascript|application\/javascript|text\/css|font\/|application\/font|application\/woff|image\/)/.test(
      ct,
    )
  ) {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
  }
});
export function collectorTimeseries(days: number) {
  const records = (db.query("SELECT record_json FROM usage_records").all() as any[])
    .flatMap((row) => {
      const parsed = UsageRecordV1.safeParse(json(row.record_json, {}));
      return parsed.success ? [parsed.data] : [];
    });
  const window = Math.min(days, 7);
  return records.flatMap((record) => {
    const recent = record.recentDays ?? [];
    const selected = days === 1
      ? [{ date: recent.at(-1)?.date ?? new Date().toISOString().slice(0, 10), messageCount: record.todayTotalTokens ?? recent.at(-1)?.messageCount ?? 0 }]
      : recent.slice(-window);
    return selected
      .map((day) => ({
        day: day.date,
        provider: record.id,
        tokens: Number(day.messageCount ?? 0),
        sessions: null,
      }))
      .filter((row) => row.tokens > 0);
  });
}
app.get("/api/health", async c => c.json({ status: "ok", index: indexProgress(), model: await modelHealth(), database: { path: process.env.OMARCHY_AGENTS_DB ? "configured" : "default" } }));
app.get("/api/overview", c => {
  const requestedPeriod = c.req.query("period") ?? "week";
  const period = ["today", "week", "month", "all"].includes(requestedPeriod) ? requestedPeriod : "week";
  const project = c.req.query("project")?.trim() ?? "";
  const records = (db.query("SELECT record_json FROM usage_records").all() as any[]).flatMap(r => { const parsed = UsageRecordV1.safeParse(json(r.record_json, {})); return parsed.success ? [parsed.data] : []; });
  let board = rank(records, period);
  if (project) {
    const since = period === "today" ? "start of day" : period === "week" ? "-7 days" : period === "month" ? "-30 days" : null;
    const clauses = ["project = ?"], args: any[] = [project];
    if (since) { clauses.push("started_at >= datetime('now', ?)"); args.push(since); }
    const sessionsList = db.query(`SELECT provider providerId, token_input tokenInput, token_output tokenOutput, cache_read cacheRead, cache_write cacheWrite, model FROM sessions WHERE ${clauses.join(" AND ")}`).all(...args) as Array<any>;
    const providerMap = new Map<string, { tokens: number; estCostUsd: number }>();
    for (const s of sessionsList) {
      const t = Number(s.tokenInput) + Number(s.tokenOutput) + Number(s.cacheRead) + Number(s.cacheWrite);
      let cost = 0;
      if (s.model) {
        const rates = ratesForModel(s.model);
        if (rates?.rates) {
          cost = estimateCostUsd(rates.rates, { input: Number(s.tokenInput), output: Number(s.tokenOutput), cacheRead: Number(s.cacheRead), cacheWrite: Number(s.cacheWrite) } as any);
        }
      }
      const existing = providerMap.get(s.providerId) ?? { tokens: 0, estCostUsd: 0 };
      providerMap.set(s.providerId, { tokens: existing.tokens + t, estCostUsd: existing.estCostUsd + cost });
    }
    const totals = Array.from(providerMap.entries()).map(([providerId, data]) => ({ providerId, tokens: data.tokens, estCostUsd: data.estCostUsd })).sort((a, b) => b.tokens - a.tokens);
    const total = totals.reduce((sum, row) => sum + Number(row.tokens), 0);
    const totalCostUsd = totals.reduce((sum, row) => sum + row.estCostUsd, 0);
    let previous = -1, rankNumber = 0;
    board = { total, totalCostUsd, rows: totals.map((row, index) => { if (Number(row.tokens) !== previous) rankNumber = index + 1; previous = Number(row.tokens); return { ...row, providerName: row.providerId, tokens: Number(row.tokens), estCostUsd: row.estCostUsd, rank: rankNumber, share: total ? Number(row.tokens) / total : 0, coverage: "indexed", updatedAt: new Date().toISOString() }; }) } as any;
  }
  return c.json({ ...board, freshness: records.map(r => ({ provider: r.id, updatedAt: r.updatedAt ?? null, coverage: isIndexed(r.id) ? "indexed" : "metrics-only" })), index: indexProgress() });
});
app.get("/limits/api/board", c => c.json(limitsBoard(indexProgress())));
app.get("/limits/api/alerts", c => c.json(alertsInbox()));
app.get("/limits/api/incidents", c => c.json(incidentsView()));
app.get("/limits/api/advice", c => {
  const task = c.req.query("task") ?? "";
  const explicit = { input: Number(c.req.query("input")), output: Number(c.req.query("output")), cacheRead: Number(c.req.query("cache")) };
  let mix = null;
  if (task in TASK_PRESETS) mix = TASK_PRESETS[task];
  else if ([explicit.input, explicit.output, explicit.cacheRead].every(n => Number.isFinite(n) && n >= 0)) mix = explicit;
  else if (task || c.req.query("input")) return c.json({ error: "task must be small, medium, or large, or pass input/output/cache token counts" }, 400);
  const capabilities = (c.req.query("capabilities") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const preferredProviders = (c.req.query("prefer") ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const profile: TaskProfile | null = capabilities.length || preferredProviders.length ? { requiredCapabilities: capabilities, preferredProviders } : null;
  return c.json(advise(loadUsageRecords(), mix, Date.now(), profile));
});
app.get("/limits/api/pricing", c => c.json({ asOfNote: "Reference API rates; override via ~/.config/omarchy-agents/pricing.json", overrideError: pricingOverrideError(), entries: effectivePricingTable() }));
app.get("/limits/api/productivity", c => {
  try {
    return c.json(productivityResponse({ query: {
      from: c.req.query("from"),
      to: c.req.query("to"),
      repo: c.req.query("repo"),
      team: c.req.query("team"),
    } }));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
app.get("/limits/api/productivity/activity", c => {
  try {
    return c.json(productivityActivity({ query: {
      from: c.req.query("from"),
      to: c.req.query("to"),
      repo: c.req.query("repo"),
      team: c.req.query("team"),
    } }));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});
app.post("/limits/api/productivity/sync", async c => c.json(await syncProductivitySources()));
app.get("/api/filter-options", c => c.json({
  projects: (db.query("SELECT DISTINCT project FROM sessions WHERE project IS NOT NULL AND trim(project) <> '' ORDER BY project COLLATE NOCASE").all() as Array<{ project: string }>).map(row => row.project),
  models: (db.query("SELECT DISTINCT model FROM sessions WHERE model IS NOT NULL AND trim(model) <> '' ORDER BY model COLLATE NOCASE").all() as Array<{ model: string }>).map(row => row.model),
}));
app.get("/api/timeseries", c => { const rawDays = Number(c.req.query("days") ?? 30), days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.floor(rawDays))) : 30, project = c.req.query("project")?.trim() ?? ""; if (!project && days <= 7) return c.json({ days, source: "collector", rows: collectorTimeseries(days) }); const clauses = ["started_at>=datetime('now',?)"], args: any[] = [`-${days} days`]; if (project) { clauses.push("project=?"); args.push(project); } return c.json({ days, source: "indexed", rows: db.query(`SELECT strftime('%Y-%m-%d',started_at) day,provider,SUM(token_input+token_output+cache_read+cache_write) tokens,COUNT(*) sessions FROM sessions WHERE ${clauses.join(" AND ")} GROUP BY day,provider ORDER BY day`).all(...args) }); });
app.get("/api/sessions", c => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50))), offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const clauses: string[] = [], args: any[] = [];
  if (c.req.query("id")) { clauses.push("id=?"); args.push(c.req.query("id")); }
  for (const key of ["provider", "model", "project"] as const) if (c.req.query(key)) { clauses.push(`${key} LIKE ?`); args.push(`%${c.req.query(key)}%`); }
  if (c.req.query("errors") === "true") clauses.push("error_count>0");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.query(`SELECT id,provider,model,project,title,started_at startedAt,ended_at endedAt,token_input tokenInput,token_output tokenOutput,cache_read cacheRead,cache_write cacheWrite,error_count errorCount,tool_count toolCount FROM sessions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];
  const total = (db.query(`SELECT COUNT(*) total FROM sessions ${where}`).get(...args) as any).total;
  const enriched = rows.map(r => {
    let estCostUsd: number | null = null;
    if (r.model) {
      const rates = ratesForModel(r.model);
      if (rates?.rates) {
        estCostUsd = estimateCostUsd(rates.rates, { input: Number(r.tokenInput), output: Number(r.tokenOutput), cacheRead: Number(r.cacheRead), cacheWrite: Number(r.cacheWrite) } as any);
      }
    }
    return { ...r, estCostUsd };
  });
  return c.json({ rows: enriched, total, limit, offset });
});
app.get("/api/sessions/:id/events", c => { const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100))), offset = Math.max(0, Number(c.req.query("offset") ?? 0)); return c.json({ rows: db.query("SELECT id,session_id sessionId,ordinal,kind,timestamp,text,tool_name toolName,source_locator sourceLocator FROM events WHERE session_id=? ORDER BY ordinal LIMIT ? OFFSET ?").all(c.req.param("id"), limit, offset), limit, offset }); });
app.get("/api/experiments", (c) => experimentResponse(c, () => {
  const state = c.req.query("state");
  if (!state) return { rows: experimentService.listExperiments() };
  const parsed = ExperimentState.safeParse(state);
  if (!parsed.success) throw new ExperimentError(400, "invalid_request", "state is not a valid experiment state", parsed.error.flatten());
  return { rows: experimentService.listExperiments({ state: parsed.data }) };
}));
app.get("/api/experiments/:id", (c) => experimentResponse(c, () => experimentService.getExperiment(c.req.param("id"))));
app.post("/api/experiments", async (c) => {
  const body = await c.req.json().catch(() => null);
  return experimentResponse(c, () => experimentService.createExperiment(body), 201);
});
app.put("/api/experiments/:id/cohorts/:cohort", async (c) => {
  const cohort = CohortKind.safeParse(c.req.param("cohort"));
  if (!cohort.success) return c.json({ error: "cohort must be baseline or trial", code: "invalid_request" }, 400);
  const body = await c.req.json().catch(() => null) as any;
  return experimentResponse(c, () => experimentService.replaceCohort(c.req.param("id"), cohort.data, body?.sessionIds));
});
app.post("/api/experiments/:id/start", (c) => experimentResponse(c, () => experimentService.startExperiment(c.req.param("id"))));
app.post("/api/experiments/:id/ready", (c) => experimentResponse(c, () => experimentService.markReadyForReview(c.req.param("id"))));
app.post("/api/experiments/:id/reviews", async (c) => {
  const body = await c.req.json().catch(() => null) as any;
  return experimentResponse(c, () => experimentService.reviewExperiment(c.req.param("id"), body), 201);
});
const reportSuggestionRows = db.query(`SELECT s.*,e.id experiment_id
  FROM suggestions s LEFT JOIN experiments e ON e.source_suggestion_id=s.id
  WHERE s.report_id=? ORDER BY s.created_at,s.id`);
const suggestionDto = (row: any) => ({
  id: row.id, reportId: row.report_id, findingKey: row.finding_key,
  title: row.title, impact: row.impact, effort: row.effort, confidence: Number(row.confidence),
  rationale: row.rationale, evidence: json(row.evidence_json, []), status: row.status,
  createdAt: row.created_at, experiment: json(row.experiment_json, null), experimentId: row.experiment_id ?? null,
});
app.get("/api/reports", (c) => c.json({
  rows: (db.query("SELECT * FROM reports ORDER BY created_at DESC LIMIT 50").all() as any[]).map((report) => ({
    id: report.id, createdAt: report.created_at, periodStart: report.period_start,
    periodEnd: report.period_end, model: report.model, summary: report.summary,
    detectors: json(report.detectors_json, []),
    suggestions: reportSuggestionRows.all(report.id).map(suggestionDto),
  })),
}));
app.post("/api/prompt-analysis", async c => {
  const body = await c.req.json().catch(() => null) as any;
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
  let prompt = typeof body?.prompt === "string" ? body.prompt : "";
  let source: "prompt" | "session" = "prompt";
  let metadata: { toolCount?: number; tokenInput?: number } = {};
  if (sessionId) {
    const session = db.query("SELECT model,token_input,tool_count FROM sessions WHERE id=?").get(sessionId) as any;
    const event = db.query("SELECT text FROM events WHERE session_id=? AND kind='prompt' ORDER BY ordinal LIMIT 1").get(sessionId) as any;
    if (!session || !event) return c.json({ error: "Session or prompt evidence not found" }, 404);
    prompt = String(event.text ?? ""); source = "session";
    metadata = { toolCount: Number(session.tool_count ?? 0), tokenInput: Number(session.token_input ?? 0) };
  }
  if (!prompt.trim() || prompt.length > 8000) return c.json({ error: "Provide a prompt between 1 and 8,000 characters or a valid sessionId" }, 400);
  const models = (db.query("SELECT model,provider FROM sessions WHERE model IS NOT NULL AND trim(model) <> '' GROUP BY model,provider ORDER BY model").all() as Array<{ model: string; provider: string }>).map(row => ({ model: row.model, provider: row.provider }));
  const configured = [process.env.OLLAMA_MODEL, process.env.OLLAMA_FALLBACK_MODEL].filter((model): model is string => Boolean(model)).map(model => ({ model, provider: "ollama" }));
  const candidates = [...new Map([...models, ...configured].map(candidate => [candidate.model.toLowerCase(), candidate])).values()];
  return c.json(analyzePrompt(prompt, candidates, source, metadata));
});
app.post("/api/agent/chat", async c => { const body = await c.req.json(); if (typeof body?.message !== "string" || !body.message.trim() || body.message.length > 8000) return c.json({ error: "A message between 1 and 8,000 characters is required" }, 400); db.query("INSERT INTO chats VALUES (?,?,?,?,?)").run(randomUUID(), "user", body.message, "[]", new Date().toISOString()); return new Response(chatStream(body.message), { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } }); });
app.post("/api/analysis/run", async c => c.json(await runNightly(), 202));
app.post("/api/refresh", async c => { const child = Bun.spawn([`${process.env.HOME}/.local/bin/omarchy-agent-usage-update`, "--force"], { stdout: "ignore", stderr: "ignore" }); void child.exited.then(() => runIndex()); return c.json({ started: true }, 202); });
app.post("/api/index/rebuild", c => { void runIndex({ rebuild: true }); return c.json({ started: true }, 202); });
app.patch("/api/suggestions/:id", async c => { const body = await c.req.json(); if (!["open", "accepted", "dismissed"].includes(body?.status)) return c.json({ error: "status must be open, accepted, or dismissed" }, 400); const result = db.query("UPDATE suggestions SET status=? WHERE id=?").run(body.status, c.req.param("id")); return result.changes ? c.json({ id: c.req.param("id"), status: body.status }) : c.json({ error: "Suggestion not found" }, 404); });
// The published API origin answers API routes only. The dashboard SPA and its
// assets are served exclusively by the Cloudflare Worker in front of the
// browser-facing hostname; they must never be served from the API domain.
// Local-first: loopback still renders the SPA and assets for development.
const serveDist = serveStatic({ root: "./dist" });
const servePublic = serveStatic({ root: "./public" });
// Portal assets and the SPA shell are also served to remote browsers whose
// Access identity requireAdmin/security verified (the portal lives on the
// API hostname, which is natively Access-gated at the edge).
const serveGated = async (c: Context, next: Next, handler: (c: Context, next: Next) => Response | Promise<Response | void>) => {
  if (localHosts.has((c.req.header("host") ?? "").split(":")[0].toLowerCase()) || identityVerified(c)) return await handler(c, next);
  return next();
};
const localOnly = async (c: Context, next: Next, handler: (c: Context, next: Next) => Response | Promise<Response | void>) => {
  const host = (c.req.header("host") ?? "").split(":")[0].toLowerCase();
  if (!localHosts.has(host)) return await next();
  return await handler(c, next);
};
app.use("/assets/*", (c, n) => serveGated(c, n, serveDist));
app.use("/provider-assets/*", (c, n) => serveGated(c, n, serveDist));
app.use("/fonts/*", (c, n) => serveGated(c, n, serveDist));
// Keep source-owned public files available before the first build completes.
// This also makes the Bun test server deterministic when Turborepo runs the
// web test and build tasks in parallel.
app.use("*", (c, n) => localOnly(c, n, servePublic));
app.get("*", async c => {
  const host = (c.req.header("host") ?? "").split(":")[0].toLowerCase();
  if (!localHosts.has(host) && !identityVerified(c)) return c.json({ error: "Not found" }, 404);
  const file = Bun.file("./dist/index.html");
  return file.size ? new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } }) : c.text("Build the dashboard with `bun run build`.", 503);
});

if (import.meta.main) { void runIndex(); startWatching(); startProductivitySync(); const port = Number(process.env.PORT ?? 4317); Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch }); console.log(`Omarchy Agents listening on http://127.0.0.1:${port}`); }
export default app;
