# semoji

Public, read-only search for Hack Club Slack emoji. No API key required.

```sh
# One Slack emoji name, as plain text without colons (for example: party-parrot)
curl --get 'https://emojis.raygen.dev/v1/emoji' \
  --data-urlencode 'q=party-parrot'

# Ranked results with descriptions and match information
curl --get 'https://emojis.raygen.dev/v1/search' \
  --data-urlencode 'q=cat waving' --data 'limit=12' --data 'mode=hybrid'

# Keyword-only search, without AI
curl --get 'https://emojis.raygen.dev/v1/search' \
  --data-urlencode 'q=celebration' --data 'mode=keyword'
```

**[Search](https://emojis.raygen.dev)** ·
[API docs / Scalar](https://emojis.raygen.dev/docs) ·
[OpenAPI JSON](https://emojis.raygen.dev/openapi.json) ·
[Source](https://github.com/lordbagel42/semoji)

Extracted from
[`lordbagel42/agent` at `77f9c7ad`, `tools/emojis`](https://github.com/lordbagel42/agent/tree/77f9c7ad/tools/emojis).
Existing copyright notices and [LICENSE](LICENSE) are preserved.

## API contract

- `q` is trimmed, then validated as 1–300 characters.
- `GET /v1/emoji` returns one name without colons. In hybrid/keyword mode, exact names/shortcodes use
  one database lookup without AI; otherwise keyword/semantic ranking selects
  a result. No match returns HTTP 404 with `{"error":"no_match"}`.
- `GET /v1/search` accepts `limit=1–50` (default 12) and `mode=hybrid|keyword|semantic`
  (default hybrid). The JSON envelope contains `results`, `mode`, `durationMs`,
  `semanticAvailable`, and optionally `degraded:"semantic_unavailable"`.
  Results contain `id`, `name`, `shortcode`, nullable `canonicalName` and
  `imageUrl`, `summary`, `description`, `score`, `match` (exact/keyword/semantic),
  and nullable `confidence`. No matches produces an empty results array.
- Confidence is 1 for an exact ID, otherwise cosine similarity clamped to 0–1
  when the candidate has a semantic match, or null for keyword-only candidates.
  **It is not a calibrated probability.** Ordering uses reciprocal-rank fusion
  (RRF) score, not confidence.
- Explicit `mode=semantic` uses vector similarity only, without an exact-name
  boost or keyword fallback. It returns 503 `semantic_unavailable` when query
  embeddings or the vector index are unavailable. Keyword mode never calls AI.
- Hybrid AI has a 150 ms wait budget; semantic-only allows 1.5 seconds, plus database/network time. There is no
  promised response latency. An empty vector index is unavailable; a partial
  embedding backlog can remain even when semantic search is available.
- Public search responses include `Access-Control-Allow-Origin: *`. Errors:
  400 `invalid_request`, 429 `rate_limited` with `Retry-After: 60`, and 503
  `service_unavailable`. Wrong methods return 405.
- Rate limiting is best-effort: 60 requests/minute/IP **per Cloudflare
  location**, not a globally coordinated budget guarantee.

The anonymous `GET /api/search` compatibility endpoint remains for June and
the search page. It has the same envelope, without `id` or `confidence` on result
items. New clients should use `/v1/search`. See
[June integration](https://github.com/lordbagel42/agent/blob/main/docs/emoji-search.md)
for the original agent client.

## Develop

Run from this repository's root using Node 24 and pnpm 10.33.0:

```sh
SHARP_IGNORE_GLOBAL_LIBVIPS=1 pnpm install --frozen-lockfile
pnpm build:docs
pnpm format && pnpm lint && pnpm typecheck && pnpm test
```

`build:docs` copies the pinned `@scalar/api-reference@1.72.2` browser bundle and
license into ignored `public/vendor/`. Scalar is dark-only, self-hosted, and uses
the same-origin OpenAPI document. External fonts, Agent, telemetry, credential
persistence and developer tools are disabled; requests do not use a proxy.
Wrangler runs this build automatically.

`/` is a dark-only search page: one input, Keyword / Semantic radio controls and
up to ten results. `/dashboard` is a compatibility alias for that page. There
are no status polls, login forms or maintenance controls; indexing status remains
available through the protected API. `/docs` serves Scalar.

## Operations

Cloudflare Worker `raygen-emojis` continues serving `emojis.raygen.dev`, backed
by the existing Neon production project `rapid-bird-71853459`. This extraction
does not require a new database or service. GitHub Actions in this repository
maintains the catalogue and requests bounded embeddings; it does not run Codex
image descriptions. Status and all writes remain protected and are not in the
public OpenAPI document.

- [Worker, credentials, maintenance and operational safety](WORKER.md)
- [Original local indexer runbook](https://github.com/lordbagel42/agent/blob/77f9c7ad/tools/emojis/README.md#index-on-legion-or-the-homelab)
  — run those commands from this repository root, not `tools/emojis`.
- [Product constraints](PRODUCT.md) and [dashboard design](DESIGN.md)

The optional local indexer serves the same search page at `/` on
loopback, with local keyword search and no bearer token. Semantic mode reports
unavailability locally; status remains at `/api/status`. Expose it remotely only
through an authenticated preview. Indexing needs a dedicated private Codex home
and explicit operator authorization; uncertain or failed inference is not
automatically retried. See the linked runbook before running or migrating it.

The maintenance workflow retains its existing enablement gate, secrets, schedule
and concurrency group. Enable it in `lordbagel42/semoji` only as an authorized
cutover; the old agent workflow must stay disabled until removed. Source changes
alone do not deploy the Worker, enable Actions or prove live semantic quality.
