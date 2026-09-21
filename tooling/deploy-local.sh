#!/bin/bash
set -euo pipefail

log_warn() { printf '[deploy-local] %s\n' "$*" >&2; }

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugins_dir="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy/plugins"
mkdir -p "$plugins_dir"

"$repo_root/node_modules/.bin/turbo" run build --filter=@omarchy-agents/omarchy-agent-leaderboard --filter=@omarchy-agents/omarchy-agent-usage
rsync -a --delete "$repo_root/apps/omarchy-agent-leaderboard/dist/" "$plugins_dir/harlan.agent-leaderboard/"
rsync -a --delete "$repo_root/apps/omarchy-agent-usage/dist/" "$plugins_dir/harlan.agents/"

# Best-effort: plugin files are already deployed; the rescan only reloads the
# bar. Skip when the omarchy source path is unavailable (e.g. bare CI shells),
# and cap the rescan — under Actions' runner context omarchy-shell can accept
# the IPC call but never answers, which used to hang the job for an hour.
if command -v omarchy-shell >/dev/null 2>&1 && [ -n "${OMARCHY_PATH:-}" ]; then
  timeout 10 omarchy-shell shell rescanPlugins || log_warn "rescan skipped: omarchy-shell unresponsive (plugins still deployed)"
fi
