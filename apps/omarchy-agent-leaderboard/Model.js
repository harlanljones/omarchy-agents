// Ranking math for the agent leaderboard. Qt-free so it can be unit
// tested under node (test/model-test.js).

var PERIODS = [
  { value: "today", label: "Today" },
  { value: "week", label: "7 days" },
  { value: "all", label: "All-time" }
]

var VIEWS = [
  { value: "provider", label: "By Provider" },
  { value: "model", label: "By Model" }
]

function periodOptions() {
  return PERIODS.slice()
}

function viewOptions() {
  return VIEWS.slice()
}

function periodLabel(period) {
  if (period === "week") return "Last 7 days"
  if (period === "all") return "All-time"
  return "Today"
}

function nextPeriod(period, delta) {
  var ids = ["today", "week", "all"]
  var step = Number(delta)
  if (!isFinite(step) || step === 0) step = 1
  var index = ids.indexOf(String(period || "today"))
  if (index < 0) index = 0
  var next = (index + step) % ids.length
  if (next < 0) next += ids.length
  return ids[next]
}

function numberValue(value) {
  var n = Number(value || 0)
  return isFinite(n) ? Math.round(n) : 0
}

function tokenBucketTotal(bucket) {
  if (!bucket || typeof bucket !== "object") return 0
  return numberValue(bucket.inputTokens)
    + numberValue(bucket.outputTokens)
    + numberValue(bucket.cacheReadInputTokens)
    + numberValue(bucket.cacheCreationInputTokens)
}

// A provider's todayTokensByModel entry can be either a flat per-model token
// total (most collectors) or a full token bucket object (Cline's collector).
// Normalize both so the "today" model view and hasUsage stay truthful for any
// writer that lands in the usage directory.
function todayTokenTotal(value) {
  if (value && typeof value === "object") return tokenBucketTotal(value)
  return numberValue(value)
}

function weekTokens(record) {
  var days = record && record.recentDays ? record.recentDays : []
  var total = 0
  for (var i = 0; i < days.length; i++)
    total += numberValue(days[i] && days[i].messageCount)
  return total
}

function allTimeTokens(record) {
  var usage = record && record.modelUsage ? record.modelUsage : {}
  var total = 0
  for (var id in usage) total += tokenBucketTotal(usage[id])
  // Collectors that only know a recent window still have a usable floor.
  return Math.max(total, weekTokens(record), numberValue(record && record.todayTotalTokens))
}

function periodTokens(record, period) {
  if (!record) return 0
  if (period === "week") return weekTokens(record)
  if (period === "all") return allTimeTokens(record)
  return numberValue(record.todayTotalTokens)
}

function hasAnyUsage(record) {
  if (!record) return false
  return numberValue(record.todayTotalTokens) > 0
    || weekTokens(record) > 0
    || allTimeTokens(record) > 0
    || numberValue(record.totalPrompts) > 0
    || numberValue(record.totalSessions) > 0
    || numberValue(record.activeDays) > 0
}

function providerEnabled(settings, id) {
  if (!settings || !settings.providers || !settings.providers[id]) return true
  return settings.providers[id].enabled !== false
}

function asArray(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.slice()
  var length = Number(value.length || 0)
  if (!isFinite(length) || length <= 0) return []
  var list = []
  for (var i = 0; i < length; i++) list.push(value[i])
  return list
}

function rankRecords(records, period, settings) {
  var rows = []
  var list = asArray(records)
  var window = String(period || "today")
  if (window !== "today" && window !== "week" && window !== "all") window = "today"

  for (var i = 0; i < list.length; i++) {
    var record = list[i]
    if (!record || !record.id) continue
    var id = String(record.id)
    if (!providerEnabled(settings, id)) continue
    if (!hasAnyUsage(record)) continue
    var tokens = periodTokens(record, window)
    if (tokens <= 0) continue
    rows.push({
      providerId: id,
      providerName: String(record.name || id),
      tokens: tokens,
      todayTokens: numberValue(record.todayTotalTokens),
      weekTokens: weekTokens(record),
      allTokens: allTimeTokens(record),
      todayPrompts: numberValue(record.todayPrompts),
      todaySessions: numberValue(record.todaySessions),
      totalPrompts: numberValue(record.totalPrompts),
      totalSessions: numberValue(record.totalSessions),
      activeDays: numberValue(record.activeDays),
      recentDays: record.recentDays || [],
      modelUsage: record.modelUsage || {},
      hasPromptStats: record.hasPromptStats !== false,
      updatedAt: String(record.updatedAt || "")
    })
  }

  rows.sort(function(a, b) {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens
    return String(a.providerName).localeCompare(String(b.providerName))
  })

  var total = 0
  for (var t = 0; t < rows.length; t++) total += rows[t].tokens

  var rank = 0
  var lastTokens = null
  for (var r = 0; r < rows.length; r++) {
    if (lastTokens === null || rows[r].tokens !== lastTokens) {
      rank = r + 1
      lastTokens = rows[r].tokens
    }
    rows[r].rank = rank
    rows[r].share = total > 0 ? rows[r].tokens / total : 0
    rows[r].bar = rows.length > 0 && rows[0].tokens > 0 ? rows[r].tokens / rows[0].tokens : 0
  }

  return {
    period: window,
    rows: rows,
    total: total,
    leader: rows.length > 0 ? rows[0] : null
  }
}

function rankByModel(records, period, settings) {
  var list = asArray(records)
  var window = String(period || "today")
  if (window !== "today" && window !== "week" && window !== "all") window = "today"

  // Aggregate modelUsage across every enabled provider.
  // modelId -> { tokens: number, providerId: string, providerName: string, todayTokens: number }
  var models = {}

  for (var i = 0; i < list.length; i++) {
    var record = list[i]
    if (!record || !record.id) continue
    var id = String(record.id)
    if (!providerEnabled(settings, id)) continue
    if (!hasAnyUsage(record)) continue

    var providerName = String(record.name || id)

    // Today: read per-model today totals from todayTokensByModel
    var todayByModel = record.todayTokensByModel || {}
    for (var mid in todayByModel) {
      var todayVal = todayTokenTotal(todayByModel[mid])
      if (todayVal <= 0) continue
      if (!models[mid]) models[mid] = { providerId: id, providerName: providerName, tokens: 0, todayTokens: 0 }
      models[mid].todayTokens += todayVal
      if (window === "today") models[mid].tokens += todayVal
    }

    // All-time: sum modelUsage buckets
    var usage = record.modelUsage || {}
    for (var mid2 in usage) {
      var bucketTotal = tokenBucketTotal(usage[mid2])
      if (bucketTotal <= 0) continue
      if (!models[mid2]) models[mid2] = { providerId: id, providerName: providerName, tokens: 0, todayTokens: 0 }
      if (window === "week" || window === "all") models[mid2].tokens += bucketTotal
    }
  }

  // Convert to rows, sort, rank
  var rows = []
  for (var mid3 in models) {
    var m = models[mid3]
    if (m.tokens <= 0) continue
    rows.push({
      providerId: mid3,
      providerName: friendlyModelName(mid3),
      modelProviderId: m.providerId,
      modelProviderName: (function() {
        var split = splitModelKey(mid3)
        return split.provider ? friendlyProviderName(split.provider) : m.providerName
      })(),
      tokens: m.tokens,
      todayTokens: m.todayTokens,
      hasPromptStats: false
    })
  }

  rows.sort(function(a, b) {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens
    return String(a.providerName).localeCompare(String(b.providerName))
  })

  var total = 0
  for (var t = 0; t < rows.length; t++) total += rows[t].tokens

  var rank = 0
  var lastTokens = null
  for (var r = 0; r < rows.length; r++) {
    if (lastTokens === null || rows[r].tokens !== lastTokens) {
      rank = r + 1
      lastTokens = rows[r].tokens
    }
    rows[r].rank = rank
    rows[r].share = total > 0 ? rows[r].tokens / total : 0
    rows[r].bar = rows.length > 0 && rows[0].tokens > 0 ? rows[r].tokens / rows[0].tokens : 0
  }

  return {
    period: window,
    rows: rows,
    total: total,
    leader: rows.length > 0 ? rows[0] : null
  }
}

function dayTokens(days, date) {
  var list = days || []
  for (var i = 0; i < list.length; i++) {
    if (String((list[i] && list[i].date) || "") === date)
      return numberValue(list[i].messageCount)
  }
  return 0
}

function pad2(value) {
  var text = String(value)
  return text.length >= 2 ? text : "0" + text
}

function dateString(date) {
  return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate())
}

function recentDateStrings(now) {
  var base = now ? new Date(now) : new Date()
  var result = []
  for (var offset = 6; offset >= 0; offset--) {
    var day = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset)
    result.push(dateString(day))
  }
  return result
}

function weekSeries(rows, now) {
  var dates = recentDateStrings(now)
  var list = rows || []
  var days = []
  var peak = 0
  for (var i = 0; i < dates.length; i++) {
    var date = dates[i]
    var parts = []
    var total = 0
    for (var r = 0; r < list.length; r++) {
      var tokens = dayTokens(list[r].recentDays, date)
      if (tokens > 0) {
        parts.push({
          providerId: list[r].providerId,
          providerName: list[r].providerName,
          tokens: tokens
        })
      }
      total += tokens
    }
    peak = Math.max(peak, total)
    days.push({ date: date, total: total, parts: parts })
  }
  return { days: days, peak: peak }
}

function modelRows(record, limit) {
  var usage = record && record.modelUsage ? record.modelUsage : {}
  var rows = []
  for (var id in usage) {
    var bucket = usage[id] || {}
    var input = numberValue(bucket.inputTokens)
    var output = numberValue(bucket.outputTokens)
    var cacheRead = numberValue(bucket.cacheReadInputTokens)
    var cacheWrite = numberValue(bucket.cacheCreationInputTokens)
    var total = input + output + cacheRead + cacheWrite
    if (total <= 0) continue
    rows.push({
      id: String(id),
      name: friendlyModelName(id),
      total: total,
      input: input,
      output: output,
      cacheRead: cacheRead,
      cacheWrite: cacheWrite
    })
  }
  rows.sort(function(a, b) { return b.total - a.total })
  var cap = Number(limit)
  if (isFinite(cap) && cap >= 0) return rows.slice(0, cap)
  return rows
}

function formatTokenCount(value) {
  var n = Number(value || 0)
  if (!isFinite(n)) n = 0
  var abs = Math.abs(n)
  if (abs >= 1e9) return trimFixed(n / 1e9) + "B"
  if (abs >= 1e6) return trimFixed(n / 1e6) + "M"
  if (abs >= 1e3) return trimFixed(n / 1e3) + "K"
  return String(Math.round(n))
}

function trimFixed(value) {
  var text = value.toFixed(1)
  return text.charAt(text.length - 1) === "0" ? text.slice(0, -2) : text
}

function formatShare(share) {
  var n = Number(share || 0)
  if (!isFinite(n) || n <= 0) return "0%"
  if (n >= 0.995) return "100%"
  if (n < 0.01) return "<1%"
  return Math.round(n * 100) + "%"
}

function modelWordCase(word) {
  if (word === "gpt") return "GPT"
  if (word === "deepseek") return "DeepSeek"
  if (word === "glm") return "GLM"
  return word.charAt(0).toUpperCase() + word.slice(1)
}

// OpenCode routes through many underlying providers (the `providerID`
// values in its session model field). These are the known ones; anything
// else falls back to a clean title-case so a newly-added provider still
// renders sanely instead of being silently mislabeled.
function friendlyProviderName(providerId) {
  var known = {
    "opencode": "OpenCode",
    "opencode-go": "OpenCode Go",
    "openrouter": "OpenRouter",
    "venice": "Venice",
    "aihubmix": "AIHubMix",
    "bai": "Bai",
    "bai-glm": "Bai GLM",
    "bai-gpt": "Bai GPT",
    "cloudflare-workers-ai": "Cloudflare Workers AI",
    "freetoken": "FreeToken",
    "gmicloud": "GMCloud",
    "gorouter": "GoRouter",
    "nous": "Nous"
  }
  if (known[providerId]) return known[providerId]
  return providerId.split(/[-\s.]+/).map(function(w) {
    if (/^(gpt|ai|glm|api|sdk|ml)$/i.test(w)) return w.toUpperCase()
    return w.charAt(0).toUpperCase() + w.slice(1)
  }).join(" ")
}

// Split an OpenCode modelUsage key (`providerID/modelID`) into its parts.
// Keys without a slash are left as a bare model id.
function splitModelKey(id) {
  var raw = String(id || "")
  var slash = raw.indexOf("/")
  if (slash < 0) return { provider: "", model: raw }
  return { provider: raw.substring(0, slash), model: raw.substring(slash + 1) }
}

function friendlyModelName(id) {
  if (!id) return "Unknown"
  var split = splitModelKey(id)
  var name = split.model.replace(/^claude-/, "").replace(/-\d{8}$/, "")
  var parts = name.split("-")
  var words = []
  var version = []
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    if (part === "") continue
    if (/^\d/.test(part)) {
      version.push(part)
      continue
    }
    if (version.length > 0) {
      words.push(version.join("."))
      version = []
    }
    words.push(modelWordCase(part))
  }
  if (version.length > 0) words.push(version.join("."))
  var model = words.length > 0 ? words.join(" ") : "Unknown"
  if (split.provider === "") return model
  return friendlyProviderName(split.provider) + " / " + model
}

function heroMeta(board, period, viewMode) {
  var modeLabel = viewMode === "model" ? " by model" : ""
  if (!board || !board.rows || board.rows.length === 0)
    return "No " + periodLabel(period).toLowerCase() + " usage yet"
  var text = periodLabel(period) + modeLabel + " · " + formatTokenCount(board.total)
  if (board.leader) text += " · " + board.leader.providerName
  return text
}

function barTooltip(board, period, viewMode) {
  var modeLabel = viewMode === "model" ? " (model)" : ""
  if (!board || !board.leader)
    return "Agent Leaderboard"
  return board.leader.providerName + " leads "
    + periodLabel(period).toLowerCase()
    + modeLabel
    + " · " + formatTokenCount(board.leader.tokens) + " tokens"
}

function selectedSummary(row, period, viewMode) {
  if (!row) return ""
  if (viewMode === "model" && row.modelProviderName)
    return "via " + row.modelProviderName
  var parts = []
  if (row.hasPromptStats !== false) {
    if (period === "today") {
      if (row.todayPrompts > 0) parts.push(row.todayPrompts + " prompt" + (row.todayPrompts === 1 ? "" : "s"))
      if (row.todaySessions > 0) parts.push(row.todaySessions + " session" + (row.todaySessions === 1 ? "" : "s"))
    } else {
      if (row.totalPrompts > 0) parts.push(row.totalPrompts + " prompt" + (row.totalPrompts === 1 ? "" : "s"))
      if (row.totalSessions > 0) parts.push(row.totalSessions + " session" + (row.totalSessions === 1 ? "" : "s"))
    }
  }
  if (row.activeDays > 0 && period === "all")
    parts.push(row.activeDays + " day" + (row.activeDays === 1 ? "" : "s"))
  return parts.join(" · ")
}

function modelTooltip(row) {
  if (!row) return ""
  return "In " + formatTokenCount(row.input)
    + " · out " + formatTokenCount(row.output)
    + " · cache read " + formatTokenCount(row.cacheRead)
    + " · cache write " + formatTokenCount(row.cacheWrite)
}

function dayName(date) {
  var parsed = new Date(String(date || "") + "T00:00:00")
  if (isNaN(parsed.getTime())) return String(date || "")
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][parsed.getDay()]
}

function dayLabel(date, today) {
  if (today) return "Today"
  return dayName(date)
}
