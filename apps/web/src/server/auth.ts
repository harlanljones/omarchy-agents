import { createRemoteJWKSet, jwtVerify, type JWTVerifyResult } from "jose";
import type { Context, Next } from "hono";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

const env = (key: string) => (process.env[key] ?? "").trim();
const lower = (value: string) => value.toLowerCase();
const remoteHost = () => env("DASHBOARD_HOSTNAME") || "agents.example.com";
const apiHost = () => env("API_HOSTNAME");
const apiAudience = () => env("CLOUDFLARE_ACCESS_API_AUD");
const serviceClientId = () => env("ACCESS_CLIENT_ID");
const accessTeam = () => env("CLOUDFLARE_ACCESS_TEAM");
const allowedEmail = () => lower(env("ACCESS_EMAIL"));
const mainAudience = () => env("CLOUDFLARE_ACCESS_AUD");
const adminAudiences = () => env("CLOUDFLARE_ACCESS_ADMIN_AUD").split(",").map(s => s.trim()).filter(Boolean);

let injectedVerifier: ((token: string, issuer: string, audience: string) => Promise<JWTVerifyResult>) | null = null;
let cachedTeam = "", cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function jwksFor(team: string) {
  if (!cachedJwks || cachedTeam !== team) {
    cachedTeam = team;
    cachedJwks = createRemoteJWKSet(new URL(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`));
  }
  return cachedJwks;
}

async function verifyAccess(token: string, audience: string) {
  const issuer = `https://${accessTeam()}.cloudflareaccess.com`;
  if (injectedVerifier) return injectedVerifier(token, issuer, audience);
  return jwtVerify(token, jwksFor(accessTeam()), { issuer, audience });
}

export function _setAccessVerifierForTests(verify: ((token: string, issuer: string, audience: string) => Promise<JWTVerifyResult>) | null) {
  injectedVerifier = verify;
}

export const isAdminPath = (path: string) =>
  path === "/limits" || path.startsWith("/limits/");

export const isAdminAssetPath = (path: string) =>
  path === "/favicon.svg" || path === "/robots.txt" || path.startsWith("/assets/") || path.startsWith("/provider-assets/") || path.startsWith("/fonts/");

const isServiceOrigin = (host: string) => host !== remoteHost() && Boolean(apiHost()) && host === apiHost() && Boolean(apiAudience()) && Boolean(serviceClientId());

export async function security(c: Context, next: Next) {
  const host = lower((c.req.header("host") ?? "").split(":")[0]);
  if (!localHosts.has(host) && host !== remoteHost() && host !== apiHost()) return c.json({ error: "Host not allowed" }, 403);
  const origin = c.req.header("origin");
  if (origin) {
    try {
      const originHost = lower(new URL(origin).hostname);
      const dashboardViaService = isServiceOrigin(host) && originHost === lower(remoteHost());
      if (originHost !== host && !dashboardViaService) return c.json({ error: "Origin not allowed" }, 403);
    } catch { return c.json({ error: "Origin not allowed" }, 403); }
  }
  const token = c.req.header("cf-access-jwt-assertion");
  if (!localHosts.has(host) && !isAdminPath(c.req.path) && !(isServiceOrigin(host) && isAdminAssetPath(c.req.path))) {
    if (isServiceOrigin(host)) {
      if (!token || !accessTeam() || !apiAudience()) return c.json({ error: "Access authentication is not configured" }, 401);
      try {
        const { payload } = await verifyAccess(token, apiAudience());
        if (payload.common_name !== serviceClientId()) return c.json({ error: "Service identity not allowed" }, 403);
      } catch { return c.json({ error: "Invalid Access token" }, 401); }
    } else {
      if (!token || !accessTeam() || !mainAudience()) return c.json({ error: "Access authentication is not configured" }, 401);
      try {
        const { payload } = await verifyAccess(token, mainAudience());
        if (lower(String(payload.email ?? "")) !== allowedEmail()) return c.json({ error: "Identity not allowed" }, 403);
      } catch { return c.json({ error: "Invalid Access token" }, 401); }
    }
  }
  if (["POST", "PATCH", "PUT", "DELETE"].includes(c.req.method) && !c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "JSON content type required" }, 415);
  if (!localHosts.has(host) && isServiceOrigin(host) && isAdminAssetPath(c.req.path)) {
    const audiences = adminAudiences();
    if (!token || !audiences.length || !allowedEmail() || !accessTeam()) return c.json({ error: "The limits portal is not configured" }, 401);
    let accepted = false;
    for (const audience of audiences) {
      try {
        const { payload } = await verifyAccess(token, audience);
        if (!payload.common_name && lower(String(payload.email ?? "")) === allowedEmail()) { accepted = true; break; }
      } catch { }
    }
    if (!accepted) return c.json({ error: "Invalid Access token" }, 401);
  }
  await next();
  c.header("Content-Security-Policy", "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  c.header("X-Content-Type-Options", "nosniff"); c.header("Referrer-Policy", "no-referrer"); c.header("X-Frame-Options", "DENY"); c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
}

export async function requireAdmin(c: Context, next: Next) {
  const audiences = adminAudiences();
  if (!audiences.length || !allowedEmail() || !accessTeam()) return c.json({ error: "The limits portal is not configured; set CLOUDFLARE_ACCESS_ADMIN_AUD, ACCESS_EMAIL, and CLOUDFLARE_ACCESS_TEAM" }, 401);
  const token = c.req.header("cf-access-jwt-assertion");
  if (!token) return c.json({ error: "The limits portal requires Cloudflare Access authentication; use the dashboard hostname" }, 401);
  for (const audience of audiences) {
    try {
      const { payload } = await verifyAccess(token, audience);
      if (payload.common_name) return c.json({ error: "The limits portal is not available to service identities" }, 403);
      if (lower(String(payload.email ?? "")) !== allowedEmail()) return c.json({ error: "Identity not allowed" }, 403);
      return await next();
    } catch { }
  }
  return c.json({ error: "Invalid Access token" }, 401);
}
