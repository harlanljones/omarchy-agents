// @ts-nocheck -- Visx's generic stack inference and fire-and-forget effects are validated at runtime.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Group } from "@visx/group";
import { BarStack } from "@visx/shape";
import { scaleBand, scaleLinear, scaleOrdinal } from "@visx/scale";
import "./styles.css";

type Nav = "overview" | "logs" | "analyst" | "settings";
const navPaths: Record<Nav, string> = {
  overview: "/overview",
  logs: "/logs",
  analyst: "/analyst",
  settings: "/settings",
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

function HistoryChart({
  rows,
  source = "indexed",
}: {
  rows: any[];
  source?: "collector" | "indexed";
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
    <figure className="chart">
      <figcaption>
        <div className="chart-heading">
          <strong id="activity-title">{activityName}</strong>
          <span>
            {days.length
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
    [loading, setLoading] = useState(true),
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
    setLoading(true);
    const projectQuery = project ? `&project=${encodeURIComponent(project)}` : "";
    Promise.all([
      api<any>(`/api/overview?period=${period}${projectQuery}`, { signal: controller.signal }),
      api<any>(
        `/api/timeseries?days=${period === "today" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 365}${projectQuery}`,
        { signal: controller.signal },
      ),
    ])
      .then(([b, s]) => {
        if (controller.signal.aborted) return;
        setBoard(b);
        setSeries({
          rows: s.rows,
          source: s.source === "collector" ? "collector" : "indexed",
        });
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        setBoard({ rows: [], total: 0, freshness: [], index: { state: "error" } });
        setSeries({ rows: [], source: "indexed" });
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    updateUrl(period, project);
    return () => controller.abort();
  }, [period, project, reload]);
  return (
    <div className="overview">
      <section className="scorehead">
        <div>
          <h1>Omarchy Agents</h1>
          <p>
            {loading
              ? "Loading collector metrics…"
              : `${fmt.format(board.total)} tokens across ${board.rows.length} active providers`}
          </p>
        </div>
        <div className="health">
          <Status tone={board.index?.state === "ready" ? "ok" : "warn"}>
            Index {board.index?.state}
          </Status>
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
          aria-busy={loading}
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
            {!loading && !board.rows.length && (
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
      <HistoryChart rows={series.rows} source={series.source} />
      <section className="coverage">
        <h2>Source coverage</h2>
        {board.freshness?.map((x: any) => (
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
            ? "Loading redacted session index…"
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
          className="sessionlist"
          ref={parent}
          aria-label="Sessions"
          aria-busy={loading}
        >
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
          {eventsLoading && <div className="empty"><strong>Loading evidence…</strong><span>Reading redacted session events.</span></div>}
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
        {labels.map((x) => (
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
