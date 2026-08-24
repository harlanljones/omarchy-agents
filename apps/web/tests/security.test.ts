import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

let app: typeof import("../src/server").default;
beforeAll(async () => {
  process.env.OMARCHY_AGENTS_DB = join(tmpdir(), `omarchy-agents-security-test-${process.pid}.sqlite`);
  ({ default: app } = await import("../src/server"));
});

describe("request boundary", () => {
  test("permits loopback without Access", async () => expect((await app.request("http://127.0.0.1/api/overview", { headers: { host: "127.0.0.1" } })).status).toBe(200));
  test("rejects an unknown host", async () => expect((await app.request("http://evil.example/api/overview", { headers: { host: "evil.example" } })).status).toBe(403));
  test("rejects a cross-site origin", async () => expect((await app.request("http://127.0.0.1/api/overview", { headers: { host: "127.0.0.1", origin: "https://evil.example" } })).status).toBe(403));
  test("requires Access configuration remotely", async () => expect((await app.request("https://agents.example.com/api/overview", { headers: { host: "agents.example.com" } })).status).toBe(401));
  test("requires JSON for mutations", async () => expect((await app.request("http://127.0.0.1/api/index/rebuild", { method: "POST", headers: { host: "127.0.0.1" } })).status).toBe(415));
});

describe("service identity boundary", () => {
  const saved: Record<string, string | undefined> = {};
  const setEnv = (values: Record<string, string>) => {
    for (const [key, value] of Object.entries(values)) {
      if (!(key in saved)) saved[key] = process.env[key];
      process.env[key] = value;
    }
  };

  afterEach(async () => {
    const { _setAccessVerifierForTests } = await import("../src/server/auth");
    _setAccessVerifierForTests(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("a shared dashboard/API hostname authenticates as a person, not a service", async () => {
    setEnv({
      API_HOSTNAME: "agents.example.com",
      CLOUDFLARE_ACCESS_TEAM: "team",
      CLOUDFLARE_ACCESS_AUD: "main-aud",
      CLOUDFLARE_ACCESS_API_AUD: "api-aud",
      ACCESS_CLIENT_ID: "service.access",
      ACCESS_EMAIL: "person@example.com",
    });
    const { _setAccessVerifierForTests } = await import("../src/server/auth");
    _setAccessVerifierForTests(async () => ({ payload: { email: "person@example.com", common_name: "someone-else.access" } }) as never);
    const res = await app.request("https://agents.example.com/api/overview", {
      headers: { host: "agents.example.com", "cf-access-jwt-assertion": "token" },
    });
    expect(res.status).toBe(200);
  });

  test("accepts the configured dashboard origin through the service hostname", async () => {
    setEnv({
      DASHBOARD_HOSTNAME: "dashboard.example.com",
      API_HOSTNAME: "api.example.com",
      CLOUDFLARE_ACCESS_TEAM: "team",
      CLOUDFLARE_ACCESS_API_AUD: "api-aud",
      ACCESS_CLIENT_ID: "worker-service",
    });
    const { Hono } = await import("hono");
    const { security, _setAccessVerifierForTests } = await import("../src/server/auth");
    _setAccessVerifierForTests(async () => ({ payload: { common_name: "worker-service" } }) as never);
    const boundary = new Hono();
    boundary.use("*", security);
    boundary.post("/api/analysis/run", c => c.json({ ok: true }));

    const response = await boundary.request("https://api.example.com/api/analysis/run", {
      method: "POST",
      headers: {
        host: "api.example.com",
        origin: "https://dashboard.example.com",
        "content-type": "application/json",
        "cf-access-jwt-assertion": "token",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);

    const crossSiteResponse = await boundary.request("https://api.example.com/api/analysis/run", {
      method: "POST",
      headers: {
        host: "api.example.com",
        origin: "https://evil.example.com",
        "content-type": "application/json",
        "cf-access-jwt-assertion": "token",
      },
      body: "{}",
    });

    expect(crossSiteResponse.status).toBe(403);
  });
});
