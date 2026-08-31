import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as providerModule from "../src/server/providers";

const { PROVIDERS, isIndexed, parseCline, parseAntigravity, parseJsonl } = providerModule;

describe("provider registry", () => {
  test("coverage is derived from the registry, not a hardcoded list", () => {
    expect(isIndexed("claude")).toBe(true);
    expect(isIndexed("codex")).toBe(true);
    expect(isIndexed("cline")).toBe(true);
    expect(isIndexed("antigravity")).toBe(true);
    expect(isIndexed("evot")).toBe(true);
    // OpenCode exposes a cursor-based indexer; simulate the wiring done in indexer.ts.
    PROVIDERS.find(p => p.id === "opencode")!.index = () => {};
    expect(isIndexed("opencode")).toBe(true);
    // Fireworks is usage-collector only and stays metrics-only.
    expect(isIndexed("fireworks")).toBe(false);
  });

  test("every indexed provider declares an intake (parser or indexer)", () => {
    for (const p of PROVIDERS) {
      if (p.id === "fireworks") continue;
      expect(p.parse || p.index).toBeTruthy();
    }
  });
});

describe("Evot transcript intake adapter", () => {
  test("flattens batched transcript items and uses authoritative session metadata", () => {
    const parseEvot = (providerModule as Record<string, unknown>).parseEvot as typeof parseJsonl | undefined;
    expect(parseEvot).toBeFunction();
    const dir = mkdtempSync(join(tmpdir(), "evot-intake-"));
    const sessionDir = join(dir, "session-123");
    mkdirSync(sessionDir, { recursive: true });
    const path = join(sessionDir, "transcript.jsonl");
    writeFileSync(join(sessionDir, "session.json"), JSON.stringify({
      session_id: "session-123",
      cwd: "/work/evot-project",
      title: "Fix the deployment",
      model: "gpt-5.6-luna",
      provider: "evot-free",
      created_at: "2026-08-28T10:00:00Z",
      updated_at: "2026-08-28T10:05:00Z",
      total_input_tokens: 1200,
      total_output_tokens: 300,
      context_tokens: 900,
      context_budget: 1000000,
    }));
    writeFileSync(path, [
      JSON.stringify([
        { session_id: "session-123", seq: 1, item: { type: "user", text: "fix it" } },
        { session_id: "session-123", seq: 2, item: { type: "assistant", timestamp: "2026-08-28T10:01:00Z", content: [
          { type: "text", text: "working" },
          { type: "tool_call", id: "call-1", name: "bash", input: { cmd: "true" } },
        ] } },
        { session_id: "session-123", seq: 3, item: { type: "tool_result", tool_call_id: "call-1", tool_name: "bash", content: "ok", is_error: false } },
        { session_id: "session-123", seq: 4, item: { type: "stats", kind: "llm_call_completed", data: { usage: { input_tokens: 99, output_tokens: 10 } } } },
      ]),
    ].join("\n"));

    const result = parseEvot!("evot", path, readFileSync(path, "utf8"))!;
    expect(result.session.id).toBe("session-123");
    expect(result.session.project).toBe("/work/evot-project");
    expect(result.session.title).toBe("Fix the deployment");
    expect(result.session.model).toBe("gpt-5.6-luna");
    expect(result.session.tokenInput).toBe(1200);
    expect(result.session.tokenOutput).toBe(300);
    expect(result.session.toolCount).toBe(1);
    expect(result.events.map(event => event.kind)).toEqual(["prompt", "response", "tool_call", "tool_result"]);
    expect(result.events.find(event => event.kind === "tool_call")?.toolName).toBe("bash");
    expect(result.session.metadata).toMatchObject({ format: "evot-jsonl", evotProvider: "evot-free", contextTokens: 900, contextBudget: 1000000 });
  });

  test("falls back to per-turn usage when an interrupted session leaves zero aggregates", () => {
    const dir = mkdtempSync(join(tmpdir(), "evot-zero-aggregate-"));
    const sessionDir = join(dir, "session-zero");
    mkdirSync(sessionDir, { recursive: true });
    const path = join(sessionDir, "transcript.jsonl");
    writeFileSync(join(sessionDir, "session.json"), JSON.stringify({
      session_id: "session-zero",
      cwd: "/work/interrupted",
      model: "gpt-5.6-luna",
      total_input_tokens: 0,
      total_output_tokens: 0,
    }));
    writeFileSync(path, JSON.stringify([
      { session_id: "session-zero", seq: 1, item: { type: "assistant", content: [{ type: "text", text: "partial" }], usage: { input: 90, output: 10, cache_read: 5, cache_write: 2 } } },
    ]));

    const parseEvot = (providerModule as Record<string, unknown>).parseEvot as typeof parseJsonl;
    const result = parseEvot("evot", path, readFileSync(path, "utf8"))!;
    expect(result.session.tokenInput).toBe(90);
    expect(result.session.tokenOutput).toBe(10);
    expect(result.session.cacheRead).toBe(5);
    expect(result.session.cacheWrite).toBe(2);
  });
});

describe("Cline JSON intake adapter", () => {
  test("maps a conversation history array into a session + events", () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-intake-"));
    const taskDir = join(dir, "task-abc-123");
    mkdirSync(join(taskDir, "nested"), { recursive: true });
    const path = join(taskDir, "api_conversation_history.json");
    writeFileSync(path, JSON.stringify([
      { role: "user", content: "write a function" },
      { role: "assistant", content: "here you go", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 } },
      { role: "tool", content: "ran command", tool_name: "bash" },
    ]));
    const result = parseCline("cline", path, readFileSync(path, "utf8"))!;
    expect(result).not.toBeNull();
    expect(result.session.id).toBe("task-abc-123");
    expect(result.events).toHaveLength(3);
    expect(result.events.map(e => e.kind)).toEqual(["prompt", "response", "tool_call"]);
    expect(result.session.tokenInput).toBe(10);
    expect(result.session.tokenOutput).toBe(5);
    expect(result.session.cacheRead).toBe(2);
    expect(result.session.toolCount).toBe(1);
  });

  test("returns null for non-array content", () => {
    expect(parseCline("cline", "/x/cline/tasks/t/api_conversation_history.json", "{ not an array }")).toBeNull();
  });
});

describe("Antigravity JSONL intake adapter", () => {
  test("maps a transcript.jsonl into a session keyed by conversation id", () => {
    const dir = mkdtempSync(join(tmpdir(), "antigravity-intake-"));
    const cid = "9a0776da-8468-402e-97ba-25a1f61f1eb3";
    const logDir = join(dir, "brain", cid, ".system_generated", "logs");
    mkdirSync(logDir, { recursive: true });
    const path = join(logDir, "transcript.jsonl");
    writeFileSync(path, [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-08-19T20:38:06Z", content: "do the thing" }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-08-19T20:39:00Z", content: "planning it" }),
      JSON.stringify({ step_index: 2, source: "SYSTEM", type: "CHECKPOINT", status: "DONE", created_at: "2026-08-19T20:40:00Z", content: "checkpoint" }),
    ].join("\n"));
    const result = parseAntigravity("antigravity", path, readFileSync(path, "utf8"))!;
    expect(result).not.toBeNull();
    expect(result.session.id).toBe(cid);
    expect(result.events.map(e => e.kind)).toEqual(["prompt", "response", "system"]);
    expect(result.session.tokenInput).toBe(0);
  });

  test("root match filter targets transcript.jsonl and excludes chunks", () => {
    const dir = mkdtempSync(join(tmpdir(), "antigravity-match-"));
    const cid = "11111111-2222-3333-4444-555555555555";
    const logs = join(dir, "brain", cid, ".system_generated", "logs");
    const chunks = join(logs, "chunks", "transcript");
    mkdirSync(chunks, { recursive: true });
    writeFileSync(join(logs, "transcript.jsonl"), "x");
    writeFileSync(join(chunks, "transcript.jsonl"), "x");
    const root = PROVIDERS.find(p => p.id === "antigravity")!.roots![0];
    expect(root.match!(join(logs, "transcript.jsonl"))).toBe(true);
    expect(root.match!(join(chunks, "transcript.jsonl"))).toBe(false);
  });
});

describe("regression: JSONL adapter still normalizes", () => {
  test("parseJsonl keeps redaction and tool counting", () => {
    const dir = mkdtempSync(join(tmpdir(), "jsonl-reg-"));
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [
      JSON.stringify({ session_id: "s1", cwd: "/work", timestamp: "2026-08-22T10:00:00Z", role: "user", content: "use OPENAI_API_KEY=sk-live-secret" }),
      "malformed",
      JSON.stringify({ session_id: "s1", timestamp: "2026-08-22T10:01:00Z", role: "assistant", content: "done", usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } }),
    ].join("\n"));
    const result = parseJsonl("codex", path, readFileSync(path, "utf8"))!;
    expect(result.session.id).toBe("s1");
    expect(result.events).toHaveLength(2);
    expect(result.events[0].text).not.toContain("sk-live");
    expect(result.session.tokenInput).toBe(120);
  });
});
