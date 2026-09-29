import { Client } from "pg";

/** One lazy connection per request/job; Hyperdrive owns the Worker-side pool. */
export function database(connectionString: string) {
  let client: Client | undefined;
  let connected: Promise<Client> | undefined;
  return {
    async query(text: string, args: unknown[] = []) {
      client ??= new Client({
        connectionString,
        connectionTimeoutMillis: 10_000,
      });
      connected ??= client.connect();
      await connected;
      return client.query(text, args);
    },
    async close() {
      if (connected) await client?.end();
    },
  };
}

export type DatabaseEnv = { DB: ReturnType<typeof database> };

/** SQL text is developer-owned; values always travel as separate parameters. */
export function sql(env: DatabaseEnv, text: string, ...args: unknown[]) {
  const run = () => env.DB.query(text, args);
  return {
    run,
    async all<T>() {
      return { results: (await run()).rows as T[] };
    },
    async first<T = Record<string, unknown>>() {
      return ((await run()).rows[0] as T | undefined) ?? null;
    },
  };
}

/** Serialize projection writers before taking source/job locks, never during AI. */
export async function transaction<T>(env: DatabaseEnv, work: () => Promise<T>) {
  await env.DB.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await env.DB.query(
      "SELECT pg_advisory_xact_lock(hashtext('emoji_catalog_write'))",
    );
    const result = await work();
    await env.DB.query("COMMIT");
    return result;
  } catch (error) {
    await env.DB.query("ROLLBACK");
    throw error;
  }
}

export async function batch(
  env: DatabaseEnv,
  statements: ReturnType<typeof sql>[],
) {
  return transaction(env, async () => {
    const results = [];
    for (const statement of statements)
      results.push({ results: (await statement.run()).rows });
    return results;
  });
}
