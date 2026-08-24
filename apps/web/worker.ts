interface Env {
  API_ORIGIN: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/limits" || url.pathname.startsWith("/limits/"))
      return Response.redirect(new URL("/limits", env.API_ORIGIN), 302);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

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
} satisfies ExportedHandler<Env>;
