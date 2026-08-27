interface Env {
  API_ORIGIN: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    // The dashboard is served here; the API domain serves only API routes —
    // plus the limits portal, which lives there because the tunnel hostname is
    // natively Access-gated at the edge (Workers on this host run before
    // zone-level Access, so the login challenge cannot be hosted here).
    if (url.pathname === "/limits" || url.pathname.startsWith("/limits/")) {
      return Response.redirect(new URL(`/limits${url.search}`, env.API_ORIGIN).toString(), 302);
    }
    if (url.pathname.startsWith("/api/")) {
      // /api/* uses the Worker's service token against the API origin.
      const origin = new URL(env.API_ORIGIN);
      const target = new URL(url.pathname + url.search, origin);
      const headers = new Headers(request.headers);
      if (env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET) {
        headers.set("CF-Access-Client-Id", env.ACCESS_CLIENT_ID);
        headers.set("CF-Access-Client-Secret", env.ACCESS_CLIENT_SECRET);
      }
      headers.delete("cookie");
      headers.delete("host");
      const upstream = new Request(target, { method: request.method, headers, body: request.body, duplex: "half" });
      return fetch(upstream);
    }
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
