#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugins_dir="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
mkdir -p "$plugins_dir"

"$repo_root/node_modules/.bin/turbo" run build --filter=@omarchy-agents/omarchy-agent-leaderboard --filter=@omarchy-agents/omarchy-agent-usage
rsync -a --delete "$repo_root/apps/omarchy-agent-leaderboard/dist/" "$plugins_dir/harlan.agent-leaderboard/"
rsync -a --delete "$repo_root/apps/omarchy-agent-usage/dist/" "$plugins_dir/harlan.agents/"

if command -v omarchy-shell >/dev/null 2>&1; then
  omarchy-shell shell rescanPlugins
fi
