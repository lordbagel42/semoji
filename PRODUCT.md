# semoji

## Platform
Web dashboard and agent API; portable Node indexing daemon.

## Users and purpose
Raygen monitors indexing; June, other agents and the public find appropriate
Hack Club Slack emoji by appearance, emotion, action and meaning.

## Approved constraints
Cloudflare Worker deployment at emojis.raygen.dev. Codex describes emoji on
LEGION initially, moving to the homelab later. Target up to 1,000 simultaneous
descriptions with a measured safe ramp. Query AI has a 150 ms wait budget plus
database/network time; there is no promised response latency. Public search and
API docs need no token; indexing status and writes require authentication. Aliases,
animations and uncertain interpretations must be handled explicitly.

## Public API and docs
Stock, self-hosted Swagger UI at `/` and `/docs`; dashboard at `/dashboard`.
`/v1/emoji` returns one Slack name without colons, using one database lookup and
no AI for exact names/shortcodes. `/v1/search` returns ranked results with nullable
semantic confidence, not a calibrated probability. RRF score determines ordering.
The anonymous `/api/search` endpoint preserves June compatibility. Public search
has CORS `*` and a best-effort 60 requests/minute/IP/location limit, not a global
budget guarantee. Semantic search can degrade to keyword search, including when
the vector index is empty; available semantics do not prove a complete backlog.
The existing Worker/domain and Neon production storage remain unchanged.

## Dashboard scope
Show actual progress, rate, resource pressure, failures and recent descriptions.
No invented statistics. Local preview is read-only. Plain static HTML/CSS/JS is
an implementation choice to share the surface between Node and Workers.
