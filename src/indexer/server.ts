import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { securityHeaders } from "../http.js";
import type { Store } from "./store.js";

/** Read-only loopback status surface. Expose only through an authenticated portal. */
export function serveDashboard(store: Store, port: number) {
  const app = new Hono();
  const hosts = new Set(["127.0.0.1", "localhost"]);
  if (process.env.PUBLIC_URL)
    hosts.add(new URL(process.env.PUBLIC_URL).hostname);
  app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries(securityHeaders))
      c.header(key, value);
    if (!hosts.has(new URL(c.req.url).hostname))
      return c.json({ error: "invalid_host" }, 403);
    await next();
  });
  app.get("/api/status", (c) => c.json(store.status()));
  app.get("/api/search", (c) => {
    const started = performance.now();
    const query = c.req.query("q")?.trim() ?? "";
    if (!query || query.length > 300)
      return c.json({ error: "invalid_query" }, 400);
    return c.json({
      results: store.search(query),
      mode: "keyword",
      semanticAvailable: false,
      durationMs: performance.now() - started,
    });
  });
  for (const [path, mime] of [
    ["index.html", "text/html"],
    ["app.js", "text/javascript"],
    ["styles.css", "text/css"],
  ]) {
    if (!path || !mime) continue;
    const contents = readFile(
      fileURLToPath(new URL(`../../public/${path}`, import.meta.url)),
    );
    app.get(path === "index.html" ? "/" : `/${path}`, async (c) => {
      c.header("Content-Type", `${mime}; charset=utf-8`);
      return c.body(await contents);
    });
  }
  app.onError((_error, c) => c.json({ error: "request_failed" }, 500));
  return serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
}
