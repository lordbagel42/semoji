import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type EmojiResult,
  type EmojiSource,
  ftsQuery,
  type IndexStatus,
  resultSchema,
  type SearchHit,
  searchText,
  sourceSchema,
} from "../shared.js";

interface Row {
  name: string;
  source: string;
  revision: string;
  canonical: string | null;
  state: string;
  result: string | null;
  error: string | null;
  updated: number;
}

/** Single-writer transactions and revision checks prevent duplicate/stale commits. */
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "index.sqlite"));
    chmodSync(join(directory, "index.sqlite"), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS emoji (
        name TEXT PRIMARY KEY, source TEXT NOT NULL, revision TEXT NOT NULL,
        canonical TEXT, state TEXT NOT NULL, result TEXT, error TEXT,
        updated INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS emoji_state ON emoji(active,state);
      CREATE INDEX IF NOT EXISTS emoji_canonical ON emoji(canonical);
      CREATE TABLE IF NOT EXISTS analyses (key TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS emoji_fts USING fts5(name UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS runtime (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, heartbeat INTEGER, status TEXT);
      INSERT OR IGNORE INTO runtime(id) VALUES(1);`);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  sync(sources: EmojiSource[]) {
    this.transaction(() => {
      this.db.exec("UPDATE emoji SET active=0");
      const write =
        this.db.prepare(`INSERT INTO emoji(name,source,revision,canonical,state,updated,active)
        VALUES(?,?,?,?,?,?,1) ON CONFLICT(name) DO UPDATE SET source=excluded.source,
        canonical=excluded.canonical, revision=excluded.revision, active=1,
        state=CASE WHEN emoji.revision=excluded.revision THEN emoji.state ELSE excluded.state END,
        result=CASE WHEN emoji.revision=excluded.revision THEN emoji.result ELSE NULL END,
        error=CASE WHEN emoji.revision=excluded.revision THEN emoji.error ELSE NULL END,
        updated=CASE WHEN emoji.revision=excluded.revision THEN emoji.updated ELSE excluded.updated END`);
      for (const input of sources) {
        const source = sourceSchema.parse(input);
        write.run(
          source.name,
          JSON.stringify(source),
          source.revision,
          source.canonicalName,
          source.aliasOf ? "alias" : "pending",
          Date.now(),
        );
      }
      this.rebuildSearch();
    });
  }
  private rebuildSearch() {
    this.db.exec("DELETE FROM emoji_fts");
    const insert = this.db.prepare(
      "INSERT INTO emoji_fts(rowid,name,text) VALUES(?,?,?)",
    );
    const rows = this.db
      .prepare(`SELECT e.rowid AS id,e.name,c.result FROM emoji e JOIN emoji c ON c.name=e.canonical
      WHERE e.active=1 AND c.active=1 AND c.state='completed'`)
      .all() as unknown as Array<{ id: number; name: string; result: string }>;
    for (const row of rows)
      insert.run(
        row.id,
        row.name,
        searchText(
          row.name,
          resultSchema.parse(JSON.parse(row.result)).analysis,
        ),
      );
  }
  own(): string {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT owner,heartbeat FROM runtime WHERE id=1")
        .get() as { owner: string | null; heartbeat: number | null };
      if (row.owner && (row.heartbeat ?? 0) > Date.now() - 60_000)
        throw new Error("indexer_already_running");
      // A crashed submitted job may have incurred inference. Never silently replay it.
      this.db.exec(
        "UPDATE emoji SET state='unknown',error='interrupted_run' WHERE state='running'",
      );
      const owner = randomUUID();
      this.db
        .prepare("UPDATE runtime SET owner=?,heartbeat=? WHERE id=1")
        .run(owner, Date.now());
      return owner;
    });
  }
  private assertOwner(owner: string) {
    const row = this.db.prepare("SELECT owner FROM runtime WHERE id=1").get();
    if (row?.owner !== owner) throw new Error("indexer_ownership_lost");
  }
  heartbeat(
    owner: string,
    status: Omit<IndexStatus, "counts" | "recent" | "updatedAt" | "mode">,
  ) {
    this.assertOwner(owner);
    this.db
      .prepare("UPDATE runtime SET heartbeat=?,status=? WHERE id=1 AND owner=?")
      .run(Date.now(), JSON.stringify(status), owner);
  }
  release(owner: string) {
    this.db
      .prepare("UPDATE runtime SET owner=NULL WHERE id=1 AND owner=?")
      .run(owner);
  }
  claim(owner: string): EmojiSource | undefined {
    return this.transaction(() => {
      this.assertOwner(owner);
      const row = this.db
        .prepare(
          "SELECT source FROM emoji WHERE active=1 AND state='pending' ORDER BY name LIMIT 1",
        )
        .get();
      if (!row) return;
      const source = sourceSchema.parse(JSON.parse(String(row.source)));
      this.db
        .prepare(
          "UPDATE emoji SET state='running',updated=?,error=NULL WHERE name=? AND revision=?",
        )
        .run(Date.now(), source.name, source.revision);
      return source;
    });
  }
  fail(owner: string, source: EmojiSource, code: string, uncertain: boolean) {
    this.assertOwner(owner);
    this.db
      .prepare(
        "UPDATE emoji SET state=?,error=?,updated=? WHERE name=? AND revision=? AND state='running'",
      )
      .run(
        uncertain ? "unknown" : "failed",
        code,
        Date.now(),
        source.name,
        source.revision,
      );
  }
  cached(key: string): EmojiResult | undefined {
    const row = this.db
      .prepare("SELECT result FROM analyses WHERE key=?")
      .get(key);
    return row ? resultSchema.parse(JSON.parse(String(row.result))) : undefined;
  }
  complete(owner: string, input: EmojiResult, cacheKey: string): boolean {
    const result = resultSchema.parse(input);
    return this.transaction(() => {
      this.assertOwner(owner);
      // Paid output survives a source revision change, but cannot publish stale search data.
      this.db
        .prepare("INSERT OR REPLACE INTO analyses(key,result) VALUES(?,?)")
        .run(cacheKey, JSON.stringify(result));
      const updated = this.db
        .prepare(
          "UPDATE emoji SET result=?,state='completed',error=NULL,updated=? WHERE name=? AND revision=? AND active=1 AND state='running'",
        )
        .run(
          JSON.stringify(result),
          Date.now(),
          result.source.name,
          result.source.revision,
        );
      if (!updated.changes) return false;
      const aliases = this.db
        .prepare(
          "SELECT rowid AS id,name FROM emoji WHERE canonical=? AND active=1",
        )
        .all(result.source.name);
      for (const alias of aliases) {
        this.db
          .prepare("DELETE FROM emoji_fts WHERE rowid=?")
          .run(Number(alias.id));
        this.db
          .prepare("INSERT INTO emoji_fts(rowid,name,text) VALUES(?,?,?)")
          .run(
            Number(alias.id),
            String(alias.name),
            searchText(String(alias.name), result.analysis),
          );
      }
      return true;
    });
  }
  retry(includeUnknown: boolean) {
    const row = this.db
      .prepare("SELECT owner,heartbeat FROM runtime WHERE id=1")
      .get();
    if (row?.owner && Number(row.heartbeat) > Date.now() - 60_000)
      throw new Error("stop_indexer_before_retry");
    return this.db
      .prepare(
        `UPDATE emoji SET state='pending',error=NULL WHERE active=1 AND state IN (${includeUnknown ? "'failed','unknown'" : "'failed'"})`,
      )
      .run().changes;
  }
  sources(): EmojiSource[] {
    return this.db
      .prepare("SELECT source FROM emoji WHERE active=1 ORDER BY name")
      .all()
      .map((row) => sourceSchema.parse(JSON.parse(String(row.source))));
  }
  *results(): Generator<EmojiResult> {
    for (const row of this.db
      .prepare(
        "SELECT result FROM emoji WHERE active=1 AND state='completed' ORDER BY name",
      )
      .iterate())
      yield resultSchema.parse(JSON.parse(String(row.result)));
  }
  status(): IndexStatus {
    const counts: IndexStatus["counts"] = {
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
      unknown: 0,
      aliases: 0,
    };
    for (const row of this.db
      .prepare(
        "SELECT state,count(*) n FROM emoji WHERE active=1 GROUP BY state",
      )
      .all()) {
      counts.total += Number(row.n);
      const key = row.state === "alias" ? "aliases" : row.state;
      if (typeof key === "string" && key in counts)
        counts[key as keyof typeof counts] = Number(row.n);
    }
    const runtime = this.db
      .prepare("SELECT owner,heartbeat,status FROM runtime WHERE id=1")
      .get();
    const alive =
      !!runtime?.owner && Number(runtime.heartbeat) > Date.now() - 60_000;
    const meta = runtime?.status ? JSON.parse(String(runtime.status)) : {};
    const recent = this.db
      .prepare(
        "SELECT * FROM emoji WHERE active=1 ORDER BY updated DESC LIMIT 24",
      )
      .all() as unknown as Row[];
    return {
      mode: "local",
      state: alive
        ? meta.state
        : counts.unknown || counts.failed || counts.running
          ? "blocked"
          : "idle",
      updatedAt: new Date(
        Number(runtime?.heartbeat) || Date.now(),
      ).toISOString(),
      counts,
      concurrency: alive ? (meta.concurrency ?? 0) : 0,
      targetConcurrency: meta.targetConcurrency ?? 1000,
      completedPerMinute: alive ? (meta.completedPerMinute ?? 0) : 0,
      availableMemoryMb: alive ? (meta.availableMemoryMb ?? null) : null,
      reason: alive
        ? (meta.reason ?? null)
        : (counts.unknown || counts.failed || counts.running) &&
            meta.state === "blocked" &&
            typeof meta.reason === "string"
          ? meta.reason
          : counts.unknown || counts.running
            ? "Interrupted attempts need review before retrying. Pending work can resume separately."
            : counts.failed
              ? "Failed attempts need review before retrying. Pending work can resume separately."
              : null,
      recent: recent.map((row) => ({
        name: row.name,
        state: row.state,
        summary: row.result
          ? resultSchema.parse(JSON.parse(row.result)).analysis.summary
          : null,
        imageUrl: sourceSchema.parse(JSON.parse(row.source)).imageUrl,
        error: row.error,
      })),
    };
  }
  search(query: string, limit = 20): SearchHit[] {
    const match = ftsQuery(query);
    if (!match) return [];
    const rows = this.db
      .prepare(`SELECT e.source,c.result,bm25(emoji_fts) rank FROM emoji_fts
      JOIN emoji e ON e.name=emoji_fts.name JOIN emoji c ON c.name=e.canonical
      WHERE emoji_fts MATCH ? AND e.active=1 AND c.active=1 AND c.state='completed'
      ORDER BY (e.name=?) DESC,rank LIMIT ?`)
      .all(match, query.replaceAll(":", ""), limit);
    return rows.map((row) => {
      const source = sourceSchema.parse(JSON.parse(String(row.source)));
      const result = resultSchema.parse(JSON.parse(String(row.result)));
      return {
        name: source.name,
        shortcode: `:${source.name}:`,
        canonicalName: source.canonicalName,
        imageUrl: source.imageUrl,
        summary: result.analysis.summary,
        description: result.analysis.description,
        score: -Number(row.rank),
        match: source.name === query.replaceAll(":", "") ? "exact" : "keyword",
      };
    });
  }
  close() {
    this.db.close();
  }
}
