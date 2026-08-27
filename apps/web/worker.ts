interface Env {
  API_ORIGIN: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // The dashboard — including the admin /limits portal page — is served here;
    // the API domain never serves the web app. Only API routes are forwarded to
    // the API origin. /api/* uses the Worker's service token; the portal's
    // /limits/api/* carries the visitor's own Access token so the portal stays
    // admin-gated (it fails closed if the dashboard host is not behind Access).
    const isApiProxy = url.pathname.startsWith("/api/") || url.pathname.startsWith("/limits/api/");
    if (!isApiProxy) return env.ASSETS.fetch(request);

    const origin = new URL(env.API_ORIGIN);
    const target = new URL(url.pathname + url.search, origin);
    const headers = new Headers(request.headers);
    if (url.pathname.startsWith("/api/") && env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET) {
      headers.set("CF-Access-Client-Id", env.ACCESS_CLIENT_ID);
      headers.set("CF-Access-Client-Secret", env.ACCESS_CLIENT_SECRET);
    }
    headers.delete("cookie");
    headers.delete("host");
    const upstream = new Request(target, { method: request.method, headers, body: request.body, duplex: "half" });
    return fetch(upstream);
  }
} satisfies ExportedHandler<Env>;
