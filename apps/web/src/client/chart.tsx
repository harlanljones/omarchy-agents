// @ts-nocheck -- Visx's generic stack inference is validated at runtime.
import React from "react";
import { Group } from "@visx/group";
import { BarStack } from "@visx/shape";
import { scaleBand, scaleLinear, scaleOrdinal } from "@visx/scale";
import { colors, fmt } from "./theme";

export function HistoryChart({
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
  const revealedRef = React.useRef(false);
  React.useEffect(() => {
    if (rows.length) revealedRef.current = true;
  }, [rows]);
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
                      className={revealedRef.current ? undefined : "bar-rise"}
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
