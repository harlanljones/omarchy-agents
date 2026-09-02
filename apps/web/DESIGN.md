---
name: Omarchy Agents
description: A local-first evidence control room for comparing, inspecting, and questioning agent activity.
colors:
  ink: "#f0f4f8"
  muted: "#8c9ba8"
  dim: "#677684"
  base: "#080a0f"
  surface: "#0d1117"
  lift: "#131922"
  line: "#1c2430"
  hairline: "#26303d"
  accent: "#d5ba64"
  focus: "#86b7ff"
  nav-deep: "#0a0c10"
  hover-surface: "#18202b"
  link: "#93c5fd"
  status-ok: "#4ade80"
  status-warning: "#fbbf24"
  status-error: "#f87171"
  provider-claude: "#e07a5f"
  provider-codex: "#10b981"
  provider-cline: "#70d480"
  provider-antigravity: "#4285f4"
  provider-fireworks: "#ff7830"
  provider-opencode: "#bd85f2"
  provider-evot: "#38bdf8"
  provider-fallback: "#64748b"
  scrollbar: "#26303d"
  status-text: "#94a3b8"
  hairline-strong: "#334155"
  hairline-soft: "#1e293b"
  text-soft: "#cbd5e1"
  text-softer: "#e2e8f0"
  error-text: "#fca5a5"
  error-border: "#7f1d1d"
  error-fill: "rgba(239, 68, 68, 0.12)"
  overlay-scrim: "rgba(0, 0, 0, 0.65)"
  overlay-shadow: "rgba(0, 0, 0, 0.45)"
typography:
  display:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "clamp(26px, 3vw, 44px)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.035em"
  headline:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  body:
    fontFamily: '"Liberation Sans", "Noto Sans", system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  data:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.04em"
  control:
    fontFamily: '"Liberation Sans", "Noto Sans", system-ui, sans-serif'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  micro:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "9px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.04em"
  caption:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  display-mobile:
    fontFamily: '"IBM Plex Mono", monospace'
    fontSize: "28px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.035em"
rounded:
  chart: "2px"
  segment: "7px"
  control: "8px"
  mark: "9px"
  group: "10px"
  nav: "12px"
  micro: "3px"
  hairline: "4px"
  round: "50%"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "10px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "36px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.base}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  button-secondary:
    backgroundColor: "{colors.lift}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  button-secondary-hover:
    backgroundColor: "{colors.hover-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
  segmented-group:
    backgroundColor: "{colors.nav-deep}"
    rounded: "{rounded.group}"
    padding: "3px"
  segmented-option:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    rounded: "{rounded.segment}"
    padding: "7px 12px"
  segmented-option-active:
    backgroundColor: "{colors.lift}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.segment}"
    padding: "7px 12px"
  nav-item-active:
    backgroundColor: "{colors.lift}"
    textColor: "{colors.ink}"
    rounded: "{rounded.nav}"
    padding: "10px 4px"
---

# Design System: Omarchy Agents

## Overview

**Creative North Star: "Aerospace Telemetry & Mission Control"**

Omarchy Agents inherits the visual world of an aerospace mission-control console: deep obsidian, carbon slate, razor-sharp 1px hairlines, and high-density telemetry instrumentation built for sustained scrutiny. Its character comes from precision monospaced typography, multi-layered obsidian depth, glowing phosphor status signals, and real-time telemetry ribbons rather than decorative fluff. The trophy and provider marks supply identity with luminous precision.

The system makes local activity legible as evidence. Its visual story is compare, inspect, ask, decide: standings and history lead; sessions open into addressable transcript events; the local analyst remains visibly advisory and citation-bound. Density is intentional, but hierarchy, alignment, subtle glow states, and generous vertical intervals keep the telemetry deck calm.

**Key Characteristics:**

- Deep obsidian and carbon slate surfaces with 1px precision hairline borders.
- Top real-time telemetry ribbon showing token velocity, active providers, and indexing daemon health.
- Ruled data regions with subtle row hover illumination.
- Monospaced headings, labels, metrics, timestamps, and evidence with crisp optical sizing.
- Adaptive Cockpit with collapsible left navigation and right analyst inspector rails.
- Restrained gold orientation accent, phosphor status pills, and luminous provider hues.
- Full keyboard-visible focus, non-color status labels, and reduced-motion behavior.

## Colors

The palette is nearly monochrome and blue-cool, with a muted trophy gold for orientation, a separate blue focus signal, and compact bursts of provider identity.

### Primary

- **Omarchy Gold**: Marks the current navigation target and active mobile destination; it is an orientation cue, not a general fill color.

### Secondary

- **Focus Blue**: Draws the universal keyboard focus ring and remains distinct from selection and provider identity.
- **Evidence Link Blue**: Identifies anchors into transcript evidence.

### Tertiary

- **Provider Clay, Provider Green, Provider Lime, Provider Blue, Provider Orange, and Provider Violet**: Identify Claude, Codex, Cline, Antigravity, Fireworks, and opencode in marks, chart stacks, and share bars. Keep each hue bound to its provider.
- **Status Green, Status Amber, and Status Red**: Signal ready/indexed, warning/metrics-only, and error states. Always pair the dot with a text label.

### Neutral

- **Console Black**: The primary working canvas.
- **Deep Rail**: The navigation and mobile-tab plane.
- **Panel Graphite**: The persistent analyst surface and default field fill.
- **Raised Graphite**: Active segments, selected ledger rows, and standard button fill.
- **Hover Graphite**: The common hover response for interactive controls.
- **Rule Gray**: One-pixel dividers, control strokes, and rail boundaries.
- **Signal White**: Primary text and the inverted primary-action surface.
- **Operational Gray**: Supporting copy and inactive control labels.
- **Instrument Gray**: Table headers, timestamps, axes, and tertiary metadata.
- **Fallback Provider Gray**: The two-letter provider mark background and provider-absent chart segments when a provider SVG is missing.
- **Status Text Gray**: The small uppercase status legends beside semantic dots.
- **Scrollbar Graphite**: The custom scrollbar thumb over the console canvas.
- **Hairline Strong / Hairline Soft**: Secondary structural strokes and inset control edges beyond the one-pixel Rule Gray.
- **Text Soft / Text Softer**: Brighter table and metadata greys for dense rows that need to lift above Instrument Gray.
- **Error Text / Error Border / Error Fill**: The red notice triad — `#f0a5a5` message text, `#7a4141` border, `#f0b0b0` faint fill — used only by the error notice and never as a general surface.

### Named Rules

**The Gold Is Orientation Rule.** Reserve gold for current-location emphasis and the inherited trophy identity; do not spread it across charts, buttons, or large surfaces.

**The Provider Ownership Rule.** Provider hues belong to provider marks, chart segments, and share indicators. They never replace semantic status colors.

**The Labeled Signal Rule.** Color may reinforce status, but the adjacent text must carry the meaning.

## Typography

**Display Font:** IBM Plex Mono family name, backed by the bundled JetBrains Mono Nerd Font asset, with monospace fallback  
**Body Font:** Liberation Sans, with Noto Sans and system sans-serif fallbacks  
**Label/Mono Font:** IBM Plex Mono family name with monospace fallback

**Character:** The sans-serif body stays plain and readable while the mono face turns headings, ranks, metrics, timestamps, states, and evidence into console instrumentation. The pairing is utilitarian and precise rather than nostalgic or decorative.

### Hierarchy

- **Display** (regular, fluid 26–44px, 1 line-height, tight tracking): Page titles only; mobile resolves to a fixed 28px.
- **Headline** (bold, 17px): Analyst and major local-panel headings.
- **Title** (bold, 16px): Section headings such as Standings and Source coverage.
- **Body** (regular, 13px, 1.6 line-height): Explanations, analyst summaries, settings prose, and compact operational copy; long settings prose is capped near 72 characters.
- **Data** (medium, 14px): Ranks and token totals that must scan vertically.
- **Label** (medium, 9–10px, tracked and often uppercase): Table headers, status text, timestamps, chart axes, roles, and small rail metadata.
- **Control** (regular, 11–12px): Buttons, segmented options, labels, and form controls.

### Named Rules

**The Instrument Type Rule.** Use mono wherever the user compares, locates, or verifies; use sans-serif for explanation and conversation.

**The Quiet Hierarchy Rule.** Establish hierarchy through size, weight, alignment, and spacing before introducing color.

## Layout

The desktop shell is a three-part control room: a sticky 88px navigation rail, a fluid central canvas, and a sticky 360px analyst rail. The central canvas is capped at 1400px and uses 36px horizontal padding, with the standings and history field occupying the first viewport beside the analyst. A route that makes the analyst the main content removes the duplicate rail.

Data regions use explicit grid columns and horizontal rules. Standings allocate fixed space to rank, coverage, and share while provider and token columns absorb width. The session ledger is a split view with a 390px virtualized session list and a scrollable transcript. Settings use two equal columns, then allow privacy guidance to span the full width. The working rhythm is built primarily from 8, 12, 16, 20, 24, and 36px intervals.

At 1100px and below, the navigation rail narrows to 76px and the analyst becomes a right-hand modal drawer, 390px or at most 92vw wide, with a scrim, focus transfer, focus trap, and Escape-to-close behavior. At 720px and below, the side rail disappears, main padding becomes 16px, and a fixed four-destination bottom navigation takes over. The standings collapse to rank, provider, and tokens; coverage timestamps disappear; filters scroll; the ledger stacks session list above transcript; and settings become a single column. The analyst drawer stops above the bottom navigation.

**The Ruled Field Rule.** Prefer full-width sections, aligned columns, and one-pixel separators over isolated card mosaics.

**The Comparison First Rule.** Preserve standings and history as the dominant canvas while keeping the advisory analyst reachable from every operational view.

## Elevation & Depth

The system is flat by default. Depth comes from tonal steps, rail boundaries, sticky positioning, and dense horizontal rules—not ambient card shadows. The only shipped shadows are a small glow under the green status dot and a structural left-cast shadow on the compact analyst drawer; neither is a general surface treatment.

### Shadow Vocabulary

- **Ready Glow** (`0 3px 8px rgba(101, 193, 140, 0.28)`): A restrained halo for the tiny ready/full status dot only.
- **Drawer Cast** (`-14px 0 36px rgba(0, 0, 0, 0.32)`): Separates the analyst drawer from the canvas below the desktop breakpoint.

### Named Rules

**The Flat-by-Default Rule.** Resting content surfaces do not float; only an overlaid drawer receives structural elevation.

## Shapes

The form language is compact and gently rounded. Inputs and buttons use 8px corners, provider tiles use 9px, segmented containers use 10px with 7px inner options, and navigation targets use 12px. Status dots are circular, chart bars receive only a 2px softening, and data fields such as share bars remain square to preserve a measured, instrument-like silhouette.

Borders are thin and low-contrast. Large panels are not rounded containers; the canvas, rails, transcript, standings, and settings are shaped by straight edges and rules. Provider marks clip a translucent tint of the provider color behind the original SVG mark or a two-letter fallback.

**The Small Controls, Straight Fields Rule.** Round compact interactive controls; keep large data regions rectilinear and edge-aligned.

## Components

### Buttons

- **Shape:** Compact rounded controls with 8px corners and 9px by 12px internal padding.
- **Primary:** Signal-white fill, console-black text, matching border, and semibold type. This inversion is reserved for the analyst submit action.
- **Secondary:** Raised-graphite fill with a rule-gray border and signal-white text.
- **Hover / Focus:** Hover moves shared controls to hover graphite and strengthens the border; keyboard focus uses a 2px blue outline offset by 3px. All color, background, border, and shadow transitions run for 160ms with standard easing.
- **Disabled:** Reduce opacity to 42% and use a not-allowed cursor; retain the label so the unavailable action remains understandable.

### Segmented Controls

- **Style:** A deep-rail container with a one-pixel rule, 10px outer corners, and 3px inset padding. Options are transparent with 7px corners and muted labels.
- **State:** The selected option uses raised graphite and signal-white text. State is exposed with `aria-pressed`, not color alone.

### Status Indicators

- **Style:** A 7px semantic dot, a 10px uppercase mono label, 4% tracking, and a 7px gap.
- **State:** Green means ready or transcript `indexed`; amber means warning, collector `metrics-only`, indexing, or missing report; red means error. Labels are mandatory; only the green state carries a slight glow. Never paraphrase `metrics-only` as full or complete coverage.

### Cards / Containers

- **Corner Style:** Major containers remain square and open; compact controls inside them carry the radius.
- **Background:** The canvas uses console black, the analyst rail uses panel graphite, and active or selected rows use raised graphite.
- **Shadow Strategy:** Flat at rest; use rules and tonal layering. Only the responsive analyst drawer casts a structural shadow.
- **Border:** One-pixel rule-gray separators define section starts, rows, rail edges, and sticky headers.
- **Internal Padding:** Desktop main content uses 32px top and 36px sides; the analyst rail uses 26px by 24px; section bands generally use 20–28px vertically.

### Inputs / Fields

- **Style:** Panel-graphite fill, rule-gray stroke, signal-white text, 8px corners, and 8px by 10px padding.
- **Focus:** Universal 2px focus-blue outline with 3px offset.
- **Hover:** Strengthen the stroke while preserving the quiet fill.
- **Text Area:** Full-width and vertically resizable, with a 1.45 line-height for analyst questions.

### Navigation

- **Desktop:** A persistent left rail centers the trophy lockup, icon-and-label destinations, and local-first status. Destinations use a 12px hit surface; the active item gains raised graphite while the icon frame turns gold.
- **Tablet:** The left rail remains at a reduced width while analyst content moves into a modal drawer.
- **Mobile:** Replace the left rail with a fixed four-column bottom bar. The active label turns gold; content receives bottom clearance and safe-area padding.
- **Limits portal:** The admin limits destination uses a compact ruled tab strip for Limits, Productivity, Activity detail, and Source sync. Tabs preserve the same selected-state treatment and remain keyboard-operable.

### Limits Watch

- **Alert inbox:** Active alerts reuse the reset-timeline row grid — provider mark and name, the alert's message, then a semantic status chip (`warning` amber, `critical` red) naming the rule. Resolved history collapses behind a quiet `details` summary so an all-clear board stays calm.
- **Depletion forecasts:** One row per reported window in the same grid. Insufficient history renders as an amber "insufficient history" state — never as a fabricated countdown; a projection that lands before the reset reads red with the time-to-exhaustion, and one that outlasts the cycle reads green.
- **Truthfulness:** Forecast language never presents a single sample or unknown reset instant as certainty, matching the portal-wide rule that every claim traces to evidence.

### Standings and History

- **Rows:** A semantic table rendered as a five-column grid on desktop, with a 35px header and at least 63px per data row. Rank and token values use the data face; provider name remains sans-serif.
- **Coverage:** Preserve the explicit `indexed` and `metrics-only` truth labels. Claude, Codex, and opencode currently report indexed transcript coverage; Fireworks, Cline, and Antigravity currently report collector metrics only.
- **Provider Mark:** A 30px rounded tile holds the provider SVG at 17px. Its background is a 13% mix of the provider hue; a two-letter mono fallback appears if the asset fails.
- **Share Bar:** A 24px square-ended track uses a provider-colored fill at 45% opacity with the percentage overlaid at the right edge.
- **History:** Stacked provider bars use the same provider mapping and only 2px corner softening. A textual figure caption and screen-reader summary keep the chart subordinate to exact evidence.

### Session Ledger

- **Structure:** A virtualized list and transcript form a ruled split pane. Selected or hovered sessions use raised graphite without changing their geometry.
- **Evidence Events:** Each event is separated by a rule, labeled with uppercase mono kind and time, and rendered as wrapping mono text. Error event text shifts to the semantic error tint; every event exposes an anchor.

### Analyst Rail

- **Character:** Persistent but visibly advisory. The header states “Read-only · citations required,” the nightly brief precedes chat, and the composer stays compact.
- **Responsive Behavior:** Sticky on wide screens; a focus-managed, Escape-dismissable drawer behind a scrim at narrower widths; a full main destination also exists in navigation.

## Do's and Don'ts

### Do:

- **Do** make important claims resolvable to a visible session, event, status, or coverage label.
- **Do** preserve the desktop hierarchy of persistent navigation, comparison canvas, and advisory analyst rail.
- **Do** use mono type for ranks, metrics, timestamps, labels, and transcript evidence.
- **Do** use thin rules and tonal changes to structure dense information.
- **Do** retain text equivalents for status color and chart content, visible keyboard focus, and reduced-motion behavior.
- **Do** keep provider marks and their original hues intact when extending comparisons or charts.
- **Do** preserve `indexed` and `metrics-only` as distinct coverage labels; missing transcript evidence is never implied to exist.

### Don't:

- **Don't** turn the interface into a collection of floating rounded cards or add decorative shadows to resting surfaces.
- **Don't** use gold as a general brand wash, primary chart series, or status color.
- **Don't** let provider colors imply success, warning, or error.
- **Don't** present analyst output as equal in authority to indexed evidence.
- **Don't** hide the comparison field behind an analyst-first composition on the overview.
- **Don't** add motion that survives the reduced-motion override or slows repeated operational work.
