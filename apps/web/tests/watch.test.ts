import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

let watch: typeof import("../src/server/watch");
beforeAll(async () => {
  process.env.OMARCHY_AGENTS_DB = join(tmpdir(), `omarchy-agents-watch-${process.pid}.sqlite`);
  watch = await import("../src/server/watch");
});

const NOW = new Date("2026-08-23T18:00:00Z").valueOf();
const hoursFromNow = (h: number) => new Date(NOW + h * 3600_000).toISOString();
const record = (raw: any) => ({ id: "claude", name: "Claude Code", ...raw });

const claudeAt = (percent: number, resetsAt = hoursFromNow(10)) =>
  record({
    ready: true,
    updatedAt: new Date(NOW).toISOString(),
    limits: [{ label: "Session (5-hour)", percent, resetsAt }],
  });

const wipe = () => {
  const { db } = require("../src/server/db");
  db.run("DELETE FROM limit_snapshots");
  db.run("DELETE FROM usage_alerts");
  db.run("DELETE FROM recommendation_log");
};

/** Notifier stub: records deliveries; fails while `failing` is true. */
const spyNotifier = () => {
  const calls: Array<{ title: string; body: string }> = [];
  let failing = false;
  return {
    calls,
    get failing() { return failing; },
    set failing(value: boolean) { failing = value; },
    notify: async (title: string, body: string) => {
      if (failing) return false;
      calls.push({ title, body });
      return true;
    },
  };
};

const activeAlerts = () =>
  (watch.alertsInbox([], NOW).active ?? []).concat();

describe("threshold crossing", () => {
  test("fires once per provider/window/cycle/rule and escalates", async () => {
    wipe();
    const spy = spyNotifier();
    await watch.observeUsageRecords([claudeAt(0.5)], NOW, spy.notify);
    expect(activeAlerts()).toHaveLength(0);

    await watch.observeUsageRecords([claudeAt(0.85)], NOW + 3600_000, spy.notify);
    let inbox = watch.alertsInbox([claudeAt(0.85)], NOW + 3600_000);
    // The 0.5 -> 0.85 jump projects exhaustion before the reset, so both the
    // threshold and the projection arm together.
    expect(inbox.active.map(a => a.rule).sort()).toEqual(["projected-exhaustion", "threshold-20"]);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.find(c => c.body.includes("under 20% remains"))).toBeTruthy();

    // Same observation again: deduplicated, no further notifications.
    await watch.observeUsageRecords([claudeAt(0.85)], NOW + 3600_000 + 120_000, spy.notify);
    expect(watch.alertsInbox([], NOW).active).toHaveLength(2);
    expect(spy.calls).toHaveLength(2);

    // Crossing 90% adds the tighter rule without resolving anything else.
    await watch.observeUsageRecords([claudeAt(0.95)], NOW + 7200_000, spy.notify);
    inbox = watch.alertsInbox([claudeAt(0.95)], NOW + 7200_000);
    expect(inbox.active.map(a => a.rule).sort()).toEqual(["projected-exhaustion", "threshold-10", "threshold-20"]);
    expect(spy.calls).toHaveLength(3);
  });

  test("exhaustion replaces thresholds as critical", async () => {
    wipe();
    const spy = spyNotifier();
    await watch.observeUsageRecords([claudeAt(0.95)], NOW, spy.notify);
    await watch.observeUsageRecords([claudeAt(1)], NOW + 3600_000, spy.notify);
    const inbox = watch.alertsInbox([], NOW + 3600_000);
    expect(inbox.active.map(a => a.rule)).toEqual(["exhausted"]);
    expect(inbox.active[0].severity).toBe("critical");
    // The two superseded thresholds resolved with recovery notices.
    expect(inbox.recent.map(a => a.rule).sort()).toEqual(["threshold-10", "threshold-20"]);
    expect(inbox.recent.every(a => a.resolvedAt)).toBe(true);
  });

  test("a past reset waits for refresh instead of alerting", async () => {
    wipe();
    const spy = spyNotifier();
    await watch.observeUsageRecords([claudeAt(1, hoursFromNow(-1))], NOW, spy.notify);
    expect(activeAlerts()).toHaveLength(0);
  });
});

describe("reset rollover", () => {
  test("old-cycle alerts recover and the new cycle starts clean", async () => {
    wipe();
    const spy = spyNotifier();
    const oldCycle = hoursFromNow(2);
    await watch.observeUsageRecords([claudeAt(0.9, oldCycle)], NOW, spy.notify);
    expect(activeAlerts().map(a => a.rule).sort()).toEqual(["threshold-10", "threshold-20"]);

    const next = NOW + 3 * 3600_000;
    const newCycle = hoursFromNow(20);
    await watch.observeUsageRecords([claudeAt(0.9, newCycle)], next, spy.notify);
    const inbox = watch.alertsInbox([], next);
    // The new cycle re-arms fresh alert rows under its own reset instant.
    expect(inbox.active.map(a => a.rule).sort()).toEqual(["threshold-10", "threshold-20"]);
    expect(new Set(inbox.active.map(a => a.resetsAt))).toEqual(new Set([newCycle]));
    expect(inbox.recent.map(a => a.rule).sort()).toEqual(["threshold-10", "threshold-20"]);
    expect(new Date(inbox.recent[0].resetsAt!).valueOf()).toBe(new Date(oldCycle).valueOf());
    // Two stacked fire notices plus one recovery notice per cleared alert.
    const titles = spy.calls.map(c => c.title);
    expect(titles.filter(t => t === "Claude Code: recovered")).toHaveLength(2);
    expect(new Set(titles.filter(t => t !== "Claude Code: recovered"))).toEqual(
      new Set(["Claude Code: threshold-20", "Claude Code: threshold-10"]),
    );
  });
});

describe("notification failure", () => {
  test("failed deliveries retry on the next pass and gate recovery notices", async () => {
    wipe();
    const spy = spyNotifier();
    spy.failing = true;
    await watch.observeUsageRecords([claudeAt(0.85)], NOW, spy.notify);
    expect(activeAlerts().map(a => a.rule)).toEqual(["threshold-20"]);

    // Still failing: alert stays unnotified and retries.
    await watch.observeUsageRecords([claudeAt(0.85)], NOW + 120_000, spy.notify);
    expect(spy.calls).toHaveLength(0);

    spy.failing = false;
    await watch.observeUsageRecords([claudeAt(0.85)], NOW + 240_000, spy.notify);
    expect(spy.calls).toHaveLength(1);

    // Recovery only announces itself because the fire notice eventually landed.
    await watch.observeUsageRecords([claudeAt(0.5)], NOW + 360_000, spy.notify);
    expect(spy.calls.map(c => c.title)).toEqual([
      "Claude Code: threshold-20",
      "Claude Code: recovered",
    ]);
    const recent = watch.alertsInbox([], NOW + 360_000).recent;
    expect(recent).toHaveLength(1);
    expect(recent[0].resolvedAt).toBeTruthy();
  });
});

describe("stale and auth states", () => {
  test("auth-needed and collector-stale fire at provider level and recover", async () => {
    wipe();
    const spy = spyNotifier();
    const broken = record({ id: "broken", name: "Broken", ready: false, authHelpText: "Run `x auth login`" });
    await watch.observeUsageRecords([broken], NOW, spy.notify);
    let inbox = watch.alertsInbox([], NOW);
    expect(inbox.active.map(a => a.rule)).toEqual(["auth-needed"]);
    expect(inbox.active[0].severity).toBe("critical");
    expect(inbox.active[0].message).toContain("x auth login");
    expect(inbox.forecasts).toEqual([]);

    const healed = record({ id: "broken", name: "Broken", ready: true, updatedAt: hoursFromNow(-1), todayTotalTokens: 100 });
    await watch.observeUsageRecords([healed], NOW + 60_000, spy.notify);
    inbox = watch.alertsInbox([], NOW + 60_000);
    expect(inbox.active).toHaveLength(0);
    expect(inbox.recent.map(a => a.rule)).toEqual(["auth-needed"]);

    const stale = record({ ...healed, updatedAt: "2026-08-21T00:00:00Z" });
    await watch.observeUsageRecords([stale], NOW + 120_000, spy.notify);
    inbox = watch.alertsInbox([], NOW + 120_000);
    expect(inbox.active.map(a => a.rule)).toEqual(["collector-stale"]);
    expect(inbox.active[0].severity).toBe("warning");
  });
});

describe("depletion forecasting", () => {
  test("needs multiple samples in the same reset cycle", async () => {
    wipe();
    const spy = spyNotifier();
    const first = claudeAt(0.5);
    await watch.observeUsageRecords([first], NOW, spy.notify);
    let inbox = watch.alertsInbox([first], NOW);
    expect(inbox.forecasts.map(f => f.sufficient)).toEqual([false]);
    expect(inbox.forecasts[0].samples).toBe(1);
    expect(inbox.active).toHaveLength(0);

    const second = claudeAt(0.6);
    await watch.observeUsageRecords([second], NOW + 3600_000, spy.notify);
    inbox = watch.alertsInbox([second], NOW + 3600_000);
    const forecast = inbox.forecasts[0];
    expect(forecast.sufficient).toBe(true);
    expect(forecast.samples).toBe(2);
    expect(forecast.projectedExhaustionAt).toBeTruthy();
    expect(new Date(forecast.projectedExhaustionAt!).valueOf())
      .toBeLessThan(new Date(first.limits![0].resetsAt!).valueOf());
    expect(inbox.active.map(a => a.rule)).toEqual(["projected-exhaustion"]);
  });

  test("flat or falling usage never projects exhaustion", async () => {
    wipe();
    const spy = spyNotifier();
    await watch.observeUsageRecords([claudeAt(0.6)], NOW, spy.notify);
    const falling = claudeAt(0.55);
    await watch.observeUsageRecords([falling], NOW + 3600_000, spy.notify);
    const inbox = watch.alertsInbox([falling], NOW + 3600_000);
    expect(inbox.forecasts[0].sufficient).toBe(false);
    expect(inbox.active).toHaveLength(0);
  });

  test("windows without a known reset stay out of the forecaster", async () => {
    wipe();
    const spy = spyNotifier();
    const openEnded = claudeAt(0.9);
    delete (openEnded.limits![0] as any).resetsAt;
    await watch.observeUsageRecords([openEnded], NOW, spy.notify);
    const inbox = watch.alertsInbox([openEnded], NOW);
    expect(inbox.forecasts.map(f => f.sufficient)).toEqual([false]);
    expect(inbox.active.map(a => a.rule).sort()).toEqual(["threshold-10", "threshold-20"]);
  });
});

describe("incident view (Phase 3)", () => {
  test("provider switches log only real transitions", () => {
    wipe();
    expect(watch.lastRecommendation()).toBeNull();
    expect(watch.recordRecommendationChange({ providerId: "claude", providerName: "Claude Code" }, watch.lastRecommendation(), NOW)).toBe(true);
    expect(watch.recordRecommendationChange({ providerId: "claude", providerName: "Claude Code" }, watch.lastRecommendation(), NOW + 1000)).toBe(false);
    expect(watch.recordRecommendationChange({ providerId: "codex", providerName: "Codex" }, watch.lastRecommendation(), NOW + 2000)).toBe(true);
    expect(watch.lastRecommendation()).toEqual({ providerId: "codex", providerName: "Codex" });
    const inbox = watch.incidentsView([], NOW + 3000);
    const switches = inbox.incidents.filter(i => i.kind === "provider-switch");
    expect(switches).toHaveLength(2);
    expect(switches[0].summary).toContain("moved from Claude Code to Codex");
  });

  test("actual resets are detected from a sharp usage drop between snapshots", async () => {
    wipe();
    const spy = spyNotifier();
    await watch.observeUsageRecords([claudeAt(0.9)], NOW, spy.notify);
    await watch.observeUsageRecords([claudeAt(0.05)], NOW + 3600_000, spy.notify);
    const resets = watch.actualResets();
    expect(resets).toHaveLength(1);
    expect(resets[0].providerId).toBe("claude");
    expect(resets[0].fromUsed).toBe(0.9);
    expect(resets[0].toUsed).toBe(0.05);
    const inbox = watch.incidentsView([], NOW + 3600_000);
    expect(inbox.incidents.some(i => i.kind === "actual-reset")).toBe(true);
  });

  test("a gradual decline under the drop threshold is not mistaken for a reset", async () => {
    wipe();
    const spy = spyNotifier();
    await watch.observeUsageRecords([claudeAt(0.5)], NOW, spy.notify);
    await watch.observeUsageRecords([claudeAt(0.3)], NOW + 3600_000, spy.notify);
    expect(watch.actualResets()).toHaveLength(0);
  });

  test("forecast accuracy compares an early two-sample projection against actual exhaustion", async () => {
    wipe();
    const spy = spyNotifier();
    const cycleReset = hoursFromNow(100);
    await watch.observeUsageRecords([claudeAt(0.5, cycleReset)], NOW, spy.notify);
    await watch.observeUsageRecords([claudeAt(0.6, cycleReset)], NOW + 3600_000, spy.notify);
    await watch.observeUsageRecords([claudeAt(1, cycleReset)], NOW + 4 * 3600_000, spy.notify);
    const accuracy = watch.forecastAccuracy();
    expect(accuracy).toHaveLength(1);
    expect(accuracy[0].providerId).toBe("claude");
    expect(accuracy[0].actualExhaustionAt).toBe(hoursFromNow(4));
    expect(accuracy[0].predictedExhaustionAt).toBeTruthy();
    expect(accuracy[0].driftMs).not.toBeNull();
    const inbox = watch.incidentsView([], NOW + 4 * 3600_000);
    expect(inbox.incidents.some(i => i.kind === "forecast-accuracy")).toBe(true);
  });

  test("incidents merge threshold crossings, switches, resets, and accuracy in one recency-ordered feed", async () => {
    wipe();
    const spy = spyNotifier();
    await watch.observeUsageRecords([claudeAt(0.85)], NOW, spy.notify);
    watch.recordRecommendationChange({ providerId: "claude", providerName: "Claude Code" }, null, NOW + 500);
    const inbox = watch.incidentsView([claudeAt(0.85)], NOW + 1000);
    const kinds = new Set(inbox.incidents.map(i => i.kind));
    expect(kinds.has("threshold")).toBe(true);
    expect(kinds.has("provider-switch")).toBe(true);
    const times = inbox.incidents.map(i => i.occurredAt);
    expect([...times]).toEqual([...times].sort().reverse());
  });
});

describe("retention", () => {
  test("retention: old snapshots and resolved alerts expire after 90 days", async () => {
    wipe();
    const spy = spyNotifier();
    await watch.observeUsageRecords([claudeAt(0.5)], NOW, spy.notify);
    await watch.observeUsageRecords([claudeAt(0.2)], NOW + 3600_000, spy.notify);
    const later = NOW + 91 * 24 * 3600_000;
    await watch.observeUsageRecords([claudeAt(0.9, hoursFromNow(20))], later, spy.notify);
    const { db } = require("../src/server/db");
    expect((db.query("SELECT COUNT(*) n FROM limit_snapshots WHERE recorded_at < ?").get(new Date(later - 90 * 24 * 3600_000).toISOString()) as any).n).toBe(0);
    // Only the fresh observation survives; the 91-day-old samples are gone.
    expect((db.query("SELECT COUNT(*) n FROM limit_snapshots").get() as any).n).toBe(1);
  });

  test("never backfills: an empty observation writes nothing historical", async () => {
    wipe();
    const spy = spyNotifier();
    const result = await watch.observeUsageRecords([], NOW, spy.notify);
    expect(result.snapshotsWritten).toBe(0);
    expect(result.alertsFired).toBe(0);
    const { db } = require("../src/server/db");
    expect(db.query("SELECT COUNT(*) n FROM limit_snapshots").get().n).toBe(0);
  });
});
