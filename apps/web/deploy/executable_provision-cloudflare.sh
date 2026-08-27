#!/bin/bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set a scoped Cloudflare API token}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set the Cloudflare account ID}"
: "${CLOUDFLARE_ZONE_ID:?Set your Cloudflare zone ID}"
: "${DASHBOARD_HOSTNAME:?Set the tunnel hostname, e.g. agents-api.example.com — the Access-protected origin the Worker proxies to}"
: "${ACCESS_EMAIL:?Set the email allowed through Cloudflare Access}"
: "${WORKER_HOSTNAME:=}"

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

request_soft() {
  local tmp status
  tmp=$(mktemp)
  status=$(curl --silent --show-error -o "$tmp" -w '%{http_code}' "${auth[@]}" "$@") || true
  if [[ $status =~ ^2 ]]; then
    cat "$tmp"
    rm -f "$tmp"
    return 0
  fi
  rm -f "$tmp"
  return 1
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

worker_script="omarchy-agents"
if [[ -n $WORKER_HOSTNAME && $WORKER_HOSTNAME != "$host" ]]; then
  zone_name=$(request "$api/zones/$CLOUDFLARE_ZONE_ID" | jq -r '.result.name')
  wdns_id=$(request "$api/zones/$CLOUDFLARE_ZONE_ID/dns_records?type=CNAME&name=$WORKER_HOSTNAME" | jq -r '.result[0].id // empty')
  wdns_body=$(jq -nc --arg name "$WORKER_HOSTNAME" --arg content "$zone_name" '{type:"CNAME",name:$name,content:$content,proxied:true}')
  if [[ -n $wdns_id ]]; then
    request -X PUT "$api/zones/$CLOUDFLARE_ZONE_ID/dns_records/$wdns_id" --data "$wdns_body" >/dev/null
    printf 'Updated proxied DNS %s -> %s.\n' "$WORKER_HOSTNAME" "$zone_name"
  elif request_soft -X POST "$api/zones/$CLOUDFLARE_ZONE_ID/dns_records" --data "$wdns_body" >/dev/null; then
    printf 'Created proxied DNS %s -> %s.\n' "$WORKER_HOSTNAME" "$zone_name"
  else
    printf 'NOTE: could not create DNS for %s (it may already be managed by Workers / a custom domain). Ensure %s is a proxied hostname in zone %s (it currently appears to be Worker-managed — nothing to do).\n' "$WORKER_HOSTNAME" "$WORKER_HOSTNAME" "$zone_name"
  fi
  if request_soft -X POST "$api/zones/$CLOUDFLARE_ZONE_ID/workers/routes" --data "$(jq -nc --arg p "$WORKER_HOSTNAME/*" --arg s "$worker_script" '{pattern:$p,script:$s}')" >/dev/null; then
    printf 'Created Worker route %s/* -> %s.\n' "$WORKER_HOSTNAME" "$worker_script"
  else
    printf 'NOTE: could not create the Worker route automatically (the API token needs Zone:Workers Routes permission, or it is already managed by Workers). If needed, attach the Worker with: bunx wrangler deploy --route "%s/*"\n' "$WORKER_HOSTNAME"
  fi
fi

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

primary="$host"
destinations=$(jq -nc --arg h "$host" '[{type:"public",uri:$h}]')
if [[ -n $WORKER_HOSTNAME && $WORKER_HOSTNAME != "$host" ]]; then
  primary="$WORKER_HOSTNAME"
  destinations=$(jq -nc --arg p "$WORKER_HOSTNAME" --arg h "$host" '[{type:"public",uri:$p},{type:"public",uri:$h}]')
fi

app_name="Omarchy Agents"
app_id=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" | jq -r --arg name "$app_name" '.result[] | select(.name==$name) | .id' | head -1)
app_body=$(jq -nc --arg name "$app_name" --arg domain "$primary" --arg idp "$otp_id" --argjson destinations "$destinations" '{name:$name,domain:$domain,type:"self_hosted",session_duration:"24h",auto_redirect_to_identity:true,allowed_idps:[$idp],destinations:$destinations}')
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
  svc_policy_body=$(jq -nc --arg tid "$svc_id" '{name:"Worker proxy",decision:"allow",include:[{service_token:{token_id:$tid}}]}')
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
printf 'Provisioned tunnel %s and one Access application covering the API origin %s%s.\n' "$tunnel_id" "$host" "${WORKER_HOSTNAME:+ and the dashboard $WORKER_HOSTNAME}"
printf 'Next:\n'
printf '  1. cd apps/web && bunx wrangler secret put ACCESS_CLIENT_ID      # %s\n' "$svc_client_id"
printf '  2. bunx wrangler secret put ACCESS_CLIENT_SECRET                 # the secret saved above\n'
printf '  3. This script attached %s to the same Access application and created its proxied DNS. If the run printed a NOTE about the Worker route, deploy with: cd apps/web && bunx wrangler deploy --route "%s/*" (the API token needs Zone:Workers Routes permission to do this automatically). Until the Worker is deployed and %s is behind Access, the portal fails closed (401). Set DASHBOARD_HOSTNAME=<browser-facing hostname> in %s/dashboard.env if it differs from %s.\n' "${WORKER_HOSTNAME:-<dashboard hostname>}" "${WORKER_HOSTNAME:-<dashboard hostname>}" "${WORKER_HOSTNAME:-<dashboard hostname>}" "$config_dir" "$host"
printf '  4. systemctl --user enable --now omarchy-agents-tunnel.service && systemctl --user restart omarchy-agents-dashboard.service\n'
