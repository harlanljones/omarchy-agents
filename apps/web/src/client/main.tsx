// @ts-nocheck -- Visx's generic stack inference and fire-and-forget effects are validated at runtime.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Group } from "@visx/group";
import { BarStack } from "@visx/shape";
import { scaleBand, scaleLinear, scaleOrdinal } from "@visx/scale";
import type { AdviceRow, AdviceVerdict, AlertsResponse, IncidentsResponse, LimitsBoard, LimitWindowView, PricingEntry, ProductivityActivityResponse, ProductivityResponse } from "../shared/schemas";
import "./styles.css";

type Nav = "overview" | "logs" | "analyst" | "settings" | "limits";
const navPaths: Record<Nav, string> = {
  overview: "/overview",
  logs: "/logs",
  analyst: "/analyst",
  settings: "/settings",
  limits: "/limits",
};
const navFromPath = (pathname = window.location.pathname): Nav =>
  (Object.entries(navPaths).find(([, path]) => path === pathname)?.[0] as Nav) ??
  "overview";
type BoardRow = {
  providerId: string;
  providerName: string;
  tokens: number;
  rank: number;
  share: number;
  coverage: string;
  updatedAt: string;
};
type HistorySeries = {
  rows: any[];
  source: "collector" | "indexed";
};
const colors: Record<string, string> = {
  claude: "#d97757",
  codex: "#10a37f",
  cline: "#6bcb77",
  antigravity: "#4285f4",
  fireworks: "#ff6b22",
  opencode: "#b478e6",
};
const fmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const duration = (ms: number) => {
  if (!(ms > 0)) return "now";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60000),
    hours = Math.floor(minutes / 60),
    days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${Math.max(1, minutes)}m`;
};
const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
  if (!(response.headers.get("content-type") ?? "").includes("application/json"))
    throw new Error(
      response.ok
        ? "Cloudflare Access returned its login page instead of JSON — your portal session expired"
        : `Request failed (${response.status})`,
    );
  if (!response.ok)
    throw new Error(
      (await response.json().catch(() => ({}))).error ??
        `Request failed (${response.status})`,
    );
  return response.json();
};

function Mark({ id }: { id: string }) {
  return (
    <span
      className="mark"
      style={{ "--provider": colors[id] ?? "#91a0ad" } as React.CSSProperties}
    >
      <img
        src={`/provider-assets/${id}.svg`}
        alt=""
        onError={(e) => (e.currentTarget.hidden = true)}
      />
      <span>{id.slice(0, 2).toUpperCase()}</span>
    </span>
  );
}
function Status({
  tone = "ok",
  children,
}: {
  tone?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`status ${tone}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}
function NavIcon({ id }: { id: Nav }) {
  const paths: Record<Nav, React.ReactNode> = {
    overview: (
      <>
        <path d="M4 5h16v4H4z" />
        <path d="M4 13h7v7H4zM15 13h5v7h-5z" />
      </>
    ),
    logs: (
      <>
        <path d="M5 4h14v16H5z" />
        <path d="M8 8h8M8 12h8M8 16h5" />
      </>
    ),
    analyst: (
      <>
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
        <circle cx="12" cy="12" r="5" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
      </>
    ),
    limits: (
      <>
        <path d="M4 20a8 8 0 1 1 16 0" />
        <path d="M12 20L15.5 9.5" />
        <circle cx="12" cy="20" r="1.6" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[id]}
    </svg>
  );
}
function Button({
  children,
  onClick,
  disabled = false,
  kind = "secondary",
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  kind?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      className={`button ${kind}`}
      onClick={onClick}
      disabled={disabled}
      type={type}
    >
      {children}
    </button>
  );
}

function Sk({ w, h = 12 }: { w: number; h?: number }) {
  return <i className="sk" style={{ width: w, height: h }} aria-hidden="true" />;
}
function StandingsSkeleton() {
  const shares = [78, 46, 30, 18, 10, 6];
  return (
    <>
      {shares.map((share, i) => (
        <tr className="standing" key={i} aria-hidden="true">
          <td className="rank"><Sk w={20} /></td>
          <th scope="row" className="provider">
            <i className="sk sk-tile" />
            <Sk w={104 - i * 6} h={11} />
          </th>
          <td className="tokens"><Sk w={52 - i * 4} /></td>
          <td><i className="sk sk-pill" /></td>
          <td className="share"><i className="sk-fill" style={{ width: `${share}%` }} /></td>
        </tr>
      ))}
    </>
  );
}
function ChartSkeleton() {
  return (
    <div className="chart sk-chart" aria-hidden="true">
      <div className="chart-heading">
        <Sk w={148} h={14} />
        <Sk w={188} h={10} />
      </div>
      <div className="chart-summary">
        {[92, 64, 108].map((w, i) => (
          <div key={i}>
            <Sk w={78} h={9} />
            <Sk w={w} h={13} />
          </div>
        ))}
      </div>
      <div className="sk-plot">
        {[0, 25, 50, 75].map((t) => (
          <i key={t} style={{ top: `${t}%` }} />
        ))}
      </div>
      <div className="sk-axis">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <Sk key={i} w={26} h={8} />
        ))}
      </div>
    </div>
  );
}
function CoverageSkeleton() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden="true">
          <i className="sk sk-tile" />
          <Sk w={84 - i * 8} h={11} />
          <i className="sk sk-pill" />
          <Sk w={128 - i * 14} h={10} />
        </div>
      ))}
    </>
  );
}
function SessionListSkeleton() {
  const titles = [152, 178, 128, 164, 112, 146, 136, 172];
  const metas = [[196, 92], [158, 78], [214, 106], [134, 70], [176, 88], [204, 98], [142, 74], [186, 94]];
  return (
    <>
      {titles.map((w, i) => (
        <div className="session sk-session" key={i} aria-hidden="true">
          <span>
            <i className="sk sk-tile" />
            <Sk w={w} h={11} />
          </span>
          <i className="sk sk-meta" style={{ width: metas[i][0] }} />
          <i className="sk sk-meta" style={{ width: metas[i][1] }} />
        </div>
      ))}
    </>
  );
}
function EventsSkeleton() {
  const lines = [
    ["88%", "62%"],
    ["76%", "44%"],
    ["84%", "56%"],
  ];
  return (
    <>
      {lines.map(([a, b], i) => (
        <article className="event sk-event" key={i} aria-hidden="true">
          <div>
            <Sk w={54} h={9} />
            <Sk w={60} h={9} />
          </div>
          <i className="sk sk-line" style={{ width: a }} />
          <i className="sk sk-line" style={{ width: b }} />
        </article>
      ))}
    </>
  );
}

function HistoryChart({
  rows,
  source = "indexed",
  updating = false,
}: {
  rows: any[];
  source?: "collector" | "indexed";
  updating?: boolean;
}) {
  const activityName = source === "collector" ? "Token activity" : "Indexed activity";
  const sourceName = source === "collector" ? "Collector totals" : "Indexed session totals";
  if (!rows.length)
    return (
      <div className="chart-empty">
        <strong>{activityName}</strong>
        <span>
          History will appear as transcript sessions are indexed. Rankings above
          remain available from usage collectors.
        </span>
      </div>
    );
  const width = 760,
    height = 320,
    margin = { top: 16, right: 12, bottom: 42, left: 64 };
  const providers = [...new Set(rows.map((r) => r.provider))] as string[],
    rawDays = [...new Set(rows.map((r) => r.day))].sort() as string[],
    days = rawDays.length < 2
      ? rawDays
      : Array.from(
          {
            length:
              Math.floor(
                (Date.parse(`${rawDays.at(-1)}T00:00:00Z`) -
                  Date.parse(`${rawDays[0]}T00:00:00Z`)) /
                  86400000,
              ) + 1,
          },
          (_, index) =>
            new Date(
              Date.parse(`${rawDays[0]}T00:00:00Z`) + index * 86400000,
            )
              .toISOString()
              .slice(0, 10),
        );
  const data = days.map((day) =>
    Object.assign(
      { day },
      Object.fromEntries(
        providers.map((p) => [
          p,
          Number(
            rows.find((r) => r.day === day && r.provider === p)?.tokens ?? 0,
          ),
        ]),
      ),
    ),
  );
  const x = scaleBand({
    domain: days,
    range: [0, width - margin.left - margin.right],
    padding: 0.22,
  });
  const max = Math.max(
    1,
    ...data.map((d) => providers.reduce((s, p) => s + Number(d[p]), 0)),
  );
  const y = scaleLinear({
    domain: [0, max],
    range: [height - margin.top - margin.bottom, 0],
    nice: true,
  });
  const yMax = Number(y.domain()[1]) || max;
  const yTicks = Array.from({ length: 5 }, (_, index) => (yMax / 4) * index);
  const totals = data.map((day) => ({
    day: day.day,
    tokens: providers.reduce((sum, provider) => sum + Number(day[provider]), 0),
  }));
  const totalIndexed = totals.reduce((sum, day) => sum + day.tokens, 0);
  const peak = totals.reduce(
    (current, day) => (day.tokens > current.tokens ? day : current),
    { day: "", tokens: 0 },
  );
  const providerTotals = providers.map((provider) => ({
    provider,
    tokens: data.reduce((sum, day) => sum + Number(day[provider]), 0),
  }));
  const color = scaleOrdinal({
    domain: providers,
    range: providers.map((p) => colors[p] ?? "#77838d"),
  });
  const labelStep = Math.max(1, Math.ceil(days.length / 7));
  const dailySummary = totals
    .filter((day) => day.tokens > 0)
    .map((day) => `${day.day}: ${fmt.format(day.tokens)} tokens`)
    .join("; ");
  return (
    <figure className={`chart ${updating ? "is-updating" : ""}`}>
      <figcaption>
        <div className="chart-heading">
          <strong id="activity-title">{activityName}</strong>
          <span>
            {updating
              ? `Updating ${activityName.toLowerCase()}…`
              : days.length
                ? `${sourceName} · ${days[0]} — ${days.at(-1)}`
                : "Waiting for indexed sessions"}
          </span>
        </div>
        <dl className="chart-summary" id="activity-summary">
          <div>
            <dt>{source === "collector" ? "Reported tokens" : "Indexed tokens"}</dt>
            <dd>{fmt.format(totalIndexed)}</dd>
          </div>
          <div>
            <dt>Active days</dt>
            <dd>{totals.filter((day) => day.tokens > 0).length}</dd>
          </div>
          <div>
            <dt>Peak day</dt>
            <dd>{peak.day ? `${peak.day.slice(5)} · ${fmt.format(peak.tokens)}` : "—"}</dd>
          </div>
        </dl>
      </figcaption>
      <div className="chart-legend" role="list" aria-label={`Providers in ${activityName.toLowerCase()}`}>
        {providerTotals.map(({ provider, tokens }) => (
          <span role="listitem" key={provider}>
            <i style={{ background: colors[provider] ?? "#77838d" }} aria-hidden="true" />
            <b>{provider}</b>
            <em>{fmt.format(tokens)}</em>
          </span>
        ))}
      </div>
      <svg
        role="img"
        aria-labelledby="activity-title activity-summary"
        aria-label={`Stacked token totals over ${days.length} days for ${providers.join(", ") || "no providers"}`}
        viewBox={`0 0 ${width} ${height}`}
      >
        <Group left={margin.left} top={margin.top}>
          {yTicks.map((tick) => (
            <g key={tick} className="chart-tick">
              <line
                x1={0}
                x2={width - margin.left - margin.right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text x={-12} y={y(tick) + 3} textAnchor="end">
                {fmt.format(tick)}
              </text>
            </g>
          ))}
          <BarStack
            data={data}
            keys={providers}
            x={(d) => d.day}
            xScale={x}
            yScale={y}
            color={color}
          >
            {(stacks) =>
              stacks.map((stack) =>
                stack.bars
                  .filter((bar) => bar.height > 0)
                  .map((bar) => (
                    <rect
                      key={`${stack.key}-${bar.index}`}
                      x={bar.x}
                      y={bar.y}
                      width={bar.width}
                      height={bar.height}
                      fill={bar.color}
                      rx="2"
                    >
                      <title>
                        {stack.key}: {fmt.format(Number(bar.bar.data[stack.key]))} tokens
                      </title>
                    </rect>
                  )),
              )
            }
          </BarStack>
          {days.map(
            (d, i) =>
              (i % labelStep === 0 ||
                i === days.length - 1) && (
                <text
                  key={d}
                  x={(x(d) ?? 0) + x.bandwidth() / 2}
                  y={height - margin.top - margin.bottom + 22}
                  textAnchor="middle"
                >
                  {d.slice(5)}
                </text>
              ),
          )}
        </Group>
      </svg>
      <p className="sr-only">
        Token volume by day from {sourceName.toLowerCase()}. {dailySummary || "No token volume yet."}
        {source === "collector"
          ? "Use standings and source coverage for the reported provider totals."
          : "Use the sessions table for exact indexed values and supporting logs."}
      </p>
    </figure>
  );
}

function Overview({
  openRail,
  railOpen,
}: {
  openRail: () => void;
  railOpen: boolean;
}) {
  const initialQuery = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestedPeriod = initialQuery.get("period") ?? "week";
  const [period, setPeriod] = useState(
      ["today", "week", "month", "all"].includes(requestedPeriod)
        ? requestedPeriod
        : "week",
    ),
    [project, setProject] = useState(initialQuery.get("project") ?? ""),
    [projects, setProjects] = useState<string[]>([]),
    [board, setBoard] = useState<any>({
      rows: [],
      total: 0,
      freshness: [],
      index: { state: "idle" },
    }),
    [series, setSeries] = useState<HistorySeries>({ rows: [], source: "indexed" }),
    [error, setError] = useState(""),
    [loadingBoard, setLoadingBoard] = useState(true),
    [loadingSeries, setLoadingSeries] = useState(true),
    [reload, setReload] = useState(0);
  const updateUrl = (nextPeriod: string, nextProject: string) => {
    const url = new URL(window.location.href);
    url.pathname = navPaths.overview;
    if (nextPeriod === "week") url.searchParams.delete("period");
    else url.searchParams.set("period", nextPeriod);
    if (nextProject) url.searchParams.set("project", nextProject);
    else url.searchParams.delete("project");
    window.history.replaceState({}, "", url);
  };
  useEffect(() => {
    api<{ projects: string[] }>("/api/filter-options")
      .then((result) => setProjects(result.projects))
      .catch(() => setProjects([]));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setLoadingBoard(true);
    setLoadingSeries(true);
    const projectQuery = project ? `&project=${encodeURIComponent(project)}` : "";
    api<any>(`/api/overview?period=${period}${projectQuery}`, { signal: controller.signal })
      .then((b) => {
        if (!controller.signal.aborted) setBoard(b);
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setBoard({ rows: [], total: 0, freshness: [], index: { state: "error" } });
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingBoard(false); });
    api<any>(
      `/api/timeseries?days=${period === "today" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 365}${projectQuery}`,
      { signal: controller.signal },
    )
      .then((s) => {
        if (!controller.signal.aborted) setSeries({
          rows: s.rows,
          source: s.source === "collector" ? "collector" : "indexed",
        });
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setSeries({ rows: [], source: "indexed" });
        setError((current) => current || (e instanceof Error ? e.message : String(e)));
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingSeries(false); });
    updateUrl(period, project);
    return () => controller.abort();
  }, [period, project, reload]);
  return (
    <div className="overview">
      <section className="scorehead">
        <div>
          <h1>Omarchy Agents</h1>
          <p>
            {loadingBoard && !board.rows.length
              ? (
                <>
                  <i className="sk sk-hero" aria-hidden="true" />
                  <span className="sr-only">Loading collector metrics…</span>
                </>
              )
              : loadingBoard
                ? "Updating standings…"
                : `${fmt.format(board.total)} tokens across ${board.rows.length} active providers`}
          </p>
        </div>
        <div className="health">
          <Status tone={board.index?.state === "ready" ? "ok" : "warn"}>
            Index {board.index?.state}
          </Status>
          <a className="button secondary limits-link" href={navPaths.limits}>
            Limits portal
          </a>
          <button
            className="rail-toggle"
            onClick={openRail}
            aria-expanded={railOpen}
            aria-controls="analyst-rail"
          >
            Open analyst
          </button>
        </div>
      </section>
      <div
        className="commandbar"
        role="group"
        aria-label="Leaderboard controls"
      >
        <div className="segmented">
          {[
            ["today", "Today"],
            ["week", "7 days"],
            ["month", "30 days"],
            ["all", "All-time"],
          ].map(([v, l]) => (
            <button
              key={v}
              aria-pressed={period === v}
              onClick={() => setPeriod(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <label>
          Project path
          <select value={project} onChange={(event) => setProject(event.target.value)}>
            <option value="">All project paths</option>
            {projects.map((path) => <option value={path} key={path}>{path}</option>)}
          </select>
        </label>
      </div>
      {error && (
        <div className="notice error" role="alert">
          <strong>Metrics could not be loaded.</strong>
          <span>{error}</span>
          <Button onClick={() => setReload((value) => value + 1)}>Retry</Button>
        </div>
      )}
      <section className="board" aria-labelledby="standings-title">
        <div className="section-title">
          <div>
            <h2 id="standings-title">Standings</h2>
            <p>Desktop-compatible token ranking; ties share a rank.</p>
          </div>
          <span>Share</span>
        </div>
        <table
          className="standings"
          aria-label={`${period} agent standings`}
          aria-busy={loadingBoard}
        >
          <thead>
            <tr className="standing header">
              <th scope="col">Rank</th>
              <th scope="col">Provider</th>
              <th scope="col">Tokens</th>
              <th scope="col">Coverage</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {board.rows.map((row: BoardRow) => (
              <tr className="standing" key={row.providerId}>
                <td className="rank">{String(row.rank).padStart(2, "0")}</td>
                <th scope="row" className="provider">
                  <Mark id={row.providerId} />
                  <b>{row.providerName}</b>
                </th>
                <td className="tokens">{fmt.format(row.tokens)}</td>
                <td>
                  <Status tone={row.coverage === "indexed" ? "ok" : "warn"}>
                    {row.coverage}
                  </Status>
                </td>
                <td
                  className="share"
                  aria-label={`${Math.round(row.share * 100)}% of tokens`}
                >
                  <i
                    style={{
                      width: `${Math.max(2, row.share * 100)}%`,
                      background: colors[row.providerId],
                    }}
                  />
                  <em>{Math.round(row.share * 100)}%</em>
                </td>
              </tr>
            ))}
            {loadingBoard && !board.rows.length && <StandingsSkeleton />}
            {!loadingBoard && !board.rows.length && (
              <tr>
                <td colSpan={5}>
                  <div className="empty">
                    <strong>No usage in this range</strong>
                    <span>
                      Metrics appear after collectors publish their first
                      record.
                    </span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      {loadingSeries && !series.rows.length
        ? <ChartSkeleton />
        : <HistoryChart rows={series.rows} source={series.source} updating={loadingSeries} />}
      <section className="coverage">
        <h2>Source coverage</h2>
        {loadingBoard && !board.freshness?.length
          ? <CoverageSkeleton />
          : board.freshness?.map((x: any) => (
          <div key={x.provider}>
            <Mark id={x.provider} />
            <b>{x.provider}</b>
            <span>{x.coverage}</span>
            <time>
              {x.updatedAt
                ? new Date(x.updatedAt).toLocaleString()
                : "Unknown freshness"}
            </time>
          </div>
        ))}
      </section>
    </div>
  );
}

function Logs() {
  const [data, setData] = useState<any>({ rows: [], total: 0 }),
    [selected, setSelected] = useState<any>(null),
    [events, setEvents] = useState<any[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [eventsLoading, setEventsLoading] = useState(false),
    [eventsError, setEventsError] = useState(""),
    [reload, setReload] = useState(0),
    [filters, setFilters] = useState({
      provider: "",
      project: "",
      errors: false,
    });
  const parent = useRef<HTMLDivElement>(null);
  const query = new URLSearchParams({
    ...filters,
    errors: String(filters.errors),
  } as any);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<any>(`/api/sessions?${query}`, { signal: controller.signal })
      .then((result) => {
        setData(result);
        setSelected((current: any) => result.rows.some((row: any) => row.id === current?.id) ? current : null);
      })
      .catch((reason) => {
        if (reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setData({ rows: [], total: 0 });
        setSelected(null);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [filters.provider, filters.project, filters.errors, reload]);
  useEffect(() => {
    const controller = new AbortController();
    setEvents([]);
    setEventsError("");
    if (selected) {
      setEventsLoading(true);
      api<any>(`/api/sessions/${encodeURIComponent(selected.id)}/events`, { signal: controller.signal })
        .then((r) => setEvents(r.rows))
        .catch((reason) => { if (reason.name !== "AbortError") setEventsError(reason instanceof Error ? reason.message : String(reason)); })
        .finally(() => { if (!controller.signal.aborted) setEventsLoading(false); });
    } else setEventsLoading(false);
    return () => controller.abort();
  }, [selected, reload]);
  const virtual = useVirtualizer({
    count: data.rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 84,
    overscan: 8,
  });
  return (
    <div className="logs">
      <header className="pagehead">
        <h1>Session ledger</h1>
        <p>
          {loading
            ? data.rows.length
              ? "Updating session index…"
              : (
                <>
                  <i className="sk sk-hero" aria-hidden="true" />
                  <span className="sr-only">Loading redacted session index…</span>
                </>
              )
            : `${data.total} indexed sessions with redacted, evidence-addressable events.`}
        </p>
      </header>
      <div className="filters">
        <label>
          Provider
          <input
            value={filters.provider}
            onChange={(e) =>
              setFilters({ ...filters, provider: e.target.value })
            }
            placeholder="codex"
          />
        </label>
        <label>
          Project
          <input
            value={filters.project}
            onChange={(e) =>
              setFilters({ ...filters, project: e.target.value })
            }
            placeholder="project path"
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.errors}
            onChange={(e) =>
              setFilters({ ...filters, errors: e.target.checked })
            }
          />{" "}
          Errors only
        </label>
        {(filters.provider || filters.project || filters.errors) && (
          <Button onClick={() => setFilters({ provider: "", project: "", errors: false })}>Clear filters</Button>
        )}
      </div>
      {error && <div className="notice error" role="alert"><strong>Sessions could not be loaded.</strong><span>{error}</span><Button onClick={() => setReload((value) => value + 1)}>Retry</Button></div>}
      <div className="ledger">
        <div
          className={`sessionlist ${loading && data.rows.length ? "is-updating" : ""}`}
          ref={parent}
          aria-label="Sessions"
          aria-busy={loading}
        >
          {loading && !data.rows.length && !error && <SessionListSkeleton />}
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((v) => {
              const s = data.rows[v.index];
              return (
                <button
                  key={s.id}
                  className={`session ${selected?.id === s.id ? "selected" : ""}`}
                  style={{
                    position: "absolute",
                    transform: `translateY(${v.start}px)`,
                    height: v.size,
                  }}
                  onClick={() => setSelected(s)}
                >
                  <span>
                    <Mark id={s.provider} />
                    <b>{s.title || "Untitled session"}</b>
                  </span>
                  <small>
                    {s.provider} · {s.model || "model unknown"} ·{" "}
                    {new Date(s.startedAt).toLocaleString()}
                  </small>
                  <em>
                    {s.toolCount} tools · {s.errorCount} errors
                  </em>
                </button>
              );
            })}
            {!loading && !error && !data.rows.length && (
              <div className="empty ledger-empty">
                <strong>{filters.provider || filters.project || filters.errors ? "No sessions match these filters" : "No sessions have been indexed"}</strong>
                <span>{filters.provider || filters.project || filters.errors ? "Clear or adjust the filters to widen the ledger." : "Run Rebuild index in Settings after confirming local agent logs are available."}</span>
              </div>
            )}
          </div>
        </div>
        <section className="transcript" aria-live="polite">
          <header>
            <h2>{selected?.title || "Select a session"}</h2>
            {selected && (
              <Status tone={selected.errorCount ? "warn" : "ok"}>
                {selected.errorCount
                  ? `${selected.errorCount} errors`
                  : "No recorded errors"}
              </Status>
            )}
          </header>
          {events.map((e) => (
            <article id={`e-${e.id}`} className={`event ${e.kind}`} key={e.id}>
              <div>
                <span>{e.kind.replace("_", " ")}</span>
                <time>{new Date(e.timestamp).toLocaleTimeString()}</time>
              </div>
              <pre>{e.text}</pre>
              <a href={`#e-${e.id}`}>Evidence anchor</a>
            </article>
          ))}
          {eventsLoading && <EventsSkeleton />}
          {eventsError && <div className="notice error" role="alert"><strong>Evidence could not be loaded.</strong><span>{eventsError}</span><Button onClick={() => setReload((value) => value + 1)}>Retry</Button></div>}
          {!selected && !eventsLoading && (
            <div className="empty">
              <strong>{data.rows.length ? "Evidence opens here" : "Waiting for indexed evidence"}</strong>
              <span>
                {data.rows.length ? "Choose a session to inspect its redacted prompt, response, tool, and error events." : "Sessions will appear here after the local index successfully processes agent logs."}
              </span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Analyst({ compact = false }: { compact?: boolean }) {
  const [reports, setReports] = useState<any[]>([]),
    [input, setInput] = useState(""),
    [messages, setMessages] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [analysisPrompt, setAnalysisPrompt] = useState(""),
    [analysisSessionId, setAnalysisSessionId] = useState(""),
    [promptAnalysis, setPromptAnalysis] = useState<any>(null),
    [analysisBusy, setAnalysisBusy] = useState(false),
    [analysisError, setAnalysisError] = useState("");
  const load = async () => {
    try {
      const result = await api<any>("/api/reports");
      setReports(result.rows);
    } catch {
      setReports([]);
    }
  };
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("analysis:complete", refresh);
    return () => window.removeEventListener("analysis:complete", refresh);
  }, []);
  async function ask(text = input) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    try {
      const response = await fetch("/api/agent/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (!response.ok) throw new Error("Analyst request failed");
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let buf = "",
        answer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const evt = JSON.parse(line);
          if (evt.type === "content") answer += evt.data;
          if (evt.type === "error") answer += `\n${evt.data}`;
          setMessages((m) => [
            ...m.filter((x) => x.stream !== true),
            {
              role: "assistant",
              content:
                answer || `Querying ${evt.data?.name ?? "local evidence"}…`,
              stream: true,
            },
          ]);
        }
      }
      setMessages((m) => m.map((x) => ({ ...x, stream: false })));
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: String(e) }]);
    } finally {
      setBusy(false);
    }
  }
  const report = reports[0];
  async function analyze() {
    if ((!analysisPrompt.trim() && !analysisSessionId.trim()) || analysisBusy) return;
    setAnalysisBusy(true); setAnalysisError("");
    try {
      setPromptAnalysis(await api("/api/prompt-analysis", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(analysisSessionId.trim() ? { sessionId: analysisSessionId.trim() } : { prompt: analysisPrompt }) }));
    } catch (error) { setAnalysisError(error instanceof Error ? error.message : String(error)); }
    finally { setAnalysisBusy(false); }
  }
  return (
    <section className={`analyst ${compact ? "compact" : ""}`}>
      <header>
        <div>
          <h2>Local analyst</h2>
          <p>Read-only · citations required</p>
        </div>
        <Status tone={report ? "ok" : "warn"}>
          {report ? "Brief ready" : "No report"}
        </Status>
      </header>
      <div className="brief">
        <h3>Nightly brief</h3>
        <p>
          {report?.summary ??
            "Run the first analysis from Settings. Deterministic checks remain available without Ollama."}
        </p>
        {report?.detectors?.slice(0, 3).map((d: any) => (
          <div className="finding" key={d.type}>
            <Status tone={d.severity === "warning" ? "warn" : "ok"}>
              {d.type.replaceAll("_", " ")}
            </Status>
            <span>{d.message}</span>
          </div>
        ))}
      </div>
      {!compact && <section className="prompt-analysis" aria-live="polite">
        <header><div><h3>Prompt analysis</h3><p>Local advisory match: task complexity vs model</p></div>{promptAnalysis && <Status tone={promptAnalysis.complexity === "high" ? "warn" : "ok"}>{promptAnalysis.complexity} complexity · {promptAnalysis.score}/100</Status>}</header>
        <label className="analysis-session">Indexed session ID <input value={analysisSessionId} onChange={(e) => setAnalysisSessionId(e.target.value)} placeholder="Optional: analyze first prompt from a session" /></label>
        <textarea aria-label="Prompt to analyze" value={analysisPrompt} onChange={(e) => { setAnalysisPrompt(e.target.value); setAnalysisSessionId(""); }} placeholder="Paste a prompt to compare complexity with available models…" rows={4} />
        <Button onClick={() => void analyze()} disabled={analysisBusy || (!analysisPrompt.trim() && !analysisSessionId.trim())}>{analysisBusy ? "Analyzing…" : "Analyze locally"}</Button>
        {analysisError && <p className="notice error" role="alert">{analysisError}</p>}
        {promptAnalysis && <>
          <p className="hint-line">Required: {promptAnalysis.requiredCapabilities.join(", ") || "basic reasoning"}. {promptAnalysis.unknowns.join(" ")}</p>
          {promptAnalysis.warnings?.map((warning: string) => <p className="notice" role="status" key={warning}>{warning}</p>)}
          <div className="prompt-recommendations" role="table" aria-label="Model recommendations">
            {promptAnalysis.recommendations.map((item: any) => <div className="prompt-recommendation" role="row" key={`${item.provider ?? "local"}-${item.model}`}><strong>{item.provider ? `${item.provider} / ` : ""}{item.model}</strong><Status tone={item.fit === "recommended" ? "ok" : item.fit === "fallback" ? "warn" : "error"}>{item.fit}</Status><span>{item.rationale}</span><b>{item.estimatedCostUsd == null ? "cost unknown" : `≈$${item.estimatedCostUsd.toFixed(2)}`} · {item.estimatedLatencyMs == null ? "latency unknown" : `~${item.estimatedLatencyMs}ms`}</b></div>)}
          </div>
          <details><summary>Complexity evidence</summary>{promptAnalysis.dimensions.map((dimension: any) => <p key={dimension.name}><strong>{dimension.name}</strong> {dimension.score}/100 — {dimension.evidence}</p>)}</details>
        </>}
      </section>}
      {!compact && (
        <div className="presets">
          <button
            onClick={() =>
              ask("What changed compared with the previous period?")
            }
          >
            Compare periods
          </button>
          <button
            onClick={() => ask("Find repeated prompts and failed tools.")}
          >
            Investigate retries
          </button>
        </div>
      )}
      <div className="chat" aria-live="polite">
        {messages.map((m, i) => (
          <div className={m.role} key={i}>
            <span>{m.role}</span>
            <p>{m.content}</p>
          </div>
        ))}
        {!messages.length && (
          <p className="hint">
            Ask about concentration, retries, tool failures, model switching, or
            a specific session.
          </p>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <label
          className="sr-only"
          htmlFor={compact ? "rail-chat" : "page-chat"}
        >
          Ask the analyst
        </label>
        <textarea
          id={compact ? "rail-chat" : "page-chat"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question grounded in local logs…"
          rows={3}
        />
        <Button type="submit" kind="primary" disabled={busy || !input.trim()}>
          {busy ? "Working…" : "Ask"}
        </Button>
      </form>
    </section>
  );
}

const limitTone = (used: number) =>
  used >= 0.95 ? "err" : used >= 0.8 ? "warn" : "ok";

function LimitMeter({
  window: w,
  providerId,
  nowMs,
  titled,
}: {
  window: LimitWindowView;
  providerId: string;
  nowMs: number;
  titled?: boolean;
}) {
  const pct = Math.round(w.used * 100);
  const resetIn = w.resetsAt ? Date.parse(w.resetsAt) - nowMs : null;
  return (
    <span className={`limit-entry ${limitTone(w.used)}`}>
      {titled && w.title && <small className="limit-title">{w.title}</small>}
      <span className="meter" role="img" aria-label={`${w.title}: ${pct}% used`}>
        <i
          style={{
            transform: `scaleX(${Math.min(100, pct) / 100})`,
            background: colors[providerId] ?? "#77838d",
          }}
        />
        <em>{pct}%</em>
      </span>
      <small className="limit-reset">
        {resetIn != null && resetIn > 0
          ? `resets in ${duration(resetIn)}`
          : w.resetsAt
            ? "awaiting refresh"
            : ""}
      </small>
    </span>
  );
}

const VERDICT_LABEL: Record<AdviceVerdict, string> = {
  recommended: "Recommended",
  usable: "Usable",
  tight: "Tight",
  wait: "Wait",
  unavailable: "Unavailable",
};

// Mirrors the CAPABILITY_SIGNATURES keys the server matches against a
// provider's dominant model (apps/web/src/server/prompt-analysis.ts). "tool
// use" is deliberately absent there — it's assumed universal among agent
// CLIs — so it stays out of this selectable list too.
const TASK_CAPABILITIES = ["deep reasoning", "code generation", "low latency", "high reliability"];

const INCIDENT_KIND_LABEL: Record<IncidentsResponse["incidents"][number]["kind"], string> = {
  threshold: "Threshold",
  "provider-switch": "Provider switch",
  "actual-reset": "Actual reset",
  "forecast-accuracy": "Forecast accuracy",
};

function AdviceRowView({ row }: { row: AdviceRow }) {
  const tone =
    row.verdict === "recommended" || row.verdict === "usable"
      ? "ok"
      : row.verdict === "tight" || row.verdict === "wait"
        ? "warn"
        : "error";
  return (
    <li className="advice-row">
      <Mark id={row.providerId} />
      <div className="advice-main">
        <div className="advice-name">
          <strong>{row.providerName}</strong>
          <Status tone={row.excludedByProfile ? "error" : tone}>
            {row.excludedByProfile ? "Excluded by profile" : VERDICT_LABEL[row.verdict]}
          </Status>
          {row.estCostUsd != null && (
            <b className="cost">≈${row.estCostUsd.toFixed(2)}</b>
          )}
          {row.unpricedModels.length > 0 && (
            <b className="cost unpriced">unpriced</b>
          )}
        </div>
        <ul className="reasons">
          {row.reasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      </div>
    </li>
  );
}

function LimitsBoardView() {
  const [board, setBoard] = useState<LimitsBoard | null>(null),
    [alerts, setAlerts] = useState<AlertsResponse | null>(null),
    [pricing, setPricing] = useState<PricingEntry[] | null>(null),
    [overrideError, setOverrideError] = useState(""),
    [task, setTask] = useState<"" | "small" | "medium" | "large">(""),
    [custom, setCustom] = useState({ input: "", output: "", cacheRead: "" }),
    [capabilities, setCapabilities] = useState<string[]>([]),
    [preferredProviders, setPreferredProviders] = useState<string[]>([]),
    [sortRisk, setSortRisk] = useState(true),
    [advice, setAdvice] = useState<{ verdictLine: string; generatedAt: string; rows: AdviceRow[]; fallbackProviderName: string | null; recommendationResetsAt: string | null; confidence: "high" | "medium" | "low" } | null>(null),
    [incidents, setIncidents] = useState<IncidentsResponse | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reload, setReload] = useState(0),
    [nowMs, setNowMs] = useState(() => Date.now()),
    [copyState, setCopyState] = useState<"idle" | "copied" | "selected">("idle"),
    [adviceResolved, setAdviceResolved] = useState(false);
  useEffect(() => {
    let last = Date.now();
    const timer = window.setInterval(() => {
      const t = Date.now();
      const urgent = (board?.platforms ?? []).some((p) =>
        p.windows.some((w) => {
          if (!w.resetsAt) return false;
          const delta = Date.parse(w.resetsAt) - t;
          return delta > 0 && delta < 120_000;
        }),
      );
      if (urgent || t - last >= 30_000) {
        last = t;
        setNowMs(t);
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [board]);
  useEffect(() => {
    setError("");
    api<LimitsBoard>("/limits/api/board")
      .then(setBoard)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api<AlertsResponse>("/limits/api/alerts")
      .then(setAlerts)
      .catch(() => setAlerts(null));
    api<IncidentsResponse>("/limits/api/incidents")
      .then(setIncidents)
      .catch(() => setIncidents(null));
    api<{ entries: PricingEntry[]; overrideError: string | null }>("/limits/api/pricing")
      .then((p) => {
        setPricing(p.entries);
        setOverrideError(p.overrideError ?? "");
      })
      .catch(() => setPricing([]));
  }, [reload]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (task) params.set("task", task);
    else if (Object.values(custom).some(Boolean)) {
      params.set("input", custom.input);
      params.set("output", custom.output);
      params.set("cache", custom.cacheRead);
    }
    if (capabilities.length) params.set("capabilities", capabilities.join(","));
    if (preferredProviders.length) params.set("prefer", preferredProviders.join(","));
    api<{ verdictLine: string; generatedAt: string; rows: AdviceRow[] }>(
      `/limits/api/advice${params.size ? `?${params}` : ""}`,
    )
      .then((next) => {
        setAdvice(next);
        setAdviceResolved(true);
        setCopyState("idle");
      })
      .catch(() => setAdvice(null));
  }, [task, custom, capabilities, preferredProviders, reload]);
  const platforms = useMemo(() => {
    const rows = [...(board?.platforms ?? [])];
    if (!sortRisk) return rows;
    return rows.sort((a, b) => {
      const risk = (p: typeof a) => p.status !== "ready" ? 0 : p.binding ? 1 - p.binding.used : p.balance?.funded ? p.balance.remaining / p.balance.funded : 0.5;
      return risk(a) - risk(b) || a.providerName.localeCompare(b.providerName);
    });
  }, [board, sortRisk]);
  const resets = useMemo(() => (board?.platforms ?? []).flatMap((platform) => platform.windows.map((window) => ({ ...window, providerName: platform.providerName, status: platform.status }))).sort((a, b) => {
    const at = a.resetsAt ? Date.parse(a.resetsAt) : Number.POSITIVE_INFINITY;
    const bt = b.resetsAt ? Date.parse(b.resetsAt) : Number.POSITIVE_INFINITY;
    return at - bt;
  }), [board]);
  const bindingPlatform = platforms.find((platform) => platform.binding) ?? platforms[0];
  const copyRoutingBrief = async () => {
    if (!advice) return;
    try {
      await navigator.clipboard.writeText(advice.verdictLine);
      setCopyState("copied");
    } catch {
      const verdict = document.querySelector(".limits-view .verdict-line");
      const selection = window.getSelection();
      if (verdict && selection) {
        const range = document.createRange();
        range.selectNodeContents(verdict);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopyState("selected");
    }
  };
  const tableSummary = platforms
    .map(
      (p) =>
        `${p.providerName}: ${
          p.binding
            ? `binding ${Math.round(p.binding.used * 100)}% used`
            : p.balance
              ? `$${p.balance.remaining.toFixed(2)} credit left`
              : "no limits reported"
        }`,
    )
    .join(". ");
  const refreshCollectors = async () => {
    setNotice("Refreshing collectors…");
    try {
      await api("/api/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      setNotice("Collectors are regenerating records; values will update shortly.");
      window.setTimeout(() => setReload((n) => n + 1), 4000);
    } catch (e) {
      setNotice(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div className="limits-view">
      <header className="pagehead">
        <h1>Usage limits</h1>
        <p>
          Admin-only view of every subscription's session, weekly, and monthly
          allowances with an advisor for picking the next platform.
        </p>
      </header>
      {error && (
        <p className="notice error" role="alert">
          {error} Reload the page to sign in through Cloudflare Access.
        </p>
      )}
      {!error && (
        <>
          <section className="verdict" aria-live="polite">
            <h2 className="sr-only">Advisor verdict</h2>
            {advice ? (
              <>
                <p className={`verdict-line${adviceResolved ? " resolved" : ""}`}>{advice.verdictLine}</p>
                <span className="as-of">
                  as of {new Date(advice.generatedAt).toLocaleTimeString()} · confidence {advice.confidence}
                </span>
              </>
            ) : (
              <p className="verdict-line">
                Consulting local usage records
                <span className="consult-cursor" aria-hidden="true" />
              </p>
            )}
            <div className="segmented" role="group" aria-label="Task size">
              {(
                [
                  ["", "General"],
                  ["small", "Small task"],
                  ["medium", "Medium task"],
                  ["large", "Large task"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={task === value}
                  onClick={() => setTask(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="workload-controls" aria-label="Custom workload estimate">
              <label>Input <input inputMode="numeric" value={custom.input} placeholder="tokens" onChange={(e) => { setTask(""); setCustom({ ...custom, input: e.target.value.replace(/[^0-9]/g, "") }); }} /></label>
              <label>Output <input inputMode="numeric" value={custom.output} placeholder="tokens" onChange={(e) => { setTask(""); setCustom({ ...custom, output: e.target.value.replace(/[^0-9]/g, "") }); }} /></label>
              <label>Cache read <input inputMode="numeric" value={custom.cacheRead} placeholder="tokens" onChange={(e) => { setTask(""); setCustom({ ...custom, cacheRead: e.target.value.replace(/[^0-9]/g, "") }); }} /></label>
              {Object.values(custom).some(Boolean) && <button className="text-button" onClick={() => setCustom({ input: "", output: "", cacheRead: "" })}>Clear custom</button>}
            </div>
            <div className="profile-controls" aria-label="Task profile">
              <fieldset className="profile-capabilities">
                <legend>Required capabilities</legend>
                {TASK_CAPABILITIES.map((cap) => (
                  <label key={cap}>
                    <input
                      type="checkbox"
                      checked={capabilities.includes(cap)}
                      onChange={() =>
                        setCapabilities((prev) =>
                          prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
                        )
                      }
                    />
                    {cap}
                  </label>
                ))}
              </fieldset>
              <fieldset className="profile-providers">
                <legend>Preferred providers</legend>
                {platforms.length ? platforms.map((p) => (
                  <label key={p.providerId}>
                    <input
                      type="checkbox"
                      checked={preferredProviders.includes(p.providerId)}
                      onChange={() =>
                        setPreferredProviders((prev) =>
                          prev.includes(p.providerId) ? prev.filter((id) => id !== p.providerId) : [...prev, p.providerId],
                        )
                      }
                    />
                    {p.providerName}
                  </label>
                )) : <small className="muted">No platforms reporting yet</small>}
              </fieldset>
              {(capabilities.length > 0 || preferredProviders.length > 0) && (
                <button className="text-button" onClick={() => { setCapabilities([]); setPreferredProviders([]); }}>
                  Clear task profile
                </button>
              )}
            </div>
            <div className="routing-receipt" aria-label="Current routing brief">
              <div className="routing-leg">
                <span>Next route</span>
                <strong>{advice?.rows[0]?.providerName ?? "Reading evidence"}</strong>
              </div>
              <div className="routing-leg">
                <span>Recovery route</span>
                <strong>{advice ? (advice.fallbackProviderName ?? "None reported") : "Reading evidence"}</strong>
              </div>
              <div className="routing-copy">
                <Button onClick={() => void copyRoutingBrief()} disabled={!advice}>
                  {copyState === "copied" ? "Routing brief copied" : "Copy routing brief"}
                </Button>
                <span className="copy-feedback" role="status" aria-live="polite">
                  {copyState === "selected" ? "Clipboard blocked · verdict selected" : ""}
                </span>
              </div>
            </div>
            <p className="capacity-brief">
              {bindingPlatform?.binding ? <><strong>{bindingPlatform.providerName}</strong> binds first at {Math.round(bindingPlatform.binding.used * 100)}% used ({Math.round((1 - bindingPlatform.binding.used) * 100)}% headroom){bindingPlatform.binding.resetsAt ? `; resets ${new Date(bindingPlatform.binding.resetsAt).toLocaleString()}` : "; reset unknown"}.</> : "No binding limit is confirmed from current records."}
              {advice?.fallbackProviderName && <> Fallback: <strong>{advice.fallbackProviderName}</strong>{advice.recommendationResetsAt ? ` until ${new Date(advice.recommendationResetsAt).toLocaleString()}` : " while the primary recovers"}.</>}
            </p>
          </section>
          <section>
            <div className="section-title">
              <h2>Alert inbox</h2>
              <span>
                {alerts
                  ? `${alerts.active.length} active · deduplicated per provider, window, and reset cycle`
                  : "watching collector refreshes"}
              </span>
            </div>
            <ol className="reset-timeline">
              {(alerts?.active ?? []).map((alert) => (
                <li key={alert.id}>
                  <strong>{alert.providerName}</strong>
                  <span>{alert.message}</span>
                  <Status tone={alert.severity === "critical" ? "error" : "warn"}>
                    {alert.rule}
                  </Status>
                </li>
              ))}
              {alerts && !alerts.active.length && (
                <li className="muted">
                  No watch rules are firing — every threshold, forecast,
                  collector heartbeat, and login is clear.
                </li>
              )}
              {!alerts && (
                <li className="muted">Loading alert history…</li>
              )}
            </ol>
            {!!alerts?.recent.length && (
              <details className="alert-history">
                <summary>{alerts.recent.length} recovered or resolved recently</summary>
                <ol className="reset-timeline">
                  {alerts.recent.map((alert) => (
                    <li key={alert.id}>
                      <strong>{alert.providerName}</strong>
                      <span>{alert.message}</span>
                      <Status tone="ok">
                        cleared{" "}
                        {alert.resolvedAt
                          ? new Date(alert.resolvedAt).toLocaleString()
                          : ""}
                      </Status>
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>
          <section>
            <div className="section-title">
              <h2>Incident timeline</h2>
              <span>threshold crossings, recommendation switches, actual resets, and forecast accuracy</span>
            </div>
            <ol className="reset-timeline">
              {(incidents?.incidents ?? []).map((incident) => (
                <li key={incident.id}>
                  <strong>{incident.providerName}</strong>
                  <span>{incident.detail}</span>
                  <Status tone={incident.kind === "threshold" ? "warn" : "ok"}>
                    {INCIDENT_KIND_LABEL[incident.kind]}
                  </Status>
                </li>
              ))}
              {incidents && !incidents.incidents.length && (
                <li className="muted">No incidents recorded yet.</li>
              )}
              {!incidents && <li className="muted">Loading incident history…</li>}
            </ol>
          </section>
          <section>
            <div className="section-title">
              <h2>Depletion forecasts</h2>
              <span>projected from snapshots within the current reset cycle</span>
            </div>
            <ol className="reset-timeline">
              {(alerts?.forecasts ?? []).map((forecast) => {
                const key = `${forecast.providerId}-${forecast.windowLabel}`;
                const state = !forecast.sufficient
                  ? forecast.samples > 0
                    ? "insufficient history"
                    : "no samples yet"
                  : forecast.projectedExhaustionAt &&
                      forecast.resetsAt &&
                      Date.parse(forecast.projectedExhaustionAt) <
                        Date.parse(forecast.resetsAt)
                    ? `exhausts in ${duration(Date.parse(forecast.projectedExhaustionAt) - nowMs)}`
                    : "outlasts this reset";
                return (
                  <li key={key}>
                    <strong>{forecast.providerName}</strong>
                    <span>{forecast.windowLabel}</span>
                    <Status
                      tone={
                        !forecast.sufficient
                          ? "warn"
                          : state.startsWith("exhausts")
                            ? "error"
                            : "ok"
                      }
                    >
                      {state}
                    </Status>
                  </li>
                );
              })}
              {!alerts?.forecasts.length && (
                <li className="muted">
                  No reported limit windows to forecast.
                </li>
              )}
            </ol>
          </section>
          <section>
            <div className="section-title">
              <h2>Platform allowances</h2>
              <span>{platforms.length} subscriptions reporting · <button className="text-button" onClick={() => setSortRisk((value) => !value)}>{sortRisk ? "risk first" : "provider order"}</button></span>
            </div>
            <Button onClick={() => void refreshCollectors()}>
              Refresh collectors
            </Button>
            {notice && (
              <p className="notice" role="status">
                {notice}
              </p>
            )}
            <div className="table-scroll">
              <table className="limits-table">
                <caption className="sr-only">
                  Usage limits per platform. {tableSummary}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Platform</th>
                    <th scope="col">Session</th>
                    <th scope="col">Weekly</th>
                    <th scope="col">Monthly</th>
                    <th scope="col">Balance</th>
                    <th scope="col">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {!platforms.length && Array.from({ length: 6 }, (_, index) => (
                    <tr key={`platform-skeleton-${index}`} aria-hidden={index ? true : undefined}>
                      <td colSpan={6}>
                        {!index && <span className="sr-only">Loading subscriptions</span>}
                        <Sk w={index % 2 ? 136 : 180} />
                      </td>
                    </tr>
                  ))}
                  {platforms.map((p) => (
                    <tr key={p.providerId}>
                      <th scope="row" className="provider">
                        <Mark id={p.providerId} />
                        <span>
                          <b>{p.providerName}</b>
                          <small>
                            {p.tier || (p.balance ? "Prepaid" : "Subscription")}
                          </small>
                        </span>
                        <Status
                          tone={
                            p.status === "ready"
                              ? "ok"
                              : p.status === "stale"
                                ? "warn"
                                : "error"
                          }
                        >
                          {p.status}
                        </Status>
                      </th>
                      {(["session", "weekly", "monthly"] as const).map((kind) => {
                        const wins = p.windows.filter((w) => w.kind === kind);
                        const worst = wins.reduce(
                          (acc, w) => Math.max(acc, w.used),
                          0,
                        );
                        return (
                          <td
                            key={kind}
                            className={`limit-cell ${limitTone(worst)}`}
                            data-label={kind}
                          >
                            {wins.length ? (
                              wins.map((w, i) => (
                                <LimitMeter
                                  key={`${w.title}-${i}`}
                                  window={w}
                                  providerId={p.providerId}
                                  nowMs={nowMs}
                                  titled={wins.length > 1}
                                />
                              ))
                            ) : (
                              <small className="limit-reset">
                                {p.windows.length ? "not reported" : "—"}
                              </small>
                            )}
                          </td>
                        );
                      })}
                      <td className="balance">
                        {p.balance
                          ? `$${p.balance.remaining.toFixed(2)}${
                              p.balance.funded
                                ? ` / $${p.balance.funded.toFixed(2)}`
                                : ""
                            }${p.balance.estimated ? " est." : ""}`
                          : "—"}
                      </td>
                      <td className="updated">
                        {p.updatedAt
                          ? new Date(p.updatedAt).toLocaleString()
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <div className="section-title"><h2>Reset timeline</h2><span>earliest recovery first</span></div>
            <ol className="reset-timeline">
              {resets.length ? resets.map((window, index) => {
                const resetMs = window.resetsAt ? Date.parse(window.resetsAt) - nowMs : null;
                const state = !window.resetsAt ? "unknown reset" : resetMs != null && resetMs <= 0 ? "awaiting refresh" : `in ${duration(resetMs!)}`;
                return <li key={`${window.providerName}-${window.title}-${index}`}><strong>{window.providerName}</strong><span>{window.title}</span><Status tone={window.status === "ready" ? (resetMs != null && resetMs <= 0 ? "warn" : "ok") : "error"}>{state}</Status></li>;
              }) : <li className="muted">No reset windows reported; capacity is unknown.</li>}
            </ol>
          </section>
          <section>
            <div className="section-title">
              <h2>Platform advisor</h2>
              <span>
                {task
                  ? `fit and cost estimated for a ${task} task`
                  : "ranked by usable headroom right now"}
              </span>
            </div>
            <ol className="advice-list">
              {(advice?.rows ?? []).map((row) => (
                <AdviceRowView key={row.providerId} row={row} />
              ))}
            </ol>
          </section>
          <section>
            <div className="section-title">
              <h2>API reference rates</h2>
              <span>USD per million tokens</span>
            </div>
            {overrideError && (
              <p className="notice error" role="status">
                pricing.json could not be read ({overrideError}); built-in
                rates apply.
              </p>
            )}
            <div className="table-scroll">
              <table className="price-table">
                <caption className="sr-only">
                  Reference API rates per model family in US dollars per
                  million tokens.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Input</th>
                    <th scope="col">Output</th>
                    <th scope="col">Cache read</th>
                    <th scope="col">Cache write</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {(pricing ?? []).map((entry) => (
                    <tr key={entry.model}>
                      <th scope="row">{entry.model}</th>
                      <td>${entry.inputPerMtok}</td>
                      <td>${entry.outputPerMtok}</td>
                      <td>${entry.cacheReadPerMtok}</td>
                      <td>${entry.cacheWritePerMtok}</td>
                      <td>
                        <span className={`source ${entry.source}`}>
                          {entry.source}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint-line">
              Models absent here are unpriced — the advisor labels their cost
              unknown instead of guessing. Override or extend rates via{" "}
              <code>~/.config/omarchy-agents/pricing.json</code>.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

const calendarShift = (day: string, amount: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};

function DailyBars({
  label,
  values,
  formatValue,
  tone,
}: {
  label: string;
  values: Array<{ day: string; value: number }>;
  formatValue: (value: number) => string;
  tone: "tokens" | "commits" | "tasks";
}) {
  const width = 900, height = 96, top = 8, bottom = 20;
  const max = Math.max(1, ...values.map((point) => point.value));
  const slot = width / Math.max(1, values.length);
  const barWidth = Math.max(1, slot - Math.min(4, slot * 0.25));
  const total = values.reduce((sum, point) => sum + point.value, 0);
  return (
    <figure className={`daily-bars ${tone}`}>
      <figcaption>
        <strong>{label}</strong>
        <span>{formatValue(total)} total · {formatValue(max)} daily peak</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} by day. ${formatValue(total)} total and ${formatValue(max)} daily peak.`}
      >
        <line x1="0" y1={height - bottom} x2={width} y2={height - bottom} className="chart-rule" />
        {values.map((point, index) => {
          const barHeight = point.value ? Math.max(2, (point.value / max) * (height - top - bottom)) : 1;
          return (
            <rect
              key={point.day}
              x={index * slot + (slot - barWidth) / 2}
              y={height - bottom - barHeight}
              width={barWidth}
              height={barHeight}
            >
              <title>{point.day}: {formatValue(point.value)}</title>
            </rect>
          );
        })}
      </svg>
    </figure>
  );
}

function CorrelationPlot({ title, points, tone }: {
  title: string;
  points: ProductivityResponse["correlations"]["tokensCommits"];
  tone: "commits" | "tasks";
}) {
  const width = 520, height = 220, left = 42, right = 12, top = 18, bottom = 32;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maxTokens = Math.max(1, ...points.map((point) => point.tokens));
  const maxCount = Math.max(1, ...points.map((point) => point.count));
  const active = points.filter((point) => point.tokens > 0 || point.count > 0).length;
  return (
    <figure className={`correlation-plot ${tone}`}>
      <figcaption><strong>{title}</strong><span>{active} active days · tokens on x-axis</span></figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}. ${active} active days plotted with tokens on the horizontal axis and activity count on the vertical axis.`}>
        <line x1={left} y1={top} x2={left} y2={height - bottom} className="chart-rule" />
        <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} className="chart-rule" />
        <text x={left - 8} y={top + 4} textAnchor="end" className="chart-label">{maxCount}</text>
        <text x={left - 8} y={height - bottom + 4} textAnchor="end" className="chart-label">0</text>
        <text x={left} y={height - 8} className="chart-label">0</text>
        <text x={width - right} y={height - 8} textAnchor="end" className="chart-label">{maxTokens.toLocaleString()}</text>
        {points.map((point) => <circle key={point.day} cx={left + (point.tokens / maxTokens) * plotWidth} cy={height - bottom - (point.count / maxCount) * plotHeight} r={point.tokens || point.count ? 3.5 : 2} className="correlation-point"><title>{point.day}: {point.tokens.toLocaleString()} tokens, {point.count} {tone}</title></circle>)}
        <text x={width / 2} y={height - 1} textAnchor="middle" className="chart-label">tokens</text>
        <text x="11" y={height / 2} textAnchor="middle" transform={`rotate(-90 11 ${height / 2})`} className="chart-label">{tone}</text>
      </svg>
      <table className="sr-only"><caption>{title} exact daily values</caption><thead><tr><th>Day</th><th>Tokens</th><th>{tone}</th></tr></thead><tbody>{points.map((point) => <tr key={point.day}><th>{point.day}</th><td>{point.tokens}</td><td>{point.count}</td></tr>)}</tbody></table>
    </figure>
  );
}

const sourceTone = (status: ProductivityResponse["sources"][number]["status"]) =>
  status === "fresh" || status === "empty"
    ? "ok"
    : status === "stale" || status === "rate-limited"
      ? "warn"
      : "error";

function SourceLedger({ sources }: { sources: ProductivityResponse["sources"] }) {
  return (
    <div className="source-ledger">
      {sources.map((source) => (
        <div key={source.id} className="source-row">
          <div><strong>{source.name}</strong><span>{source.recordCount} cached records</span></div>
          <Status tone={sourceTone(source.status)}>{source.status}</Status>
          <span>{source.coverage ? `${source.coverage.from}—${source.coverage.to}` : "coverage unavailable"}</span>
          <time dateTime={source.lastSyncedAt ?? undefined}>{source.lastSyncedAt ? new Date(source.lastSyncedAt).toLocaleString() : "never synced"}</time>
          {source.error && <p>{source.error}</p>}
        </div>
      ))}
    </div>
  );
}

function SourceSyncView() {
  const [data, setData] = useState<ProductivityResponse | null>(null),
    [loading, setLoading] = useState(true),
    [syncing, setSyncing] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api<ProductivityResponse>("/limits/api/productivity"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const sync = async () => {
    setSyncing(true);
    setNotice("Synchronizing GitHub and Linear on the server…");
    try {
      const result = await api<{ sources: ProductivityResponse["sources"] }>("/limits/api/productivity/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      await load();
      const unavailable = result.sources.filter((source) => source.status !== "fresh" && source.status !== "empty");
      setNotice(unavailable.length
        ? `Sync finished with source warnings: ${unavailable.map((source) => `${source.name} is ${source.status}`).join("; ")}. Last successful cache remains available where present.`
        : "GitHub and Linear cache is up to date.");
    } catch (caught) {
      setNotice(`Sync could not finish: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="source-sync-view" aria-busy={loading}>
      <header className="pagehead productivity-head">
        <div>
          <h1>Source sync</h1>
          <p>Review cached GitHub and Linear coverage. External services are contacted only by the server.</p>
        </div>
        <Button onClick={() => void sync()} disabled={syncing}>{syncing ? "Syncing sources…" : "Sync sources"}</Button>
      </header>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="notice error" role="alert">{error} Check source configuration, then try again.</p>}
      {loading && !data && <section className="productivity-loading" aria-label="Loading source status"><Sk w={240} /><Sk w={520} /></section>}
      {data && (
        <section aria-labelledby="source-state-title">
          <div className="section-title"><h2 id="source-state-title">Source state</h2><span>cached reads · six-hour server refresh</span></div>
          <SourceLedger sources={data.sources} />
        </section>
      )}
    </div>
  );
}

function ActivityDetailView() {
  const requestedRange = Number(new URLSearchParams(window.location.search).get("range"));
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>([7, 30, 90].includes(requestedRange) ? requestedRange as 7 | 30 | 90 : 30),
    [data, setData] = useState<ProductivityActivityResponse | null>(null),
    [repo, setRepo] = useState(new URLSearchParams(window.location.search).get("repo") ?? ""),
    [team, setTeam] = useState(new URLSearchParams(window.location.search).get("team") ?? ""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");

  const writeUrl = (days: 7 | 30 | 90, nextRepo = repo, nextTeam = team) => {
    const params = new URLSearchParams(window.location.search);
    params.set("view", "activity");
    params.set("range", String(days));
    nextRepo.trim() ? params.set("repo", nextRepo.trim()) : params.delete("repo");
    nextTeam.trim() ? params.set("team", nextTeam.trim()) : params.delete("team");
    window.history.replaceState({}, "", `${window.location.pathname}?${params}`);
  };

  const load = async (days: 7 | 30 | 90, nextRepo = repo, nextTeam = team, updateUrl = false) => {
    setLoading(true);
    setError("");
    try {
      const anchor = await api<ProductivityActivityResponse>("/limits/api/productivity/activity");
      const query = new URLSearchParams({
        from: days === 30 ? anchor.range.from : calendarShift(anchor.range.to, -(days - 1)),
        to: anchor.range.to,
      });
      if (nextRepo.trim()) query.set("repo", nextRepo.trim());
      if (nextTeam.trim()) query.set("team", nextTeam.trim());
      const next = days === 30 && !nextRepo.trim() && !nextTeam.trim()
        ? anchor
        : await api<ProductivityActivityResponse>(`/limits/api/productivity/activity?${query}`);
      setData(next);
      setRangeDays(days);
      setRepo(nextRepo);
      setTeam(nextTeam);
      if (updateUrl) writeUrl(days, nextRepo, nextTeam);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(rangeDays, repo, team); }, []);

  const applyFilters = () => void load(rangeDays, repo, team, true);
  const changeRange = (days: 7 | 30 | 90) => { if (!loading) void load(days, repo, team, true); };
  const fmtDate = (value: string) => new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  return (
    <div className="activity-view" aria-busy={loading}>
      <header className="pagehead productivity-head">
        <div>
          <h1>Activity detail</h1>
          <p>Inspect the public records behind the productivity comparison. No session-to-repository attribution is inferred.</p>
        </div>
      </header>
      <div className="activity-controls">
        <div className="segmented" role="group" aria-label="Activity range">
          {([7, 30, 90] as const).map((days) => <button key={days} aria-pressed={rangeDays === days} disabled={loading} onClick={() => changeRange(days)}>{days} days</button>)}
        </div>
        <label>Repository<input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="owner/repository" /></label>
        <label>Linear team<input value={team} onChange={(event) => setTeam(event.target.value)} placeholder="team name or ID" /></label>
        <Button onClick={applyFilters} disabled={loading}>Apply filters</Button>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {data && <div className="activity-grid">
        <section aria-labelledby="commit-detail-title">
          <div className="section-title"><h2 id="commit-detail-title">Public commits</h2><span>{data.commits.length} records · {data.range.from}—{data.range.to}</span></div>
          <div className="activity-list">
            {data.commits.length ? data.commits.map((commit) => <article key={commit.sha}><div><strong>{commit.repository}</strong><span>{commit.sha.slice(0, 10)} · {fmtDate(commit.committedAt)}</span></div><a href={commit.url} target="_blank" rel="noreferrer">Open commit</a></article>) : <p>No public commits match these filters.</p>}
          </div>
        </section>
        <section aria-labelledby="task-detail-title">
          <div className="section-title"><h2 id="task-detail-title">Completed Linear tasks</h2><span>{data.tasks.length} records · {data.range.from}—{data.range.to}</span></div>
          <div className="activity-list">
            {data.tasks.length ? data.tasks.map((task) => <article key={task.issueId}><div><strong>{task.identifier} · {task.title}</strong><span>{task.team} · {fmtDate(task.completedAt)}</span></div>{task.url && <a href={task.url} target="_blank" rel="noreferrer">Open task</a>}</article>) : <p>No completed tasks match these filters.</p>}
          </div>
        </section>
      </div>}
    </div>
  );
}

function ProductivityView() {
  const requestedRange = Number(new URLSearchParams(window.location.search).get("range"));
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>([7, 30, 90].includes(requestedRange) ? requestedRange as 7 | 30 | 90 : 30),
    [data, setData] = useState<ProductivityResponse | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");

  const writeRangeToUrl = (days: 7 | 30 | 90) => {
    const params = new URLSearchParams(window.location.search);
    params.set("view", "productivity");
    params.set("range", String(days));
    window.history.replaceState({}, "", `${window.location.pathname}?${params}`);
  };

  const load = async (days: 7 | 30 | 90, baseline = data, updateUrl = false) => {
    setLoading(true);
    setError("");
    try {
      const anchor = baseline ?? await api<ProductivityResponse>("/limits/api/productivity");
      const path = days === 30
        ? "/limits/api/productivity"
        : `/limits/api/productivity?from=${calendarShift(anchor.range.to, -(days - 1))}&to=${anchor.range.to}`;
      const next = days === 30 && !baseline ? anchor : await api<ProductivityResponse>(path);
      setData(next);
      setRangeDays(days);
      if (updateUrl) writeRangeToUrl(days);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(baseline ? `${message} Showing retained data for ${baseline.range.from}—${baseline.range.to}; the selected range did not load.` : message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(rangeDays); }, []);

  const changeRange = (days: 7 | 30 | 90) => {
    if (days !== rangeDays && !loading) void load(days, data, true);
  };

  const fmtExact = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
  const formatRatio = (value: number | null) => value == null ? "Unavailable" : `${fmt.format(value)} tokens`;
  const start = data?.range.from ? new Date(`${data.range.from}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  const end = data?.range.to ? new Date(`${data.range.to}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
  const middleDay = data?.tokens.daily[Math.floor((data.tokens.daily.length - 1) / 2)]?.day;
  const middle = middleDay ? new Date(`${middleDay}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";

  return (
    <div className="productivity-view" aria-busy={loading}>
      <header className="pagehead productivity-head">
        <div>
          <h1>Tokens vs productivity</h1>
          <p>Daily token use beside public commits and completed Linear tasks. This is descriptive evidence, not a productivity score.</p>
        </div>
      </header>
      <div className="productivity-controls">
        <div className="segmented" role="group" aria-label="Comparison range">
          {([7, 30, 90] as const).map((days) => (
            <button key={days} aria-pressed={rangeDays === days} disabled={loading} onClick={() => changeRange(days)}>{days} days</button>
          ))}
        </div>
        {data && <span>{data.range.from}—{data.range.to} · {data.range.timeZone}</span>}
      </div>
      {error && <p className="notice error" role="alert">{error} Check source configuration, then try again.</p>}
      {loading && !data && <section className="productivity-loading" aria-label="Loading comparison"><Sk w={240} /><Sk w={520} /><Sk w={420} /></section>}
      {data && (
        <>
          <section aria-labelledby="productivity-totals-title">
            <h2 id="productivity-totals-title" className="sr-only">Range totals</h2>
            <dl className="productivity-totals">
              <div><dt>Indexed tokens</dt><dd>{fmtExact(data.tokens.total)}</dd></div>
              <div><dt>Public commits</dt><dd>{fmtExact(data.commits.total)}</dd></div>
              <div><dt>Completed tasks</dt><dd>{fmtExact(data.tasks.total)}</dd></div>
            </dl>
          </section>
          <section aria-labelledby="daily-comparison-title">
            <div className="section-title"><h2 id="daily-comparison-title">Daily comparison</h2><span>shared dates · independent scales</span></div>
            <div className="daily-series">
              <DailyBars label="Tokens" tone="tokens" values={data.tokens.daily.map((row) => ({ day: row.day, value: row.tokens }))} formatValue={(value) => fmt.format(value)} />
              <DailyBars label="Commits" tone="commits" values={data.commits.daily.map((row) => ({ day: row.day, value: row.count }))} formatValue={fmtExact} />
              <DailyBars label="Tasks" tone="tasks" values={data.tasks.daily.map((row) => ({ day: row.day, value: row.count }))} formatValue={fmtExact} />
              <div className="shared-axis" aria-hidden="true"><span>{start}</span><span>{middle}</span><span>{end}</span></div>
            </div>
            <table className="sr-only">
              <caption>Exact daily tokens, commits, and completed tasks</caption>
              <thead><tr><th>Day</th><th>Tokens</th><th>Commits</th><th>Completed tasks</th></tr></thead>
              <tbody>{data.tokens.daily.map((row, index) => <tr key={row.day}><th>{row.day}</th><td>{row.tokens}</td><td>{data.commits.daily[index]?.count ?? 0}</td><td>{data.tasks.daily[index]?.count ?? 0}</td></tr>)}</tbody>
            </table>
          </section>
          <section aria-labelledby="correlations-title">
            <div className="section-title"><h2 id="correlations-title">Token correlations</h2><span>one dot per day · descriptive only</span></div>
            <div className="correlation-grid">
              <CorrelationPlot title="Tokens ↔ commits" tone="commits" points={data.correlations.tokensCommits} />
              <CorrelationPlot title="Tokens ↔ completed tasks" tone="tasks" points={data.correlations.tokensTasks} />
            </div>
            <p className="noncausal-note">Dots show daily co-occurrence, not attribution or causation. Hover a dot for its exact date and values.</p>
          </section>
          <section className="ratio-band" aria-labelledby="ratios-title">
            <div><h2 id="ratios-title">Descriptive ratios</h2><p>Normalized against activity counts in this range.</p></div>
            <dl><div><dt>Tokens per commit</dt><dd>{formatRatio(data.ratios.tokensPerCommit)}</dd></div><div><dt>Tokens per task</dt><dd>{formatRatio(data.ratios.tokensPerTask)}</dd></div></dl>
            <p className="noncausal-note"><strong>Non-causal.</strong> These ratios do not measure quality, attribute work to a session, or show that token use caused an outcome.</p>
          </section>
          <section aria-labelledby="breakdowns-title">
            <div className="section-title"><h2 id="breakdowns-title">Activity breakdowns</h2><span>cached source records in range</span></div>
            <div className="breakdown-grid">
              <div className="breakdown"><h3>GitHub repositories</h3>{data.commits.repos.length ? <ol>{data.commits.repos.map((repo) => <li key={repo.repository}><span>{repo.repository}</span><b>{repo.count}</b></li>)}</ol> : <p>No public commits recorded for this range.</p>}</div>
              <div className="breakdown"><h3>Linear teams</h3>{data.tasks.teams.length ? <ol>{data.tasks.teams.map((team) => <li key={team.id}><span>{team.team}</span><b>{team.count}</b></li>)}</ol> : <p>No completed tasks recorded for this range.</p>}</div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Limits() {
  type PortalView = "limits" | "productivity" | "activity" | "sources";
  const viewFromUrl = (): PortalView => {
    const value = new URLSearchParams(window.location.search).get("view");
    return value === "productivity" || value === "activity" || value === "sources" ? value : "limits";
  };
  const [view, setView] = useState<PortalView>(viewFromUrl);
  useEffect(() => {
    const sync = () => setView(viewFromUrl());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const select = (next: PortalView) => {
    const params = new URLSearchParams(window.location.search);
    if (next === "limits") { params.delete("view"); params.delete("range"); }
    else {
      params.set("view", next);
      if (next === "sources") params.delete("range");
    }
    const query = params.toString();
    window.history.pushState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    setView(next);
  };
  const moveTab = (event: React.KeyboardEvent, current: PortalView) => {
    const order: PortalView[] = ["limits", "productivity", "activity", "sources"];
    const index = order.indexOf(current);
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (index + 1) % order.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (index + order.length - 1) % order.length
        : event.key === "Home" ? 0 : event.key === "End" ? order.length - 1 : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = order[nextIndex];
    select(next);
    requestAnimationFrame(() => document.getElementById(`${next}-tab`)?.focus());
  };
  return (
    <div className="limits">
      <div className="portal-tabs" role="tablist" aria-label="Limits portal views">
        <button id="limits-tab" role="tab" tabIndex={view === "limits" ? 0 : -1} aria-selected={view === "limits"} aria-controls="limits-panel" onKeyDown={(event) => moveTab(event, "limits")} onClick={() => select("limits")}>Limits</button>
        <button id="productivity-tab" role="tab" tabIndex={view === "productivity" ? 0 : -1} aria-selected={view === "productivity"} aria-controls="productivity-panel" onKeyDown={(event) => moveTab(event, "productivity")} onClick={() => select("productivity")}>Productivity</button>
        <button id="activity-tab" role="tab" tabIndex={view === "activity" ? 0 : -1} aria-selected={view === "activity"} aria-controls="activity-panel" onKeyDown={(event) => moveTab(event, "activity")} onClick={() => select("activity")}>Activity detail</button>
        <button id="sources-tab" role="tab" tabIndex={view === "sources" ? 0 : -1} aria-selected={view === "sources"} aria-controls="sources-panel" onKeyDown={(event) => moveTab(event, "sources")} onClick={() => select("sources")}>Source sync</button>
      </div>
      <div id={`${view}-panel`} role="tabpanel" aria-labelledby={`${view}-tab`}>
        {view === "limits" ? <LimitsBoardView /> : view === "productivity" ? <ProductivityView /> : view === "activity" ? <ActivityDetailView /> : <SourceSyncView />}
      </div>
    </div>
  );
}

function Settings() {
  const [health, setHealth] = useState<any>(null),
    [notice, setNotice] = useState("");
  const load = async () => {
    try {
      setHealth(await api<any>("/api/health"));
    } catch (error) {
      setNotice(`Health check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const mutate = async (path: string) => {
    setNotice("Starting…");
    try {
      await api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (path === "/api/analysis/run") {
        setNotice("Analysis complete. The analyst brief is up to date.");
        window.dispatchEvent(new Event("analysis:complete"));
      } else {
        setNotice("Started. Progress will update in Health.");
      }
      window.setTimeout(() => void load(), 700);
    } catch (error) {
      setNotice(`Could not start operation: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (
    <div className="settings">
      <header className="pagehead">
        <h1>System settings</h1>
        <p>
          {health
            ? "Local sources, model readiness, and safe maintenance controls."
            : "Checking local services and index state…"}
        </p>
      </header>
      <section aria-busy={!health}>
        <h2>Index</h2>
        <dl>
          <div>
            <dt>State</dt>
            <dd>
              <Status tone={health?.index?.state === "ready" ? "ok" : "warn"}>
                {health?.index?.state ?? "checking"}
              </Status>
            </dd>
          </div>
          <div>
            <dt>Files scanned</dt>
            <dd>
              {health?.index?.scanned ?? "—"} / {health?.index?.total ?? "—"}
            </dd>
          </div>
          <div>
            <dt>Indexed this pass</dt>
            <dd>{health?.index?.indexed ?? "—"}</dd>
          </div>
          <div>
            <dt>Errors isolated</dt>
            <dd>{health?.index?.errors ?? "—"}</dd>
          </div>
        </dl>
        <div className="actions">
          <Button onClick={() => mutate("/api/refresh")}>
            Refresh collectors
          </Button>
          <Button onClick={() => mutate("/api/index/rebuild")}>
            Rebuild index
          </Button>
        </div>
      </section>
      <section>
        <h2>Ollama</h2>
        <dl>
          <div>
            <dt>Readiness</dt>
            <dd>
              <Status tone={health?.model?.ready ? "ok" : "warn"}>
                {health?.model?.ready ? "Ready" : "Unavailable"}
              </Status>
            </dd>
          </div>
          <div>
            <dt>Selected model</dt>
            <dd>{health?.model?.selected ?? "Checking…"}</dd>
          </div>
          <div>
            <dt>Latency</dt>
            <dd>{health?.model?.latencyMs ?? "—"} ms</dd>
          </div>
          <div>
            <dt>Fallback</dt>
            <dd>{health?.model?.fallback ? "Active" : "Standby"}</dd>
          </div>
        </dl>
        <Button onClick={() => mutate("/api/analysis/run")}>
          Run analysis now
        </Button>
      </section>
      <section>
        <h2>Privacy boundary</h2>
        <p>
          Raw logs and the SQLite index stay on this machine. Secret-like
          strings are removed before persistence. Remote traffic passes through
          Cloudflare Access, while the local analyst receives only redacted
          indexed evidence. Refresh and analysis endpoints expose fixed
          operations—never a shell.
        </p>
      </section>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}

function App() {
  const [nav, setNav] = useState<Nav>(() => navFromPath()),
    [rail, setRail] = useState(false),
    [railCollapsed, setRailCollapsed] = useState(false),
    [compactLayout, setCompactLayout] = useState(false);
  const railRef = useRef<HTMLElement>(null);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const labels: { id: Nav; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "logs", label: "Logs" },
    { id: "analyst", label: "Analyst" },
    { id: "settings", label: "Settings" },
    { id: "limits", label: "Limits" },
  ];
  useEffect(() => {
    const query = matchMedia("(max-width: 1100px)");
    const sync = () => setCompactLayout(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    const sync = () => setNav(navFromPath());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const navigate = (next: Nav) => {
    if (next !== nav) window.history.pushState({}, "", navPaths[next]);
    setNav(next);
    setRail(false);
  };
  const openRail = () => {
    returnFocus.current = document.activeElement as HTMLElement;
    if (compactLayout) setRail(true);
    else setRailCollapsed(false);
    requestAnimationFrame(() =>
      railRef.current?.querySelector<HTMLElement>("button,textarea")?.focus(),
    );
  };
  const closeRail = () => {
    if (compactLayout) {
      setRail(false);
      requestAnimationFrame(() => returnFocus.current?.focus());
    } else {
      setRailCollapsed(true);
      requestAnimationFrame(() => railToggleRef.current?.focus());
    }
  };
  const trapRail = (event: React.KeyboardEvent) => {
    if (!compactLayout) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeRail();
      return;
    }
    if (event.key !== "Tab" || !railRef.current) return;
    const items = [
      ...railRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled),textarea:not(:disabled),a[href]",
      ),
    ];
    if (!items.length) return;
    const first = items[0],
      last = items.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const railHidden = compactLayout ? !rail : railCollapsed;
  return (
    <div
      className={`shell ${nav === "analyst" || railCollapsed ? "without-rail" : ""} ${nav === "limits" ? "limits-shell" : ""}`}
    >
      <a href="#main" className="skip">
        Skip to content
      </a>
      <aside className="nav">
        <div className="brand">
          <img src="/provider-assets/trophy.svg" alt="" />
          <span>
            Agent
            <br />
            Leaderboard
          </span>
        </div>
        <nav aria-label="Primary">
          {labels.map((x) => (
            <button
              key={x.id}
              aria-current={nav === x.id ? "page" : undefined}
              onClick={() => navigate(x.id)}
            >
              <i>
                <NavIcon id={x.id} />
              </i>
              <span>{x.label}</span>
            </button>
          ))}
        </nav>
        <div className="local">
          <Status>Local first</Status>
          <small>127.0.0.1:4317</small>
        </div>
      </aside>
      <main id="main">
        <div
          className="direction-contract sr-only"
          data-form-seed="established-omarchy-console/control-room-a"
        >
          THESIS: local activity becomes inspectable evidence. OWN-WORLD:
          Omarchy console. STORY: compare, inspect, ask, decide. FIRST VIEWPORT:
          standings and advisory rail. FORM: ruled control room.
        </div>
        {nav !== "analyst" && (nav !== "overview" || railCollapsed) && (
          <button
            ref={railToggleRef}
            className={`rail-toggle rail-toggle-global ${railCollapsed ? "rail-toggle-collapsed" : ""}`}
            onClick={openRail}
            aria-expanded={compactLayout ? rail : !railCollapsed}
            aria-controls="analyst-rail"
          >
            Open analyst
          </button>
        )}
        {nav === "overview" && (
          <Overview
            openRail={openRail}
            railOpen={compactLayout ? rail : !railCollapsed}
          />
        )}{" "}
        {nav === "logs" && <Logs />}
        {nav === "analyst" && <Analyst />}
        {nav === "settings" && <Settings />}
        {nav === "limits" && <Limits />}
      </main>
      {nav !== "analyst" && (
        <aside
          id="analyst-rail"
          ref={railRef}
          className={`rail ${rail ? "open" : ""} ${railCollapsed ? "collapsed" : ""}`}
          inert={railHidden ? "" : undefined}
          aria-hidden={railHidden ? true : undefined}
          onKeyDown={trapRail}
        >
          <button
            className="rail-close"
            onClick={closeRail}
            aria-label={compactLayout ? "Close analyst" : "Collapse analyst"}
          >
            {compactLayout ? "Close" : "Collapse analyst"}
          </button>
          <Analyst compact />
        </aside>
      )}
      <div className={`scrim ${rail ? "show" : ""}`} onClick={closeRail} />
      <nav className="mobile-nav" aria-label="Mobile primary">
        {labels
          .filter((x) => x.id !== "limits")
          .map((x) => (
            <button
              key={x.id}
              aria-current={nav === x.id ? "page" : undefined}
              onClick={() => navigate(x.id)}
            >
              {x.label}
            </button>
          ))}
      </nav>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
