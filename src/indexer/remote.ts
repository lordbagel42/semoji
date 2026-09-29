import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { boundedJson } from "../http.js";
import {
  type EmojiResult,
  leaseSchema,
  PROMPT_VERSION,
  resultSchema,
  SCHEMA_VERSION,
} from "../shared.js";
import { createCodexDescriber } from "./codex.js";
import { ModelError } from "./codex-policy.js";
import { MediaError, prepareMedia } from "./media.js";
import type { Store } from "./store.js";

export class RemoteError extends Error {
  constructor(readonly status: number) {
    super(`remote_http_${status}`);
  }
}

/** Fixed HTTPS origin; never send credentials to a redirect or accept response text as errors. */
export function remoteClient(service: string, token: string) {
  const base = new URL(service);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("https_service_origin_required");
  if (token.length < 32 || token.length > 512)
    throw new Error("remote_token_required");
  return {
    origin: base.origin,
    async post(
      path: string,
      body: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> {
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded) > 512 * 1024)
        throw new Error("upload_too_large");
      const response = await fetch(new URL(path, base), {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: encoded,
        signal: AbortSignal.any([
          AbortSignal.timeout(15_000),
          ...(signal ? [signal] : []),
        ]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RemoteError(response.status);
      }
      return boundedJson(response, 128 * 1024);
    },
  };
}
type Client = ReturnType<typeof remoteClient>;

export async function upload(store: Store, client: Client) {
  // Each request is an idempotent administrative upsert. Rerun upload after interruption.
  for (
    let offset = 0, sources = store.sources();
    offset < sources.length;
    offset += 20
  )
    await client.post("/api/import", {
      sources: sources.slice(offset, offset + 20),
      results: [],
    });
  for (const result of store.results())
    await client.post("/api/import", { sources: [], results: [result] });
}

export function prepareReceipts(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS remote_receipts (
    id TEXT PRIMARY KEY, origin TEXT NOT NULL, state TEXT NOT NULL,
    lease TEXT NOT NULL, result TEXT, code TEXT, uncertain INTEGER NOT NULL DEFAULT 0);
    UPDATE remote_receipts SET state='failed',code='interrupted_inference',uncertain=1 WHERE state='submitted';`);
}

/** Delivery retries never invoke inference. Stale results remain locally recoverable. */
export async function deliverReceipts(
  store: Store,
  client: Client,
  signal?: AbortSignal,
) {
  const rows = store.db
    .prepare(
      "SELECT * FROM remote_receipts WHERE origin=? AND state IN ('result','failed')",
    )
    .all(client.origin);
  for (const row of rows) {
    try {
      if (row.state === "result")
        await client.post(
          "/api/jobs/complete",
          {
            leaseId: row.id,
            result: resultSchema.parse(JSON.parse(String(row.result))),
          },
          signal,
        );
      else
        await client.post(
          "/api/jobs/fail",
          {
            leaseId: row.id,
            code: row.code,
            uncertain: Boolean(row.uncertain),
          },
          signal,
        );
      store.db
        .prepare("UPDATE remote_receipts SET state='acknowledged' WHERE id=?")
        .run(String(row.id));
    } catch (error) {
      if (!(error instanceof RemoteError) || error.status !== 409) throw error;
      store.db
        .prepare("UPDATE remote_receipts SET state='stale' WHERE id=?")
        .run(String(row.id));
    }
  }
}

/** Outbound-only single-slot listener, portable between LEGION and homelab. */
export async function connect(
  store: Store,
  client: Client,
  options: { home: string; model: string; signal: AbortSignal },
) {
  const owner = store.own();
  let provider: Awaited<ReturnType<typeof createCodexDescriber>> | undefined;
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  const timer = setInterval(() => {
    try {
      store.heartbeat(owner, {
        state: "running",
        concurrency: 1,
        targetConcurrency: 1,
        completedPerMinute: 0,
        availableMemoryMb: null,
        reason:
          "Connected to the cloud queue; see the cloud dashboard for progress.",
      });
    } catch {
      stop.abort();
    }
  }, 5000);
  try {
    prepareReceipts(store);
    while (!signal.aborted) {
      // A failed delivery blocks new admission; only the persisted payload is retried.
      try {
        await deliverReceipts(store, client, signal);
      } catch (error) {
        if (error instanceof RemoteError && error.status < 500) throw error;
        await sleep(2000, undefined, { signal }).catch(() => {});
        continue;
      }
      let claimed: unknown;
      try {
        claimed = await client.post("/api/jobs/claim", {}, signal);
      } catch (error) {
        if (error instanceof RemoteError && error.status < 500) throw error;
        // A lost claim response is NOT reclaimed: its server lease will become unknown.
        await sleep(2000, undefined, { signal }).catch(() => {});
        continue;
      }
      const { lease } = z
        .object({ lease: leaseSchema.nullable() })
        .strict()
        .parse(claimed);
      if (!lease) {
        await sleep(2000, undefined, { signal }).catch(() => {});
        continue;
      }
      store.db
        .prepare(
          "INSERT INTO remote_receipts(id,origin,state,lease) VALUES(?,?,'submitted',?)",
        )
        .run(lease.id, client.origin, JSON.stringify(lease));
      const cancelled = new AbortController();
      const jobSignal = AbortSignal.any([signal, cancelled.signal]);
      let expiresAt = lease.expiresAt;
      let beating = false;
      const heartbeat = setInterval(() => {
        if (expiresAt <= Date.now() + 20_000) cancelled.abort();
        if (beating || jobSignal.aborted) return;
        beating = true;
        void client
          .post("/api/jobs/heartbeat", { leaseId: lease.id }, jobSignal)
          .then((response) => {
            expiresAt = z
              .object({ expiresAt: z.number().int().positive() })
              .parse(response).expiresAt;
          })
          .catch((error) => {
            if (error instanceof RemoteError && error.status < 500)
              cancelled.abort();
          })
          .finally(() => {
            beating = false;
          });
      }, 10_000);
      let failure: string | undefined;
      let submitted = false;
      try {
        if (expiresAt <= Date.now() + 20_000) throw new Error("stale_lease");
        const input = await prepareMedia(
          lease.source,
          join(store.directory, "media"),
          jobSignal,
        );
        provider ??= await createCodexDescriber({
          home: options.home,
          model: options.model,
          capacity: 1,
          timeoutMs: 180_000,
        });
        const started = Date.now();
        submitted = true;
        const analysis = await provider.describe(
          lease.source,
          input.media,
          input.imagePaths,
          jobSignal,
        );
        const result: EmojiResult = resultSchema.parse({
          schemaVersion: SCHEMA_VERSION,
          source: lease.source,
          media: input.media,
          analysis,
          provenance: {
            provider: "codex",
            model: options.model,
            promptVersion: PROMPT_VERSION,
            indexedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
          },
        });
        // Commit durable output before making any network request with it.
        store.db
          .prepare(
            "UPDATE remote_receipts SET state='result',result=? WHERE id=?",
          )
          .run(JSON.stringify(result), lease.id);
        failure = provider.failure;
      } catch (error) {
        const code =
          error instanceof ModelError || error instanceof MediaError
            ? error.code
            : "indexing_failed";
        store.db
          .prepare(
            "UPDATE remote_receipts SET state='failed',code=?,uncertain=? WHERE id=?",
          )
          .run(
            code,
            Number(error instanceof ModelError ? error.uncertain : submitted),
            lease.id,
          );
        if (!(error instanceof MediaError)) failure = code;
      } finally {
        clearInterval(heartbeat);
        cancelled.abort();
      }
      // On error, report once then stop admission. If delivery fails it stays durable for restart.
      if (failure) {
        await deliverReceipts(store, client).catch(() => {});
        throw new Error(failure);
      }
    }
  } finally {
    clearInterval(timer);
    await provider?.close();
    store.release(owner);
  }
}
