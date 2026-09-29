import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { URL } from "node:url";
import { getPlatformProxy } from "wrangler";
import { resultStatement, sourceStatement } from "../catalog.js";
import { batch, database, sql, transaction } from "../database.js";
import { slackCatalog } from "../http.js";
import {
  catalogSources,
  type EmojiLease,
  type IndexStatus,
  resultSchema,
  type SearchHit,
} from "../shared.js";
import worker from "./index.js";
import { drainEmbeddings } from "./store.js";

type SearchResponse = {
  results: SearchHit[];
  mode: string;
  semanticAvailable: boolean;
  degraded?: string;
};

test("Slack catalogues require a matching workspace or an explicit enterprise workspace grant", async (t) => {
  let identity = { team_id: "E_ORG", is_enterprise_install: true };
  let granted = true;
  let redirect = false;
  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (...[input, init]: Parameters<typeof fetch>) => {
      const request = new Request(input, init);
      assert.equal(request.redirect, "manual");
      const method = new URL(request.url).pathname.split("/").pop();
      const params = new URLSearchParams(await request.text());
      calls.push(method ?? "");
      if (redirect)
        return new Response(null, {
          status: 302,
          headers: { Location: "https://example.invalid/collect" },
        });
      if (method === "auth.test")
        return Response.json({ ok: true, ...identity });
      if (method === "auth.teams.list") {
        return Response.json({
          ok: true,
          teams: [
            { id: params.get("cursor") && granted ? "T0266FRGM" : "T_OTHER" },
          ],
          response_metadata: {
            next_cursor: params.get("cursor") ? "" : "page2",
          },
        });
      }
      assert.equal(method, "emoji.list");
      assert.equal(params.get("team_id"), "T0266FRGM");
      return Response.json({
        ok: true,
        emoji: { wave: "https://emoji.slack-edge.com/wave.png" },
      });
    },
  );
  assert.deepEqual(await slackCatalog("fixture"), {
    wave: "https://emoji.slack-edge.com/wave.png",
  });
  assert.deepEqual(calls, [
    "auth.test",
    "auth.teams.list",
    "auth.teams.list",
    "emoji.list",
  ]);
  calls.length = 0;
  granted = false;
  await assert.rejects(slackCatalog("fixture"), /slack_workspace_mismatch/);
  assert.ok(!calls.includes("emoji.list"));
  calls.length = 0;
  identity = { team_id: "T_OTHER", is_enterprise_install: false };
  await assert.rejects(slackCatalog("fixture"), /slack_workspace_mismatch/);
  assert.deepEqual(calls, ["auth.test"]);
  calls.length = 0;
  identity = { team_id: "T0266FRGM", is_enterprise_install: false };
  await slackCatalog("fixture");
  assert.deepEqual(calls, ["auth.test", "emoji.list"]);
  calls.length = 0;
  redirect = true;
  await assert.rejects(slackCatalog("fixture"), /slack_http_302/);
  assert.deepEqual(calls, ["auth.test"]);
});

test("Postgres: role boundaries, lease fencing, idempotency, alias/removal and signed events", {
  skip: !process.env.EMOJI_TEST_DATABASE_URL,
}, async () => {
  const url = new URL(process.env.EMOJI_TEST_DATABASE_URL ?? "");
  const bootstrap = database(url.toString());
  const schema = `emoji_test_${randomUUID().replaceAll("-", "")}`;
  await bootstrap.query(
    "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public",
  );
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const previous =
    process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
    url.toString();
  const platform = await getPlatformProxy<Env>({
    persist: false,
    remoteBindings: false,
  });
  const DB = database(url.toString());
  try {
    let failAI = false;
    let aiCalls = 0;
    let limited = false;
    const env: Env & { DB: typeof DB } = {
      ...platform.env,
      DB,
      SEARCH_LIMITER: { limit: async () => ({ success: !limited }) },
      HYPERDRIVE: new Proxy(platform.env.HYPERDRIVE, {
        get: (target, key) =>
          key === "connectionString"
            ? url.toString()
            : Reflect.get(target, key),
      }),
      READ_TOKEN: randomUUID(),
      INDEXER_TOKEN: randomUUID(),
      ADMIN_TOKEN: randomUUID(),
      SLACK_SIGNING_SECRET: randomUUID(),
      SLACK_BOT_TOKEN: "unused-local-fixture",
      AI: new Proxy(platform.env.AI, {
        get: (_target, key) =>
          key === "run"
            ? async (_model: string, input: { text: string[] }) => {
                aiCalls++;
                if (failAI) throw new Error("private_provider_failure");
                return {
                  data: input.text.map(() => [1, ...Array(383).fill(0)]),
                };
              }
            : undefined,
      }),
    };
    const migration = await readFile(
      new URL("../../migrations/postgres/0001_catalog.sql", import.meta.url),
      "utf8",
    );
    await DB.query(migration);
    const request = async (path: string, token = "", body?: unknown) =>
      worker.fetch(
        new Request(`https://local.test${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      );
    assert.equal((await request("/api/status", "wrong")).status, 401);
    assert.equal((await request("/api/search?q=cat&mode=keyword")).status, 200);
    for (const path of [
      "/api/import",
      "/api/embeddings",
      "/api/sync",
      "/api/jobs/claim",
    ])
      assert.equal((await request(path, "", {})).status, 401);
    const privateStatus = await request("/api/status");
    assert.equal(privateStatus.status, 401);
    assert.equal(
      privateStatus.headers.get("Access-Control-Allow-Origin"),
      null,
    );
    limited = true;
    const throttled = await request("/v1/emoji?q=cat");
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get("Retry-After"), "60");
    assert.equal(throttled.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(aiCalls, 0);
    limited = false;
    for (const path of [
      "/v1/emoji?q=",
      "/v1/search?q=cat&limit=0",
      "/v1/search?q=cat&limit=51",
    ])
      assert.equal((await request(path)).status, 400);
    assert.equal((await request("/v1/emoji?q=cat&mode=keyword")).status, 404);
    const preflight = await worker.fetch(
      new Request("https://local.test/v1/search", { method: "OPTIONS" }),
      env,
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(
      (await request("/api/jobs/claim", env.READ_TOKEN, {})).status,
      401,
    );
    assert.equal(
      (
        await request("/api/import", env.INDEXER_TOKEN, {
          sources: [],
          results: [],
        })
      ).status,
      401,
    );
    assert.equal((await request("/api/status", env.INDEXER_TOKEN)).status, 401);
    assert.equal((await request("/api/catalog", env.READ_TOKEN)).status, 404);
    const sources = await catalogSources({
      cat: "https://emoji.slack-edge.com/cat.png",
      kitty: "alias:cat",
    });
    const source = sources.find((s) => s.name === "cat");
    assert.ok(source);
    assert.equal(
      (await request("/api/import", env.ADMIN_TOKEN, { sources, results: [] }))
        .status,
      200,
    );
    const callsBeforeExact = aiCalls;
    const fast = await request("/v1/emoji?q=:kitty:");
    assert.equal(fast.status, 200);
    assert.equal(await fast.text(), "kitty");
    assert.equal(aiCalls, callsBeforeExact, "exact IDs never invoke AI");
    assert.match(fast.headers.get("Content-Type") ?? "", /^text\/plain/);
    const claims = await Promise.all([
      request("/api/jobs/claim", env.INDEXER_TOKEN, {}),
      request("/api/jobs/claim", env.INDEXER_TOKEN, {}),
    ]);
    const leases = await Promise.all(
      claims.map((r) => r.json<{ lease: EmojiLease | null }>()),
    );
    const lease = leases.find((v) => v.lease)?.lease;
    assert.ok(lease);
    assert.equal(leases.filter((v) => v.lease).length, 1);
    const result = resultSchema.parse({
      schemaVersion: 1,
      source,
      media: {
        hash: "a".repeat(64),
        mime: "image/png",
        width: 64,
        height: 64,
        frames: 1,
        sampledFrames: [0],
      },
      analysis: {
        summary: "A happy cat",
        description:
          "A small happy cat with a friendly face and cheerful eyes.",
        visibleText: [],
        subjects: ["cat"],
        actions: [],
        colors: [],
        style: [],
        emotions: ["happy"],
        tags: [],
        usageExamples: [],
        interpretation: "",
        uncertainties: [],
        confidence: "high",
        animationDescription: "",
        embeddingText: "happy cat friendly face",
      },
      provenance: {
        provider: "codex",
        model: "fixture",
        promptVersion: "emoji-vision-1",
        indexedAt: new Date().toISOString(),
        durationMs: 1,
      },
    });
    assert.equal(
      (
        await request("/api/jobs/complete", env.INDEXER_TOKEN, {
          leaseId: randomUUID(),
          result,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request("/api/jobs/heartbeat", env.INDEXER_TOKEN, {
          leaseId: lease.id,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/jobs/complete", env.INDEXER_TOKEN, {
          leaseId: lease.id,
          result,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/jobs/complete", env.INDEXER_TOKEN, {
          leaseId: lease.id,
          result,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/jobs/complete", env.INDEXER_TOKEN, {
          leaseId: lease.id,
          result: {
            ...result,
            analysis: { ...result.analysis, summary: "Different" },
          },
        })
      ).status,
      409,
    );
    let search = await (
      await request("/api/search?q=happy&mode=keyword", env.READ_TOKEN)
    ).json<SearchResponse>();
    assert.equal(search.results.length, 2);
    assert.ok(
      search.results.some(
        (r: { name: string; summary: string }) =>
          r.name === "kitty" && r.summary === "A happy cat",
      ),
    );
    const publicHits = await (
      await request("/v1/search?q=happy&mode=keyword&limit=1")
    ).json<{ results: { id: string; confidence: number | null }[] }>();
    assert.equal(publicHits.results.length, 1);
    assert.equal(publicHits.results[0]?.confidence, null);
    failAI = true;
    await assert.rejects(drainEmbeddings(env));
    assert.ok(
      (
        await sql(
          env,
          "SELECT count(*)::int AS n FROM embedding_outbox",
        ).first<{
          n: number;
        }>()
      )?.n,
    );
    search = await (
      await request("/api/search?q=cat", env.READ_TOKEN)
    ).json<SearchResponse>();
    assert.equal(search.mode, "keyword");
    assert.equal(search.semanticAvailable, false);
    assert.equal(search.degraded, "semantic_unavailable");
    failAI = false;
    await drainEmbeddings(env);
    assert.equal(
      (
        await sql(env, "SELECT count(*)::int AS n FROM embeddings").first<{
          n: number;
        }>()
      )?.n,
      2,
    );
    for (const [name, x, y] of [
      ["cat", 0.8, 0.6],
      ["kitty", 0.6, 0.8],
    ] as const)
      await DB.query(
        "UPDATE embeddings SET embedding=$1::halfvec FROM search_documents d WHERE embeddings.id=d.vector_id AND d.name=$2",
        [JSON.stringify([x, y, ...Array(382).fill(0)]), name],
      );
    const semanticHits = await (
      await request("/v1/search?q=kitty&limit=1&mode=semantic")
    ).json<{ mode: string; results: { id: string; confidence: number }[] }>();
    assert.equal(semanticHits.mode, "semantic");
    assert.equal(semanticHits.results.length, 1);
    // Semantic similarity must outrank the competing exact keyword "kitty".
    assert.equal(semanticHits.results[0]?.id, "cat");
    assert.ok(
      Math.abs((semanticHits.results[0]?.confidence ?? 0) - 0.8) < 0.001,
    );
    failAI = true;
    const unavailable = await request("/v1/search?q=kitty&mode=semantic");
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: "semantic_unavailable",
    });
    const beforeKeyword = aiCalls;
    const keywordOnly = await request("/v1/search?q=kitty&mode=keyword");
    assert.equal(keywordOnly.status, 200);
    assert.equal(aiCalls, beforeKeyword);
    failAI = false;
    search = await (
      await request("/api/search?q=cheerful", env.READ_TOKEN)
    ).json<SearchResponse>();
    assert.equal(search.semanticAvailable, true);
    assert.ok(search.results.some((r) => r.name === "kitty"));
    assert.equal(
      (await request("/api/reindex", env.ADMIN_TOKEN, { name: "cat" })).status,
      200,
    );
    const second = (
      await (
        await request("/api/jobs/claim", env.INDEXER_TOKEN, {})
      ).json<{ lease: EmojiLease | null }>()
    ).lease;
    assert.ok(second);
    const replacement = await catalogSources({
      cat: "https://emoji.slack-edge.com/new.png",
      kitty: "alias:cat",
    });
    assert.equal(
      (
        await request("/api/import", env.ADMIN_TOKEN, {
          sources: replacement,
          results: [],
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/api/jobs/complete", env.INDEXER_TOKEN, {
          leaseId: second.id,
          result,
        })
      ).status,
      409,
    );
    search = await (
      await request("/api/search?q=happy", env.READ_TOKEN)
    ).json<SearchResponse>();
    assert.equal(search.results.length, 0);
    const third = (
      await (
        await request("/api/jobs/claim", env.INDEXER_TOKEN, {})
      ).json<{ lease: EmojiLease | null }>()
    ).lease;
    assert.ok(third);
    await sql(
      env,
      "UPDATE jobs SET expires_at=0 WHERE lease_id=$1",
      third.id,
    ).run();
    assert.equal(
      (
        await (
          await request("/api/jobs/claim", env.INDEXER_TOKEN, {})
        ).json<{ lease: EmojiLease | null }>()
      ).lease,
      null,
    );
    assert.equal(
      (await (await request("/api/status", env.READ_TOKEN)).json<IndexStatus>())
        .counts.unknown,
      1,
    );
    await sql(env, "DELETE FROM sources").run();
    search = await (
      await request("/api/search?q=cat", env.READ_TOKEN)
    ).json<SearchResponse>();
    assert.equal(search.results.length, 0);
    assert.equal(
      (
        await sql(
          env,
          "SELECT count(*)::int AS n FROM search_documents",
        ).first<{
          n: number;
        }>()
      )?.n,
      0,
    );
    const signed = async (
      team: string,
      stamp = String(Math.floor(Date.now() / 1000)),
    ) => {
      const raw = JSON.stringify({
        type: "event_callback",
        team_id: team,
        event: { type: "emoji_changed" },
      });
      const sig = createHmac("sha256", env.SLACK_SIGNING_SECRET)
        .update(`v0:${stamp}:${raw}`)
        .digest("hex");
      return worker.fetch(
        new Request("https://local.test/slack/events", {
          method: "POST",
          headers: {
            "x-slack-request-timestamp": stamp,
            "x-slack-signature": `v0=${sig}`,
          },
          body: raw,
        }),
        env,
      );
    };
    assert.equal((await signed("OTHER")).status, 403);
    assert.equal((await signed("T0266FRGM", "1000000000")).status, 401);
    const before =
      (
        await sql(env, "SELECT dirty FROM sync_state").first<{
          dirty: number;
        }>()
      )?.dirty ?? 0;
    assert.equal((await signed("T0266FRGM")).status, 200);
    assert.equal(
      (
        await sql(env, "SELECT dirty FROM sync_state").first<{
          dirty: number;
        }>()
      )?.dirty,
      before + 1,
    );
    // A new alias and concurrent canonical completion must publish one digest.
    const racing = await catalogSources({
      race: "https://emoji.slack-edge.com/race.png",
      race_alias: "alias:race",
    });
    const canonical = racing.find((item) => item.name === "race");
    const alias = racing.find((item) => item.name === "race_alias");
    assert.ok(canonical && alias);
    await batch(env, [sourceStatement(env, canonical)]);
    const other = database(url.toString());
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const aliasWrite = transaction(env, async () => {
      await sourceStatement(env, alias).run();
      ready.resolve();
      await release.promise;
    });
    void aliasWrite.catch(ready.reject);
    let publication: Promise<unknown> | undefined;
    try {
      await ready.promise;
      const writer = (await other.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      const { statement } = await resultStatement(
        { DB: other },
        { ...result, source: canonical },
      );
      publication = batch({ DB: other }, [statement]);
      void publication.catch(() => {});
      let blocked = false;
      for (let i = 0; i < 50; i++) {
        const row = await bootstrap.query(
          "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
          [writer],
        );
        if (row.rows[0].blocked) {
          blocked = true;
          break;
        }
        await sleep(20);
      }
      assert.ok(
        blocked,
        "publication waits for the alias transaction before taking row locks",
      );
    } finally {
      release.resolve();
      await aliasWrite;
      await publication;
      await other.close();
    }
    assert.equal(
      (
        await DB.query(
          "SELECT count(*)::int AS n FROM documents WHERE name='race_alias' AND result_json IS NOT NULL",
        )
      ).rows[0].n,
      1,
    );
    await drainEmbeddings(env);
    assert.equal(
      (
        await DB.query(
          "SELECT count(*)::int AS n FROM embeddings e JOIN documents d ON d.vector_id=e.id WHERE d.name='race_alias'",
        )
      ).rows[0].n,
      1,
    );
    await DB.query("DELETE FROM sources WHERE name IN ('race','race_alias')");

    // Interrupted/replayed migration must never authorize another inference.
    const directory = await mkdtemp(join(tmpdir(), "emoji-import-"));
    const local = new DatabaseSync(join(directory, "index.sqlite"));
    try {
      local.exec(
        `CREATE TABLE emoji(name TEXT,revision TEXT,source TEXT,result TEXT,state TEXT,error TEXT,updated INTEGER,active INTEGER)`,
      );
      const imported = await catalogSources({
        import_completed: "https://emoji.slack-edge.com/complete.png",
        import_pending: "https://emoji.slack-edge.com/pending.png",
        import_unknown: "https://emoji.slack-edge.com/unknown.png",
      });
      for (const item of imported)
        local
          .prepare("INSERT INTO emoji VALUES(?,?,?,NULL,?,NULL,1,1)")
          .run(
            item.name,
            item.revision,
            JSON.stringify(item),
            item.name.replace("import_", ""),
          );
      const runImport = () =>
        spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "src/maintenance.ts",
            "import",
            "--data",
            directory,
          ],
          {
            env: { ...process.env, EMOJI_DATABASE_URL: url.toString() },
            encoding: "utf8",
            timeout: 60_000,
          },
        );
      // Missing completed payload forces failure after the source batch commits.
      assert.equal(runImport().status, 1);
      assert.deepEqual(
        (
          await DB.query(
            "SELECT state FROM jobs WHERE name LIKE 'import_%' ORDER BY name",
          )
        ).rows,
        [{ state: "completed" }, { state: "pending" }, { state: "unknown" }],
      );
      const completed = imported.find(
        (item) => item.name === "import_completed",
      );
      assert.ok(completed);
      local
        .prepare("UPDATE emoji SET result=? WHERE name='import_completed'")
        .run(JSON.stringify({ ...result, source: completed }));
      await DB.query(
        "UPDATE jobs SET state='unknown',lease_id=$1,error='lease_expired' WHERE name='import_pending'",
        [randomUUID()],
      );
      assert.equal(runImport().status, 0);
      assert.deepEqual(
        (
          await DB.query(
            "SELECT state FROM jobs WHERE name LIKE 'import_%' ORDER BY name",
          )
        ).rows,
        [{ state: "completed" }, { state: "unknown" }, { state: "unknown" }],
      );
      assert.equal(
        (
          await (
            await request("/api/jobs/claim", env.INDEXER_TOKEN, {})
          ).json<{ lease: EmojiLease | null }>()
        ).lease,
        null,
      );
    } finally {
      local.close();
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    await DB.close();
    await platform.dispose();
    if (previous === undefined)
      delete process.env
        .CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE;
    else
      process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
        previous;
    await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
    await bootstrap.close();
  }
});
