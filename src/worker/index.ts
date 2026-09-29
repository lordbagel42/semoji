import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  expire,
  LEASE_MS,
  markDirty,
  resultStatement,
  sourceStatement,
  validateSource,
} from "../catalog.js";
import { batch, type DatabaseEnv, database, sql } from "../database.js";
import { boundedJson, securityHeaders } from "../http.js";
import {
  type IndexStatus,
  nameSchema,
  resultSchema,
  type SearchHit,
  sha256,
  sourceSchema,
  WORKSPACE_ID,
} from "../shared.js";
import { drainEmbeddings, embed } from "./store.js";

type RuntimeEnv = Env & DatabaseEnv;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: securityHeaders });
const publicSearchPaths = ["/v1/emoji", "/v1/search", "/api/search"];
async function equal(a: string, b: string) {
  const hash = async (s: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return timingSafeEqual(
    new Uint8Array(await hash(a)),
    new Uint8Array(await hash(b)),
  );
}
async function auth(
  request: Request,
  env: Env,
  roles: ("READ_TOKEN" | "ADMIN_TOKEN" | "INDEXER_TOKEN")[],
) {
  const secrets = [env.READ_TOKEN, env.INDEXER_TOKEN, env.ADMIN_TOKEN];
  if (
    secrets.some((s) => !s || s.length < 32 || s.length > 512) ||
    new Set(secrets).size !== 3
  )
    throw new HttpError(503, "auth_unconfigured");
  const token =
    request.headers.get("Authorization")?.match(/^Bearer (.{1,512})$/)?.[1] ??
    "";
  const checks = await Promise.all(
    roles.map((role) => equal(token, env[role])),
  );
  if (!checks.some(Boolean)) throw new HttpError(401, "unauthorized");
}
async function body(request: Request) {
  try {
    return await boundedJson(new Response(request.body), 512 * 1024);
  } catch {
    throw new HttpError(400, "invalid_body");
  }
}
async function slack(request: Request, env: RuntimeEnv) {
  const stamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  if (
    !/^\d{10}$/.test(stamp) ||
    Math.abs(Date.now() / 1000 - Number(stamp)) > 300 ||
    !/^v0=[a-f0-9]{64}$/.test(signature) ||
    !env.SLACK_SIGNING_SECRET
  )
    throw new HttpError(401, "invalid_signature");
  // Read bytes with a hard bound, preserving the exact signed body.
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 64 * 1024) throw new HttpError(413, "body_too_large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  const prefix = new TextEncoder().encode(`v0:${stamp}:`);
  const signed = new Uint8Array(prefix.length + size);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = Uint8Array.from(signature.slice(3).match(/../g) ?? [], (s) =>
    Number.parseInt(s, 16),
  );
  if (!(await crypto.subtle.verify("HMAC", key, sig, signed)))
    throw new HttpError(401, "invalid_signature");
  const data = z
    .object({
      type: z.string(),
      team_id: z.string().optional(),
      challenge: z.string().max(1000).optional(),
      event: z.object({ type: z.string() }).passthrough().optional(),
    })
    .parse(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    );
  // Slack URL-verification has no team_id; its signature proves app ownership.
  if (data.type === "url_verification" && data.challenge)
    return json({ challenge: data.challenge });
  if (data.team_id !== WORKSPACE_ID)
    throw new HttpError(403, "wrong_workspace");
  if (data.type === "event_callback" && data.event?.type === "emoji_changed")
    await markDirty(env);
  return json({ ok: true });
}
type DocumentRow = {
  name: string;
  revision: string;
  vector_id: string;
  source_json: string;
  result_json: string | null;
};
function hit(
  row: DocumentRow,
  score: number,
  match: SearchHit["match"],
): SearchHit {
  const source = sourceSchema.parse(JSON.parse(row.source_json));
  const result = row.result_json
    ? resultSchema.parse(JSON.parse(row.result_json))
    : null;
  return {
    name: row.name,
    shortcode: `:${row.name}:`,
    canonicalName: source.canonicalName,
    imageUrl: source.imageUrl,
    summary: result?.analysis.summary ?? row.name,
    description: result?.analysis.description ?? "Not yet analyzed.",
    score,
    match,
  };
}
async function semanticQuery(
  request: Request,
  env: Env,
  q: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    // Cache only query vectors, never catalog/results. This key is not a public route.
    const key = new Request(
      new URL(`/_embeddings/bge-small-v1/${await sha256(q)}`, request.url),
    );
    const cache = typeof caches === "undefined" ? undefined : caches.default;
    const cached = await cache?.match(key);
    let vector: number[] | undefined;
    if (cached)
      vector = z
        .array(z.number().finite())
        .length(384)
        .parse(await cached.json());
    else {
      [vector] = await embed(env, [q]);
      if (vector && cache)
        await cache.put(
          key,
          Response.json(vector, {
            headers: { "Cache-Control": "max-age=3600" },
          }),
        );
    }
    return vector ?? null;
  })().catch(() => null);
  // Let a slow first embedding warm the private cache, without holding up search.
  ctx?.waitUntil(work.then(() => {}));
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 150);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function search(
  request: Request,
  env: RuntimeEnv,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  const started = performance.now();
  const url = new URL(request.url);
  const single = url.pathname === "/v1/emoji";
  const q = z.string().trim().min(1).max(300).parse(url.searchParams.get("q"));
  const requestedLimit = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .parse(url.searchParams.get("limit") ?? 12);
  const limit = single ? 1 : requestedLimit;
  const mode = z
    .enum(["hybrid", "keyword"])
    .parse(url.searchParams.get("mode") ?? "hybrid");
  const exact = q.replace(/^:|:$/g, "");
  // One indexed lookup, no descriptions or AI, for the latency-critical route.
  if (single) {
    const found = await sql(
      env,
      "SELECT name FROM search_documents WHERE name=$1",
      exact,
    ).first<{ name: string }>();
    if (found)
      return new Response(found.name, {
        headers: {
          ...securityHeaders,
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
  }
  const semantic =
    mode === "hybrid"
      ? semanticQuery(request, env, q, ctx)
      : Promise.resolve(null);
  const query = (q.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, 12)
    .map((term) => `'${term}':*`)
    .join(" | ");
  // Rank compact keys first. Only retrieve full JSON for returned results.
  const keyword = await sql(
    env,
    `SELECT name,vector_id FROM search_documents
    WHERE name=$2 OR search_vector @@ to_tsquery('simple',$1)
    ORDER BY (name=$2) DESC,ts_rank_cd(search_vector,to_tsquery('simple',$1)) DESC,name LIMIT 50`,
    query,
    exact,
  ).all<{ name: string; vector_id: string }>();
  const ranked = new Map<
    string,
    { score: number; match: SearchHit["match"]; confidence: number | null }
  >();
  keyword.results.forEach((row, i) => {
    const isExact = row.name === exact;
    ranked.set(row.vector_id, {
      score: isExact ? 1 : 1 / (60 + i),
      match: isExact ? "exact" : "keyword",
      confidence: isExact ? 1 : null,
    });
  });
  let semanticAvailable = false;
  if (mode === "hybrid")
    try {
      const vector = await semantic;
      if (!vector) throw new Error("semantic_unavailable");
      const matches = (
        await sql(
          env,
          "SELECT id,1-(embedding <=> $1::halfvec) AS similarity FROM embeddings ORDER BY embedding <=> $1::halfvec LIMIT 50",
          JSON.stringify(vector),
        ).all<{ id: string; similarity: number }>()
      ).results;
      matches.forEach((m, i) => {
        const old = ranked.get(m.id);
        ranked.set(m.id, {
          score: (old?.score ?? 0) + 1 / (60 + i),
          match: old?.match ?? "semantic",
          confidence:
            old?.match === "exact" ? 1 : Math.max(0, Math.min(1, m.similarity)),
        });
      });
      // An empty vector index is not working semantic search.
      semanticAvailable = matches.length > 0;
    } catch {
      /* Deliberate keyword fallback; never leak provider errors. */
    }
  // Revalidate even keyword candidates after the asynchronous provider call.
  const ids = [...ranked.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .map(([id]) => id);
  if (single) {
    const best = ids.length
      ? await sql(
          env,
          "SELECT name FROM search_documents WHERE vector_id=ANY($1::text[]) ORDER BY array_position($1::text[],vector_id) LIMIT 1",
          ids,
        ).first<{ name: string }>()
      : null;
    if (!best) throw new HttpError(404, "no_match");
    return new Response(best.name, {
      headers: {
        ...securityHeaders,
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
  const current = ids.length
    ? (
        await sql(
          env,
          "SELECT name,revision,vector_id,source_json,result_json FROM documents WHERE vector_id=ANY($1::text[]) ORDER BY array_position($1::text[],vector_id) LIMIT $2",
          ids,
          limit,
        ).all<DocumentRow>()
      ).results
    : [];
  return json({
    results: current.map((row) => {
      // biome-ignore lint/style/noNonNullAssertion: SQL restricts rows to ranked vector IDs.
      const rank = ranked.get(row.vector_id)!;
      return {
        ...hit(row, rank.score, rank.match),
        ...(url.pathname === "/v1/search"
          ? { id: row.name, confidence: rank.confidence }
          : {}),
      };
    }),
    mode: semanticAvailable ? "hybrid" : "keyword",
    durationMs: Math.round(performance.now() - started),
    semanticAvailable,
    ...(mode === "hybrid" && !semanticAvailable
      ? { degraded: "semantic_unavailable" }
      : {}),
  });
}
async function status(env: RuntimeEnv) {
  await expire(env);
  const groups = (
    await sql(
      env,
      "SELECT state,count(*)::int AS n FROM jobs GROUP BY state",
    ).all<{
      state: string;
      n: number;
    }>()
  ).results;
  const counts: IndexStatus["counts"] = {
    total: 0,
    aliases: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    unknown: 0,
  };
  for (const state of [
    "pending",
    "running",
    "completed",
    "failed",
    "unknown",
  ] as const)
    counts[state] = groups.find((r) => r.state === state)?.n ?? 0;
  counts.total =
    (
      await sql(env, "SELECT count(*)::int AS n FROM sources").first<{
        n: number;
      }>()
    )?.n ?? 0;
  counts.aliases =
    (
      await sql(
        env,
        "SELECT count(*)::int AS n FROM sources WHERE source_json::jsonb->>'aliasOf' IS NOT NULL",
      ).first<{ n: number }>()
    )?.n ?? 0;
  const recent = (
    await sql(
      env,
      `SELECT s.name,coalesce(j.state,'alias') AS state,d.result_json::jsonb->'analysis'->>'summary' AS summary,s.image_url AS "imageUrl",j.error FROM sources s LEFT JOIN jobs j ON j.name=s.name LEFT JOIN documents d ON d.name=s.name ORDER BY j.updated_at DESC NULLS LAST LIMIT 12`,
    ).all<IndexStatus["recent"][number]>()
  ).results;
  const completed =
    (
      await sql(
        env,
        "SELECT count(*)::int AS n FROM jobs WHERE state='completed' AND updated_at>$1",
        Date.now() - 60_000,
      ).first<{ n: number }>()
    )?.n ?? 0;
  const result: IndexStatus = {
    mode: "cloud",
    state: counts.running
      ? "running"
      : counts.unknown || counts.failed
        ? "blocked"
        : "idle",
    updatedAt: new Date().toISOString(),
    counts,
    concurrency: counts.running,
    targetConcurrency: 0,
    completedPerMinute: completed,
    availableMemoryMb: null,
    reason: counts.unknown
      ? "Explicit reindex required for uncertain jobs"
      : null,
    recent,
  };
  return json(result);
}
async function route(
  request: Request,
  env: RuntimeEnv,
  ctx?: Pick<ExecutionContext, "waitUntil">,
) {
  const path = new URL(request.url).pathname;
  if (path === "/slack/events" && request.method === "POST")
    return slack(request, env);
  if (publicSearchPaths.includes(path)) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204 });
    if (request.method !== "GET")
      throw new HttpError(405, "method_not_allowed");
    const allowed = await env.SEARCH_LIMITER.limit({
      key: request.headers.get("CF-Connecting-IP") ?? "local",
    });
    if (!allowed.success) throw new HttpError(429, "rate_limited");
    return search(request, env, ctx);
  }
  if (!path.startsWith("/api/")) {
    if (
      ![
        "/",
        "/index.html",
        "/docs",
        "/docs/",
        "/docs.html",
        "/docs.css",
        "/docs-init.js",
        "/openapi.json",
        "/vendor/swagger-ui-bundle.js",
        "/vendor/swagger-ui.css",
        "/dashboard",
        "/app.js",
        "/style.css",
        "/styles.css",
        "/favicon.ico",
      ].includes(path)
    )
      throw new HttpError(404, "not_found");
    const docs = ["/", "/index.html", "/docs", "/docs/", "/docs.html"].includes(
      path,
    );
    const assetUrl = new URL(request.url);
    if (docs) assetUrl.pathname = "/docs.html";
    if (path === "/dashboard") assetUrl.pathname = "/index.html";
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(securityHeaders)) headers.set(k, v);
    if (docs)
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    return new Response(response.body, { status: response.status, headers });
  }
  if (path === "/api/status" && request.method === "GET") {
    await auth(request, env, ["READ_TOKEN", "ADMIN_TOKEN"]);
    return status(env);
  }
  if (request.method !== "POST") throw new HttpError(404, "not_found");
  if (path.startsWith("/api/jobs/")) {
    await auth(request, env, ["INDEXER_TOKEN"]);
    await expire(env);
    if (path === "/api/jobs/claim") {
      if (request.body)
        z.object({})
          .strict()
          .parse(await body(request));
      const id = crypto.randomUUID();
      const expiresAt = Date.now() + LEASE_MS;
      const job = await sql(
        env,
        `UPDATE jobs SET state='running',lease_id=$1,expires_at=$2,updated_at=$3,error=NULL WHERE name=(SELECT j.name FROM jobs j JOIN sources s ON s.name=j.name AND s.revision=j.revision WHERE j.state='pending' ORDER BY j.updated_at,j.name LIMIT 1 FOR UPDATE OF j SKIP LOCKED) AND state='pending' RETURNING name,revision`,
        id,
        expiresAt,
        Date.now(),
      ).first<{ name: string; revision: string }>();
      if (!job) return json({ lease: null });
      const row = await sql(
        env,
        "SELECT source_json FROM sources WHERE name=$1 AND revision=$2",
        job.name,
        job.revision,
      ).first<{ source_json: string }>();
      return json({
        lease: row
          ? { id, source: JSON.parse(row.source_json), expiresAt }
          : null,
      });
    }
    const input = await body(request);
    if (path === "/api/jobs/heartbeat") {
      const { leaseId } = z.object({ leaseId: z.uuid() }).strict().parse(input);
      const expiresAt = Date.now() + LEASE_MS;
      const row = await sql(
        env,
        "UPDATE jobs SET expires_at=$1,updated_at=$2 WHERE lease_id=$3 AND state='running' AND expires_at>$4 RETURNING name",
        expiresAt,
        Date.now(),
        leaseId,
        Date.now(),
      ).first();
      if (!row) throw new HttpError(409, "stale_lease");
      return json({ expiresAt });
    }
    if (path === "/api/jobs/complete") {
      const { leaseId, result } = z
        .object({ leaseId: z.uuid(), result: resultSchema })
        .strict()
        .parse(input);
      await validateSource(result.source);
      const { digest, statement } = await resultStatement(env, result, leaseId);
      const outcomes = await batch(env, [
        sql(
          env,
          `UPDATE jobs SET state='completed',digest=$1,updated_at=$2 WHERE lease_id=$3 AND name=$4 AND revision=$5 AND ((state='running' AND expires_at>(extract(epoch FROM clock_timestamp())*1000)::bigint) OR (state='completed' AND digest=$6)) RETURNING name`,
          digest,
          Date.now(),
          leaseId,
          result.source.name,
          result.source.revision,
          digest,
        ),
        statement,
      ]);
      if (!outcomes[0]?.results.length) throw new HttpError(409, "stale_lease");
      return json({ ok: true });
    }
    if (path === "/api/jobs/fail") {
      const { leaseId, code, uncertain } = z
        .object({
          leaseId: z.uuid(),
          code: z.string().regex(/^[a-z0-9_]{1,64}$/),
          uncertain: z.boolean(),
        })
        .strict()
        .parse(input);
      const row = await sql(
        env,
        "UPDATE jobs SET state=$1,error=$2,updated_at=$3 WHERE lease_id=$4 AND state='running' AND expires_at>$5 RETURNING name",
        uncertain ? "unknown" : "failed",
        code,
        Date.now(),
        leaseId,
        Date.now(),
      ).first();
      if (!row) throw new HttpError(409, "stale_lease");
      return json({ ok: true });
    }
    throw new HttpError(404, "not_found");
  }
  await auth(request, env, ["ADMIN_TOKEN"]);
  if (path === "/api/embeddings") {
    z.object({})
      .strict()
      .parse(await body(request));
    return json({ processed: await drainEmbeddings(env) });
  }
  if (path === "/api/sync") {
    if (request.body)
      z.object({})
        .strict()
        .parse(await body(request));
    await markDirty(env);
    return json({ ok: true }, 202);
  }
  if (path === "/api/reindex") {
    const { name } = z
      .object({ name: nameSchema })
      .strict()
      .parse(await body(request));
    const row = await sql(
      env,
      `UPDATE jobs SET state='pending',lease_id=NULL,expires_at=NULL,digest=NULL,error=NULL,updated_at=$1 WHERE name=(SELECT canonical_name FROM sources WHERE name=$2) RETURNING name`,
      Date.now(),
      name,
    ).first();
    if (!row) throw new HttpError(404, "not_found");
    return json({ ok: true });
  }
  if (path === "/api/import") {
    const input = z
      .object({
        sources: z.array(sourceSchema).max(50),
        results: z.array(resultSchema).max(20),
      })
      .strict()
      .parse(await body(request));
    await Promise.all(
      [...input.sources, ...input.results.map((r) => r.source)].map(
        validateSource,
      ),
    );
    // Imported results carry their source, so result-only batches are useful and bounded.
    const sources = new Map(
      [...input.sources, ...input.results.map((r) => r.source)].map((s) => [
        s.name,
        s,
      ]),
    );
    const statements = [...sources.values()].map((s) =>
      sourceStatement(env, s),
    );
    for (const result of input.results) {
      if (result.source.canonicalName !== result.source.name)
        throw new HttpError(400, "canonical_result_required");
      const { statement } = await resultStatement(env, result);
      statements.push(statement);
      statements.push(
        sql(
          env,
          "UPDATE jobs SET state='completed',lease_id=NULL,digest=NULL,updated_at=$1 WHERE name=$2 AND revision=$3",
          Date.now(),
          result.source.name,
          result.source.revision,
        ),
      );
    }
    if (statements.length) await batch(env, statements);
    return json({
      ok: true,
      sources: sources.size,
      results: input.results.length,
    });
  }
  throw new HttpError(404, "not_found");
}
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx?: Pick<ExecutionContext, "waitUntil">,
  ) {
    const DB = database(env.HYPERDRIVE.connectionString);
    let response: Response;
    try {
      response = await route(request, { ...env, DB }, ctx);
    } catch (error) {
      response = json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : error instanceof z.ZodError ||
                  error instanceof SyntaxError ||
                  (error instanceof Error && error.message === "invalid_source")
                ? "invalid_request"
                : "service_unavailable",
        },
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError ||
              error instanceof SyntaxError ||
              (error instanceof Error && error.message === "invalid_source")
            ? 400
            : 503,
      );
    } finally {
      await DB.close();
    }
    const path = new URL(request.url).pathname;
    if (publicSearchPaths.includes(path) || path === "/openapi.json") {
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.headers.set("Access-Control-Max-Age", "86400");
      if (response.status === 429) response.headers.set("Retry-After", "60");
      if (response.status === 405)
        response.headers.set("Allow", "GET, OPTIONS");
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
