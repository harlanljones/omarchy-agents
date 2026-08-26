#!/usr/bin/env node
const fs = require("fs")
const path = require("path")
const vm = require("vm")

const root = path.resolve(__dirname, "..")
const source = fs.readFileSync(path.join(root, "Model.js"), "utf8")
const model = {}
vm.createContext(model)
vm.runInContext(source + "\nthis.exports = this", model)
const M = model

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + "\n  expected: " + JSON.stringify(expected) + "\n  actual:   " + JSON.stringify(actual))
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const records = [
  {
    id: "claude",
    name: "Claude Code",
    todayTotalTokens: 5_152_265,
    todayPrompts: 50,
    todaySessions: 1,
    totalPrompts: 50,
    totalSessions: 1,
    activeDays: 1,
    recentDays: [
      { date: "2026-08-09", messageCount: 0 },
      { date: "2026-08-10", messageCount: 0 },
      { date: "2026-08-11", messageCount: 0 },
      { date: "2026-08-12", messageCount: 0 },
      { date: "2026-08-13", messageCount: 0 },
      { date: "2026-08-14", messageCount: 0 },
      { date: "2026-08-15", messageCount: 5_152_265 }
    ],
    modelUsage: {
      "deepseek-v4-pro": { inputTokens: 5_122_117, outputTokens: 30_148, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    }
  },
  {
    id: "codex",
    name: "Codex",
    todayTotalTokens: 653_412,
    todayPrompts: 20,
    todaySessions: 2,
    totalPrompts: 219,
    totalSessions: 9,
    activeDays: 2,
    recentDays: [
      { date: "2026-08-09", messageCount: 0 },
      { date: "2026-08-10", messageCount: 0 },
      { date: "2026-08-11", messageCount: 0 },
      { date: "2026-08-12", messageCount: 0 },
      { date: "2026-08-13", messageCount: 0 },
      { date: "2026-08-14", messageCount: 10_611_954 },
      { date: "2026-08-15", messageCount: 653_412 }
    ],
    modelUsage: {
      "gpt-5.3-codex": { inputTokens: 8_000_000, outputTokens: 2_000_000, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 265_366 }
    }
  },
  {
    // Cline's collector writes todayTokensByModel as per-model token bucket
    // objects (not flat totals), which must rank in the today model view too.
    id: "cline",
    name: "Cline",
    todayTotalTokens: 500_000,
    todayPrompts: 10,
    todaySessions: 3,
    totalPrompts: 30,
    totalSessions: 7,
    activeDays: 1,
    recentDays: [
      { date: "2026-08-09", messageCount: 0 },
      { date: "2026-08-10", messageCount: 0 },
      { date: "2026-08-11", messageCount: 0 },
      { date: "2026-08-12", messageCount: 0 },
      { date: "2026-08-13", messageCount: 0 },
      { date: "2026-08-14", messageCount: 0 },
      { date: "2026-08-15", messageCount: 500_000 }
    ],
    modelUsage: {
      "glm-5.3-flash": { inputTokens: 400_000, outputTokens: 200_000, cacheReadInputTokens: 300_000, cacheCreationInputTokens: 0 }
    },
    todayTokensByModel: {
      "glm-5.3-flash": { inputTokens: 150_000, outputTokens: 10_000, cacheReadInputTokens: 140_000, cacheCreationInputTokens: 0 },
      "kimi-k3": { inputTokens: 50_000, outputTokens: 5_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
    }
  },
  {
    id: "fireworks",
    name: "Fireworks",
    todayTotalTokens: 0,
    totalPrompts: 0,
    totalSessions: 0,
    activeDays: 0,
    recentDays: [],
    modelUsage: {}
  }
]

const today = M.rankRecords(records, "today")
assertEqual(today.rows.length, 3, "today hides Fireworks with no tokens")
assertEqual(today.rows[0].providerId, "claude", "Claude leads today")
assertEqual(today.rows[1].providerId, "codex", "Codex is second today")
assertEqual(today.rows[2].providerId, "cline", "Cline ranks today")
assertEqual(today.rows[0].rank, 1, "leader is rank 1")
assertEqual(today.rows[1].rank, 2, "runner-up is rank 2")
assertEqual(today.leader.providerId, "claude", "leader object is Claude")
assertEqual(today.total, 5_152_265 + 653_412 + 500_000, "today total sums ranked agents")
assert(today.rows[0].bar === 1, "leader bar is full")
assert(today.rows[1].bar < 1, "second bar is shorter than the leader")

// Cline's collector writes todayTokensByModel as per-model token bucket
// objects, not flat totals. The today model view must still surface its models.
const modelToday = M.rankByModel(records, "today")
assertEqual(modelToday.rows.length, 2, "today model view ranks Cline's models")
assertEqual(modelToday.rows[0].providerId, "glm-5.3-flash", "glm leads Cline's models today")
assertEqual(modelToday.rows[0].tokens, 150_000 + 10_000 + 140_000, "bucket-object today tokens sum")
assertEqual(modelToday.rows[0].modelProviderName, "Cline", "model row reports its provider")
assertEqual(modelToday.rows[1].providerId, "kimi-k3", "kimi is second")
assertEqual(modelToday.rows[1].tokens, 50_000 + 5_000, "second model bucket is object-shaped")

const week = M.rankRecords(records, "week")
assertEqual(week.rows[0].providerId, "codex", "Codex leads the week")
assertEqual(week.rows[1].providerId, "claude", "Claude is second for the week")
assertEqual(week.rows[0].tokens, 11_265_366, "week tokens sum recentDays")

const all = M.rankRecords(records, "all")
assertEqual(all.rows[0].providerId, "codex", "Codex leads all-time from modelUsage")
assertEqual(all.rows[0].tokens, 11_265_366, "all-time is the modelUsage total")

const disabled = M.rankRecords(records, "today", { providers: { claude: { enabled: false } } })
assertEqual(disabled.rows.length, 2, "disabled Claude is omitted")
assertEqual(disabled.rows[0].providerId, "codex", "Codex remains when Claude is off")

const empty = M.rankRecords([], "today")
assertEqual(empty.rows.length, 0, "empty input yields no rows")
assertEqual(empty.leader, null, "empty board has no leader")
assertEqual(M.heroMeta(empty, "today"), "No today usage yet", "empty hero mentions the window")

const tied = M.rankRecords([
  { id: "claude", name: "Claude Code", todayTotalTokens: 100, recentDays: [], modelUsage: {} },
  { id: "codex", name: "Codex", todayTotalTokens: 100, recentDays: [], modelUsage: {} }
], "today")
assertEqual(tied.rows[0].rank, 1, "tie keeps shared first rank")
assertEqual(tied.rows[1].rank, 1, "both tied rows are rank 1")
assertEqual(tied.rows[0].providerId, "claude", "ties break alphabetically by name")

assertEqual(M.nextPeriod("today", 1), "week", "next period from today is week")
assertEqual(M.nextPeriod("all", 1), "today", "next period wraps")
assertEqual(M.nextPeriod("today", -1), "all", "previous period wraps backward")

assertEqual(M.formatTokenCount(5152265), "5.2M", "millions keep one decimal")
assertEqual(M.formatTokenCount(1000000), "1M", "exact millions drop the trailing zero")
assertEqual(M.formatTokenCount(653), "653", "small counts stay raw")
assertEqual(M.formatShare(0.66), "66%", "share renders as a percent")
assertEqual(M.formatShare(0.004), "<1%", "tiny shares do not round to zero")

assertEqual(M.friendlyModelName("deepseek-v4-pro"), "DeepSeek V4 Pro", "model names title-case")
assertEqual(M.friendlyModelName("gpt-5.3-codex"), "GPT 5.3 Codex", "gpt stays uppercase")

const models = M.modelRows(records[1], 4)
assertEqual(models.length, 1, "codex has one model row")
assertEqual(models[0].total, 11_265_366, "model row totals the bucket")

const series = M.weekSeries(week.rows, "2026-08-15T12:00:00")
assertEqual(series.days.length, 7, "week series has seven days")
assertEqual(series.days[5].date, "2026-08-14", "penultimate day is Friday the 14th")
assertEqual(series.days[5].total, 10_611_954, "Friday is Codex-only")
assertEqual(series.days[6].parts.length, 3, "Saturday has all three agents")
assertEqual(series.peak, 10_611_954, "peak is the busiest day")

assertEqual(M.heroMeta(today, "today"), "Today · 6.3M · Claude Code", "hero is short and names the leader")
assertEqual(M.barTooltip(today, "today"), "Claude Code leads today · 5.2M tokens", "bar tooltip names the leader")
assertEqual(M.selectedSummary(today.rows[0], "today"), "50 prompts · 1 session", "today summary uses today's counts")
assertEqual(M.dayLabel("2026-08-15", true), "Today", "today's column is labeled Today")

console.log("ok")
