import React, { useEffect, useReducer, useRef, useState } from "react";
import type {
  ExperimentDetail, ExperimentOutcome, ExperimentSummary, MetricKind, Suggestion,
} from "../shared/schemas";

export type ExperimentRequest = <T,>(path: string, init?: RequestInit) => Promise<T>;
export type SessionRow = {
  id: string; provider: string; model: string | null; project: string | null; title: string | null;
  startedAt: string; endedAt: string | null; tokenInput: number; tokenOutput: number;
  cacheRead: number; cacheWrite: number; errorCount: number; toolCount: number;
};
export type ExperimentDraft = {
  hypothesis: string; metricKind: MetricKind; targetValue: number;
  baselineSessionIds: string[]; trialSessionIds: string[];
  note: string; outcome: ExperimentOutcome | null;
};
export type ExperimentUiState = {
  phase: "loading" | "ready" | "empty" | "error";
  summaries: ExperimentSummary[]; detail: ExperimentDetail | null; suggestion: Suggestion | null;
  sessions: SessionRow[]; sessionsTotal: number; loadError: string; saveError: string; busy: boolean;
  draft: ExperimentDraft;
};
export const initialExperimentUiState: ExperimentUiState = {
  phase: "loading", summaries: [], detail: null, suggestion: null, sessions: [], sessionsTotal: 0,
  loadError: "", saveError: "", busy: false,
  draft: { hypothesis: "", metricKind: "tool_failure_rate", targetValue: 0.1, baselineSessionIds: [], trialSessionIds: [], note: "", outcome: null },
};
type Action =
  | { type: "loading" }
  | { type: "loaded"; summaries: ExperimentSummary[]; detail: ExperimentDetail | null; suggestion: Suggestion | null; sessions: SessionRow[]; sessionsTotal: number }
  | { type: "load_failed"; message: string }
  | { type: "patch_draft"; value: Partial<ExperimentDraft> }
  | { type: "saving" }
  | { type: "persisted"; detail: ExperimentDetail }
  | { type: "saved"; detail: ExperimentDetail }
  | { type: "save_failed"; message: string }
  | { type: "append_sessions"; rows: SessionRow[]; total: number };

export function experimentReducer(state: ExperimentUiState, action: Action): ExperimentUiState {
  if (action.type === "loading") return { ...state, phase: "loading", loadError: "" };
  if (action.type === "loaded") {
    const defaults = action.suggestion?.experiment;
    return {
      ...state, phase: action.detail || action.suggestion ? "ready" : "empty",
      summaries: action.summaries, detail: action.detail, suggestion: action.suggestion,
      sessions: action.sessions, sessionsTotal: action.sessionsTotal, loadError: "", saveError: "",
      draft: action.detail ? {
        ...state.draft, hypothesis: action.detail.hypothesis, metricKind: action.detail.metricKind,
        targetValue: action.detail.targetValue, baselineSessionIds: action.detail.cohorts.baseline,
        trialSessionIds: action.detail.cohorts.trial,
      } : defaults ? {
        ...state.draft, hypothesis: defaults.hypothesis, metricKind: defaults.metricKind,
        targetValue: defaults.targetValue, baselineSessionIds: [], trialSessionIds: [],
      } : state.draft,
    };
  }
  if (action.type === "load_failed") return { ...state, phase: "error", loadError: action.message };
  if (action.type === "patch_draft") return { ...state, draft: { ...state.draft, ...action.value } };
  if (action.type === "saving") return { ...state, busy: true, saveError: "" };
  if (action.type === "persisted") return {
    ...state, detail: action.detail,
    draft: { ...state.draft, baselineSessionIds: action.detail.cohorts.baseline, trialSessionIds: action.detail.cohorts.trial },
  };
  if (action.type === "saved") return {
    ...state, busy: false, saveError: "", detail: action.detail,
    suggestion: action.detail.state === "draft" ? state.suggestion : null,
    draft: { ...state.draft, baselineSessionIds: action.detail.cohorts.baseline, trialSessionIds: action.detail.cohorts.trial },
  };
  if (action.type === "save_failed") return { ...state, busy: false, saveError: action.message };
  const known = new Set(state.sessions.map((session) => session.id));
  return { ...state, sessions: [...state.sessions, ...action.rows.filter((session) => !known.has(session.id))], sessionsTotal: action.total };
}

export function SessionPicker({
  legend, rows, selectedIds, onChange, onLoadMore, hasMore = false,
}: {
  legend: string; rows: SessionRow[]; selectedIds: string[];
  onChange: (ids: string[]) => void; onLoadMore?: () => void; hasMore?: boolean;
}) {
  const selected = new Set(selectedIds);
  const toggle = (sessionId: string) => onChange(
    selected.has(sessionId) ? selectedIds.filter((id) => id !== sessionId) : [...selectedIds, sessionId],
  );
  return <fieldset className="experiment-picker">
    <legend>{legend}</legend>
    <p>Only checked sessions belong to this cohort.</p>
    <div className="experiment-picker-list">
      {rows.map((session) => <label key={session.id}>
        <input type="checkbox" checked={selected.has(session.id)} onChange={() => toggle(session.id)} />
        <span><strong>{session.title || "Untitled session"}</strong><small>{session.provider} · {new Date(session.startedAt).toLocaleString()}</small></span>
        <em>{session.toolCount} tools · {session.errorCount} errors</em>
      </label>)}
    </div>
    {hasMore && <button type="button" className="button" onClick={onLoadMore}>Load more sessions</button>}
  </fieldset>;
}

export type ExperimentSetupSource = Pick<Suggestion, "title" | "rationale" | "findingKey">;

export function ExperimentSetupView({ suggestion, sessions, draft, definitionLocked = false, busy, error, onPatch, onStart, onLoadMore, hasMore }: {
  suggestion: ExperimentSetupSource; sessions: SessionRow[]; draft: ExperimentDraft; definitionLocked?: boolean; busy: boolean; error: string;
  onPatch: (value: Partial<ExperimentDraft>) => void; onStart: () => void; onLoadMore: () => void; hasMore: boolean;
}) {
  return <section className="experiment-setup" aria-labelledby="experiment-setup-title">
    <header className="experiment-pagehead"><div><span>New experiment</span><h1 id="experiment-setup-title">{suggestion.title}</h1><p>{suggestion.rationale}</p></div></header>
    <ol className="experiment-steps" aria-label="Experiment setup steps"><li>Finding</li><li>Metric</li><li>Baseline</li><li>Trial</li></ol>
    <section><h2>Finding</h2><p>{suggestion.findingKey}</p></section>
    {definitionLocked && <p className="notice">The experiment definition was already saved. You can repair its baseline selection and retry Start trial.</p>}
    <label className="experiment-field">Hypothesis<textarea value={draft.hypothesis} disabled={definitionLocked} maxLength={1000} onChange={(event) => onPatch({ hypothesis: event.target.value })} /></label>
    <div className="experiment-fields">
      <label>Metric<select value={draft.metricKind} disabled={definitionLocked} onChange={(event) => onPatch({ metricKind: event.target.value as MetricKind })}>
        <option value="tool_failure_rate">Tool failure rate</option><option value="tokens_per_session">Tokens per session</option>
        <option value="average_duration_minutes">Average session duration</option><option value="cache_read_ratio">Cache-read ratio</option>
      </select></label>
      <label>Target<input type="number" min="0" step="any" value={draft.targetValue} disabled={definitionLocked} onChange={(event) => onPatch({ targetValue: Number(event.target.value) })} /></label>
    </div>
    <SessionPicker legend="Baseline sessions" rows={sessions} selectedIds={draft.baselineSessionIds} onChange={(baselineSessionIds) => onPatch({ baselineSessionIds })} onLoadMore={onLoadMore} hasMore={hasMore} />
    {error && <p className="notice error" role="alert">{error}</p>}
    <button type="button" className="button primary" disabled={busy || !draft.hypothesis.trim() || !draft.baselineSessionIds.length || !Number.isFinite(draft.targetValue) || draft.targetValue < 0} onClick={onStart}>
      {busy ? "Starting…" : "Start trial"}
    </button>
  </section>;
}

export function ExperimentActiveView({ detail, sessions, draft, busy, error, onPatch, onSaveTrial, onReview, onLoadMore, hasMore }: {
  detail: ExperimentDetail; sessions: SessionRow[]; draft: ExperimentDraft; busy: boolean; error: string;
  onPatch: (value: Partial<ExperimentDraft>) => void; onSaveTrial: () => void; onReview: () => void; onLoadMore: () => void; hasMore: boolean;
}) {
  const valid = detail.currentCalculation.baseline.validCount > 0 && detail.currentCalculation.trial.validCount > 0;
  const missingCount = [...detail.currentCalculation.baseline.excluded, ...detail.currentCalculation.trial.excluded]
    .filter((item) => item.reason === "session_missing").length;
  return <section className="experiment-active" aria-labelledby="experiment-active-title">
    <header className="experiment-pagehead"><div><span>Active experiment</span><h1 id="experiment-active-title">{detail.title}</h1><p>{detail.hypothesis}</p></div></header>
    <div className="experiment-live-metric" aria-live="polite"><strong>{detail.currentCalculation.baseline.formatted}</strong><span>baseline</span><strong>{detail.currentCalculation.trial.formatted}</strong><span>trial · descriptive</span></div>
    <p>Baseline is locked. Trial membership changes only when you save the checked set.</p>
    {missingCount > 0 && <p className="notice" role="status">{missingCount} selected session{missingCount === 1 ? " is" : "s are"} temporarily unavailable in the index. Membership is preserved; review stays disabled until metric-valid rows return.</p>}
    <SessionPicker legend="Trial sessions" rows={sessions} selectedIds={draft.trialSessionIds} onChange={(trialSessionIds) => onPatch({ trialSessionIds })} onLoadMore={onLoadMore} hasMore={hasMore} />
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="experiment-actions"><button type="button" className="button" disabled={busy} onClick={onSaveTrial}>Save trial sessions</button><button type="button" className="button primary" disabled={busy || !valid} onClick={onReview}>Review experiment</button></div>
  </section>;
}

export type EvidenceFilter = "all" | "baseline" | "trial";
const metricLabels: Record<MetricKind, string> = {
  tool_failure_rate: "Tool failure rate", tokens_per_session: "Tokens per session",
  average_duration_minutes: "Average duration", cache_read_ratio: "Cache-read ratio",
};
const metricDescriptions: Record<MetricKind, string> = {
  tool_failure_rate: "tool errors ÷ tool calls", tokens_per_session: "input + output + cache tokens",
  average_duration_minutes: "positive end − start minutes", cache_read_ratio: "cache-read ÷ input tokens",
};
const formatContribution = (metricKind: MetricKind, value: number) => {
  if (metricKind === "tool_failure_rate" || metricKind === "cache_read_ratio") return `${(value * 100).toFixed(1)}%`;
  if (metricKind === "average_duration_minutes") return `${value.toFixed(1)} min`;
  return Math.round(value).toLocaleString("en-US");
};
const providerNames: Record<string, string> = {
  claude: "Claude Code", opencode: "opencode", antigravity: "Antigravity", codex: "Codex",
};
function ProviderIdentity({ provider }: { provider: string | null }) {
  if (!provider) return <>Unavailable</>;
  return <span className="experiment-provider"><img src={`/provider-assets/${encodeURIComponent(provider)}.svg`} alt="" onError={(event) => { event.currentTarget.hidden = true; }} /><strong>{providerNames[provider] ?? provider}</strong></span>;
}

export function EvidenceLedger({ detail, filter, onFilter, onOpenSession }: {
  detail: ExperimentDetail; filter: EvidenceFilter; onFilter: (filter: EvidenceFilter) => void;
  onOpenSession: (sessionId: string, eventId?: string | null) => void;
}) {
  const rows = filter === "all" ? detail.sessions : detail.sessions.filter((session) => session.cohort === filter);
  const contributionBySession = new Map(
    [...detail.currentCalculation.baseline.contributions, ...detail.currentCalculation.trial.contributions]
      .map((contribution) => [contribution.sessionId, contribution.value]),
  );
  return <section className="experiment-evidence" aria-labelledby="experiment-evidence-title">
    <header><div><h2 id="experiment-evidence-title">Evidence ledger—explicitly selected sessions</h2><p>{detail.sessions.length} sessions across both cohorts</p></div>
      <div className="segmented" aria-label="Filter evidence sessions">{(["all", "baseline", "trial"] as const).map((value) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => onFilter(value)}>{value[0].toUpperCase() + value.slice(1)} ({value === "all" ? detail.sessions.length : detail.sessions.filter((row) => row.cohort === value).length})</button>)}</div>
    </header>
    <div className="experiment-table-scroll" role="region" aria-label="Experiment evidence sessions" tabIndex={0}>
      <table><thead><tr><th scope="col">Cohort</th><th scope="col">Provider</th><th scope="col">Session ID</th><th scope="col">Date (UTC)</th><th scope="col">Tokens</th><th scope="col">Tool failures</th><th scope="col">{metricLabels[detail.metricKind]}</th><th scope="col">Evidence anchor</th></tr></thead>
        <tbody>{rows.map((session) => {
          const contribution = contributionBySession.get(session.sessionId);
          const eventQuery = session.evidenceEventId ? `&event=${encodeURIComponent(session.evidenceEventId)}` : "";
          const evidenceHref = `/logs?session=${encodeURIComponent(session.sessionId)}${eventQuery}`;
          return <tr key={session.sessionId} className={session.available ? "" : "missing"}>
            <td>{session.cohort}</td><td><ProviderIdentity provider={session.provider} /></td><th scope="row">{session.sessionId}</th>
            <td>{session.startedAt ? new Date(session.startedAt).toISOString() : "Session missing"}</td>
            <td>{session.tokenTotal?.toLocaleString("en-US") ?? "—"}</td><td>{session.errorCount ?? "—"}</td><td>{contribution === undefined ? "—" : formatContribution(detail.metricKind, contribution)}</td>
            <td>{session.available ? <a className="text-button" href={evidenceHref} onClick={(event) => {
              event.preventDefault();
              onOpenSession(session.sessionId, session.evidenceEventId);
            }}>{session.evidenceEventId ? "Open event" : "Open session"}</a> : <span>Evidence unavailable</span>}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  </section>;
}

const outcomeLabels: Record<ExperimentOutcome, string> = {
  adopt_change: "Adopt change", extend_trial: "Extend trial", no_improvement: "No improvement",
};

export function formatTarget(metricKind: MetricKind, targetValue: number, direction: "lower" | "higher") {
  const comparator = direction === "lower" ? "≤" : "≥";
  const numeric = targetValue.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (metricKind === "tool_failure_rate" || metricKind === "cache_read_ratio") {
    return `${comparator}${(targetValue * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  }
  if (metricKind === "average_duration_minutes") return `${comparator}${numeric} min`;
  return `${comparator}${numeric}`;
}

export function SavedConclusion({ detail }: { detail: ExperimentDetail }) {
  const review = detail.reviews.at(-1);
  if (!review) return <section className="experiment-conclusion saved" aria-labelledby="saved-conclusion-title">
    <div><h2 id="saved-conclusion-title">Saved conclusion unavailable</h2><p>The completed experiment has no readable review snapshot.</p></div>
  </section>;
  return <section className="experiment-conclusion saved" aria-labelledby="saved-conclusion-title">
    <div><h2 id="saved-conclusion-title">Saved conclusion</h2><p>Recorded {new Date(review.createdAt).toLocaleString()}</p></div>
    <div><strong>{outcomeLabels[review.outcome]}</strong><p>{review.note}</p></div>
  </section>;
}

export function ReviewHistory({ reviews }: { reviews: ExperimentDetail["reviews"] }) {
  if (!reviews.length) return null;
  return <details className="experiment-review-history">
    <summary>Review history ({reviews.length})</summary>
    <ol>{reviews.map((review) => <li key={review.id}>
      <strong>{outcomeLabels[review.outcome]}</strong><time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleString()}</time><p>{review.note}</p>
    </li>)}</ol>
  </details>;
}

export function ExperimentReviewView({ detail, draft, busy, error, onPatch, onSave, onOpenSession }: {
  detail: ExperimentDetail; draft: ExperimentDraft; busy: boolean; error: string;
  onPatch: (value: Partial<ExperimentDraft>) => void; onSave: () => void;
  onOpenSession: (sessionId: string, eventId?: string | null) => void;
}) {
  const [filter, setFilter] = useState<EvidenceFilter>("all");
  const calculation = detail.currentCalculation;
  return <section className="experiment-review" aria-labelledby="experiment-review-title">
    <header className="experiment-pagehead"><div><span>Experiment review</span><h1 id="experiment-review-title">{detail.title}</h1><p>{detail.id} · Created {new Date(detail.createdAt).toLocaleString()}</p></div><span className="status"><i aria-hidden="true" />{detail.state.replaceAll("_", " ")}</span></header>
    <ol className="experiment-thread" aria-label="Evidence thread">
      <li><span>Finding</span><strong>{detail.source.finding?.type.replaceAll("_", " ") ?? detail.source.findingKey}</strong><p>{detail.source.finding?.message ?? detail.source.suggestion.rationale}</p></li>
      <li><span>Hypothesis</span><strong>{detail.hypothesis}</strong></li>
      <li><span>Baseline</span><strong>{detail.cohorts.baseline.length} sessions</strong></li>
      <li><span>Trial</span><strong>{detail.cohorts.trial.length} sessions</strong></li>
      <li><span>Conclusion</span><strong>{detail.state === "completed" ? "Recorded" : "Human review required"}</strong></li>
    </ol>
    <dl className="experiment-metric-band">
      <div><dt>Primary metric</dt><dd>{metricLabels[detail.metricKind]}</dd><small>{metricDescriptions[detail.metricKind]} · {calculation.direction === "lower" ? "Lower is better" : "Higher is better"}</small></div>
      <div><dt>Baseline</dt><dd>{calculation.baseline.formatted}</dd><small>{calculation.baseline.validCount} valid sessions</small></div>
      <div><dt>Trial</dt><dd>{calculation.trial.formatted}</dd><small>{calculation.trial.validCount} valid sessions</small></div>
      <div><dt>Target</dt><dd>{formatTarget(detail.metricKind, detail.targetValue, calculation.direction)}</dd></div>
      <div><dt>Result</dt><dd>{calculation.targetMet === null ? "Not enough data" : calculation.targetMet ? "Target met · descriptive result" : "Target not met · descriptive result"}</dd><small>No causal attribution</small></div>
      <div><dt>Confidence</dt><dd>{calculation.sampleNote.replaceAll("_", " ")}</dd><small>{detail.sessions.length} sessions total</small></div>
    </dl>
    <EvidenceLedger detail={detail} filter={filter} onFilter={setFilter} onOpenSession={onOpenSession} />
    <ReviewHistory reviews={detail.reviews} />
    {detail.state === "completed" ? <SavedConclusion detail={detail} /> : <section className="experiment-conclusion"><div><h2>What did you learn?</h2><p>Summarize the take-away from this descriptive comparison.</p></div>
      <label><span className="sr-only">Review note</span><textarea value={draft.note} minLength={1} maxLength={1000} onChange={(event) => onPatch({ note: event.target.value })} /><small>{draft.note.length} / 1000 characters</small></label>
      <fieldset><legend>Your decision</legend>{([
        ["adopt_change", "Adopt change", "Implement the trial setting."],
        ["extend_trial", "Extend trial", "Collect more data before deciding."],
        ["no_improvement", "No improvement", "Do not adopt; end experiment."],
      ] as const).map(([value, label, description]) => <label key={value}><input type="radio" name="experiment-outcome" value={value} checked={draft.outcome === value} onChange={() => onPatch({ outcome: value })} /><span><strong>{label}</strong><small>{description}</small></span></label>)}</fieldset>
      <div>{error && <p className="notice error" role="alert">{error}</p>}<button type="button" className="experiment-save" disabled={busy || !draft.note.trim() || !draft.outcome} onClick={onSave}>{busy ? "Saving…" : "Save conclusion"}</button></div>
    </section>}
    <footer className="experiment-provenance">Provenance: {detail.sessions.length} explicitly selected sessions · metric computed from indexed session metrics · calculated {new Date(calculation.calculatedAt).toLocaleString()} · No causal attribution</footer>
  </section>;
}

export function ExperimentHistory({ summaries, selectedId, onChoose }: {
  summaries: ExperimentSummary[]; selectedId: string; onChoose: (experimentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeAndFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  return <div className="experiment-history" onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); closeAndFocus(); }
  }}>
    <button ref={trigger} type="button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((value) => !value)}>
      <span>Experiment history</span><code>{selectedId}</code>
    </button>
    {open && <div className="experiment-history-menu" role="menu" aria-label="Experiment history">
      {summaries.map((summary) => <button type="button" role="menuitem" key={summary.id} onClick={() => {
        onChoose(summary.id);
        closeAndFocus();
      }}>
        <strong>{summary.title}</strong><span>{summary.state.replaceAll("_", " ")}</span>
        <small>{summary.id}</small><time dateTime={summary.updatedAt}>{new Date(summary.updatedAt).toLocaleString()}</time>
      </button>)}
    </div>}
  </div>;
}

export function Experiments({ request, search, onOpenSession, onOpenAnalyst }: {
  request: ExperimentRequest; search?: string;
  onOpenSession: (sessionId: string, eventId?: string | null) => void; onOpenAnalyst: () => void;
}) {
  const [state, dispatch] = useReducer(experimentReducer, initialExperimentUiState);
  const [routeSearch, setRouteSearch] = useState(search ?? (typeof window === "undefined" ? "" : window.location.search));
  useEffect(() => {
    if (search !== undefined) { setRouteSearch(search); return; }
    const sync = () => setRouteSearch(window.location.search);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [search]);

  const load = async (requestedSearch = routeSearch) => {
    dispatch({ type: "loading" });
    try {
      const requested = new URLSearchParams(requestedSearch);
      const selectedId = requested.get("id");
      const suggestionId = requested.get("suggestion");
      const [list, reports, sessionPage] = await Promise.all([
        request<{ rows: ExperimentSummary[] }>("/api/experiments"),
        request<{ rows: Array<{ suggestions: Suggestion[] }> }>("/api/reports"),
        request<{ rows: SessionRow[]; total: number }>("/api/sessions?limit=100&offset=0"),
      ]);
      const allSuggestions = reports.rows.flatMap((report) => report.suggestions);
      let suggestion = allSuggestions.find((item) => item.id === suggestionId) ?? null;
      const targetId = selectedId ?? (!suggestionId ? list.rows.find((item) => item.state === "active")?.id ?? list.rows[0]?.id : null);
      const detail = targetId ? await request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(targetId)}`) : null;
      if (!suggestion && detail?.state === "draft") suggestion = allSuggestions.find((item) => item.id === detail.sourceSuggestionId) ?? null;
      dispatch({ type: "loaded", summaries: list.rows, detail, suggestion, sessions: sessionPage.rows, sessionsTotal: sessionPage.total });
    } catch (error) {
      dispatch({ type: "load_failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  useEffect(() => { void load(routeSearch); }, [routeSearch]);

  const sourceFromSnapshot = (detail: ExperimentDetail): ExperimentSetupSource => ({
    title: detail.source.suggestion.title,
    rationale: detail.source.suggestion.rationale,
    findingKey: detail.source.findingKey,
  });

  const mutate = async (operation: () => Promise<ExperimentDetail>) => {
    dispatch({ type: "saving" });
    try { dispatch({ type: "saved", detail: await operation() }); }
    catch (error) { dispatch({ type: "save_failed", message: error instanceof Error ? error.message : String(error) }); }
  };
  const start = async () => {
    dispatch({ type: "saving" });
    try {
      let draft = state.detail?.state === "draft" ? state.detail : null;
      if (!draft) {
        draft = await request<ExperimentDetail>("/api/experiments", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
            suggestionId: state.suggestion!.id, hypothesis: state.draft.hypothesis,
            metricKind: state.draft.metricKind, targetValue: state.draft.targetValue,
            baselineSessionIds: state.draft.baselineSessionIds,
          }),
        });
        dispatch({ type: "persisted", detail: draft });
        const nextSearch = `?id=${encodeURIComponent(draft.id)}`;
        if (typeof window !== "undefined") window.history.replaceState({}, "", `/experiments${nextSearch}`);
      } else {
        draft = await request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(draft.id)}/cohorts/baseline`, {
          method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionIds: state.draft.baselineSessionIds }),
        });
        dispatch({ type: "persisted", detail: draft });
      }
      const active = await request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(draft.id)}/start`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      dispatch({ type: "saved", detail: active });
      const nextSearch = `?id=${encodeURIComponent(active.id)}`;
      setRouteSearch(nextSearch);
    } catch (error) {
      dispatch({ type: "save_failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const saveTrial = () => mutate(() => request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(state.detail!.id)}/cohorts/trial`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionIds: state.draft.trialSessionIds }),
  }));
  const ready = () => mutate(() => request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(state.detail!.id)}/ready`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  const loadMore = async () => {
    try {
      const page = await request<{ rows: SessionRow[]; total: number }>(`/api/sessions?limit=100&offset=${state.sessions.length}`);
      dispatch({ type: "append_sessions", rows: page.rows, total: page.total });
    } catch (error) {
      dispatch({ type: "save_failed", message: error instanceof Error ? error.message : String(error) });
    }
  };
  const chooseExperiment = (experimentId: string) => {
    const nextSearch = `?id=${encodeURIComponent(experimentId)}`;
    if (typeof window !== "undefined") window.history.pushState({}, "", `/experiments${nextSearch}`);
    setRouteSearch(nextSearch);
  };
  const saveReview = () => mutate(() => request<ExperimentDetail>(`/api/experiments/${encodeURIComponent(state.detail!.id)}/reviews`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ outcome: state.draft.outcome, note: state.draft.note }),
  }));

  const withHistory = (content: React.ReactNode) => <>
    {state.detail && <ExperimentHistory summaries={state.summaries} selectedId={state.detail.id} onChoose={chooseExperiment} />}
    {content}
  </>;

  if (state.phase === "loading") return <section className="experiment-loading" aria-busy="true"><h1>Experiments</h1><p>Loading explicitly selected evidence…</p></section>;
  if (state.phase === "error") return <section><h1>Experiments</h1><p className="notice error" role="alert">{state.loadError}</p><button className="button" type="button" onClick={() => void load()}>Retry</button></section>;
  if (state.phase === "empty") return <section className="empty"><strong>No experiments yet</strong><span>Start from a supported cited suggestion in Analyst.</span><button className="text-button" type="button" onClick={onOpenAnalyst}>Open Analyst</button></section>;
  if (state.suggestion || state.detail?.state === "draft") {
    const setupSource = state.suggestion ?? sourceFromSnapshot(state.detail!);
    return withHistory(<ExperimentSetupView
      suggestion={setupSource} sessions={state.sessions} draft={state.draft} definitionLocked={Boolean(state.detail)}
      busy={state.busy} error={state.saveError} onPatch={(value) => dispatch({ type: "patch_draft", value })}
      onStart={() => void start()} onLoadMore={() => void loadMore()} hasMore={state.sessions.length < state.sessionsTotal}
    />);
  }
  if (state.detail?.state === "active") return withHistory(<>
    <ExperimentActiveView
      detail={state.detail} sessions={state.sessions} draft={state.draft} busy={state.busy} error={state.saveError}
      onPatch={(value) => dispatch({ type: "patch_draft", value })} onSaveTrial={() => void saveTrial()}
      onReview={() => void ready()} onLoadMore={() => void loadMore()} hasMore={state.sessions.length < state.sessionsTotal}
    />
    <ReviewHistory reviews={state.detail.reviews} />
  </>);
  return withHistory(<ExperimentReviewView
    detail={state.detail!} draft={state.draft} busy={state.busy} error={state.saveError}
    onPatch={(value) => dispatch({ type: "patch_draft", value })} onSave={() => void saveReview()}
    onOpenSession={onOpenSession}
  />);
}
