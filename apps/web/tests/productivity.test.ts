import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FetchLike, ProductivityConfig } from "../src/server/productivity";

let subject: typeof import("../src/server/productivity");
beforeAll(async () => {
  process.env.OMARCHY_AGENTS_DB = join(tmpdir(), `omarchy-agents-test-${process.pid}.sqlite`);
  subject = await import("../src/server/productivity");
});

const NOW = new Date("2026-08-23T18:00:00Z");
const config = (overrides: Partial<ProductivityConfig> = {}): ProductivityConfig => ({
  githubOwner: "example",
  githubOwnerType: "user",
  githubRepos: [],
  linearApiKey: "linear-test-key",
  linearTeamIds: ["team-a"],
  timeZone: "America/Los_Angeles",
  ...overrides,
});
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), {
  status: init.status ?? 200,
  headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) },
});
const database = () => {
  const value = new Database(":memory:", { strict: true });
  value.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, token_input INTEGER NOT NULL DEFAULT 0, token_output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0)");
  subject.initializeProductivityTables(value);
  return value;
};

describe("GitHub synchronization adapter", () => {
  test("paginates commits, ignores private repositories, and deduplicates SHAs", async () => {
    const requested: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("/users/example/repos")) return json([
        { name: "alpha", full_name: "example/alpha", private: false },
        { name: "beta", full_name: "example/beta", private: false },
        { name: "secret", full_name: "example/secret", private: true },
      ]);
      if (url.includes("example/alpha/commits") && url.includes("page=1")) return json([
        { sha: "sha-1", html_url: "https://github.test/sha-1", commit: { committer: { date: "2026-08-22T10:00:00Z" } } },
        { sha: "shared", html_url: "https://github.test/shared", commit: { committer: { date: "2026-08-22T11:00:00Z" } } },
      ], { headers: { link: '<https://api.github.com/repos/example/alpha/commits?page=2>; rel="next"' } });
      if (url.includes("example/alpha/commits") && url.includes("page=2")) return json([
        { sha: "sha-2", html_url: "https://github.test/sha-2", commit: { committer: { date: "2026-08-23T10:00:00Z" } } },
      ]);
      if (url.includes("example/beta/commits")) return json([
        { sha: "shared", html_url: "https://github.test/shared", commit: { committer: { date: "2026-08-22T11:00:00Z" } } },
      ]);
      throw new Error(`Unexpected URL: ${url}`);
    };
    const commits = await subject.fetchGitHubCommits(config(), new Date("2026-08-01T00:00:00Z"), fetchImpl);
    expect(commits.map((commit) => commit.sha).sort()).toEqual(["sha-1", "sha-2", "shared"]);
    expect(requested.some((url) => url.includes("page=2"))).toBe(true);
    expect(requested.some((url) => url.includes("/secret/commits"))).toBe(false);
  });
});

describe("Linear synchronization adapter", () => {
  test("uses cursor pagination and keeps only completed tasks from configured teams", async () => {
    const bodies: any[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      if (!body.variables.after) return json({ data: { issues: {
        nodes: [
          { id: "issue-1", identifier: "ENG-1", title: "Ship", completedAt: "2026-08-22T10:00:00Z", url: "https://linear.test/ENG-1", team: { id: "team-a", name: "Engineering" } },
          { id: "issue-open", identifier: "ENG-2", title: "Open", completedAt: null, url: "", team: { id: "team-a", name: "Engineering" } },
          { id: "issue-old", identifier: "ENG-0", title: "Old", completedAt: "2026-07-01T11:00:00Z", url: "", team: { id: "team-a", name: "Engineering" } },
          { id: "issue-other", identifier: "OPS-1", title: "Other", completedAt: "2026-08-22T11:00:00Z", url: "", team: { id: "team-b", name: "Operations" } },
        ],
        pageInfo: { hasNextPage: true, endCursor: "next-page" },
      } } });
      return json({ data: { issues: {
        nodes: [{ id: "issue-2", identifier: "ENG-3", title: "Verify", completedAt: "2026-08-23T10:00:00Z", url: "https://linear.test/ENG-3", team: { id: "team-a", name: "Engineering" } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } });
    };
    const tasks = await subject.fetchLinearTasks(config(), new Date("2026-08-01T00:00:00Z"), fetchImpl);
    expect(tasks.map((task) => task.issueId)).toEqual(["issue-1", "issue-2"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].variables.after).toBe("next-page");
    expect(bodies[0].variables.filter.team.id.in).toEqual(["team-a"]);
  });
});

describe("daily productivity aggregation", () => {
  test("buckets canonical token totals by configured local day and computes descriptive ratios", () => {
    const value = database();
    value.query("INSERT INTO sessions VALUES (?,?,?,?,?,?)").run("late-22", "2026-08-23T06:30:00Z", 100, 20, 30, 50);
    value.query("INSERT INTO sessions VALUES (?,?,?,?,?,?)").run("early-23", "2026-08-23T07:30:00Z", 200, 40, 10, 0);
    value.query("INSERT INTO github_commits VALUES (?,?,?,?,?)").run("sha-1", "example/alpha", "2026-08-23T06:45:00Z", "https://github.test/sha-1", NOW.toISOString());
    value.query("INSERT INTO github_commits VALUES (?,?,?,?,?)").run("sha-2", "example/beta", "2026-08-23T07:45:00Z", "https://github.test/sha-2", NOW.toISOString());
    value.query("INSERT INTO linear_tasks VALUES (?,?,?,?,?,?,?,?)").run("issue-1", "ENG-1", "team-a", "Engineering", "Done", "2026-08-23T08:00:00Z", "https://linear.test/ENG-1", NOW.toISOString());
    const response = subject.productivityResponse({ database: value, config: config(), query: { from: "2026-08-22", to: "2026-08-23" }, now: NOW });
    expect(response.tokens.daily).toEqual([{ day: "2026-08-22", tokens: 200 }, { day: "2026-08-23", tokens: 250 }]);
    expect(response.commits.daily.map((row) => row.count)).toEqual([1, 1]);
    expect(response.tasks.daily.map((row) => row.count)).toEqual([0, 1]);
    expect(response.tokens.total).toBe(450);
    expect(response.ratios).toEqual({ tokensPerCommit: 225, tokensPerTask: 450 });
    expect(subject.descriptiveRatio(10, 0)).toBeNull();
    expect(subject.dayInTimeZone("2026-08-23T06:30:00Z", "America/Los_Angeles")).toBe("2026-08-22");
  });
});

describe("activity detail", () => {
  test("returns filtered cached commits and completed tasks without token attribution", () => {
    const value = database();
    value.query("INSERT INTO github_commits VALUES (?,?,?,?,?)").run("sha-1", "example/alpha", "2026-08-23T07:00:00Z", "https://github.test/sha-1", NOW.toISOString());
    value.query("INSERT INTO github_commits VALUES (?,?,?,?,?)").run("sha-2", "example/beta", "2026-08-23T08:00:00Z", "https://github.test/sha-2", NOW.toISOString());
    value.query("INSERT INTO linear_tasks VALUES (?,?,?,?,?,?,?,?)").run("issue-1", "ENG-1", "team-a", "Engineering", "Ship", "2026-08-23T09:00:00Z", "https://linear.test/ENG-1", NOW.toISOString());
    const response = subject.productivityActivity({ database: value, config: config(), query: { from: "2026-08-23", to: "2026-08-23", repo: "example/alpha", team: "Engineering" }, now: NOW });
    expect(response.commits.map((commit) => commit.sha)).toEqual(["sha-1"]);
    expect(response.tasks.map((task) => task.identifier)).toEqual(["ENG-1"]);
    expect("tokens" in response).toBe(false);
  });
});

describe("source reliability states", () => {
  let value: Database;
  beforeEach(() => { value = database(); });

  test("retains the last GitHub cache after a rate limit while Linear completes empty", async () => {
    value.query("INSERT INTO github_commits VALUES (?,?,?,?,?)").run("old-sha", "example/alpha", "2026-08-22T10:00:00Z", "https://github.test/old-sha", "2026-08-22T12:00:00Z");
    value.query("INSERT INTO productivity_sync_runs(source,started_at,finished_at,status,imported_count,coverage_from,coverage_to,error) VALUES (?,?,?,?,?,?,?,?)")
      .run("github", "2026-08-22T12:00:00Z", "2026-08-22T12:00:01Z", "success", 1, "2026-05-26", "2026-08-23", null);
    const fetchImpl: FetchLike = async (input) => String(input).includes("api.github.com")
      ? json({ message: "rate limit" }, { status: 429, headers: { "x-ratelimit-remaining": "0" } })
      : json({ data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    const result = await subject.runProductivitySync({ database: value, config: config(), fetchImpl, now: NOW });
    expect((value.query("SELECT COUNT(*) count FROM github_commits").get() as any).count).toBe(1);
    expect(result.sources.find((source) => source.id === "github")?.status).toBe("rate-limited");
    expect(result.sources.find((source) => source.id === "linear")?.status).toBe("empty");
  });

  test("distinguishes stale and unconfigured sources from zero activity", () => {
    value.query("INSERT INTO productivity_sync_runs(source,started_at,finished_at,status,imported_count,coverage_from,coverage_to,error) VALUES (?,?,?,?,?,?,?,?)")
      .run("github", "2026-08-20T10:00:00Z", "2026-08-20T10:01:00Z", "empty", 0, "2026-05-23", "2026-08-20", null);
    const states = subject.productivitySourceStates(value, config({ linearApiKey: null, linearTeamIds: [] }), NOW);
    expect(states.find((source) => source.id === "github")?.status).toBe("stale");
    const linear = states.find((source) => source.id === "linear");
    expect(linear?.status).toBe("unconfigured");
    expect(linear?.error).toContain("LINEAR_API_KEY");
  });
});
