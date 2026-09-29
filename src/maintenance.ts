import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import {
  expire,
  reconcile,
  validateSource,
  withCatalogLock,
  writeSources,
} from "./catalog.js";
import {
  batch,
  type DatabaseEnv,
  database,
  sql,
  transaction,
} from "./database.js";
import { remoteClient } from "./indexer/remote.js";
import { resultSchema, sha256, sourceSchema } from "./shared.js";

process.umask(0o077);
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string" },
    "embedding-batches": { type: "string", default: "120" },
  },
});

async function importLocal(env: DatabaseEnv, directory: string) {
  if (!isAbsolute(directory))
    throw new Error("absolute_data_directory_required");
  const local = new DatabaseSync(join(directory, "index.sqlite"), {
    readOnly: true,
  });
  try {
    if (
      Number(
        local
          .prepare(
            "SELECT count(*) AS n FROM emoji WHERE active=1 AND state='running'",
          )
          .get()?.n,
      )
    )
      throw new Error("local_indexer_still_running");
    return await withCatalogLock(env, async () => {
      let sources = 0;
      let results = 0;
      for (let offset = 0; ; offset += 250) {
        const rows = local
          .prepare(
            "SELECT name,revision,source,result,state,error,updated FROM emoji WHERE active=1 ORDER BY name LIMIT 250 OFFSET ?",
          )
          .all(offset);
        if (!rows.length) break;
        const items = rows.map((row) =>
          sourceSchema.parse(JSON.parse(String(row.source))),
        );
        await Promise.all(items.map(validateSource));
        // Never expose imported terminal work as pending, even after interruption.
        await transaction(env, async () => {
          await writeSources(env, items);
          await sql(
            env,
            `UPDATE jobs j SET state=r.state,error=r.error,updated_at=r.updated
            FROM jsonb_to_recordset($1::jsonb) AS r(name text,revision text,state text,error text,updated bigint)
            WHERE j.name=r.name AND j.revision=r.revision AND j.state='pending' AND j.lease_id IS NULL
            AND r.state IN ('completed','pending','failed','unknown')`,
            JSON.stringify(
              rows.map((row) => ({
                name: row.name,
                revision: row.revision,
                state: row.state,
                updated: row.updated,
                error:
                  row.error && /^[a-z0-9_]{1,64}$/.test(String(row.error))
                    ? row.error
                    : null,
              })),
            ),
          ).run();
        });
        sources += items.length;
      }
      for (let offset = 0; ; offset += 100) {
        const rows = local
          .prepare(
            "SELECT name,revision,result,state,error,updated FROM emoji WHERE active=1 ORDER BY name LIMIT 100 OFFSET ?",
          )
          .all(offset);
        if (!rows.length) break;
        const analyses = [];
        for (const row of rows) {
          if (row.state !== "completed") continue;
          const result = resultSchema.parse(JSON.parse(String(row.result)));
          await validateSource(result.source);
          if (
            result.source.name !== row.name ||
            result.source.revision !== row.revision ||
            result.source.canonicalName !== row.name
          )
            throw new Error("local_result_source_mismatch");
          const encoded = JSON.stringify(result);
          analyses.push({
            name: row.name,
            revision: row.revision,
            digest: await sha256(encoded),
            result_json: encoded,
          });
        }
        await batch(env, [
          sql(
            env,
            `INSERT INTO analyses(name,revision,digest,result_json)
            SELECT a.* FROM jsonb_to_recordset($1::jsonb) AS a(name text,revision text,digest text,result_json text)
            JOIN sources s ON s.name=a.name AND s.revision=a.revision AND s.canonical_name=s.name
            ON CONFLICT(name,revision) DO UPDATE SET digest=excluded.digest,result_json=excluded.result_json WHERE analyses.digest<>excluded.digest`,
            JSON.stringify(analyses),
          ),
        ]);
        results += analyses.length;
        if (offset % 5000 === 0)
          console.log(JSON.stringify({ importedResults: results }));
      }
      return { importedSources: sources, importedResults: results };
    });
  } finally {
    local.close();
  }
}

async function main() {
  const connectionString = process.env.EMOJI_DATABASE_URL;
  if (
    !connectionString ||
    new URL(connectionString).hostname.includes("-pooler")
  )
    throw new Error("direct_database_url_required");
  const DB = database(connectionString);
  const env = { DB };
  try {
    const command = positionals[0];
    if (command === "migrate") {
      await DB.query(
        await readFile(
          new URL("../migrations/postgres/0001_catalog.sql", import.meta.url),
          "utf8",
        ),
      );
      console.log("Postgres schema created.");
    } else if (command === "import") {
      console.log(JSON.stringify(await importLocal(env, values.data ?? "")));
    } else if (command === "sync") {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) throw new Error("slack_bot_token_required");
      await expire(env);
      console.log(
        JSON.stringify(await reconcile({ ...env, SLACK_BOT_TOKEN: token })),
      );
    } else if (command === "embeddings") {
      const count = Number(values["embedding-batches"]);
      if (!Number.isInteger(count) || count < 1 || count > 10000)
        throw new Error("invalid_embedding_batch_limit");
      const client = remoteClient(
        "https://emojis.raygen.dev",
        process.env.EMOJI_ADMIN_TOKEN ?? "",
      );
      let processed = 0;
      for (let i = 0; i < count; i++) {
        const result = await client.post("/api/embeddings", {});
        if (
          typeof result !== "object" ||
          result === null ||
          !("processed" in result) ||
          typeof result.processed !== "number"
        )
          throw new Error("invalid_embedding_receipt");
        processed += result.processed;
        if (!result.processed) break;
      }
      console.log(JSON.stringify({ processed }));
    } else throw new Error("expected_migrate_import_sync_or_embeddings");
  } finally {
    await DB.close();
  }
}

void main().catch((error) => {
  console.error(
    error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message)
      ? error.message
      : "maintenance_failed",
  );
  process.exitCode = 1;
});
