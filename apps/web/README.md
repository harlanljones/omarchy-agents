# Omarchy Agents Dashboard

This app is developed from the workspace root. Use `bun run dev --filter=@omarchy-agents/web` for development and `bun run check` for the full workspace verification.

Private local dashboard for Omarchy agent usage and transcript evidence.

## Local setup

```bash
bun install --frozen-lockfile
bun run build
systemctl --user enable --now ollama-omarchy-agents.service omarchy-agents-dashboard.service omarchy-agents-analysis.timer
```

Open `http://127.0.0.1:4317`. The first index runs in the background and metrics remain available while transcript indexing progresses.

## Remote setup

Create a scoped Cloudflare API token with Tunnel, DNS, Access application/policy, and Access identity-provider write permissions. Export `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, `DASHBOARD_HOSTNAME` (e.g. `agents.example.com`), and `ACCESS_EMAIL`, then run `deploy/executable_provision-cloudflare.sh`. It creates or updates the remotely managed tunnel, published route, proxied DNS record, OTP identity provider, self-hosted Access application, and allow policy for `$ACCESS_EMAIL`. Set `DASHBOARD_HOSTNAME` in `~/.config/omarchy-agents/dashboard.env` too so the server accepts the remote host.

Add the Cloudflare Access team name to `~/.config/omarchy-agents/dashboard.env`, then enable `omarchy-agents-tunnel.service`. Both environment files must stay mode `0600`; the provisioning script writes the tunnel token there and never into chezmoi.

## Rollback

```bash
systemctl --user disable --now omarchy-agents-tunnel.service omarchy-agents-analysis.timer omarchy-agents-dashboard.service ollama-omarchy-agents.service
```

Disable or delete the Access application and tunnel route in Cloudflare. Local indexed data remains at `~/.local/state/omarchy-agents/index.sqlite` until deliberately removed.
