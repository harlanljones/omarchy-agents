import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { createHash } from "node:crypto";
import { redact } from "./redact";
import { LogEvent, NormalizedSession, type Event, type Session } from "../shared/schemas";

// Provider intake module.
//
// This is the single source of truth for which agent providers the indexer
// knows about and how each one's local transcript store is turned into a
// normalized session + event stream. Every provider declares its source roots
// and, if it is "indexable", a `parse` adapter (or a cursor-based `index`
// function for stores that are not flat files).
//
// Coverage ("indexed" vs "metrics-only") is *derived* from this registry: a
// provider is indexed iff it has an intake (a parser or indexer). There is no
// longer a hardcoded list of provider ids scattered across server/limits/ranking.

const home = process.env.HOME ?? "";

// --- shared intake helpers (promoted from indexer.ts so every adapter reuses them) ---

const id = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const iso = (value: unknown, fallback: string) => { const d = new Date(String(value ?? "")); return Number.isNaN(d.valueOf()) ? fallback : d.toISOString(); };
const first = (...values: unknown[]) => values.find(v => typeof v === "string" && v.length) as string | undefined;
export const obj = (v: unknown): Record<string, any> => v && typeof v === "object" ? v as Record<string, any> : {};
type TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number };
export const tokenNumber = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;
const tokenValue = (usage: Record<string, any>, keys: string[]) => {
  for (const key of keys) if (usage[key] !== undefined && usage[key] !== null) return tokenNumber(usage[key]);
  return 0;
};
export const epochIso = (value: unknown, fallback: string) => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  const milliseconds = Math.abs(numberValue) < 10_000_000_000 ? numberValue * 1000 : numberValue;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
};
const usageObject = (raw: any) => {
  const message = obj(raw.message), payload = obj(raw.payload), data = obj(raw.data);
  const candidates = [
    raw.usage, message.usage, payload.usage, data.usage,
    raw.token_usage, message.token_usage, payload.token_usage,
    raw.tokens, message.tokens, payload.tokens,
  ].map(obj);
  return candidates.find((usage) => Object.keys(usage).some((key) => /token|usage|cache/i.test(key))) ?? null;
};
function usageTotals(raw: any): TokenTotals | null {
  const usage = usageObject(raw);
  if (!usage) return null;
  const cacheCreation = usage.cache_creation && typeof usage.cache_creation === "object"
    ? tokenNumber(usage.cache_creation.ephemeral_5m_input_tokens) + tokenNumber(usage.cache_creation.ephemeral_1h_input_tokens)
    : 0;
  const totals = {
    input: tokenValue(usage, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "prompt_token_count", "promptTokenCount"]),
    output: tokenValue(usage, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "completion_token_count", "completionTokenCount"]),
    cacheRead: tokenValue(usage, ["cache_read_input_tokens", "cacheReadInputTokens", "cache_read_tokens", "cacheReadTokens"]),
    cacheWrite: tokenValue(usage, ["cache_creation_input_tokens", "cacheCreationInputTokens", "cache_write_input_tokens", "cacheWriteInputTokens", "cache_creation_tokens", "cacheCreationTokens"]) || cacheCreation,
  };
  return totals.input || totals.output || totals.cacheRead || totals.cacheWrite ? totals : null;
}
function jsonlTokenTotals(raws: any[]): TokenTotals {
  const snapshots = new Map<string, TokenTotals>();
  raws.forEach((raw, index) => {
    const totals = usageTotals(raw);
    if (!totals) return;
    const message = obj(raw.message), payload = obj(raw.payload);
    const key = String(message.id ?? payload.id ?? raw.id ?? `line:${index}`);
    const previous = snapshots.get(key);
    snapshots.set(key, previous ? {
      input: Math.max(previous.input, totals.input),
      output: Math.max(previous.output, totals.output),
      cacheRead: Math.max(previous.cacheRead, totals.cacheRead),
      cacheWrite: Math.max(previous.cacheWrite, totals.cacheWrite),
    } : totals);
  });
  return [...snapshots.values()].reduce((sum, totals) => ({
    input: sum.input + totals.input,
    output: sum.output + totals.output,
    cacheRead: sum.cacheRead + totals.cacheRead,
    cacheWrite: sum.cacheWrite + totals.cacheWrite,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}

export function walk(root: string, extensions: string[], out: string[], limit = 100_000) {
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

function buildSession(provider: string, raws: any[], ctx: { sessionId: string; project: string | null; path: string; sourceKey: string; fallbackTime: string; format: string; extraMeta?: Record<string, unknown> }): { session: Session; events: Event[] } {
  const tokenTotals = jsonlTokenTotals(raws);
  const events = raws.map((r, i) => eventFrom(r, ctx.sessionId, i, ctx.path, ctx.fallbackTime)).filter(Boolean) as Event[];
  const startedAt = events[0]?.timestamp ?? ctx.fallbackTime;
  const endedAt = events.at(-1)?.timestamp ?? startedAt;
  const models = raws.map(r => first(r.model, r?.message?.model, r?.payload?.model)).filter(Boolean);
  const title = events.find(e => e.kind === "prompt")?.text.slice(0, 120) ?? basename(ctx.path);
  const session = NormalizedSession.parse({
    id: ctx.sessionId, provider, model: models.at(-1) ?? null, project: ctx.project ?? null, title,
    startedAt, endedAt, sourcePath: ctx.path, sourceKey: ctx.sourceKey,
    tokenInput: tokenTotals.input, tokenOutput: tokenTotals.output, cacheRead: tokenTotals.cacheRead, cacheWrite: tokenTotals.cacheWrite,
    errorCount: events.filter(e => e.kind === "error").length, toolCount: events.filter(e => e.kind === "tool_call").length,
    metadata: { format: ctx.format, ...(ctx.extraMeta ?? {}) },
  });
  return { session, events };
}

// --- per-provider intake adapters ---

// JSONL transcript (Claude, Codex, and any provider that emits line-delimited JSON).
export function parseJsonl(provider: string, path: string, content: string): { session: Session; events: Event[] } | null {
  const fallbackTime = statSync(path).mtime.toISOString();
  const lines = content.split(/\r?\n/).filter(Boolean);
  const raws: any[] = [];
  for (const line of lines) { try { raws.push(JSON.parse(line)); } catch { /* caller records parse failures */ } }
  if (!raws.length) return null;
  const meta = raws.map(obj).find(r => r.session_id || r.sessionId || r.conversation_id || r.cwd || r.project || r.model) ?? {};
  const sourceKey = `${provider}:${path}`;
  const sessionId = String(meta.session_id ?? meta.sessionId ?? meta.conversation_id ?? id(sourceKey));
  const project = first(meta.cwd, meta.project, dirname(path).split("/").at(-1));
  return buildSession(provider, raws, { sessionId, project: project ?? null, path, sourceKey, fallbackTime, format: "jsonl" });
}

// Cline stores conversation history as a JSON array under
// `tasks/<taskId>/api_conversation_history.json` (and tool calls in
// `claude_api_calls.jsonl`). Each element is already a message-shaped object
// ({ role, content, usage }), so it maps directly onto the shared event builder.
// NOTE: validated structurally; no live Cline store was available at implementation
// time, so the field mapping is a best-effort match of the documented format.
export function parseCline(provider: string, path: string, content: string): { session: Session; events: Event[] } | null {
  let data: any; try { data = JSON.parse(content); } catch { return null; }
  const messages = Array.isArray(data) ? data : (data.messages ?? data.conversation ?? null);
  if (!Array.isArray(messages) || !messages.length) return null;
  const fallbackTime = statSync(path).mtime.toISOString();
  const sourceKey = `${provider}:${path}`;
  const sessionId = basename(dirname(path));
  const project = first(messages.find(m => m.cwd)?.cwd, messages.find(m => m.project)?.project) ?? null;
  return buildSession(provider, messages, { sessionId, project, path, sourceKey, fallbackTime, format: "cline-json" });
}

// Antigravity emits its real transcripts as JSONL at
// `brain/<conversationId>/.system_generated/logs/transcript.jsonl` — the
// `conversations/*.db` stores are protobuf and not parsed. Each step carries
// source/type/created_at/content, which we map onto the shared event builder.
export function parseAntigravity(provider: string, path: string, content: string): { session: Session; events: Event[] } | null {
  const fallbackTime = statSync(path).mtime.toISOString();
  const lines = content.split(/\r?\n/).filter(Boolean);
  const raws: any[] = [];
  for (const line of lines) { try { raws.push(JSON.parse(line)); } catch { /* skip malformed */ } }
  if (!raws.length) return null;
  const match = path.match(/brain\/([0-9a-fA-F-]{36})\//) ?? path.match(/([0-9a-fA-F-]{36})/);
  const sessionId = match ? match[1] : id(`${provider}:${path}`);
  const sourceKey = `${provider}:${path}`;
  const mapped = raws.map(step => {
    const role = step.source === "USER_EXPLICIT" ? "user"
      : step.source === "SYSTEM" || step.type === "CHECKPOINT" ? "system"
      : step.type && /tool/i.test(String(step.type)) ? "tool"
      : "assistant";
    return { ...step, role, timestamp: step.created_at, content: step.content ?? "" };
  });
  return buildSession(provider, mapped, { sessionId, project: null, path, sourceKey, fallbackTime, format: "antigravity-jsonl" });
}

// --- registry ---

export interface IntakeRoot {
  path: string;
  kinds: string[];
  // Optional path predicate so a root can target a specific file layout
  // (e.g. Antigravity's nested transcript.jsonl under brain/<id>/...).
  match?: (path: string) => boolean;
}

export interface ProviderIntake {
  id: string;
  name: string;
  roots?: IntakeRoot[];
  // File-based intake: parse a single transcript file into a session + events.
  parse?: (provider: string, path: string, content: string) => { session: Session; events: Event[] } | null;
  // Cursor-based intake for stores that are not flat files (e.g. OpenCode's sqlite).
  // Wired in indexer.ts after the sqlite indexer is defined.
  index?: () => void;
}

export const PROVIDERS: ProviderIntake[] = [
  { id: "claude", name: "Claude", roots: [{ path: `${home}/.claude/projects`, kinds: [".jsonl"] }], parse: parseJsonl },
  { id: "codex", name: "Codex", roots: [{ path: `${home}/.codex/sessions`, kinds: [".jsonl"] }], parse: parseJsonl },
  {
    id: "cline",
    name: "Cline",
    roots: [{
      path: `${home}/.local/share/cline`,
      kinds: [".json", ".jsonl"],
      match: p => /api_conversation_history\.json$/.test(p) || /claude_api_calls\.jsonl$/.test(p),
    }],
    parse: parseCline,
  },
  {
    id: "antigravity",
    name: "Antigravity",
    roots: [{
      path: `${home}/.gemini/antigravity-cli/brain`,
      kinds: [".jsonl"],
      match: p => /\.system_generated\/logs\/transcript\.jsonl$/.test(p),
    }],
    parse: parseAntigravity,
  },
  // OpenCode is indexed through its sqlite store, not file walking (see indexOpenCode).
  { id: "opencode", name: "OpenCode", roots: [{ path: `${home}/.local/share/opencode`, kinds: [".json", ".jsonl"] }] },
  // Fireworks is usage-collector only: no transcript store, so it stays metrics-only
  // and intentionally has no intake.
  { id: "fireworks", name: "Fireworks" },
];

export const isIndexed = (id: string) => PROVIDERS.some(p => p.id === id && (p.parse || p.index));
