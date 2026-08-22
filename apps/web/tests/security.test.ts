import { beforeAll, describe, expect, test } from "bun:test";
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
  test("requires Access configuration remotely", async () => expect((await app.request("https://agents.harlanljones.com/api/overview", { headers: { host: "agents.harlanljones.com" } })).status).toBe(401));
  test("requires JSON for mutations", async () => expect((await app.request("http://127.0.0.1/api/index/rebuild", { method: "POST", headers: { host: "127.0.0.1" } })).status).toBe(415));
});
