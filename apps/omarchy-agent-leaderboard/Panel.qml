import QtQuick
import QtQuick.Controls
import QtQuick.Effects
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

Panel {
  id: root
  moduleName: "mustafaokur.agent-leaderboard"
  ipcTarget: "mustafaokur.agent-leaderboard"
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color accent: Color.accent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color surface: Color.popups.background
  readonly property color track: root.alpha(root.accent, 0.14)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property url trophyMark: Qt.resolvedUrl("assets/trophy.svg")

  property string period: {
    var value = String(setting("period", "today"))
    if (value === "week" || value === "all") return value
    return "today"
  }
  property string viewMode: {
    var value = String(setting("viewMode", "provider"))
    if (value === "model") return value
    return "provider"
  }
  property string selectedProviderId: ""
  property bool cursorActive: false
  property double nowMs: Date.now()

  readonly property var board: {
    var rev = usage.dataRevision
    if (root.viewMode === "model")
      return Model.rankByModel(usage.records, root.period, root.settings)
    return Model.rankRecords(usage.records, root.period, root.settings)
  }
  readonly property var modelBoard: root.viewMode === "model" ? board : null
  readonly property bool isModelView: root.viewMode === "model"
  readonly property var standings: board && board.rows ? board.rows : []
  readonly property var selectedRow: {
    for (var i = 0; i < standings.length; i++)
      if (standings[i].providerId === selectedProviderId) return standings[i]
    return standings.length > 0 ? standings[0] : null
  }
  readonly property int selectedIndex: {
    if (!selectedRow) return 0
    for (var i = 0; i < standings.length; i++)
      if (standings[i].providerId === selectedRow.providerId) return i
    return 0
  }
  readonly property var weekChart: {
    if (root.viewMode === "model") return null
    var rev = usage.dataRevision
    return Model.weekSeries(standings, root.nowMs)
  }
  readonly property bool hasUsage: {
    var rev = usage.dataRevision
    var records = usage.records || []
    if (root.viewMode === "model") {
      for (var i = 0; i < records.length; i++) {
        var rec = records[i]
        if (!Model.providerEnabled(root.settings, String(rec.id || ""))) continue
        var usage2 = rec.modelUsage || {}
        for (var mid in usage2)
          if (Model.tokenBucketTotal(usage2[mid]) > 0) return true
        var tbm = rec.todayTokensByModel || {}
        for (var mid2 in tbm)
          if (Model.numberValue(tbm[mid2]) > 0) return true
      }
      return false
    }
    for (var j = 0; j < records.length; j++)
      if (Model.hasAnyUsage(records[j]) && Model.providerEnabled(root.settings, String(records[j].id || "")))
        return true
    return false
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
  function alpha(c, a) { return Qt.rgba(c.r, c.g, c.b, a) }

  function selectRow(index) {
    if (standings.length === 0) return
    var wrapped = ((index % standings.length) + standings.length) % standings.length
    selectedProviderId = standings[wrapped].providerId
  }

  function cyclePeriod(delta) {
    period = Model.nextPeriod(period, delta)
  }

  function refreshNow() {
    usage.refreshAll(true)
  }

  function launchAgent() {
    if (root.bar) root.bar.run("omarchy-agent --pick")
    root.close()
  }

  function todayDate() {
    var now = new Date(root.nowMs)
    return now.getFullYear()
      + "-" + String(now.getMonth() + 1).padStart(2, "0")
      + "-" + String(now.getDate()).padStart(2, "0")
  }

  function colorChannelLuminance(value) {
    var channel = Number(value)
    if (!isFinite(channel)) return 0
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
  }

  function colorLuminance(color) {
    return 0.2126 * colorChannelLuminance(color.r)
      + 0.7152 * colorChannelLuminance(color.g)
      + 0.0722 * colorChannelLuminance(color.b)
  }

  readonly property var shippedMarks: ({
    cline: true,
    antigravity: true,
    agy: true,
    claude: true,
    codex: true,
    fireworks: true,
    grok: true,
    hermes: true,
    opencode: true
  })

  function iconCandidatesFor(id, surfaceColor) {
    if (!id || !root.shippedMarks[id]) return []
    var candidates = []
    if ((id === "codex" || id === "grok" || id === "antigravity" || id === "agy" || id === "cline" || id === "opencode") && colorLuminance(surfaceColor || Color.background) >= 0.5)
      candidates.push(Qt.resolvedUrl("assets/" + id + "-light.svg"))
    candidates.push(Qt.resolvedUrl("assets/" + id + ".svg"))
    return candidates
  }

  function agentAccent(id) {
    if (id === "cline") return "#6BCB77"
    if (id === "antigravity" || id === "agy") return "#4285F4"
    if (id === "claude") return "#D97757"
    if (id === "fireworks") return "#FF6B22"
    if (id === "hermes") return "#C9A227"
    if (id === "codex") return "#10A37F"
    if (id === "opencode") return "#C77DFF"
    if (id === "grok") return "#E8C468"
    var palette = ["#7C9CFF", "#6BCB77", "#FFD93D", "#FF6B6B", "#C77DFF", "#4ECDC4"]
    var hash = 0
    var key = String(id || "")
    for (var i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
    return palette[hash % palette.length]
  }

  function weekTooltip(day) {
    if (!day) return ""
    var today = String(day.date || "") === root.todayDate()
    var label = Model.dayLabel(day.date, today)
    var text = label + " · " + Model.formatTokenCount(day.total) + " tokens"
    var parts = day.parts || []
    for (var i = 0; i < parts.length; i++)
      text += "\n" + parts[i].providerName + " " + Model.formatTokenCount(parts[i].tokens)
    return text
  }

  visible: root.hasUsage
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onPeriodChanged: if (panelFlick) panelFlick.contentY = 0
  onOpenedChanged: if (opened) {
    cursorActive = false
    nowMs = Date.now()
    if (panelFlick) panelFlick.contentY = 0
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Main {
    id: usage
    settings: root.settings
  }

  Timer {
    interval: 30000
    running: root.opened
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { root.refreshNow(); return "ok" }
    function next(): string { root.cyclePeriod(1); return "ok" }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // Font Awesome trophy, present in every Nerd Font Omarchy ships.
    // Only drawn if the SVG mark fails to load.
    text: "\uf091"
    tooltipText: Model.barTooltip(root.board, root.period, root.viewMode)
    // Nerd-font neighbors (Agents, network, bluetooth) paint at iconFont
    // on a larger iconCanvas. Fill that font box so the cup matches them
    // instead of looking like a 16px tray portrait.
    opticalSize: Style.bar.iconFont
    iconComponent: Component {
      Item {
        Image {
          id: barMark
          anchors.fill: parent
          source: root.trophyMark
          sourceSize.width: Math.max(2, width) * 2
          sourceSize.height: Math.max(2, height) * 2
          fillMode: Image.PreserveAspectFit
          smooth: true
          antialiasing: true
          visible: false
          layer.enabled: true
        }

        MultiEffect {
          anchors.fill: barMark
          source: barMark
          visible: barMark.status === Image.Ready
          colorization: 1.0
          colorizationColor: button.active && button.useActiveColor ? button.activeColor : button.foreground
        }

        Text {
          anchors.centerIn: parent
          visible: barMark.status !== Image.Ready
          text: button.text
          color: button.active && button.useActiveColor ? button.activeColor : button.foreground
          font.family: button.fontFamily
          font.pixelSize: button.fontSize
        }
      }
    }
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.launchAgent()
      else if (buttonCode === Qt.MiddleButton) root.cyclePeriod(1)
      else root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onMoveRequested: function(dx, dy) {
        if (dx !== 0) {
          root.cursorActive = true
          root.cyclePeriod(dx)
        }
        if (dy !== 0) {
          root.cursorActive = true
          root.selectRow(root.selectedIndex + dy)
        }
      }
      onActivateRequested: root.refreshNow()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "r" || t === "R") root.refreshNow()
        else if (t === "h" || t === "H") root.cyclePeriod(-1)
        else if (t === "l" || t === "L") root.cyclePeriod(1)
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "Agent Leaderboard"
            meta: Model.heroMeta(root.board, root.period, root.viewMode)
            foreground: root.foreground
            fontFamily: root.fontFamily

            iconComponent: Component {
              Item {
                width: Style.font.display
                height: Style.font.display

                Image {
                  id: heroMark
                  anchors.fill: parent
                  source: root.trophyMark
                  sourceSize.width: Style.font.display * 2
                  sourceSize.height: Style.font.display * 2
                  fillMode: Image.PreserveAspectFit
                  visible: false
                  layer.enabled: true
                }

                MultiEffect {
                  anchors.fill: heroMark
                  source: heroMark
                  visible: heroMark.status === Image.Ready
                  colorization: 1.0
                  colorizationColor: root.foreground
                }

                Text {
                  anchors.centerIn: parent
                  visible: heroMark.status !== Image.Ready
                  text: button.text
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.display
                }
              }
            }
          }

          Row {
            id: periodSwitch
            width: parent.width
            spacing: Style.spacing.md

            readonly property var options: Model.periodOptions()
            readonly property real cellWidth: options.length > 0
              ? (width - spacing * (options.length - 1)) / options.length
              : 0

            Repeater {
              model: periodSwitch.options

              Button {
                required property var modelData
                required property int index

                width: periodSwitch.cellWidth
                text: modelData.label
                selected: modelData.value === root.period
                hasCursor: root.cursorActive && modelData.value === root.period
                bordered: true
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.bodySmall
                verticalPadding: Style.spacing.controlPaddingY
                onClicked: {
                  root.cursorActive = true
                  root.period = modelData.value
                }
                onHovered: function(isHovered) { if (isHovered) root.cursorActive = true }
              }
            }
          }

          Row {
            id: viewSwitch
            width: parent.width
            spacing: Style.spacing.md

            readonly property var options: Model.viewOptions()
            readonly property real cellWidth: options.length > 0
              ? (width - spacing * (options.length - 1)) / options.length
              : 0

            Repeater {
              model: viewSwitch.options

              Button {
                required property var modelData
                required property int index

                width: viewSwitch.cellWidth
                text: modelData.label
                selected: modelData.value === root.viewMode
                hasCursor: root.cursorActive && modelData.value === root.viewMode
                bordered: true
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                verticalPadding: Style.spacing.controlPaddingY
                onClicked: {
                  root.cursorActive = true
                  root.viewMode = modelData.value
                }
                onHovered: function(isHovered) { if (isHovered) root.cursorActive = true }
              }
            }
          }

          Text {
            visible: root.standings.length === 0
            width: parent.width
            topPadding: Style.space(12)
            text: root.hasUsage
              ? "No tokens in this window.\nSwitch the ranking period or refresh."
              : "No AI coding agents found.\nClaude, Codex, and Fireworks show up here once you've used them."
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
          }

          PanelSeparator {
            visible: standingsSection.visible
            foreground: root.foreground
          }

          Column {
            id: standingsSection
            visible: root.standings.length > 0
            width: parent.width
            spacing: Style.spacing.md

            PanelSectionHeader {
              width: parent.width
              text: "STANDINGS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.standings

              RankRow {
                required property var modelData
                required property int index
                width: standingsSection.width
                row: modelData
                rowIndex: index
                selected: root.selectedRow && modelData.providerId === root.selectedRow.providerId
              }
            }
          }

          PanelSeparator {
            visible: weekSection.visible
            foreground: root.foreground
          }

          Column {
            id: weekSection
            visible: root.weekChart && root.weekChart.peak > 0
            width: parent.width
            spacing: Style.spacing.md

            PanelSectionHeader {
              width: parent.width
              text: "LAST 7 DAYS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Row {
              id: weekRow
              width: parent.width
              height: Style.space(88)
              spacing: Style.space(6)

              Repeater {
                model: root.weekChart ? root.weekChart.days : []

                DayColumn {
                  required property var modelData
                  required property int index
                  width: weekRow.width > 0
                    ? (weekRow.width - weekRow.spacing * 6) / 7
                    : Style.space(40)
                  height: weekRow.height
                  day: modelData
                  peak: root.weekChart ? root.weekChart.peak : 1
                  today: String(modelData.date || "") === root.todayDate()
                }
              }
            }
          }

        }
      }
    }
  }

  component RankRow: Item {
    id: rankRow
    property var row: null
    property int rowIndex: 0
    property bool selected: false

    implicitHeight: Math.max(rankLabel.implicitHeight, nameLabel.implicitHeight) + Style.spacing.lg

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius
      color: rankRow.selected ? root.alpha(root.accent, 0.08) : root.alpha(root.foreground, 0.03)
      border.width: rankRow.selected ? 1 : 0
      border.color: root.alpha(root.accent, 0.35)
    }

    Rectangle {
      id: selectedBar
      anchors.left: parent.left
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: rankRow.selected ? Style.space(2) : 0
      color: root.accent
      visible: rankRow.selected

      Behavior on width {
        NumberAnimation { duration: 120; easing.type: Easing.OutCubic }
      }
    }

    Rectangle {
      anchors.left: parent.left
      anchors.top: parent.top
      anchors.bottom: parent.bottom
      width: parent.width * root.clamp(rankRow.row ? rankRow.row.bar : 0, 0, 1)
      radius: Style.cornerRadius
      color: root.alpha(root.agentAccent(rankRow.row ? (root.isModelView && rankRow.row.modelProviderId ? rankRow.row.modelProviderId : rankRow.row.providerId) : ""), 0.20)

      Behavior on width {
        NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
      }
    }

    Text {
      id: rankLabel
      text: rankRow.row ? String(rankRow.row.rank) : ""
      color: rankRow.row && rankRow.row.rank === 1 ? root.accent : (rankRow.row && rankRow.row.rank <= 3 ? root.foreground : root.dim)
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: rankRow.row && rankRow.row.rank <= 3
      horizontalAlignment: Text.AlignHCenter
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(22)
    }

    Item {
      id: mark
      width: Style.space(18)
      height: Style.space(18)
      anchors.left: rankLabel.right
      anchors.leftMargin: Style.space(4)
      anchors.verticalCenter: parent.verticalCenter

      property var candidates: root.iconCandidatesFor(rankRow.row ? (root.isModelView && rankRow.row.modelProviderId ? rankRow.row.modelProviderId : rankRow.row.providerId) : "", root.surface)
      property string candidatesKey: candidates.join("\n")
      property int candidateIndex: 0
      onCandidatesKeyChanged: candidateIndex = 0

      Image {
        id: markImage
        anchors.fill: parent
        source: mark.candidateIndex < mark.candidates.length ? mark.candidates[mark.candidateIndex] : ""
        sourceSize.width: Style.space(36)
        sourceSize.height: Style.space(36)
        fillMode: Image.PreserveAspectFit
        onStatusChanged: if (status === Image.Error && mark.candidateIndex < mark.candidates.length)
          Qt.callLater(function() { mark.candidateIndex++ })
      }

      Rectangle {
        anchors.fill: parent
        radius: width / 2
        visible: markImage.status !== Image.Ready
        color: root.alpha(root.agentAccent(rankRow.row ? rankRow.row.providerId : ""), 0.85)

        Text {
          anchors.centerIn: parent
          text: rankRow.row && rankRow.row.providerName ? rankRow.row.providerName.charAt(0) : "?"
          color: root.surface
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }
      }
    }

    Text {
      id: nameLabel
      text: rankRow.row ? rankRow.row.providerName : ""
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
      anchors.left: mark.right
      anchors.leftMargin: Style.space(8)
      anchors.right: shareLabel.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      id: shareLabel
      text: rankRow.row ? Model.formatShare(rankRow.row.share) : ""
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      anchors.right: tokensLabel.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      id: tokensLabel
      text: rankRow.row ? Model.formatTokenCount(rankRow.row.tokens) : ""
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      font.bold: true
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
    }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      onClicked: {
        root.cursorActive = true
        if (rankRow.row) root.selectedProviderId = rankRow.row.providerId
      }
      onEntered: root.cursorActive = true
    }
  }

  component DayColumn: Item {
    id: dayCol
    property var day: null
    property real peak: 1
    property bool today: false

    Column {
      anchors.fill: parent
      spacing: Style.space(4)

      Item {
        width: parent.width
        height: parent.height - dayName.implicitHeight - parent.spacing

        Rectangle {
          id: dayTrack
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          height: parent.height * root.clamp((dayCol.day ? dayCol.day.total : 0) / Math.max(1, dayCol.peak), 0, 1)
          radius: Style.space(3)
          color: dayCol.today ? root.alpha(root.accent, 0.18) : root.track

          Column {
            anchors.fill: parent
            spacing: 0

            Repeater {
              model: dayCol.day ? dayCol.day.parts : []

              Rectangle {
                required property var modelData
                required property int index
                width: dayTrack.width
                height: dayTrack.height * (modelData.tokens / Math.max(1, dayCol.day.total))
                color: root.alpha(root.agentAccent(modelData.providerId), dayCol.today ? 0.92 : 0.65)
              }
            }
          }

          Behavior on height {
            NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
          }
        }
      }

      Text {
        id: dayName
        width: parent.width
        text: Model.dayLabel(dayCol.day ? dayCol.day.date : "", dayCol.today)
        color: dayCol.today ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: dayCol.today
        horizontalAlignment: Text.AlignHCenter
        elide: Text.ElideRight
      }
    }

    MouseArea {
      id: dayHover
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.NoButton
    }

    PanelToolTip {
      visible: dayHover.containsMouse && dayCol.day && dayCol.day.total > 0
      text: root.weekTooltip(dayCol.day)
      fontFamily: root.fontFamily
    }
  }
}
