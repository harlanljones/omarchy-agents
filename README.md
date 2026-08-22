# Omarchy Agents

The source workspace for Harlan's local Omarchy Agents system.

## Apps

- `apps/web` — Bun, Hono, React, and SQLite dashboard served on `127.0.0.1:4317`.
- `apps/omarchy-agent-leaderboard` — fork of `mustafaokur.agent-leaderboard`, focused on cross-provider rankings.
- `apps/omarchy-agent-usage` — fork of Omarchy's first-party Agents widget, focused on per-provider usage and limits.

Provider marks live once in `packages/provider-assets`; each app consumes them through a repository-relative symlink. Plugin builds dereference that link so deployed Omarchy directories remain self-contained.

## Commands

```bash
bun install
bun run check
bun run dev --filter=@omarchy-agents/web
bun run deploy:local
```

`deploy:local` copies packaged plugins to `~/.config/omarchy/plugins/`. The web service runs directly from `apps/web`, so there is no second application copy under `~/.local/share`.

## Machine boundary

Chezmoi owns the systemd units, untracked environment files, Omarchy/Cline settings, usage collector overrides, and the after-apply hook that invokes this workspace. See `docs/chezmoi-boundary.md`.
