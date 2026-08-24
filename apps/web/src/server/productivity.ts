import type { Database } from "bun:sqlite";
import { db } from "./db";
import type { ProductivityActivityResponse, ProductivityResponse, ProductivitySourceState } from "../shared/schemas";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ProductivityConfig = {
  githubOwner: string | null;
  githubOwnerType: "user" | "org" | null;
  githubRepos: string[];
  linearApiKey: string | null;
  linearTeamIds: string[];
  timeZone: string;
};
type GitHubCommit = { sha: string; repository: string; committedAt: string; url: string };
type LinearTask = { issueId: string; identifier: string; teamId: string; team: string; title: string; completedAt: string; url: string };
type SyncSource = "github" | "linear";
type SyncStatus = "success" | "empty" | "error" | "rate-limited";
type SyncRunRow = {
  source: SyncSource;
  finished_at: string;
  status: SyncStatus;
  imported_count: number;
  coverage_from: string | null;
  coverage_to: string | null;
  error: string | null;
};

const DAY_MS = 86_400_000;
const SYNC_DAYS = 90;
const STALE_AFTER_MS = 24 * 60 * 60_000;
const BACKGROUND_SYNC_MS = 6 * 60 * 60_000;
const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "omarchy-agents-productivity",
  "x-github-api-version": "2022-11-28",
};

export class SourceRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRateLimitError";
  }
}

const commaList = (value: string | undefined) =>
  [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];

export function productivityConfig(env = process.env): ProductivityConfig {
  const ownerType = env.PRODUCTIVITY_GITHUB_OWNER_TYPE?.trim().toLowerCase();
  const requestedTimeZone = env.PRODUCTIVITY_TIME_ZONE?.trim() || "America/Los_Angeles";
  let timeZone = requestedTimeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    timeZone = "America/Los_Angeles";
  }
  return {
    githubOwner: env.PRODUCTIVITY_GITHUB_OWNER?.trim() || null,
    githubOwnerType: ownerType === "user" || ownerType === "org" ? ownerType : null,
    githubRepos: commaList(env.PRODUCTIVITY_GITHUB_REPOS),
    linearApiKey: env.LINEAR_API_KEY?.trim() || null,
    linearTeamIds: commaList(env.PRODUCTIVITY_LINEAR_TEAM_IDS),
    timeZone,
  };
}

function configurationError(source: SyncSource, config: ProductivityConfig): string | null {
  if (source === "github") {
    const missing = [
      !config.githubOwner ? "PRODUCTIVITY_GITHUB_OWNER" : null,
      !config.githubOwnerType ? "PRODUCTIVITY_GITHUB_OWNER_TYPE" : null,
    ].filter(Boolean);
    if (!missing.length) return null;
    const additional = !config.githubOwnerType ? " (set to 'user' or 'org')" : "";
    return `Set ${missing.join(" and ")}${additional} to enable GitHub synchronization.`;
  }
  const missing = [
    !config.linearApiKey ? "LINEAR_API_KEY" : null,
    !config.linearTeamIds.length ? "PRODUCTIVITY_LINEAR_TEAM_IDS" : null,
  ].filter(Boolean);
  return missing.length ? `Set ${missing.join(" and ")} to enable Linear synchronization.` : null;
}

export function dayInTimeZone(value: string | number | Date, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error("Invalid timestamp");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function shiftDay(day: string, amount: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error("Dates must use YYYY-MM-DD.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function validDay(day: string) {
  try {
    return shiftDay(day, 0) === day;
  } catch {
    return false;
  }
}

export function resolveProductivityRange(
  query: { from?: string; to?: string },
  timeZone: string,
  now = new Date(),
) {
  const to = query.to || dayInTimeZone(now, timeZone);
  const from = query.from || shiftDay(to, -29);
  if (!validDay(from) || !validDay(to)) throw new Error("from and to must be valid YYYY-MM-DD dates.");
  const count = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  if (count < 1) throw new Error("from must be on or before to.");
  if (count > SYNC_DAYS) throw new Error("Date ranges may include at most 90 days.");
  return { from, to, timeZone };
}

export function daysInRange(from: string, to: string) {
  const count = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  return Array.from({ length: count }, (_, index) => shiftDay(from, index));
}

export const descriptiveRatio = (tokens: number, activity: number) => activity > 0 ? tokens / activity : null;

function nextLink(value: string | null) {
  if (!value) return null;
  for (const part of value.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return null;
}

async function jsonResponse<T>(response: Response, source: SyncSource): Promise<T> {
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    const reset = response.headers.get("x-ratelimit-reset");
    const suffix = reset ? ` Retry after ${new Date(Number(reset) * 1000).toISOString()}.` : "";
    throw new SourceRateLimitError(`${source === "github" ? "GitHub" : "Linear"} rate limit reached.${suffix}`);
  }
  const payload = await response.json().catch(() => null) as T | null;
  if (!response.ok) throw new Error(`${source === "github" ? "GitHub" : "Linear"} request failed (${response.status}).`);
  if (payload == null) throw new Error(`${source === "github" ? "GitHub" : "Linear"} returned invalid JSON.`);
  return payload;
}

async function githubRepositories(config: ProductivityConfig, fetchImpl: FetchLike) {
  const owner = config.githubOwner!;
  const base = config.githubOwnerType === "org"
    ? `https://api.github.com/orgs/${encodeURIComponent(owner)}/repos?type=all&sort=updated&per_page=100&page=1`
    : `https://api.github.com/users/${encodeURIComponent(owner)}/repos?type=owner&sort=updated&per_page=100&page=1`;
  let url: string | null = base;
  let pageNumber = 1;
  const repositories: Array<{ name: string; full_name: string; private: boolean }> = [];
  while (url) {
    const response = await fetchImpl(url, { headers: GITHUB_HEADERS });
    const page = await jsonResponse<unknown>(response, "github");
    if (!Array.isArray(page)) throw new Error("GitHub repository response was not a list.");
    for (const raw of page) {
      const item = raw as Record<string, unknown>;
      if (item.private === false && typeof item.name === "string" && typeof item.full_name === "string") {
        repositories.push({ name: item.name, full_name: item.full_name, private: false });
      }
    }
    const linked = nextLink(response.headers.get("link"));
    pageNumber += 1;
    url = linked ?? (page.length === 100 ? base.replace(/page=\d+/, `page=${pageNumber}`) : null);
  }
  if (!config.githubRepos.length) return repositories;
  const allow = new Set(config.githubRepos.map((item) => item.toLowerCase()));
  const selected = repositories.filter((repo) => allow.has(repo.name.toLowerCase()) || allow.has(repo.full_name.toLowerCase()));
  const found = new Set(selected.flatMap((repo) => [repo.name.toLowerCase(), repo.full_name.toLowerCase()]));
  const missing = config.githubRepos.filter((item) => !found.has(item.toLowerCase()));
  if (missing.length) throw new Error(`Configured GitHub repositories were not found or are not public: ${missing.join(", ")}.`);
  return selected;
}

export async function fetchGitHubCommits(
  config: ProductivityConfig,
  since: Date,
  fetchImpl: FetchLike = fetch,
): Promise<GitHubCommit[]> {
  const repositories = await githubRepositories(config, fetchImpl);
  const unique = new Map<string, GitHubCommit>();
  for (const repository of repositories) {
    const base = `https://api.github.com/repos/${repository.full_name}/commits?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(new Date().toISOString())}&per_page=100&page=1`;
    let url: string | null = base;
    let pageNumber = 1;
    while (url) {
      const response = await fetchImpl(url, { headers: GITHUB_HEADERS });
      const page = await jsonResponse<unknown>(response, "github");
      if (!Array.isArray(page)) throw new Error("GitHub commits response was not a list.");
      for (const raw of page) {
        const item = raw as any;
        const committedAt = item?.commit?.committer?.date;
        if (typeof item?.sha !== "string" || typeof committedAt !== "string" || !Number.isFinite(Date.parse(committedAt)) || Date.parse(committedAt) < since.valueOf()) continue;
        unique.set(item.sha, {
          sha: item.sha,
          repository: repository.full_name,
          committedAt,
          url: typeof item.html_url === "string" ? item.html_url : `https://github.com/${repository.full_name}/commit/${item.sha}`,
        });
      }
      const linked = nextLink(response.headers.get("link"));
      pageNumber += 1;
      url = linked ?? (page.length === 100 ? base.replace(/page=\d+/, `page=${pageNumber}`) : null);
    }
  }
  return [...unique.values()];
}

const LINEAR_QUERY = `query CompletedIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes { id identifier title completedAt url team { id name } }
    pageInfo { hasNextPage endCursor }
  }
}`;

export async function fetchLinearTasks(
  config: ProductivityConfig,
  since: Date,
  fetchImpl: FetchLike = fetch,
): Promise<LinearTask[]> {
  let after: string | null = null;
  const tasks = new Map<string, LinearTask>();
  do {
    const response = await fetchImpl("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: config.linearApiKey!, "content-type": "application/json" },
      body: JSON.stringify({
        query: LINEAR_QUERY,
        variables: {
          first: 50,
          after,
          filter: {
            completedAt: { gte: since.toISOString() },
            team: { id: { in: config.linearTeamIds } },
          },
        },
      }),
    });
    const payload = await jsonResponse<any>(response, "linear");
    if (Array.isArray(payload.errors) && payload.errors.length) {
      const message = payload.errors.map((error: any) => String(error?.message ?? "Unknown GraphQL error")).join("; ");
      if (/rate.?limit/i.test(message)) throw new SourceRateLimitError("Linear rate limit reached.");
      throw new Error(`Linear GraphQL error: ${message}`);
    }
    const connection = payload?.data?.issues;
    if (!connection || !Array.isArray(connection.nodes)) throw new Error("Linear issues response was incomplete.");
    for (const raw of connection.nodes) {
      if (!raw?.completedAt || !raw?.team?.id || !config.linearTeamIds.includes(String(raw.team.id))) continue;
      if (!Number.isFinite(Date.parse(raw.completedAt)) || Date.parse(raw.completedAt) < since.valueOf()) continue;
      tasks.set(String(raw.id), {
        issueId: String(raw.id),
        identifier: String(raw.identifier ?? ""),
        teamId: String(raw.team.id),
        team: String(raw.team.name ?? raw.team.id),
        title: String(raw.title ?? "Untitled task"),
        completedAt: String(raw.completedAt),
        url: typeof raw.url === "string" ? raw.url : "",
      });
    }
    after = connection.pageInfo?.hasNextPage && connection.pageInfo?.endCursor
      ? String(connection.pageInfo.endCursor)
      : null;
  } while (after);
  return [...tasks.values()];
}

export function initializeProductivityTables(database: Database = db) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS github_commits (sha TEXT PRIMARY KEY, repository TEXT NOT NULL, commit_date TEXT NOT NULL, url TEXT NOT NULL, imported_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS github_commits_date ON github_commits(commit_date DESC);
    CREATE INDEX IF NOT EXISTS github_commits_repository ON github_commits(repository, commit_date DESC);
    CREATE TABLE IF NOT EXISTS linear_tasks (issue_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, team_id TEXT NOT NULL, team TEXT NOT NULL, title TEXT NOT NULL, completion_date TEXT NOT NULL, url TEXT NOT NULL, imported_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS linear_tasks_date ON linear_tasks(completion_date DESC);
    CREATE INDEX IF NOT EXISTS linear_tasks_team ON linear_tasks(team_id, completion_date DESC);
    CREATE TABLE IF NOT EXISTS productivity_sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, status TEXT NOT NULL, imported_count INTEGER NOT NULL DEFAULT 0, coverage_from TEXT, coverage_to TEXT, error TEXT);
    CREATE INDEX IF NOT EXISTS productivity_sync_runs_source ON productivity_sync_runs(source, id DESC);
  `);
}

initializeProductivityTables();

function recordSyncRun(
  database: Database,
  source: SyncSource,
  startedAt: string,
  finishedAt: string,
  status: SyncStatus,
  count: number,
  coverage: { from: string; to: string },
  error: string | null,
) {
  database.query("INSERT INTO productivity_sync_runs(source,started_at,finished_at,status,imported_count,coverage_from,coverage_to,error) VALUES (?,?,?,?,?,?,?,?)")
    .run(source, startedAt, finishedAt, status, count, coverage.from, coverage.to, error);
}

async function syncGitHub(
  database: Database,
  config: ProductivityConfig,
  fetchImpl: FetchLike,
  since: Date,
  coverage: { from: string; to: string },
  now: Date,
) {
  const startedAt = now.toISOString();
  try {
    const commits = await fetchGitHubCommits(config, since, fetchImpl);
    const importedAt = new Date().toISOString();
    database.transaction(() => {
      database.query("DELETE FROM github_commits WHERE commit_date >= ?").run(since.toISOString());
      const insert = database.query("INSERT INTO github_commits(sha,repository,commit_date,url,imported_at) VALUES (?,?,?,?,?) ON CONFLICT(sha) DO UPDATE SET repository=excluded.repository,commit_date=excluded.commit_date,url=excluded.url,imported_at=excluded.imported_at");
      for (const commit of commits) insert.run(commit.sha, commit.repository, commit.committedAt, commit.url, importedAt);
      recordSyncRun(database, "github", startedAt, importedAt, commits.length ? "success" : "empty", commits.length, coverage, null);
    })();
  } catch (error) {
    const finishedAt = new Date().toISOString();
    recordSyncRun(database, "github", startedAt, finishedAt, error instanceof SourceRateLimitError ? "rate-limited" : "error", 0, coverage, error instanceof Error ? error.message : String(error));
  }
}

async function syncLinear(
  database: Database,
  config: ProductivityConfig,
  fetchImpl: FetchLike,
  since: Date,
  coverage: { from: string; to: string },
  now: Date,
) {
  const startedAt = now.toISOString();
  try {
    const tasks = await fetchLinearTasks(config, since, fetchImpl);
    const importedAt = new Date().toISOString();
    database.transaction(() => {
      database.query("DELETE FROM linear_tasks WHERE completion_date >= ?").run(since.toISOString());
      const insert = database.query("INSERT INTO linear_tasks(issue_id,identifier,team_id,team,title,completion_date,url,imported_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(issue_id) DO UPDATE SET identifier=excluded.identifier,team_id=excluded.team_id,team=excluded.team,title=excluded.title,completion_date=excluded.completion_date,url=excluded.url,imported_at=excluded.imported_at");
      for (const task of tasks) insert.run(task.issueId, task.identifier, task.teamId, task.team, task.title, task.completedAt, task.url, importedAt);
      recordSyncRun(database, "linear", startedAt, importedAt, tasks.length ? "success" : "empty", tasks.length, coverage, null);
    })();
  } catch (error) {
    const finishedAt = new Date().toISOString();
    recordSyncRun(database, "linear", startedAt, finishedAt, error instanceof SourceRateLimitError ? "rate-limited" : "error", 0, coverage, error instanceof Error ? error.message : String(error));
  }
}

export async function runProductivitySync(options: {
  database?: Database;
  config?: ProductivityConfig;
  fetchImpl?: FetchLike;
  now?: Date;
} = {}) {
  const database = options.database ?? db;
  const config = options.config ?? productivityConfig();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  initializeProductivityTables(database);
  const coverage = { to: dayInTimeZone(now, config.timeZone), from: shiftDay(dayInTimeZone(now, config.timeZone), -(SYNC_DAYS - 1)) };
  const since = new Date(now.valueOf() - (SYNC_DAYS + 1) * DAY_MS);
  const jobs: Promise<void>[] = [];
  if (!configurationError("github", config)) jobs.push(syncGitHub(database, config, fetchImpl, since, coverage, now));
  if (!configurationError("linear", config)) jobs.push(syncLinear(database, config, fetchImpl, since, coverage, now));
  await Promise.all(jobs);
  return { syncedAt: new Date().toISOString(), sources: productivitySourceStates(database, config, now) };
}

function countForSource(database: Database, source: SyncSource) {
  const table = source === "github" ? "github_commits" : "linear_tasks";
  return Number((database.query(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count);
}

export function productivitySourceStates(
  database: Database = db,
  config: ProductivityConfig = productivityConfig(),
  now = new Date(),
): ProductivitySourceState[] {
  return (["github", "linear"] as const).map((source) => {
    const configError = configurationError(source, config);
    const latest = database.query("SELECT source,finished_at,status,imported_count,coverage_from,coverage_to,error FROM productivity_sync_runs WHERE source=? ORDER BY id DESC LIMIT 1").get(source) as SyncRunRow | null;
    const successful = database.query("SELECT source,finished_at,status,imported_count,coverage_from,coverage_to,error FROM productivity_sync_runs WHERE source=? AND status IN ('success','empty') ORDER BY id DESC LIMIT 1").get(source) as SyncRunRow | null;
    let status: ProductivitySourceState["status"];
    let error: string | null = null;
    if (configError) {
      status = "unconfigured";
      error = configError;
    } else if (!latest) {
      status = "stale";
      error = "This source has not completed its first synchronization.";
    } else if (latest.status === "rate-limited") {
      status = "rate-limited";
      error = latest.error;
    } else if (latest.status === "error") {
      status = successful ? "stale" : "error";
      error = latest.error;
    } else if (now.valueOf() - Date.parse(latest.finished_at) > STALE_AFTER_MS) {
      status = "stale";
      error = "Cached data is older than 24 hours.";
    } else {
      status = latest.status === "empty" ? "empty" : "fresh";
    }
    const coverageRow = successful ?? latest;
    return {
      id: source,
      name: source === "github" ? "GitHub public commits" : "Linear completed tasks",
      status,
      lastSyncedAt: successful?.finished_at ?? null,
      error,
      recordCount: countForSource(database, source),
      coverage: coverageRow?.coverage_from && coverageRow.coverage_to
        ? { from: coverageRow.coverage_from, to: coverageRow.coverage_to }
        : null,
    };
  });
}

function rowsInRange<T extends { day: string }>(rows: T[], from: string, to: string) {
  return rows.filter((row) => row.day >= from && row.day <= to);
}

export function productivityResponse(options: {
  database?: Database;
  config?: ProductivityConfig;
  query?: { from?: string; to?: string; repo?: string; team?: string };
  now?: Date;
} = {}): ProductivityResponse {
  const database = options.database ?? db;
  const config = options.config ?? productivityConfig();
  const now = options.now ?? new Date();
  const query = options.query ?? {};
  const range = resolveProductivityRange(query, config.timeZone, now);
  const days = daysInRange(range.from, range.to);
  const approxSince = new Date(Date.parse(`${range.from}T00:00:00Z`) - DAY_MS).toISOString();
  const approxUntil = new Date(Date.parse(`${range.to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  const tokenRows = rowsInRange(
    (database.query("SELECT started_at, token_input+token_output+cache_read+cache_write tokens FROM sessions WHERE started_at>=? AND started_at<?").all(approxSince, approxUntil) as Array<{ started_at: string; tokens: number }>)
      .map((row) => ({ day: dayInTimeZone(row.started_at, config.timeZone), tokens: Number(row.tokens) })),
    range.from,
    range.to,
  );
  const allCommits = rowsInRange(
    (database.query("SELECT repository,commit_date FROM github_commits WHERE commit_date>=? AND commit_date<?").all(approxSince, approxUntil) as Array<{ repository: string; commit_date: string }>)
      .map((row) => ({ day: dayInTimeZone(row.commit_date, config.timeZone), repository: row.repository })),
    range.from,
    range.to,
  );
  const allTasks = rowsInRange(
    (database.query("SELECT team_id,team,completion_date FROM linear_tasks WHERE completion_date>=? AND completion_date<?").all(approxSince, approxUntil) as Array<{ team_id: string; team: string; completion_date: string }>)
      .map((row) => ({ day: dayInTimeZone(row.completion_date, config.timeZone), teamId: row.team_id, team: row.team })),
    range.from,
    range.to,
  );
  const repo = query.repo?.trim() || null;
  const team = query.team?.trim() || null;
  const commits = repo ? allCommits.filter((row) => row.repository.toLowerCase() === repo.toLowerCase()) : allCommits;
  const tasks = team ? allTasks.filter((row) => row.teamId === team || row.team.toLowerCase() === team.toLowerCase()) : allTasks;
  const tokenByDay = new Map<string, number>(), commitByDay = new Map<string, number>(), taskByDay = new Map<string, number>();
  for (const row of tokenRows) tokenByDay.set(row.day, (tokenByDay.get(row.day) ?? 0) + row.tokens);
  for (const row of commits) commitByDay.set(row.day, (commitByDay.get(row.day) ?? 0) + 1);
  for (const row of tasks) taskByDay.set(row.day, (taskByDay.get(row.day) ?? 0) + 1);
  const repoCounts = new Map<string, number>(), teamCounts = new Map<string, { id: string; team: string; count: number }>();
  for (const row of allCommits) repoCounts.set(row.repository, (repoCounts.get(row.repository) ?? 0) + 1);
  for (const row of allTasks) {
    const current = teamCounts.get(row.teamId) ?? { id: row.teamId, team: row.team, count: 0 };
    current.count += 1;
    teamCounts.set(row.teamId, current);
  }
  const tokenTotal = [...tokenByDay.values()].reduce((sum, value) => sum + value, 0);
  return {
    range,
    generatedAt: now.toISOString(),
    tokens: { total: tokenTotal, daily: days.map((day) => ({ day, tokens: tokenByDay.get(day) ?? 0 })) },
    commits: {
      total: commits.length,
      daily: days.map((day) => ({ day, count: commitByDay.get(day) ?? 0 })),
      repos: [...repoCounts].map(([repository, count]) => ({ repository, count })).sort((a, b) => b.count - a.count || a.repository.localeCompare(b.repository)),
    },
    tasks: {
      total: tasks.length,
      daily: days.map((day) => ({ day, count: taskByDay.get(day) ?? 0 })),
      teams: [...teamCounts.values()].sort((a, b) => b.count - a.count || a.team.localeCompare(b.team)),
    },
    ratios: { tokensPerCommit: descriptiveRatio(tokenTotal, commits.length), tokensPerTask: descriptiveRatio(tokenTotal, tasks.length) },
    filters: { repo, team },
    sources: productivitySourceStates(database, config, now),
  };
}

export function productivityActivity(options: {
  database?: Database;
  config?: ProductivityConfig;
  query?: { from?: string; to?: string; repo?: string; team?: string };
  now?: Date;
} = {}): ProductivityActivityResponse {
  const database = options.database ?? db;
  const config = options.config ?? productivityConfig();
  const now = options.now ?? new Date();
  const query = options.query ?? {};
  const range = resolveProductivityRange(query, config.timeZone, now);
  const approxSince = new Date(Date.parse(`${range.from}T00:00:00Z`) - DAY_MS).toISOString();
  const approxUntil = new Date(Date.parse(`${range.to}T00:00:00Z`) + 2 * DAY_MS).toISOString();
  const repo = query.repo?.trim() || null;
  const team = query.team?.trim() || null;
  const commits = (database.query("SELECT sha,repository,commit_date, url FROM github_commits WHERE commit_date>=? AND commit_date<? ORDER BY commit_date DESC LIMIT 500").all(approxSince, approxUntil) as Array<{ sha: string; repository: string; commit_date: string; url: string }>)
    .filter((row) => dayInTimeZone(row.commit_date, config.timeZone) >= range.from && dayInTimeZone(row.commit_date, config.timeZone) <= range.to)
    .filter((row) => !repo || row.repository.toLowerCase() === repo.toLowerCase())
    .map((row) => ({ sha: row.sha, repository: row.repository, committedAt: row.commit_date, url: row.url }));
  const tasks = (database.query("SELECT issue_id,identifier,team_id,team,title,completion_date,url FROM linear_tasks WHERE completion_date>=? AND completion_date<? ORDER BY completion_date DESC LIMIT 500").all(approxSince, approxUntil) as Array<{ issue_id: string; identifier: string; team_id: string; team: string; title: string; completion_date: string; url: string }>)
    .filter((row) => dayInTimeZone(row.completion_date, config.timeZone) >= range.from && dayInTimeZone(row.completion_date, config.timeZone) <= range.to)
    .filter((row) => !team || row.team_id === team || row.team.toLowerCase() === team.toLowerCase())
    .map((row) => ({ issueId: row.issue_id, identifier: row.identifier, teamId: row.team_id, team: row.team, title: row.title, completedAt: row.completion_date, url: row.url }));
  return { range, generatedAt: now.toISOString(), filters: { repo, team }, commits, tasks };
}

let activeSync: Promise<Awaited<ReturnType<typeof runProductivitySync>>> | null = null;
export function syncProductivitySources() {
  if (!activeSync) activeSync = runProductivitySync().finally(() => { activeSync = null; });
  return activeSync;
}

let backgroundTimer: ReturnType<typeof setInterval> | null = null;
export function startProductivitySync() {
  if (backgroundTimer) return;
  const configured = () => {
    const config = productivityConfig();
    return !configurationError("github", config) || !configurationError("linear", config);
  };
  const refreshIfNeeded = () => {
    const config = productivityConfig();
    const states = productivitySourceStates(db, config);
    if (states.some((source) => source.status === "stale" || source.status === "error")) void syncProductivitySources();
  };
  refreshIfNeeded();
  backgroundTimer = setInterval(() => {
    if (configured()) void syncProductivitySources();
  }, BACKGROUND_SYNC_MS);
  backgroundTimer.unref?.();
}
