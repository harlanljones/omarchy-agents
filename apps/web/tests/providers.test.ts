import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as providerModule from "../src/server/providers";

const { PROVIDERS, isIndexed, parseCline, parseAntigravity, parseCommandCode, parseJsonl } = providerModule;
describe("provider registry", () => {
  test("coverage is derived from the registry, not a hardcoded list", () => {
    expect(isIndexed("claude")).toBe(true);
    expect(isIndexed("codex")).toBe(true);
    expect(isIndexed("cline")).toBe(true);
    expect(isIndexed("antigravity")).toBe(true);
    expect(isIndexed("commandcode")).toBe(true);
    // OpenCode exposes a cursor-based indexer; simulate the wiring done in indexer.ts.
    PROVIDERS.find(p => p.id === "opencode")!.index = () => {};
    expect(isIndexed("opencode")).toBe(true);
    // Cursor, Hermes, and Pi are usage-collector only and stay metrics-only.
    expect(isIndexed("cursor")).toBe(false);
    expect(isIndexed("hermes")).toBe(false);
    expect(isIndexed("pi")).toBe(false);
  });

  test("every indexed provider declares an intake (parser or indexer)", () => {
    for (const p of PROVIDERS) {
      if (["cursor", "hermes", "pi"].includes(p.id)) continue;
      expect(p.parse || p.index).toBeTruthy();
    }
  });

  test("cline intake points at the live CLI store", () => {
    const cline = PROVIDERS.find(p => p.id === "cline")!;
    expect(cline.roots![0].path.endsWith(".cline/data/sessions")).toBe(true);
    const match = cline.roots![0].match!;
    expect(match("session.messages.json")).toBe(true);
    expect(match("session.json")).toBe(false);
    expect(match("1787278971450_cks8j.json")).toBe(false);
    expect(match(join("tasks", "abc", "api_conversation_history.json"))).toBe(false);
  });
});

describe("Cline CLI intake adapter", () => {
  test("maps a .messages.json session plus sibling metadata into a session + events", () => {
    const dir = mkdtempSync(join(tmpdir(), "cline-intake-"));
    const sessionDir = join(dir, "1787278971450_cks8j");
    mkdirSync(sessionDir, { recursive: true });
    const path = join(sessionDir, "1787278971450_cks8j.messages.json");
    writeFileSync(join(sessionDir, "1787278971450_cks8j.json"), JSON.stringify({
      sessionId: "1787278971450_cks8j", cwd: "/work/herdr-outpost",
      provider: "cline-pass", model: "cline-pass/kimi-k3",
    }));
    writeFileSync(path, JSON.stringify({
      sessionId: "1787278971450_cks8j",
      messages: [
        { id: "msg-1", role: "user", ts: 1787279046309, content: [{ type: "text", text: "write a function" }] },
        {
          id: "msg-2", role: "assistant", ts: 1787279051057,
          modelInfo: { id: "cline-pass/kimi-k3", provider: "cline-pass" },
          metrics: { inputTokens: 5894, outputTokens: 196, cacheReadTokens: 5893, cacheWriteTokens: 0, cost: 0.02 },
          content: [
            { type: "text", text: "here you go" },
            { type: "tool_use", id: "run_commands_0", name: "run_commands", input: { commands: ["true"] } },
          ],
        },
        { id: "msg-3", role: "user", ts: 1787279052000, content: [{ type: "tool_result", tool_use_id: "run_commands_0", name: "run_commands", content: "ok" }] },
      ],
    }));
    const result = parseCline("cline", path, readFileSync(path, "utf8"))!;
    expect(result).not.toBeNull();
    expect(result.session.id).toBe("1787278971450_cks8j");
    expect(result.session.project).toBe("/work/herdr-outpost");
    expect(result.session.model).toBe("cline-pass/kimi-k3");
    expect(result.events.map(e => e.kind)).toEqual(["prompt", "response", "tool_call", "tool_result"]);
    expect(result.session.tokenInput).toBe(5894);
    expect(result.session.tokenOutput).toBe(196);
    expect(result.session.cacheRead).toBe(5893);
    expect(result.session.toolCount).toBe(1);
  });

  test("returns null for non-message content", () => {
    expect(parseCline("cline", "/x/.cline/data/sessions/s/s.messages.json", "{ not messages }")).toBeNull();
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

describe("Command Code JSONL intake adapter", () => {
  test("maps session/message lines into usage, model, and project", () => {
    const dir = mkdtempSync(join(tmpdir(), "commandcode-intake-"));
    const sessionDir = join(dir, "projects", "home-harlan-dev-demo");
    mkdirSync(sessionDir, { recursive: true });
    const path = join(sessionDir, "session-1.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-09-16T10:00:00Z", cwd: "/work/demo" }),
      JSON.stringify({ type: "message", id: "m1", timestamp: "2026-09-16T10:01:00Z", model: "meta/muse-spark-1.3-contributor", message: { role: "user", content: [{ type: "text", text: "do the thing" }] } }),
      JSON.stringify({ type: "message", id: "m2", timestamp: "2026-09-16T10:02:00Z", model: "meta/muse-spark-1.3-contributor", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5 }, message: { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "/work/demo" } }] } }),
      JSON.stringify({ type: "message", id: "m3", timestamp: "2026-09-16T10:03:00Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: "file contents" }] }] } }),
    ].join("\n"));
    const result = parseCommandCode("commandcode", path, readFileSync(path, "utf8"))!;
    expect(result).not.toBeNull();
    expect(result.session.id).toBe("session-1");
    expect(result.session.project).toBe("/work/demo");
    expect(result.session.model).toBe("meta/muse-spark-1.3-contributor");
    expect(result.session.tokenInput).toBe(100);
    expect(result.session.tokenOutput).toBe(20);
    expect(result.session.cacheRead).toBe(40);
    expect(result.session.cacheWrite).toBe(5);
    expect(result.session.toolCount).toBe(1);
    expect(result.events.map(e => e.kind)).toEqual(["prompt", "tool_call", "tool_result"]);
  });

  test("counts one multi-block assistant message once", () => {
    const dir = mkdtempSync(join(tmpdir(), "commandcode-fanout-"));
    const sessionDir = join(dir, "projects", "proj");
    mkdirSync(sessionDir, { recursive: true });
    const path = join(sessionDir, "s.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-09-16T10:00:00Z", cwd: "/work" }),
      JSON.stringify({ type: "message", id: "m1", timestamp: "2026-09-16T10:01:00Z", model: "meta/muse-spark-1.3-contributor", usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0 }, message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read_file", input: {} }, { type: "tool_use", id: "b", name: "glob", input: {} }] } }),
    ].join("\n"));
    const result = parseCommandCode("commandcode", path, readFileSync(path, "utf8"))!;
    expect(result.session.tokenInput).toBe(50);
    expect(result.session.tokenOutput).toBe(10);
  });

  test("root match filter skips checkpoint sidecars", () => {
    const root = PROVIDERS.find(p => p.id === "commandcode")!.roots![0];
    expect(root.match!(join("projects", "proj", "s.jsonl"))).toBe(true);
    expect(root.match!(join("projects", "proj", "s.checkpoints.jsonl"))).toBe(false);
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
