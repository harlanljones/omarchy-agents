interface Env {
  API_ORIGIN: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
  ASSETS: Fetcher;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const origin = new URL(env.API_ORIGIN);
    const target = new URL(url.pathname + url.search, origin);
    const headers = new Headers(request.headers);
    headers.set("Host", origin.host);
    if (env.ACCESS_CLIENT_ID && env.ACCESS_CLIENT_SECRET) {
      headers.set("CF-Access-Client-Id", env.ACCESS_CLIENT_ID);
      headers.set("CF-Access-Client-Secret", env.ACCESS_CLIENT_SECRET);
    }
    const upstream = new Request(target, request);
    upstream.headers.clear();
    for (const [key, value] of headers) upstream.headers.set(key, value);
    return fetch(upstream);
  }
} satisfies ExportedHandler<Env>;
