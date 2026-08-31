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

var PRICING_AS_OF = "2026-08-01"

var BUILT_IN_PRICING = [
  { match: "claude-opus", inputPerMtok: 5, outputPerMtok: 25, cacheReadPerMtok: 0.5, cacheWritePerMtok: 6.25, asOf: PRICING_AS_OF },
  { match: "claude-sonnet", inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75, asOf: PRICING_AS_OF },
  { match: "claude-haiku", inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.1, cacheWritePerMtok: 1.25, asOf: PRICING_AS_OF },
  { match: "gpt-5", inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 0.25, cacheWritePerMtok: 2.5, asOf: PRICING_AS_OF },
  { match: "gpt-4", inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 0.25, cacheWritePerMtok: 2.5, asOf: PRICING_AS_OF },
  { match: "codex", inputPerMtok: 2.5, outputPerMtok: 10, cacheReadPerMtok: 0.25, cacheWritePerMtok: 2.5, asOf: PRICING_AS_OF },
  { match: "deepseek", inputPerMtok: 0.28, outputPerMtok: 1.12, cacheReadPerMtok: 0.028, cacheWritePerMtok: 0.28, asOf: PRICING_AS_OF },
  { match: "kimi", inputPerMtok: 0.6, outputPerMtok: 2.5, cacheReadPerMtok: 0.06, cacheWritePerMtok: 0.6, asOf: PRICING_AS_OF },
  { match: "glm", inputPerMtok: 0.6, outputPerMtok: 2.2, cacheReadPerMtok: 0.11, cacheWritePerMtok: 0.6, asOf: PRICING_AS_OF },
  { match: "qwen", inputPerMtok: 0.55, outputPerMtok: 2.2, cacheReadPerMtok: 0.055, cacheWritePerMtok: 0.55, asOf: PRICING_AS_OF }
]

function normalizeModel(model) {
  return String(model || "").toLowerCase().replace(/^(@cf\/|models\/|(?:openai|anthropic|google|meta|microsoft)\/)/, "")
}

function longestMatch(normalized, matches) {
  var hits = matches.filter(function(m) { return normalized.indexOf(m) === 0 })
  hits.sort(function(a, b) { return b.length - a.length })
  return hits.length > 0 ? hits[0] : null
}

function ratesForModel(model, overrides) {
  var normalized = normalizeModel(model)
  var ov = overrides || {}
  var overrideKeys = Object.keys(ov)
  var overrideKey = overrideKeys.indexOf(normalized) >= 0
    ? normalized
    : longestMatch(normalized, overrideKeys.map(function(k) { return normalizeModel(k) }))
  if (overrideKey) {
    var raw = ov[overrideKey]
    if (!raw) return null
    return {
      inputPerMtok: Number(raw.inputPerMtok || 0),
      outputPerMtok: Number(raw.outputPerMtok || 0),
      cacheReadPerMtok: Number(raw.cacheReadPerMtok || 0),
      cacheWritePerMtok: Number(raw.cacheWritePerMtok || 0),
      source: "override"
    }
  }
  var match = longestMatch(normalized, BUILT_IN_PRICING.map(function(e) { return e.match }))
  if (!match) return null
  for (var i = 0; i < BUILT_IN_PRICING.length; i++) {
    if (BUILT_IN_PRICING[i].match === match) {
      var entry = BUILT_IN_PRICING[i]
      return {
        inputPerMtok: entry.inputPerMtok,
        outputPerMtok: entry.outputPerMtok,
        cacheReadPerMtok: entry.cacheReadPerMtok,
        cacheWritePerMtok: entry.cacheWritePerMtok,
        source: "built-in"
      }
    }
  }
  return null
}

function bucketCost(modelId, bucket, overrides) {
  if (!bucket || typeof bucket !== "object") return 0
  var rates = ratesForModel(modelId, overrides)
  if (!rates) return 0
  var input = numberValue(bucket.inputTokens)
  var output = numberValue(bucket.outputTokens)
  var cacheRead = numberValue(bucket.cacheReadInputTokens)
  var cacheWrite = numberValue(bucket.cacheCreationInputTokens)
  return (input * rates.inputPerMtok + output * rates.outputPerMtok + cacheRead * rates.cacheReadPerMtok + cacheWrite * rates.cacheWritePerMtok) / 1e6
}

function estimateTokensCost(modelId, tokens, overrides) {
  var n = Number(tokens || 0)
  if (!isFinite(n) || n <= 0) return 0
  var rates = ratesForModel(modelId, overrides)
  if (!rates) return 0
  var blended = rates.inputPerMtok * 0.75 + rates.outputPerMtok * 0.25
  return (n * blended) / 1e6
}

function dominantModelKey(record) {
  var usage = record && record.modelUsage ? record.modelUsage : {}
  var bestModel = null
  var bestTokens = 0
  for (var mid in usage) {
    var t = tokenBucketTotal(usage[mid])
    if (t > bestTokens) {
      bestTokens = t
      bestModel = mid
    }
  }
  if (bestModel) return bestModel
  var todayByModel = record && record.todayTokensByModel ? record.todayTokensByModel : {}
  for (var mid2 in todayByModel) {
    var t2 = todayTokenTotal(todayByModel[mid2])
    if (t2 > bestTokens) {
      bestTokens = t2
      bestModel = mid2
    }
  }
  return bestModel
}

function allTimeRecordCost(record, overrides) {
  var usage = record && record.modelUsage ? record.modelUsage : {}
  var totalCost = 0
  var modelTokensSum = 0
  for (var mid in usage) {
    totalCost += bucketCost(mid, usage[mid], overrides)
    modelTokensSum += tokenBucketTotal(usage[mid])
  }
  var allTokens = allTimeTokens(record)
  if (modelTokensSum > 0 && allTokens > modelTokensSum) {
    totalCost = (totalCost / modelTokensSum) * allTokens
  } else if (modelTokensSum === 0 && allTokens > 0) {
    var dom = dominantModelKey(record)
    if (dom) totalCost = estimateTokensCost(dom, allTokens, overrides)
  }
  return totalCost
}

function todayRecordCost(record, overrides) {
  var todayByModel = record && record.todayTokensByModel ? record.todayTokensByModel : {}
  var hasTodayModels = false
  var cost = 0
  for (var mid in todayByModel) {
    hasTodayModels = true
    var val = todayByModel[mid]
    if (val && typeof val === "object") {
      cost += bucketCost(mid, val, overrides)
    } else {
      var t = Number(val || 0)
      if (t <= 0) continue
      var histBucket = record && record.modelUsage ? record.modelUsage[mid] : null
      var histTokens = tokenBucketTotal(histBucket)
      if (histTokens > 0) {
        var histCost = bucketCost(mid, histBucket, overrides)
        cost += (histCost / histTokens) * t
      } else {
        cost += estimateTokensCost(mid, t, overrides)
      }
    }
  }
  if (hasTodayModels) return cost
  var todayTokens = numberValue(record && record.todayTotalTokens)
  if (todayTokens <= 0) return 0
  var allTokens = allTimeTokens(record)
  var allCost = allTimeRecordCost(record, overrides)
  if (allTokens > 0 && allCost > 0) {
    return (allCost / allTokens) * todayTokens
  }
  var dom = dominantModelKey(record)
  if (dom) return estimateTokensCost(dom, todayTokens, overrides)
  return 0
}

function periodRecordCost(record, period, overrides) {
  if (!record) return 0
  if (period === "today") return todayRecordCost(record, overrides)
  if (period === "all") return allTimeRecordCost(record, overrides)
  var wTokens = weekTokens(record)
  if (wTokens <= 0) return 0
  var allTokens = allTimeTokens(record)
  var allCost = allTimeRecordCost(record, overrides)
  if (allTokens > 0 && allCost > 0) {
    return (allCost / allTokens) * wTokens
  }
  var dom = dominantModelKey(record)
  if (dom) return estimateTokensCost(dom, wTokens, overrides)
  return 0
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
  var overrides = settings && settings.pricingOverrides ? settings.pricingOverrides : null

  for (var i = 0; i < list.length; i++) {
    var record = list[i]
    if (!record || !record.id) continue
    var id = String(record.id)
    if (!providerEnabled(settings, id)) continue
    if (!hasAnyUsage(record)) continue
    var tokens = periodTokens(record, window)
    if (tokens <= 0) continue
    var cost = periodRecordCost(record, window, overrides)
    rows.push({
      providerId: id,
      providerName: String(record.name || id),
      tokens: tokens,
      cost: cost,
      todayTokens: numberValue(record.todayTotalTokens),
      todayCost: todayRecordCost(record, overrides),
      weekTokens: weekTokens(record),
      weekCost: periodRecordCost(record, "week", overrides),
      allTokens: allTimeTokens(record),
      allCost: allTimeRecordCost(record, overrides),
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
  var totalCost = 0
  for (var t = 0; t < rows.length; t++) {
    total += rows[t].tokens
    totalCost += rows[t].cost
  }

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
    totalCost: totalCost,
    leader: rows.length > 0 ? rows[0] : null
  }
}

function rankByModel(records, period, settings) {
  var list = asArray(records)
  var window = String(period || "today")
  if (window !== "today" && window !== "week" && window !== "all") window = "today"
  var overrides = settings && settings.pricingOverrides ? settings.pricingOverrides : null

  // Aggregate modelUsage across every enabled provider.
  // modelId -> { tokens: number, cost: number, providerId: string, providerName: string, todayTokens: number, todayCost: number }
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
      var todayCostVal = typeof todayByModel[mid] === "object"
        ? bucketCost(mid, todayByModel[mid], overrides)
        : estimateTokensCost(mid, todayVal, overrides)
      if (!models[mid]) models[mid] = { providerId: id, providerName: providerName, tokens: 0, cost: 0, todayTokens: 0, todayCost: 0 }
      models[mid].todayTokens += todayVal
      models[mid].todayCost += todayCostVal
      if (window === "today") {
        models[mid].tokens += todayVal
        models[mid].cost += todayCostVal
      }
    }

    // All-time: sum modelUsage buckets
    var usage = record.modelUsage || {}
    for (var mid2 in usage) {
      var bucketTotalVal = tokenBucketTotal(usage[mid2])
      if (bucketTotalVal <= 0) continue
      var bucketCostVal = bucketCost(mid2, usage[mid2], overrides)
      if (!models[mid2]) models[mid2] = { providerId: id, providerName: providerName, tokens: 0, cost: 0, todayTokens: 0, todayCost: 0 }
      if (window === "week" || window === "all") {
        models[mid2].tokens += bucketTotalVal
        models[mid2].cost += bucketCostVal
      }
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
      cost: m.cost,
      todayTokens: m.todayTokens,
      todayCost: m.todayCost,
      hasPromptStats: false
    })
  }

  rows.sort(function(a, b) {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens
    return String(a.providerName).localeCompare(String(b.providerName))
  })

  var total = 0
  var totalCost = 0
  for (var t = 0; t < rows.length; t++) {
    total += rows[t].tokens
    totalCost += rows[t].cost
  }

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
    totalCost: totalCost,
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

function modelRows(record, limit, overrides) {
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
    var cost = bucketCost(id, bucket, overrides)
    rows.push({
      id: String(id),
      name: friendlyModelName(id),
      total: total,
      cost: cost,
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

function formatCost(value) {
  var n = Number(value || 0)
  if (!isFinite(n) || n <= 0) return "$0.00"
  if (n < 0.005) return "<$0.01"
  if (n < 1000) return "$" + n.toFixed(2)
  if (n < 1e6) return "$" + trimFixed(n / 1e3) + "K"
  return "$" + trimFixed(n / 1e6) + "M"
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
  if (board.totalCost > 0) text += " (" + formatCost(board.totalCost) + ")"
  if (board.leader) text += " · " + board.leader.providerName
  return text
}

function barTooltip(board, period, viewMode) {
  var modeLabel = viewMode === "model" ? " (model)" : ""
  if (!board || !board.leader)
    return "Agent Leaderboard"
  var costText = board.leader.cost > 0 ? " (" + formatCost(board.leader.cost) + ")" : ""
  return board.leader.providerName + " leads "
    + periodLabel(period).toLowerCase()
    + modeLabel
    + " · " + formatTokenCount(board.leader.tokens) + " tokens"
    + costText
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
  if (row.cost > 0)
    parts.push("est. " + formatCost(row.cost))
  return parts.join(" · ")
}

function modelTooltip(row) {
  if (!row) return ""
  var text = "In " + formatTokenCount(row.input)
    + " · out " + formatTokenCount(row.output)
    + " · cache read " + formatTokenCount(row.cacheRead)
    + " · cache write " + formatTokenCount(row.cacheWrite)
  if (row.cost > 0)
    text += " · est. " + formatCost(row.cost)
  return text
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
