// @ts-nocheck -- Visx's generic stack inference and fire-and-forget effects are validated at runtime.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Group } from "@visx/group";
import { BarStack } from "@visx/shape";
import { scaleBand, scaleLinear, scaleOrdinal } from "@visx/scale";
import "./styles.css";

type Nav = "overview" | "logs" | "analyst" | "settings";
type BoardRow = {
  providerId: string;
  providerName: string;
  tokens: number;
  rank: number;
  share: number;
  coverage: string;
  updatedAt: string;
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

function HistoryChart({ rows }: { rows: any[] }) {
  if (!rows.length)
    return (
      <div className="chart-empty">
        <strong>Indexed activity</strong>
        <span>
          History will appear as transcript sessions are indexed. Rankings above
          remain available from usage collectors.
        </span>
      </div>
    );
  const width = 760,
    height = 250,
    margin = { top: 20, right: 10, bottom: 34, left: 48 };
  const providers = [...new Set(rows.map((r) => r.provider))] as string[],
    days = [...new Set(rows.map((r) => r.day))] as string[];
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
  const color = scaleOrdinal({
    domain: providers,
    range: providers.map((p) => colors[p] ?? "#77838d"),
  });
  return (
    <figure className="chart">
      <figcaption>
        <strong>Indexed activity</strong>
        <span>
          {days.length
            ? `${days[0]} — ${days.at(-1)}`
            : "Waiting for indexed sessions"}
        </span>
      </figcaption>
      <svg
        role="img"
        aria-label={`Stacked token totals over ${days.length} days for ${providers.join(", ") || "no providers"}`}
        viewBox={`0 0 ${width} ${height}`}
      >
        <Group left={margin.left} top={margin.top}>
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
                stack.bars.map((bar) => (
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
                      {stack.key}: {fmt.format(bar.bar.data[stack.key])} tokens
                    </title>
                  </rect>
                )),
              )
            }
          </BarStack>
          {days.map(
            (d, i) =>
              (i % Math.ceil(days.length / 7) === 0 ||
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
        Token volume by day. Use the sessions table for exact values and
        supporting logs.
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
  const [period, setPeriod] = useState("week"),
    [board, setBoard] = useState<any>({
      rows: [],
      total: 0,
      freshness: [],
      index: { state: "idle" },
    }),
    [series, setSeries] = useState<any[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    setError("");
    setLoading(true);
    Promise.all([
      api<any>(`/api/overview?period=${period}`),
      api<any>(
        `/api/timeseries?days=${period === "today" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 365}`,
      ),
    ])
      .then(([b, s]) => {
        setBoard(b);
        setSeries(s.rows);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [period]);
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
          View
          <select>
            <option>By provider</option>
            <option>By model</option>
          </select>
        </label>
        <label>
          Project
          <select>
            <option>All projects</option>
          </select>
        </label>
      </div>
      {error && (
        <div className="notice error" role="alert">
          <strong>Metrics could not be loaded.</strong>
          <span>{error}</span>
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
                <td className="share">
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
      <HistoryChart rows={series} />
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
    setLoading(true);
    api<any>(`/api/sessions?${query}`)
      .then(setData)
      .finally(() => setLoading(false));
  }, [filters.provider, filters.project, filters.errors]);
  useEffect(() => {
    if (selected)
      api<any>(`/api/sessions/${selected.id}/events`).then((r) =>
        setEvents(r.rows),
      );
  }, [selected]);
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
      </div>
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
          {!selected && (
            <div className="empty">
              <strong>Evidence opens here</strong>
              <span>
                Choose a session to inspect its redacted prompt, response, tool,
                and error events.
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
  const load = () => api<any>("/api/reports").then((r) => setReports(r.rows));
  useEffect(() => {
    void load();
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
  const load = () => api<any>("/api/health").then(setHealth);
  useEffect(load, []);
  const mutate = async (path: string) => {
    setNotice("Starting…");
    await api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    setNotice("Started. Progress will update in Health.");
    setTimeout(load, 700);
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
  const [nav, setNav] = useState<Nav>("overview"),
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
              onClick={() => setNav(x.id)}
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
            onClick={() => setNav(x.id)}
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
