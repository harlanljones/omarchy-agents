# Chezmoi boundary

The workspace is the source of truth for application and plugin code. Chezmoi is the source of truth for machine deployment and private configuration.

## Kept in this repository

- Web source, tests, product/design documentation, and Cloudflare provisioning helper.
- Both Omarchy plugin forks and their plugin-local collectors.
- Shared provider/trophy artwork.
- Turbo tasks and the local plugin packaging/deployment script.

## Kept in chezmoi

- `~/.config/systemd/user/omarchy-agents-*` and the dedicated Ollama unit.
- `~/.config/omarchy-agents/{dashboard,tunnel}.env` creation and permissions; actual secrets remain untracked.
- User collector overrides under `~/.local/bin/omarchy-agent-usage-*`, and the Cline and OpenCode Go dashboard helpers (login, scrape, override, their timers, and the `opencode-go-usage` skill).
- Cline workflow/settings, Omarchy shell placement/settings, and provider-specific private configuration.
- A lightweight after-apply hook that runs this repository's build and local deployment when the checkout exists.

## Not synchronized

- `node_modules`, Turbo/Vite caches, production bundles, screenshots, SQLite indexes, transcript data, and tunnel tokens.

This split prevents generated code and application source from being maintained twice while allowing a fresh chezmoi apply to configure any machine that already has the workspace checkout.
