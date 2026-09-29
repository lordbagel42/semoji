import { batch, type DatabaseEnv, sql, transaction } from "./database.js";
import { slackCatalog } from "./http.js";
import {
  catalogSources,
  type EmojiResult,
  type EmojiSource,
  SCHEMA_VERSION,
  sha256,
} from "./shared.js";

export const LEASE_MS = 5 * 60_000;

export async function validateSource(source: EmojiSource) {
  if (
    source.revision !==
    (await sha256(
      JSON.stringify([
        SCHEMA_VERSION,
        source.name,
        source.source,
        source.canonicalName,
        source.imageUrl,
      ]),
    ))
  )
    throw new Error("invalid_source");
  if (
    source.aliasOf !==
    (source.source.startsWith("alias:") ? source.source.slice(6) : null)
  )
    throw new Error("invalid_source");
  if (
    !source.aliasOf &&
    (source.canonicalName !== source.name || source.imageUrl !== source.source)
  )
    throw new Error("invalid_source");
  if (source.imageUrl && new URL(source.imageUrl).protocol !== "https:")
    throw new Error("invalid_source");
}

export function sourceStatement(env: DatabaseEnv, s: EmojiSource) {
  return sql(
    env,
    `INSERT INTO sources(name,revision,canonical_name,image_url,source_json) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,canonical_name=excluded.canonical_name,image_url=excluded.image_url,source_json=excluded.source_json WHERE sources.revision<>excluded.revision`,
    s.name,
    s.revision,
    s.canonicalName,
    s.imageUrl,
    JSON.stringify(s),
  );
}

export async function resultStatement(
  env: DatabaseEnv,
  result: EmojiResult,
  leaseId: string | null = null,
) {
  const digest = await sha256(JSON.stringify(result));
  return {
    digest,
    statement: sql(
      env,
      `INSERT INTO analyses(name,revision,digest,result_json)
     SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM sources WHERE name=$1 AND revision=$2 AND canonical_name=name)
     AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM jobs WHERE lease_id=$5 AND name=$1 AND revision=$2 AND state='completed' AND digest=$3))
     ON CONFLICT(name,revision) DO UPDATE SET digest=excluded.digest,result_json=excluded.result_json WHERE analyses.digest<>excluded.digest`,
      result.source.name,
      result.source.revision,
      digest,
      JSON.stringify(result),
      leaseId,
    ),
  };
}

export async function expire(env: DatabaseEnv) {
  await sql(
    env,
    "UPDATE jobs SET state='unknown',error='lease_expired',updated_at=$1 WHERE state='running' AND expires_at<=$1",
    Date.now(),
  ).run();
}
export async function markDirty(env: DatabaseEnv) {
  await sql(env, "UPDATE sync_state SET dirty=dirty+1 WHERE id=1").run();
}

/** Maintenance/import use a direct session, never a transaction-pooled URL. */
export async function withCatalogLock<T>(
  env: DatabaseEnv,
  work: () => Promise<T>,
) {
  const lock = await sql(
    env,
    "SELECT pg_try_advisory_lock(hashtext('emoji_catalog')) AS locked",
  ).first<{ locked: boolean }>();
  if (!lock?.locked) throw new Error("catalog_busy");
  try {
    return await work();
  } finally {
    await sql(
      env,
      "SELECT pg_advisory_unlock(hashtext('emoji_catalog'))",
    ).run();
  }
}

export async function writeSources(env: DatabaseEnv, sources: EmojiSource[]) {
  await sql(
    env,
    `INSERT INTO sources(name,revision,canonical_name,image_url,source_json)
    SELECT s->>'name',s->>'revision',s->>'canonicalName',s->>'imageUrl',s::text
    FROM jsonb_array_elements($1::jsonb) s
    ON CONFLICT(name) DO UPDATE SET revision=excluded.revision,canonical_name=excluded.canonical_name,image_url=excluded.image_url,source_json=excluded.source_json WHERE sources.revision<>excluded.revision`,
    JSON.stringify(sources),
  ).run();
}

/** GitHub Actions does the full catalogue work; Workers only mark it dirty. */
export async function reconcile(
  env: DatabaseEnv & { SLACK_BOT_TOKEN: string },
) {
  return withCatalogLock(env, async () => {
    const state = await sql(
      env,
      "SELECT dirty,last_sync FROM sync_state WHERE id=1",
    ).first<{ dirty: number; last_sync: string }>();
    if (
      !state ||
      (!state.dirty && Number(state.last_sync) > Date.now() - 60 * 60_000)
    )
      return { synced: false };
    const sources = await catalogSources(
      await slackCatalog(env.SLACK_BOT_TOKEN),
    );
    if (!sources.length) throw new Error("empty_catalog_rejected");
    await Promise.all(sources.map(validateSource));
    for (let i = 0; i < sources.length; i += 500)
      await transaction(env, () =>
        writeSources(env, sources.slice(i, i + 500)),
      );
    await batch(env, [
      sql(
        env,
        "DELETE FROM sources WHERE NOT (name=ANY($1::text[]))",
        sources.map((s) => s.name),
      ),
      sql(
        env,
        "UPDATE sync_state SET dirty=greatest(0,dirty-$1),last_sync=$2 WHERE id=1",
        state.dirty,
        Date.now(),
      ),
    ]);
    return { synced: true, sources: sources.length };
  });
}
