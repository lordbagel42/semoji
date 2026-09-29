# semoji operations

Cloudflare Workers serve the dashboard/API and run Workers AI embeddings. Neon
Postgres holds the catalogue, analyses, job leases, full-text index, pgvector
index, and durable embedding outbox. GitHub Actions owns scheduled maintenance;
neither search nor catalogue reconciliation requires LEGION or June's process.
There is no Worker cron or Workers Paid CPU setting.

The standalone repository is `lordbagel42/semoji`; run commands from its root.
Production remains Worker `raygen-emojis` at `emojis.raygen.dev`, backed by the
existing Neon project `rapid-bird-71853459`. Do not provision a replacement
database or rerun the initial migration as part of the repository extraction.
For local image-description operations, use the
[original indexer runbook](https://github.com/lordbagel42/agent/blob/77f9c7ad/tools/emojis/README.md#index-on-legion-or-the-homelab),
substituting this repository root for `tools/emojis`.

## Credentials and API

Search, API docs and the static dashboard shell are public. Read, indexer and admin tokens
must be distinct random **32–512 character** values. Store them as secrets, never
in URLs, model arguments, logs or Git. The dashboard keeps its read token only
in memory for indexing status, never sends it on search requests, and can search
without signing in. June's compatibility search no longer requires a read token.

`/` and `/docs` serve stock Swagger UI; `/dashboard` serves the index dashboard.
Run `pnpm build:docs` through Wrangler's build command before serving/deploying:
it copies pinned Swagger UI 5.33.0 assets and license notices to ignored
`public/vendor/`. The external `/docs-init.js` initializer avoids inline scripts;
there is no CDN, online validator, persisted authorization or query-string config.
Only public GET operations appear in `/openapi.json` or Swagger Try it out.

For protected APIs, send JSON for POST bodies and `Authorization: Bearer <role token>`. API responses
are `no-store`. Wrong role: 401; invalid input: 400; obsolete lease: 409; storage
or provider error: generic 503. Provider errors and credentials are never returned.

| Endpoint | Role | Request / response |
| --- | --- | --- |
| `GET /v1/emoji?q=...` | public | One plain-text name without colons; 404 `no_match` if absent |
| `GET /v1/search?q=...&limit=12&mode=hybrid` | public | Versioned ranked results; see [OpenAPI](public/openapi.json) |
| `GET /api/status` | read or admin | `IndexStatus` from `src/shared.ts` |
| `GET /api/search?q=...&limit=12&mode=hybrid` | public | Compatibility `{results,mode,durationMs,semanticAvailable,degraded?}`; omits result `id`/`confidence` |
| `POST /api/jobs/claim` | indexer | `{}` → `{lease: EmojiLease \| null}` |
| `POST /api/jobs/heartbeat` | indexer | `{leaseId}` → `{expiresAt}` |
| `POST /api/jobs/complete` | indexer | `{leaseId,result}` → `{ok:true}` |
| `POST /api/jobs/fail` | indexer | `{leaseId,code,uncertain}` → `{ok:true}` |
| `POST /api/import` | admin | `{sources,results}` → `{ok:true,sources,results}` |
| `POST /api/reindex` | admin | `{name}` → `{ok:true}`; alias resolves to canonical job |
| `POST /api/sync` | admin | `{}` → 202; marks dirty for the next Actions run |
| `POST /api/embeddings` | admin | `{}` → `{processed}`; at most eight documents |
| `POST /slack/events` | Slack signature | signed challenge or workspace-scoped event |

JSON bodies are capped at 512 KiB. API imports accept at most 50 sources and 20
canonical results. They are administrative overwrites, not authoritative deletion.
Do not import over concurrent maintenance. The CLI import shares the maintenance
advisory lock and reads the local SQLite catalogue without modifying it.

Public search sends CORS `*`. Errors are 400 `invalid_request`, 429 `rate_limited`
with `Retry-After: 60`, and 503 `service_unavailable`; wrong methods return 405.
The best-effort limit is 60 requests/minute/IP per Cloudflare location, not a
global budget guarantee. Status and write APIs remain authenticated.

Search trims queries and accepts 1–300 characters and 1–50 results (default 12).
`/v1/emoji` resolves exact names/shortcodes in one database lookup without AI.
PostgreSQL prefix full-text
search and pgvector cosine search combine using reciprocal-rank fusion; exact
shortcodes rank first. Query embeddings get a 150 ms wait budget and a one-hour
private hashed-key cache. Slow/unavailable AI yields keyword results with
`semanticAvailable:false` and `degraded:"semantic_unavailable"`. Explicit keyword
mode does not call AI. An empty vector index is unavailable; available semantic
search does not mean the embedding backlog is empty. Database/network time is
additional, with no promised response latency. Versioned results include
confidence: 1 for an exact ID, otherwise clamped cosine similarity 0–1 when a
candidate has a semantic match, or null for keyword-only candidates. Confidence
is not a calibrated probability and does not determine ordering; RRF score does.
Results are revalidated against current revision/digest IDs
after AI returns. No catalogue results are cached; disable Hyperdrive query caching.

## Actions owns maintenance, not image descriptions

`.github/workflows/emoji-maintenance.yml` runs every 15 minutes or by manual
dispatch, serialized by concurrency group. GitHub may delay scheduled runs. It
is guarded to `lordbagel42/semoji` and runs from the repository root. The old
agent repository workflow stays disabled pending removal; do not enable both.
The schedule, concurrency, gate and secret names are unchanged. It requires
repository variable `EMOJI_MAINTENANCE_ENABLED=true` and secrets:

- `EMOJI_DATABASE_URL`: direct, non-pooled Neon URL for the maintenance role.
- `EMOJI_SLACK_BOT_TOKEN`: the existing workspace-authorized catalogue token.
- `EMOJI_ADMIN_TOKEN`: Worker admin token for bounded embedding requests.

Each run expires old leases and reconciles Slack when dirty or an hour since the
last successful reconciliation. It then requests up to 120 embedding batches;
manual dispatch accepts 1–10000 batches for initial backfill, with a 25-minute
job timeout. It never starts or retries Codex image analysis. New images are
searchable by name immediately after reconciliation; rich descriptions require
an explicitly operated indexer. Existing completed descriptions are imported,
not regenerated, and failed/unknown work is not silently retried.

Slack identity is validated before fetching the catalogue, always selecting
workspace `T0266FRGM`. Enterprise tokens must prove that workspace grant. Signed
`emoji_changed` events increment a durable counter before acknowledgment;
retries may harmlessly increment it again. A five-minute signature timestamp
window and raw-body HMAC protect events. Only signed URL verification is exempt
from the workspace check. No Slack app changes are required for hourly polling.

Reconciliation uses a session advisory lock on a direct connection, validates
the entire nonempty catalogue, writes bounded batches, and removes absent names
only after all batches succeed. Events received during the run remain dirty.
Failed/interrupted reconciliation is retried at the next Actions run. Publication
is incremental, not a snapshot swap. Unchanged source rows are not rewritten.
Source/result writers share a short transaction lock acquired before row locks,
so concurrent aliases and completions publish matching projections. Slack and
AI calls never hold this lock. Inspect Actions receipts for maintenance
success, and `/api/status` for job counts; neither proves all embeddings are ready.
No separate notification is sent by this workflow.

## Revision and paid-work safety

Source/result changes transactionally rebuild current search projections and
enqueue embeddings. Vector IDs combine source revision and analysis digest.
Foreign keys cascade deletion through vectors/outbox; stale embedding work
cannot republish removed or changed documents. Model
`@cf/baai/bge-small-en-v1.5` produces 384 dimensions, stored as pgvector `halfvec`
with an HNSW cosine index. Embedding writes and outbox acknowledgment are one
atomic statement. Failures retain the queue; keyword search stays available.

Only canonical images receive jobs. Claims use `FOR UPDATE SKIP LOCKED`; leases
last five minutes. Expired running work becomes **unknown**, never automatically
pending. Failed/unknown inference requires operator reconciliation and explicit
reindex. Stop/reconcile an old indexer before retrying uncertain work.
Persist local output before completion. Replaying the same completed lease and
digest is idempotent; different digests, expired/replaced leases, changed source
revisions and removed names are rejected. Admin reindex fences the previous lease
and authorizes another attempt. Read credentials cannot change any of this.

## Verification and deployment

Use Node 24 through this package's pinned pnpm setup. Supply a **disposable**
direct database URL privately as `EMOJI_TEST_DATABASE_URL`, then run:

```sh
pnpm format && pnpm lint && pnpm typecheck && pnpm test
pnpm build:docs
pnpm exec wrangler types
pnpm exec wrangler deploy --dry-run
```

The boundary test creates/drops a unique schema in that database and exercises
the HTTP handler against real Postgres/pgvector with mocked AI. Without the test
URL, it explicitly skips the database test. It is not a deployed Workers CPU,
Hyperdrive, AI quality, latency or Slack installation check. Ordinary Wrangler
development can call remote AI; do not use it as an offline inference fixture.

The following is the initial database migration runbook, not a requirement for
the standalone repository cutover. Production storage already exists. For an
authorized new database cutover, first migrate/import into a disposable Neon branch
and compare counts/digests and storage size, including embeddings. Maintenance
uses `EMOJI_DATABASE_URL` from a private environment, never a CLI argument:

```sh
pnpm maintenance migrate
pnpm maintenance import --data /absolute/private/catalog
pnpm maintenance sync
```

`migrate` creates the schema once; it deliberately fails on an existing schema.
Import is restartable and preserves completed/failed/unknown states. Use a
restricted runtime database role, provision cache-disabled Hyperdrive against
Neon, and replace the placeholder binding ID before deploying. Keep the old D1,
Vectorize and local SQLite data until the new service is verified. Do not delete
them as part of cutover. Measure the footprint after import and compact the
bootstrap database before embedding backfill if necessary, while it is offline;
do not run blocking full-table compaction as periodic maintenance. The full-size
test used 456 MiB after compaction, including 62,013 synthetic vectors and HNSW,
leaving limited growth room under 512 MiB. Synthetic vectors test storage only
and must never be copied into production. Configure Actions secrets and enable its variable only
after the Worker is ready. Verify anonymous search, protected status/write role rejection,
June's read-only client, and an actual Actions receipt. Monitor Neon storage and
compute quotas; scheduling and connection pooling are not unlimited capacity.

Provisioning, deployment, workflow activation and Slack configuration require
operator authorization. Source publication alone proves none of them. The
standalone `slack-manifest.json` is a template, never a replacement for June's
live manifest. Preserve unrelated settings when changing an authorized app.
