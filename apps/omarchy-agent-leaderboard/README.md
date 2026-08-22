# Agent Leaderboard

<p align="center">
  <img src="preview.png" alt="Agent Leaderboard: today standings and last seven days" width="420">
</p>

An Omarchy bar widget that ranks **token usage across every coding agent** on this machine.

It is a comparison board, not a per-subscription meter. The first-party Agents widget still owns limits, pace, and the model breakdown for one tool at a time. This panel answers a different question: *who is spending the tokens?*

The board is display-only. It watches the usage records that `omarchy-agent-usage-update` writes to `~/.local/state/omarchy/agents/usage/` and ranks whatever appears there. Antigravity, Claude, Cline, Codex, Fireworks, opencode, and the local Grok collector are enabled and supported. Any other collector that writes the same record contract — Hermes, a future agent — shows up on the next refresh. The Grok mark is a stand-in until Omarchy ships one. The same files live in `~/.config/omarchy/agents/assets/` and in the cloned Agents plugin (`harlan.agents`) so the first-party-style panel can show Grok too.

## Install

Source lives in the `apps/omarchy-agent-leaderboard` workspace. `bun run deploy:local` from the repository root builds a self-contained plugin and syncs it to `~/.config/omarchy/plugins/harlan.agent-leaderboard`.

To enable or move it in Omarchy:

```sh
omarchy plugin enable harlan.agent-leaderboard --section right
omarchy bar move harlan.agent-leaderboard --section right
```

Or when developing:

```sh
omarchy-shell shell rescanPlugins
```

The widget lands on the right of the bar, in the **AI** category next to Agents. A panel preview is in `preview.png`.

## Usage

- Left click: open or close the panel
- Right click: launch an agent
- Middle click: next ranking window (today → 7 days → all-time)
- Escape: close
- `h` / `l` or left / right: change the ranking window
- `j` / `k` or up / down: move the selected standing
- `R` or Enter: refresh
- Tab: hand off to the neighboring bar panel

The panel ranks the selected window and draws a last-seven-days chart. Per-model totals stay in the first-party Agents widget.

Summon without the bar:

```sh
omarchy-shell shell summon harlan.agent-leaderboard '{}'
omarchy-shell shell hide harlan.agent-leaderboard
```

## How ranking is computed

Each usage record already carries the numbers the first-party collectors publish:

| Window | Source |
|---|---|
| **Today** | `todayTotalTokens` |
| **7 days** | sum of `recentDays[].messageCount` (those values are token totals, despite the name) |
| **All-time** | sum of every `modelUsage` bucket, floored by the week and today totals when a collector only knows a recent window |

Agents with no tokens in the selected window are omitted from that board. An agent that has never recorded usage does not appear at all. The bar icon itself stays hidden until at least one enabled agent has usage.

### Collectors

- **Antigravity (`agy`):** Collected via `collect-antigravity.py` bundled with this plugin (invoked by `omarchy-agent-usage-antigravity` and during refresh). Parses transcript logs under `~/.gemini/antigravity-cli/brain/` for per-model context-weighted tokens and live limits.
- **Claude:** Refreshed through `omarchy-agent-usage-update` from `~/.claude/projects`.
- **Cline:** Parsed from `~/.cline/data/sessions` transcripts via `omarchy-agent-usage-cline` with estimated or scraped limits (`omarchy-cline-usage-scrape`).
- **Codex:** Parsed from native Codex CLI session files via `omarchy-agent-usage-codex`.
- **OpenCode:** Parsed from SQLite storage `~/.local/share/opencode/opencode.db` via `omarchy-agent-usage-opencode`.
- **Fireworks:** Omarchy's official collector asks the Fireworks billing API. Console/OpenCode keys work, but Cloudflare blocks the request because the collector sends no User-Agent and then reports a fake "cannot read billing" error. This plugin reruns that same official collector with a User-Agent (`collect-fireworks.py`) and writes `fireworks.json`. Sign in to Fireworks in OpenCode, or set `FIREWORKS_API_KEY` / `firectl set-api-key`.

## Configure

Settings live on the widget's entry in `~/.config/omarchy/shell.json`:

| Key | Default | What it does |
|---|---|---|
| `refreshIntervalSec` | `900` | How often the usage records regenerate |
| `period` | `"today"` | Opening ranking window: `today`, `week`, or `all` |

```sh
omarchy bar set harlan.agent-leaderboard refreshIntervalSec 300 --json
omarchy bar set harlan.agent-leaderboard period week
```

Per-agent enablement is nested. Pass the whole `providers` object (or edit `shell.json` directly):

```sh
omarchy bar set harlan.agent-leaderboard providers '{
  "antigravity": { "enabled": true },
  "claude": { "enabled": true },
  "cline": { "enabled": true },
  "codex": { "enabled": true },
  "fireworks": { "enabled": true },
  "opencode": { "enabled": true }
}' --json
```

`enabled` defaults to `true` for every discovered agent; set it to `false` to hide one.

## Validate

```sh
omarchy plugin validate .
qmllint -I "$OMARCHY_PATH/shell" Agent.qml Main.qml Panel.qml
node test/model-test.js
```

## Remove

```sh
omarchy plugin remove harlan.agent-leaderboard
```

That deletes the plugin folder. It does **not** remove `~/.local/state/omarchy/agents/usage/`.

## Attribution

- Panel structure and the Claude / Codex / Fireworks marks follow Omarchy’s first-party Agents widget (MIT, David Heinemeier Hansson / Omarchy).
- The Antigravity mark follows the Google Antigravity CLI brand mark.
- The Cline mark follows the Cline brand icon.
- The Hermes mark is traced from the official Hermes Desktop icon (MIT, [Nous Research](https://github.com/NousResearch/hermes-agent)).
- The Grok mark follows the current singularity-G brand path. Replace it with Omarchy’s official asset when that ships.
- Ranking reads the same usage records that `omarchy-agent-usage-update` already writes.
- The opencode mark follows the official opencode brand glyph (simple-icons).

## License

MIT — see [LICENSE](LICENSE).
