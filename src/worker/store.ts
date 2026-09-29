import { type DatabaseEnv, sql } from "../database.js";

export async function embed(env: Pick<Env, "AI">, texts: string[]) {
  const response = await env.AI.run("@cf/baai/bge-small-en-v1.5", {
    text: texts,
  });
  if (
    !("data" in response) ||
    !response.data ||
    response.data.length !== texts.length ||
    response.data.some(
      (v) => v.length !== 384 || v.some((n) => !Number.isFinite(n)),
    )
  )
    throw new Error("embedding_unavailable");
  return response.data;
}

export async function drainEmbeddings(env: Pick<Env, "AI"> & DatabaseEnv) {
  // Small batches keep JSON/vector processing within Workers Free's CPU budget.
  const rows = (
    await sql(
      env,
      `SELECT o.id,d.embedding_text FROM embedding_outbox o JOIN documents d ON d.vector_id=o.id ORDER BY o.id LIMIT 8`,
    ).all<{ id: string; embedding_text: string }>()
  ).results;
  if (!rows.length) return 0;
  const vectors = await embed(
    env,
    rows.map((r) => r.embedding_text),
  );
  // One atomic write; keep current document keys locked until acknowledgement.
  await sql(
    env,
    `WITH saved AS (
    INSERT INTO embeddings(id,embedding)
    SELECT d.vector_id,v.embedding::text::halfvec
    FROM jsonb_to_recordset($1::jsonb) AS v(id text,embedding jsonb)
    JOIN search_documents d ON d.vector_id=v.id FOR KEY SHARE OF d
    ON CONFLICT(id) DO UPDATE SET embedding=excluded.embedding RETURNING id
  ) DELETE FROM embedding_outbox WHERE id IN (SELECT id FROM saved)`,
    JSON.stringify(rows.map((r, i) => ({ id: r.id, embedding: vectors[i] }))),
  ).run();
  return rows.length;
}
