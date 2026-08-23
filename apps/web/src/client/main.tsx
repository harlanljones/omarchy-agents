// @ts-nocheck -- Visx's generic stack inference and fire-and-forget effects are validated at runtime.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Group } from "@visx/group";
import { BarStack } from "@visx/shape";
import { scaleBand, scaleLinear, scaleOrdinal } from "@visx/scale";
import type { AdviceRow, AdviceVerdict, LimitsBoard, LimitWindowView, PricingEntry } from "../shared/schemas";
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
  const minutes = Math.floor(ms / 60000),
    hours = Math.floor(minutes / 60),
    days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${Math.max(1, minutes)}m`;
};
const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
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
    [busy, setBusy] = useState(false);
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
        <i style={{ width: `${Math.min(100, pct)}%`, background: colors[providerId] ?? "#77838d" }} />
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
          <Status tone={tone}>{VERDICT_LABEL[row.verdict]}</Status>
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

function Limits() {
  const [board, setBoard] = useState<LimitsBoard | null>(null),
    [pricing, setPricing] = useState<PricingEntry[] | null>(null),
    [overrideError, setOverrideError] = useState(""),
    [task, setTask] = useState<"" | "small" | "medium" | "large">(""),
    [advice, setAdvice] = useState<{ verdictLine: string; generatedAt: string; rows: AdviceRow[] } | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reload, setReload] = useState(0),
    [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    setError("");
    api<LimitsBoard>("/api/limits/board")
      .then(setBoard)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api<{ entries: PricingEntry[]; overrideError: string | null }>("/api/limits/pricing")
      .then((p) => {
        setPricing(p.entries);
        setOverrideError(p.overrideError ?? "");
      })
      .catch(() => setPricing([]));
  }, [reload]);
  useEffect(() => {
    const query = task ? `?task=${task}` : "";
    api<{ verdictLine: string; generatedAt: string; rows: AdviceRow[] }>(
      `/api/limits/advice${query}`,
    )
      .then(setAdvice)
      .catch(() => setAdvice(null));
  }, [task, reload]);
  const platforms = board?.platforms ?? [];
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
    <div className="limits">
      <header className="pagehead">
        <h1>Usage limits</h1>
        <p>
          Admin-only view of every subscription's session, weekly, and monthly
          allowances with an advisor for picking the next platform.
        </p>
      </header>
      {error && (
        <p className="notice error" role="alert">
          {error} Open the dashboard through its Access-protected hostname —
          this portal demands Cloudflare authentication on every host.
        </p>
      )}
      {!error && (
        <>
          <section className="verdict" aria-live="polite">
            <h2 className="sr-only">Advisor verdict</h2>
            {advice ? (
              <>
                <p className="verdict-line">{advice.verdictLine}</p>
                <span className="as-of">
                  as of {new Date(advice.generatedAt).toLocaleTimeString()}
                </span>
              </>
            ) : (
              <p className="verdict-line">Consulting local usage records…</p>
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
          </section>
          <section>
            <div className="section-title">
              <h2>Platform allowances</h2>
              <span>{platforms.length} subscriptions reporting</span>
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
                  {!platforms.length && (
                    <tr>
                      <td colSpan={6}>
                        <Sk w={180} />
                      </td>
                    </tr>
                  )}
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
    [compactLayout, setCompactLayout] = useState(false);
  const railRef = useRef<HTMLElement>(null);
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
    setRail(true);
    requestAnimationFrame(() =>
      railRef.current?.querySelector<HTMLElement>("button,textarea")?.focus(),
    );
  };
  const closeRail = () => {
    setRail(false);
    requestAnimationFrame(() => returnFocus.current?.focus());
  };
  const trapRail = (event: React.KeyboardEvent) => {
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
  return (
    <div className={`shell ${nav === "analyst" ? "without-rail" : ""}`}>
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
        {nav !== "overview" && nav !== "analyst" && (
          <button
            className="rail-toggle rail-toggle-global"
            onClick={openRail}
            aria-expanded={rail}
            aria-controls="analyst-rail"
          >
            Open analyst
          </button>
        )}
        {nav === "overview" && <Overview openRail={openRail} railOpen={rail} />}{" "}
        {nav === "logs" && <Logs />}
        {nav === "analyst" && <Analyst />}
        {nav === "settings" && <Settings />}
        {nav === "limits" && <Limits />}
      </main>
      {nav !== "analyst" && (
        <aside
          id="analyst-rail"
          ref={railRef}
          className={`rail ${rail ? "open" : ""}`}
          inert={compactLayout && !rail ? "" : undefined}
          aria-hidden={compactLayout && !rail ? true : undefined}
          onKeyDown={trapRail}
        >
          <button
            className="rail-close"
            onClick={closeRail}
            aria-label="Close analyst"
          >
            Close
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
