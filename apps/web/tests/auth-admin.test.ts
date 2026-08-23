import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalJWKSet, generateKeyPair, exportJWK, jwtVerify, SignJWT, type CryptoKey } from "jose";

const savedEnv: Record<string, string | undefined> = {};
const setEnv = (key: string, value: string) => { savedEnv[key] ??= process.env[key]; process.env[key] = value; };

let app: typeof import("../src/server").default;
let privateKey: CryptoKey;
let signToken: (audience: string, email?: string) => Promise<string>;
let setVerifier: (typeof import("../src/server/auth"))["_setAccessVerifierForTests"];

beforeAll(async () => {
  setEnv("OMARCHY_AGENTS_DB", join(tmpdir(), `omarchy-agents-admin-test-${process.pid}.sqlite`));
  setEnv("CLOUDFLARE_ACCESS_TEAM", "test-team");
  setEnv("CLOUDFLARE_ACCESS_AUD", "aud-main");
  setEnv("CLOUDFLARE_ACCESS_ADMIN_AUD", "aud-admin-a, aud-admin-b");
  setEnv("ACCESS_EMAIL", "admin@example.com");
  ({ default: app } = await import("../src/server"));
  ({ _setAccessVerifierForTests: setVerifier } = await import("../src/server/auth"));

  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey as CryptoKey;
  const jwk = await exportJWK(pair.publicKey);
  const localJwks = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", use: "sig" }] });
  setVerifier((token, issuer, audience) => jwtVerify(token, localJwks, { issuer, audience }));
  const issuer = "https://test-team.cloudflareaccess.com";
  signToken = (audience, email = "admin@example.com") => new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
});

afterAll(() => {
  setVerifier(null);
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const get = (path: string, host: string, token?: string) =>
  app.request(`https://${host}${path}`, { headers: { host, ...(token ? { "cf-access-jwt-assertion": token } : {}) } });

describe("limits portal boundary", () => {
  test("rejects loopback without a token", async () =>
    expect((await get("/limits/api/board", "127.0.0.1")).status).toBe(401));

  test("accepts a first-configured admin audience on loopback", async () => {
    const response = await get("/limits/api/board", "127.0.0.1", await signToken("aud-admin-a"));
    expect(response.status).toBe(200);
  });

  test("accepts the second configured admin audience", async () => {
    const response = await get("/limits/api/board", "127.0.0.1", await signToken("aud-admin-b"));
    expect(response.status).toBe(200);
  });

  test("rejects a token minted for the main dashboard audience", async () =>
    expect((await get("/limits/api/board", "127.0.0.1", await signToken("aud-main"))).status).toBe(401));

  test("rejects an unknown audience", async () =>
    expect((await get("/limits/api/board", "127.0.0.1", await signToken("aud-other"))).status).toBe(401));

  test("rejects a valid token for a different email", async () =>
    expect((await get("/limits/api/board", "127.0.0.1", await signToken("aud-admin-a", "intruder@example.com"))).status).toBe(403));

  test("blocks the service-origin path to the portal", async () => {
    setEnv("API_HOSTNAME", "api.example.com");
    setEnv("CLOUDFLARE_ACCESS_API_AUD", "aud-api");
    setEnv("ACCESS_CLIENT_ID", "svc.client");
    try {
      const response = await get("/limits/api/board", "api.example.com", await signToken("aud-admin-a"));
      expect(response.status).toBe(403);
    } finally {
      for (const key of ["API_HOSTNAME", "CLOUDFLARE_ACCESS_API_AUD", "ACCESS_CLIENT_ID"]) delete process.env[key];
    }
  });

  test("fails closed when no admin audience is configured", async () => {
    const saved = process.env.CLOUDFLARE_ACCESS_ADMIN_AUD;
    delete process.env.CLOUDFLARE_ACCESS_ADMIN_AUD;
    try {
      const response = await get("/limits/api/board", "127.0.0.1", await signToken("aud-admin-a"));
      expect(response.status).toBe(401);
    } finally { process.env.CLOUDFLARE_ACCESS_ADMIN_AUD = saved; }
  });

  test("guards the portal page route too", async () =>
    expect((await get("/limits", "127.0.0.1")).status).toBe(401));
});

describe("existing boundary preserved", () => {
  test("loopback stays open for non-admin routes", async () =>
    expect((await get("/api/overview", "127.0.0.1")).status).toBe(200));

  test("remote non-admin routes still demand the main audience", async () => {
    const missing = await get("/api/overview", "agents.example.com");
    expect(missing.status).toBe(401);
    const wrongAud = await get("/api/overview", "agents.example.com", await signToken("aud-admin-a"));
    expect(wrongAud.status).toBe(401);
    const good = await get("/api/overview", "agents.example.com", await signToken("aud-main"));
    expect(good.status).toBe(200);
  });
});
