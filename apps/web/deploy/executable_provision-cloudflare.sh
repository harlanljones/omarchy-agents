#!/bin/bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set a scoped Cloudflare API token}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set the Cloudflare account ID}"
: "${CLOUDFLARE_ZONE_ID:?Set your Cloudflare zone ID}"
: "${DASHBOARD_HOSTNAME:?Set the tunnel hostname, e.g. agents-api.example.com — the Access-protected origin the Worker proxies to}"
: "${ACCESS_EMAIL:?Set the email allowed through Cloudflare Access}"

api="https://api.cloudflare.com/client/v4"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")
host="$DASHBOARD_HOSTNAME"
tunnel_name="omarchy-agents"

request() {
  local tmp status
  tmp=$(mktemp)
  status=$(curl --silent --show-error -o "$tmp" -w '%{http_code}' "${auth[@]}" "$@") || true
  if [[ ! $status =~ ^2 ]]; then
    {
      printf 'Cloudflare API call failed (HTTP %s):\n  ' "$status"
      printf '%q ' "$@"
      printf '\nResponse: '
      cat "$tmp"
      printf '\n'
    } >&2
    rm -f "$tmp"
    exit 1
  fi
  cat "$tmp"
  rm -f "$tmp"
}

tunnel_id=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?name=$tunnel_name&is_deleted=false" | jq -r '.result[0].id // empty')
if [[ -z $tunnel_id ]]; then
  tunnel_id=$(request -X POST "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel" --data "$(jq -nc --arg name "$tunnel_name" '{name:$name,config_src:"cloudflare"}')" | jq -er '.result.id')
fi

request -X PUT "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$tunnel_id/configurations" --data "$(jq -nc --arg hostname "$host" '{config:{ingress:[{hostname:$hostname,service:"http://127.0.0.1:4317",originRequest:{}},{service:"http_status:404"}]}}')" >/dev/null

dns_id=$(request "$api/zones/$CLOUDFLARE_ZONE_ID/dns_records?type=CNAME&name=$host" | jq -r '.result[0].id // empty')
dns_body=$(jq -nc --arg name "$host" --arg content "$tunnel_id.cfargotunnel.com" '{type:"CNAME",name:$name,content:$content,proxied:true}')
if [[ -n $dns_id ]]; then request -X PUT "$api/zones/$CLOUDFLARE_ZONE_ID/dns_records/$dns_id" --data "$dns_body" >/dev/null
else request -X POST "$api/zones/$CLOUDFLARE_ZONE_ID/dns_records" --data "$dns_body" >/dev/null; fi

otp_id=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/identity_providers" | jq -r '.result[] | select(.type=="onetimepin") | .id' | head -1)
if [[ -z $otp_id ]]; then otp_id=$(request -X POST "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/identity_providers" --data '{"name":"One-time PIN login","type":"onetimepin","config":{}}' | jq -er '.result.id'); fi

svc_name="omarchy-agents-worker"
if [[ -n ${SERVICE_TOKEN_CLIENT_ID:-} ]]; then
  svc_client_id="$SERVICE_TOKEN_CLIENT_ID"
  printf 'Using service token %s from SERVICE_TOKEN_CLIENT_ID; ensure the "Worker proxy" service-auth policy exists on the %s Access app (Zero Trust console).\n' "$svc_client_id" "$host"
else
  svc_row=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/service_tokens" | jq -c --arg n "$svc_name" '.result[] | select(.name==$n)' | head -1)
  if [[ -n $svc_row ]]; then
    svc_id=$(printf '%s' "$svc_row" | jq -er '.id')
    svc_client_id=$(printf '%s' "$svc_row" | jq -er '.client_id')
    printf 'Reusing existing service token %s — keep its previously stored secret.\n' "$svc_name"
  else
    svc=$(request -X POST "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/service_tokens" --data "$(jq -nc --arg n "$svc_name" '{name:$n,duration:"8760h"}')")
    svc_id=$(printf '%s' "$svc" | jq -er '.result.id')
    svc_client_id=$(printf '%s' "$svc" | jq -er '.result.client_id')
    printf '\nThe Worker service-token secret is shown ONCE — copy it now:\n  ACCESS_CLIENT_SECRET=%s\n\n' "$(printf '%s' "$svc" | jq -er '.result.client_secret')"
  fi
fi

app_id=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" | jq -r --arg host "$host" '.result[] | select(.domain==$host) | .id' | head -1)
app_body=$(jq -nc --arg domain "$host" --arg idp "$otp_id" '{name:"Omarchy Agents",domain:$domain,type:"self_hosted",session_duration:"24h",auto_redirect_to_identity:true,allowed_idps:[$idp]}')
if [[ -n $app_id ]]; then request -X PUT "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id" --data "$app_body" >/dev/null
else app_id=$(request -X POST "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" --data "$app_body" | jq -er '.result.id'); fi

policy_id=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies" | jq -r '.result[] | select(.name=="Dashboard user") | .id' | head -1)
policy_body=$(jq -nc --arg email "$ACCESS_EMAIL" '{name:"Dashboard user",decision:"allow",include:[{email:{email:$email}}],session_duration:"24h"}')
if [[ -n $policy_id ]]; then request -X PUT "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies/$policy_id" --data "$policy_body" >/dev/null
else request -X POST "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies" --data "$policy_body" >/dev/null; fi

if [[ -n ${SERVICE_TOKEN_CLIENT_ID:-} ]]; then
  :
else
  svc_policy_id=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies" | jq -r '.result[] | select(.name=="Worker proxy") | .id' | head -1)
  svc_policy_body=$(jq -nc --arg tid "$svc_id" '{name:"Worker proxy",decision:"service_auth",include:[{service_token:{token_id:$tid}}]}')
  if [[ -n $svc_policy_id ]]; then request -X PUT "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies/$svc_policy_id" --data "$svc_policy_body" >/dev/null
  else request -X POST "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies" --data "$svc_policy_body" >/dev/null; fi
fi

for legacy_domain in "$host/limits" "$host/api/limits"; do
  legacy_id=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" | jq -r --arg domain "$legacy_domain" '.result[] | select(.domain==$domain) | .id' | head -1)
  if [[ -n $legacy_id ]]; then
    request -X DELETE "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$legacy_id" >/dev/null
    printf 'Removed legacy path-scoped Access app %s; one application now covers the whole tunnel host.\n' "$legacy_domain"
  fi
done

token=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$tunnel_id/token" | jq -er '.result')
aud=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id" | jq -er '.result.aud')
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy-agents"
mkdir -p "$config_dir"; chmod 700 "$config_dir"; umask 077
printf 'TUNNEL_TOKEN=%s\n' "$token" >"$config_dir/tunnel.env"
touch "$config_dir/dashboard.env"; chmod 600 "$config_dir/dashboard.env"
if grep -q '^CLOUDFLARE_ACCESS_AUD=' "$config_dir/dashboard.env"; then
  sed -i "s|^CLOUDFLARE_ACCESS_AUD=.*|CLOUDFLARE_ACCESS_AUD=$aud|" "$config_dir/dashboard.env"
else
  printf 'CLOUDFLARE_ACCESS_AUD=%s\n' "$aud" >>"$config_dir/dashboard.env"
fi
admin_aud_list="$aud"
if grep -q '^CLOUDFLARE_ACCESS_ADMIN_AUD=' "$config_dir/dashboard.env"; then
  sed -i "s|^CLOUDFLARE_ACCESS_ADMIN_AUD=.*|CLOUDFLARE_ACCESS_ADMIN_AUD=$admin_aud_list|" "$config_dir/dashboard.env"
else
  printf 'CLOUDFLARE_ACCESS_ADMIN_AUD=%s\n' "$admin_aud_list" >>"$config_dir/dashboard.env"
fi
upsert_env() {
  if grep -q "^$1=" "$config_dir/dashboard.env"; then
    sed -i "s|^$1=.*|$1=$2|" "$config_dir/dashboard.env"
  else
    printf '%s=%s\n' "$1" "$2" >>"$config_dir/dashboard.env"
  fi
}
upsert_env API_HOSTNAME "$host"
upsert_env CLOUDFLARE_ACCESS_API_AUD "$aud"
upsert_env ACCESS_CLIENT_ID "$svc_client_id"
printf 'Provisioned %s via tunnel %s with one Access application covering the host, the portal audience, and the worker service policy.\n' "$host" "$tunnel_id"
printf 'Next:\n'
printf '  1. cd apps/web && bunx wrangler secret put ACCESS_CLIENT_ID      # %s\n' "$svc_client_id"
printf '  2. bunx wrangler secret put ACCESS_CLIENT_SECRET                 # the secret saved above\n'
printf '  3. Set DASHBOARD_HOSTNAME=<browser-facing hostname> in %s/dashboard.env if it differs from %s; the portal lives at %s/limits\n' "$config_dir" "$host" "$host"
printf '  4. systemctl --user enable --now omarchy-agents-tunnel.service && systemctl --user restart omarchy-agents-dashboard.service\n'
