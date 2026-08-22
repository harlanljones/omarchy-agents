import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context, Next } from "hono";

const remoteHost = "agents.harlanljones.com";
const allowedEmail = (process.env.ACCESS_EMAIL ?? "harlanljones@gmail.com").toLowerCase();
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function security(c: Context, next: Next) {
  const host = (c.req.header("host") ?? "").split(":")[0].toLowerCase();
  if (!localHosts.has(host) && host !== remoteHost) return c.json({ error: "Host not allowed" }, 403);
  const origin = c.req.header("origin");
  if (origin) { try { if (new URL(origin).hostname !== host) return c.json({ error: "Origin not allowed" }, 403); } catch { return c.json({ error: "Origin not allowed" }, 403); } }
  if (!localHosts.has(host)) {
    const token = c.req.header("cf-access-jwt-assertion");
    const team = process.env.CLOUDFLARE_ACCESS_TEAM;
    const audience = process.env.CLOUDFLARE_ACCESS_AUD;
    if (!token || !team || !audience) return c.json({ error: "Access authentication is not configured" }, 401);
    try {
      const jwks = createRemoteJWKSet(new URL(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`));
      const { payload } = await jwtVerify(token, jwks, { issuer: `https://${team}.cloudflareaccess.com`, audience });
      if (String(payload.email ?? "").toLowerCase() !== allowedEmail) return c.json({ error: "Identity not allowed" }, 403);
    } catch { return c.json({ error: "Invalid Access token" }, 401); }
  }
  if (["POST", "PATCH", "PUT", "DELETE"].includes(c.req.method) && !c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "JSON content type required" }, 415);
  await next();
  c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  c.header("X-Content-Type-Options", "nosniff"); c.header("Referrer-Policy", "no-referrer"); c.header("X-Frame-Options", "DENY"); c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
}
