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

// OpenCode routes through many underlying providers; the modelUsage key is
// `providerID/modelID` and both halves must render correctly.
assertEqual(M.splitModelKey("opencode-go/hy3").provider, "opencode-go", "split isolates the opencode sub-provider")
assertEqual(M.splitModelKey("opencode-go/hy3").model, "hy3", "split isolates the opencode model id")
assertEqual(M.friendlyModelName("opencode-go/hy3"), "OpenCode Go / Hy3", "opencode sub-provider is named")
assertEqual(M.friendlyModelName("opencode/x-preview-f-free"), "OpenCode / X Preview F Free", "opencode default provider is named")
assertEqual(M.friendlyModelName("bai-glm/glm-5.2"), "Bai GLM / GLM 5.2", "unknown-but-mapped provider is named")
assertEqual(M.friendlyModelName("some-future-provider/model-x"), "Some Future Provider / Model X", "unmapped provider falls back to title-case")
assertEqual(M.friendlyProviderName("cloudflare-workers-ai"), "Cloudflare Workers AI", "hyphenated acronyms title-case")


const models = M.modelRows(records[1], 4)
assertEqual(models.length, 1, "codex has one model row")
assertEqual(models[0].total, 11_265_366, "model row totals the bucket")

const series = M.weekSeries(week.rows, "2026-08-15T12:00:00")
assertEqual(series.days.length, 7, "week series has seven days")
assertEqual(series.days[5].date, "2026-08-14", "penultimate day is Friday the 14th")
assertEqual(series.days[5].total, 10_611_954, "Friday is Codex-only")
assertEqual(series.days[6].parts.length, 3, "Saturday has all three agents")
assertEqual(series.peak, 10_611_954, "peak is the busiest day")

assertEqual(M.formatCost(0), "$0.00", "zero cost formats as $0.00")
assertEqual(M.formatCost(0.002), "<$0.01", "sub-cent cost formats as <$0.01")
assertEqual(M.formatCost(1.468), "$1.47", "normal cost formats with two decimals")
assertEqual(M.formatCost(1250), "$1.3K", "large cost formats with K suffix")

assert(Math.abs(today.rows[0].cost - 1.46795852) < 0.001, "Claude cost is estimated from DeepSeek rates")
assert(Math.abs(today.rows[1].cost - 2.3732057) < 0.001, "Codex cost is estimated from GPT-5 rates")
assert(Math.abs(today.rows[2].cost - 0.1699) < 0.001, "Cline cost sums GLM and Kimi buckets")
assert(Math.abs(today.totalCost - 4.01106) < 0.001, "today total cost sums all agents")

assertEqual(M.heroMeta(today, "today"), "Today · 6.3M ($4.01) · Claude Code", "hero includes formatted total cost")
assertEqual(M.barTooltip(today, "today"), "Claude Code leads today · 5.2M tokens ($1.47)", "bar tooltip includes leader cost")
assertEqual(M.selectedSummary(today.rows[0], "today"), "50 prompts · 1 session · est. $1.47", "today summary includes estimated cost")
assertEqual(M.dayLabel("2026-08-15", true), "Today", "today's column is labeled Today")

// Pricing overrides
const overridden = M.rankRecords(records, "today", { pricingOverrides: { "deepseek-v4-pro": { inputPerMtok: 10, outputPerMtok: 20 } } })
assert(overridden.rows[0].cost > 50, "pricing override takes effect in rankRecords")

// Router provider prefixes strip down to the underlying model id.
assertEqual(M.normalizeModel("cheaper-inference/gpt-6-astra"), "gpt-6-astra", "cheaper-inference prefix strips")
assertEqual(M.normalizeModel("venice/stealth-ox-alpha"), "ox-alpha", "stealth- prefix strips")
assertEqual(M.normalizeModel("openrouter/openai/o4-mini"), "o4-mini", "nested provider prefixes strip")
assertEqual(M.normalizeModel("openrouter/minimax-m3:free"), "minimax-m3", "free marker strips")
assertEqual(M.normalizeModel("nous/hy3:free"), "hy3", "hy3's free marker strips")
assertEqual(M.normalizeModel("gmicloud/DeepSeek-V4-Pro"), "deepseek-v4-pro", "case and provider strip together")
assert(M.ratesForModel("cursor-grok-4.5-high"), "cursor grok keys price")
assertEqual(M.ratesForModel("cursor-grok-4.5-high").outputPerMtok, 6, "cursor grok keys price at grok rates")

// Frontier models carry their own rates instead of falling back to gpt-5.
const astra = M.ratesForModel("gpt-6-astra")
assertEqual(astra.inputPerMtok, 10, "astra input rate")
assertEqual(astra.outputPerMtok, 50, "astra output rate")
assertEqual(astra.cacheReadPerMtok, 1, "astra cache read rate")
assertEqual(astra.cacheWritePerMtok, 12.5, "astra cache write rate")
assertEqual(M.ratesForModel("gpt-5.6-sol").inputPerMtok, 4, "5.6 sol input rate")
assertEqual(M.ratesForModel("gpt-5.6-sol").outputPerMtok, 20, "5.6 sol output rate")
assertEqual(M.ratesForModel("gpt-5.6-terra").outputPerMtok, 12, "5.6 terra output rate")
assertEqual(M.ratesForModel("gpt-5.6-luna").outputPerMtok, 1.2, "5.6 luna output rate")
assertEqual(M.ratesForModel("claude-fable-5").inputPerMtok, 10, "fable input rate")
assertEqual(M.ratesForModel("claude-fable-5").outputPerMtok, 50, "fable output rate")
assert(M.ratesForModel("cheaper-inference/gpt-6-astra"), "cheaper-inference astra key is priced")
assertEqual(M.ratesForModel("cheaper-inference/gpt-6-astra").outputPerMtok, 50, "cheaper-inference key prices at astra rates")
assert(M.ratesForModel("gpt-5.3-codex"), "older gpt-5.x still matches the gpt-5 bucket")
assert(M.ratesForModel("meta/muse-spark-1.3-contributor"), "command code muse-spark key is priced")
assertEqual(M.ratesForModel("meta/muse-spark-1.3-contributor").outputPerMtok, 4.25, "command code key prices at muse-spark rates")

// Cost sort: expensive frontier models outrank cheap bulk token volume.
const frontierBulk = [
  {
    id: "bulk", name: "Bulk", todayTotalTokens: 9_000_000,
    recentDays: [], modelUsage: { "deepseek-v4-flash": { inputTokens: 9_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }
  },
  {
    id: "frontier", name: "Frontier", todayTotalTokens: 1_000_000,
    recentDays: [], modelUsage: { "gpt-6-astra": { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }
  }
]
const byTokens = M.rankRecords(frontierBulk, "today")
assertEqual(byTokens.basis, "tokens", "sort basis defaults to tokens")
assertEqual(byTokens.rows[0].providerId, "bulk", "token sort keeps bulk volume first")
assertEqual(byTokens.rows[0].share > byTokens.rows[1].share, true, "token share favors the bulk agent")

const byCost = M.rankRecords(frontierBulk, "today", { sortMode: "cost" })
assertEqual(byCost.basis, "cost", "sort basis flips to cost")
assertEqual(byCost.rows[0].providerId, "frontier", "cost sort puts the frontier model first")
assertEqual(byCost.rows[1].providerId, "bulk", "cheap bulk volume drops below astra")
assertEqual(byCost.rows[0].bar, 1, "cost leader bar is full")
assert(byCost.rows[1].bar < 1, "cheap agent bar shrinks under cost sort")
assertEqual(byCost.rows[0].share > byCost.rows[1].share, true, "cost share favors astra")
assertEqual(M.heroMeta(byCost, "today"), "Today by cost · $12.52 (10M tokens) · Frontier", "cost hero features spend")
assertEqual(M.barTooltip(byCost, "today"), "Frontier leads today by cost · $10.00 (est.)", "cost tooltip features spend")

const modelByCost = M.rankByModel(frontierBulk, "all", { sortMode: "cost" })
assertEqual(modelByCost.basis, "cost", "model view honors cost sort")
assertEqual(modelByCost.rows[0].providerId, "gpt-6-astra", "model view ranks astra above deepseek by cost")

console.log("ok")
