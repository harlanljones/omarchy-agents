#!/bin/bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set a scoped Cloudflare API token}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set the Cloudflare account ID}"
: "${CLOUDFLARE_ZONE_ID:?Set your Cloudflare zone ID}"
: "${DASHBOARD_HOSTNAME:?Set the dashboard hostname, e.g. agents.example.com}"
: "${ACCESS_EMAIL:?Set the email allowed through Cloudflare Access}"

api="https://api.cloudflare.com/client/v4"
auth=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json")
host="$DASHBOARD_HOSTNAME"
tunnel_name="omarchy-agents"

request() { curl --fail-with-body --silent --show-error "${auth[@]}" "$@"; }

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

app_id=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" | jq -r --arg host "$host" '.result[] | select(.domain==$host) | .id' | head -1)
app_body=$(jq -nc --arg domain "$host" --arg idp "$otp_id" '{name:"Omarchy Agents",domain:$domain,type:"self_hosted",session_duration:"24h",auto_redirect_to_identity:true,allowed_idps:[$idp]}')
if [[ -n $app_id ]]; then request -X PUT "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id" --data "$app_body" >/dev/null
else app_id=$(request -X POST "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" --data "$app_body" | jq -er '.result.id'); fi

policy_id=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies" | jq -r '.result[] | select(.name=="Dashboard user") | .id' | head -1)
policy_body=$(jq -nc --arg email "$ACCESS_EMAIL" '{name:"Dashboard user",decision:"allow",precedence:1,include:[{email:{email:$email}}],session_duration:"24h"}')
if [[ -n $policy_id ]]; then request -X PUT "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies/$policy_id" --data "$policy_body" >/dev/null
else request -X POST "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id/policies" --data "$policy_body" >/dev/null; fi

token=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$tunnel_id/token" | jq -er '.result')
aud=$(request "$api/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$app_id" | jq -er '.result.aud')
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/omarchy-agents"
mkdir -p "$config_dir"; chmod 700 "$config_dir"; umask 077
printf 'TUNNEL_TOKEN=%s\n' "$token" >"$config_dir/tunnel.env"
touch "$config_dir/dashboard.env"
grep -q '^CLOUDFLARE_ACCESS_AUD=' "$config_dir/dashboard.env" || printf 'CLOUDFLARE_ACCESS_AUD=%s\n' "$aud" >>"$config_dir/dashboard.env"
printf 'Provisioned %s via tunnel %s. Add CLOUDFLARE_ACCESS_TEAM to %s/dashboard.env.\n' "$host" "$tunnel_id" "$config_dir"
