import QtQuick
import Quickshell
import Quickshell.Io

// Discovers agent usage records, watches them, and regenerates them
// through omarchy-agent-usage-update. Ranking lives in Model.js; this
// file only owns the files on disk.
Item {
  id: root
  visible: false

  property var settings: ({})

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string usageDir: (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy/agents/usage"
  readonly property string configDir: Quickshell.env("OMARCHY_AGENTS_CONFIG") || (home + "/.config/omarchy-agents")

  property var agentIds: []
  property var agents: []
  property var records: []
  property var pricingOverrides: ({})
  property int dataRevision: 0

  FileView {
    path: root.configDir + "/pricing.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      try {
        var parsed = JSON.parse(String(text() || ""))
        root.pricingOverrides = parsed && typeof parsed === "object" ? parsed : ({})
      } catch (e) {
        root.pricingOverrides = ({})
      }
      root.publishRecords()
    }
    onLoadFailed: {
      root.pricingOverrides = ({})
      root.publishRecords()
    }
  }

  Process {
    id: listProcess
    running: false
    command: ["find", root.usageDir, "-maxdepth", "1", "-name", "*.json", "-printf", "%f\n"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyAgentListing(text)
    }
  }

  function rescanAgents() {
    if (!listProcess.running) listProcess.running = true
  }

  function applyAgentListing(output) {
    var ids = []
    var lines = String(output || "").split("\n")
    for (var i = 0; i < lines.length; i++) {
      var name = lines[i].trim()
      if (name.slice(-5) === ".json") ids.push(name.slice(0, -5))
    }
    ids.sort()
    if (JSON.stringify(ids) !== JSON.stringify(agentIds)) agentIds = ids
  }

  Instantiator {
    id: agentInstantiator
    model: root.agentIds

    delegate: Agent {
      required property var modelData
      agentId: modelData
      path: root.usageDir + "/" + modelData + ".json"
      onRecordChanged: root.publishRecords()
    }

    onObjectAdded: (index, object) => root.rebuildAgents()
    onObjectRemoved: (index, object) => root.rebuildAgents()
  }

  function rebuildAgents() {
    var result = []
    for (var i = 0; i < agentInstantiator.count; i++) {
      var agent = agentInstantiator.objectAt(i)
      if (agent) result.push(agent)
    }
    agents = result
    publishRecords()
  }

  function publishRecords() {
    var next = []
    for (var i = 0; i < agents.length; i++) {
      var record = agents[i] ? agents[i].record : null
      if (record && record.id) next.push(record)
    }
    records = next
    dataRevision++
  }

  readonly property string fireworksHelper: {
    var url = String(Qt.resolvedUrl("collect-fireworks.py"))
    if (url.indexOf("file://") === 0) url = url.substring(7)
    try { return decodeURIComponent(url) } catch (e) { return url }
  }

  readonly property string antigravityHelper: {
    var url = String(Qt.resolvedUrl("collect-antigravity.py"))
    if (url.indexOf("file://") === 0) url = url.substring(7)
    try { return decodeURIComponent(url) } catch (e) { return url }
  }

  Component.onCompleted: {
    rescanAgents()
    runFireworksOfficial()
    runAntigravityCollector()
  }

  property int refreshIntervalSec: Math.max(30, Number(setting("refreshIntervalSec", 900)))
  property string pendingUpdateKind: ""

  Timer {
    interval: root.refreshIntervalSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.runUpdate("normal")
  }

  Process {
    id: updateProcess
    running: false
    onExited: {
      root.runFireworksOfficial()
      root.runAntigravityCollector()
      if (root.pendingUpdateKind !== "") {
        var kind = root.pendingUpdateKind
        root.pendingUpdateKind = ""
        root.runUpdate(kind)
      }
    }

    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("agent-leaderboard", text.trim())
    }
  }

  Process {
    id: fireworksProcess
    running: false
    onExited: root.rescanAgents()
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("agent-leaderboard/fireworks", text.trim())
    }
  }

  Process {
    id: antigravityProcess
    running: false
    onExited: root.rescanAgents()
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("agent-leaderboard/antigravity", text.trim())
    }
  }

  function runFireworksOfficial() {
    if (fireworksProcess.running || root.fireworksHelper === "") {
      root.rescanAgents()
      return
    }
    fireworksProcess.command = ["python3", root.fireworksHelper]
    fireworksProcess.running = true
  }

  function runAntigravityCollector() {
    if (antigravityProcess.running || root.antigravityHelper === "") {
      root.rescanAgents()
      return
    }
    antigravityProcess.command = ["python3", root.antigravityHelper]
    antigravityProcess.running = true
  }

  function updateCommand(kind) {
    // quickshell's own PATH puts /usr/share/omarchy/bin ahead of
    // ~/.local/bin, so a bare lookup would always hit the stock collector
    // and skip user overrides (e.g. the codex rate-limit fix). Force
    // ~/.local/bin first, matching how a login shell already resolves it.
    var command = ["bash", "-c", 'PATH="$HOME/.local/bin:$PATH" exec omarchy-agent-usage-update "$@"', "omarchy-agent-usage-update"]
    if (kind === "force") command.push("--force")
    var providers = settings && settings.providers ? settings.providers : {}
    for (var id in providers) {
      if (providers[id] && providers[id].enabled === false) command.push("--except", id)
    }
    return command
  }

  function runUpdate(kind) {
    if (updateProcess.running) {
      if (kind === "force" || root.pendingUpdateKind === "") root.pendingUpdateKind = kind
      return
    }
    updateProcess.command = updateCommand(kind)
    updateProcess.running = true
  }

  function refresh() { refreshAll(true) }
  function refreshAll(force) { runUpdate(force === true ? "force" : "normal") }

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }
}
