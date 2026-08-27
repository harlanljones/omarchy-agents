import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let parseJsonl: typeof import("../src/server/indexer").parseJsonl;
let persist: typeof import("../src/server/indexer").persist;
let db: typeof import("../src/server/db").db;
beforeAll(async () => {
  process.env.OMARCHY_AGENTS_DB = join(tmpdir(), `omarchy-agents-test-${process.pid}.sqlite`);
  ({ parseJsonl, persist } = await import("../src/server/indexer"));
  ({ db } = await import("../src/server/db"));
});

describe("JSONL source adapter", () => {
  test("normalizes prompt, response, tool, malformed records, and credentials", () => {
    const dir=mkdtempSync(join(tmpdir(),"agent-index-test-")), path=join(dir,"session.jsonl");
    writeFileSync(path,[
      JSON.stringify({session_id:"s1",cwd:"/work/project",timestamp:"2026-08-22T10:00:00Z",role:"user",content:"use OPENAI_API_KEY=sk-live-abcdefghijklmnop"}),
      "malformed",
      JSON.stringify({session_id:"s1",timestamp:"2026-08-22T10:01:00Z",role:"assistant",content:"done",usage:{input_tokens:120,output_tokens:30,cache_read_input_tokens:40,cache_creation_input_tokens:10}}),
      JSON.stringify({session_id:"s1",timestamp:"2026-08-22T10:02:00Z",type:"tool_call",name:"read",content:{path:"a.ts"}})
    ].join("\n"));
    const result=parseJsonl("codex",path,readFile(path))!;
    expect(result.session.id).toBe("s1"); expect(result.events).toHaveLength(3);
    expect(result.session.tokenInput).toBe(120); expect(result.session.tokenOutput).toBe(30);
    expect(result.session.cacheRead).toBe(40); expect(result.session.cacheWrite).toBe(10);
    expect(result.events[0].text).not.toContain("sk-live"); expect(result.session.toolCount).toBe(1);
  });

  test("persists a normalized session and its events", () => {
    const dir=mkdtempSync(join(tmpdir(),"agent-index-persist-test-")), path=join(dir,"session.jsonl");
    writeFileSync(path, JSON.stringify({session_id:"persist-s1",cwd:"/work/project",timestamp:"2026-08-22T10:00:00Z",role:"user",content:"hello"}));
    const result=parseJsonl("codex",path,readFile(path))!;
    persist(result.session,result.events);
    expect((db.query("SELECT COUNT(*) count FROM sessions WHERE id=?").get("persist-s1") as any).count).toBe(1);
    expect((db.query("SELECT COUNT(*) count FROM events WHERE session_id=?").get("persist-s1") as any).count).toBe(1);
  });
});
function readFile(path:string){ return require("node:fs").readFileSync(path,"utf8") }
