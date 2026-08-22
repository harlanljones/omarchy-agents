import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { randomUUID } from "node:crypto";
import { db, json } from "./server/db";
import { security } from "./server/auth";
import { rank } from "./server/ranking";
import { runIndex, indexProgress, startWatching } from "./server/indexer";
import { chatStream, modelHealth, runNightly } from "./server/analyst";
import { UsageRecordV1 } from "./shared/schemas";

const app = new Hono(); app.use("*", security);
app.get("/api/health", async c => c.json({ status: "ok", index: indexProgress(), model: await modelHealth(), database: { path: process.env.OMARCHY_AGENTS_DB ? "configured" : "default" } }));
app.get("/api/overview", c => { const period = c.req.query("period") ?? "week"; const records = (db.query("SELECT record_json FROM usage_records").all() as any[]).flatMap(r => { const parsed = UsageRecordV1.safeParse(json(r.record_json, {})); return parsed.success ? [parsed.data] : []; }); const board = rank(records, period); return c.json({ ...board, freshness: records.map(r => ({ provider: r.id, updatedAt: r.updatedAt ?? null, coverage: ["claude", "codex", "opencode"].includes(r.id) ? "indexed" : "metrics-only" })), index: indexProgress() }); });
app.get("/api/timeseries", c => { const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 30))); return c.json({ days, rows: db.query("SELECT strftime('%Y-%m-%d',started_at) day,provider,SUM(token_input+token_output+cache_read+cache_write) tokens,COUNT(*) sessions FROM sessions WHERE started_at>=datetime('now',?) GROUP BY day,provider ORDER BY day").all(`-${days} days`) }); });
app.get("/api/sessions", c => { const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50))), offset = Math.max(0, Number(c.req.query("offset") ?? 0)); const clauses: string[] = [], args: any[] = []; for (const key of ["provider", "model", "project"] as const) if (c.req.query(key)) { clauses.push(`${key} LIKE ?`); args.push(`%${c.req.query(key)}%`); } if (c.req.query("errors") === "true") clauses.push("error_count>0"); const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""; const rows = db.query(`SELECT id,provider,model,project,title,started_at startedAt,ended_at endedAt,token_input tokenInput,token_output tokenOutput,cache_read cacheRead,cache_write cacheWrite,error_count errorCount,tool_count toolCount FROM sessions ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset); const total = (db.query(`SELECT COUNT(*) total FROM sessions ${where}`).get(...args) as any).total; return c.json({ rows, total, limit, offset }); });
app.get("/api/sessions/:id/events", c => { const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100))), offset = Math.max(0, Number(c.req.query("offset") ?? 0)); return c.json({ rows: db.query("SELECT id,session_id sessionId,ordinal,kind,timestamp,text,tool_name toolName,source_locator sourceLocator FROM events WHERE session_id=? ORDER BY ordinal LIMIT ? OFFSET ?").all(c.req.param("id"), limit, offset), limit, offset }); });
app.get("/api/reports", c => c.json({ rows: (db.query("SELECT * FROM reports ORDER BY created_at DESC LIMIT 50").all() as any[]).map(r => ({ id: r.id, createdAt: r.created_at, periodStart: r.period_start, periodEnd: r.period_end, model: r.model, summary: r.summary, detectors: json(r.detectors_json, []), suggestions: (db.query("SELECT * FROM suggestions WHERE report_id=?").all(r.id) as any[]).map(s => ({ ...s, evidence: json(s.evidence_json, []) })) })) }));
app.post("/api/agent/chat", async c => { const body = await c.req.json(); if (typeof body?.message !== "string" || !body.message.trim() || body.message.length > 8000) return c.json({ error: "A message between 1 and 8,000 characters is required" }, 400); db.query("INSERT INTO chats VALUES (?,?,?,?,?)").run(randomUUID(), "user", body.message, "[]", new Date().toISOString()); return new Response(chatStream(body.message), { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } }); });
app.post("/api/analysis/run", async c => c.json(await runNightly(), 202));
app.post("/api/refresh", async c => { const child = Bun.spawn([`${process.env.HOME}/.local/bin/omarchy-agent-usage-update`, "--force"], { stdout: "ignore", stderr: "ignore" }); void child.exited.then(() => runIndex()); return c.json({ started: true }, 202); });
app.post("/api/index/rebuild", c => { void runIndex({ rebuild: true }); return c.json({ started: true }, 202); });
app.patch("/api/suggestions/:id", async c => { const body = await c.req.json(); if (!["open", "accepted", "dismissed"].includes(body?.status)) return c.json({ error: "status must be open, accepted, or dismissed" }, 400); const result = db.query("UPDATE suggestions SET status=? WHERE id=?").run(body.status, c.req.param("id")); return result.changes ? c.json({ id: c.req.param("id"), status: body.status }) : c.json({ error: "Suggestion not found" }, 404); });
app.use("/assets/*", serveStatic({ root: "./dist" }));
app.use("/provider-assets/*", serveStatic({ root: "./dist" }));
app.use("/fonts/*", serveStatic({ root: "./dist" }));
app.get("*", async c => { const file = Bun.file("./dist/index.html"); return file.size ? new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } }) : c.text("Build the dashboard with `bun run build`.", 503); });

if (import.meta.main) { void runIndex(); startWatching(); const port = Number(process.env.PORT ?? 4317); Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch }); console.log(`Omarchy Agents listening on http://127.0.0.1:${port}`); }
export default app;
