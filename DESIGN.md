# semoji

## Public API documentation

Use stock Swagger UI at `/` and `/docs`, not a custom landing page. Self-host the
pinned 5.33.0 bundle and CSS with license notices via `pnpm build:docs`; only
generated vendor assets are ignored. Use an external initializer and same-origin
OpenAPI JSON, with no CDN, online validator, query-config overrides or persisted
authorization. Try it out permits GET only. Public docs never list protected
status or write operations. The Swagger description links to `/dashboard`.

## Dashboard direction

Operate mode: a compact, light-neutral workbench for monitoring indexing and
finding Slack emoji. The first viewport presents a horizontal count ledger,
resource readings, a search form, and a dense activity table. Emoji artwork is
content, not interface decoration. No hero, metric cards, invented progress
percentages, or write controls.

The monitoring scene is a desktop workspace in ordinary ambient light. A light
surface and restrained moss accent distinguish completed work without turning
the dashboard into an alarm panel. One native sans-serif family serves all roles.

## Tokens and composition

- Typeface: Segoe UI, Helvetica Neue, sans-serif. Body 15px / 1.5; headings
  22px, 18px, 16px; metadata 12–13px. Tabular numerals for reported counts.
- Canvas `#f6f7f5`, surface `#ffffff`, text `#252c27`, muted `#606961`.
- Rule `#d7ddd5`, moss `#3c603c`, error `#963d29`.
- Content width: 1200px plus 24px side gutters; 16px gutters on narrow screens.
- Native inputs and buttons: minimum 44px height, 5px corners. Visible 3px moss
  focus outlines. Selection and caret inherit the palette.
- Ledger: seven desktop columns, four narrow-screen columns. Recent activity
  stays a semantic table with a keyboard-focusable horizontal scroll region.
- Search results: one full-width list, bounded 40px artwork, readable text
  measures, native disclosure for full descriptions. Search details remain open
  across status polls. Only short button-color transitions; no entrance motion.

## Interaction and integration

The Worker serves the existing dashboard at `/dashboard`; the local indexer
continues serving it at `/`. The dashboard itself needs no build step, runtime
framework, remote font or generated image. Its docs link uses the public origin
so it also works on the local indexer. Status is a direct `IndexStatus` response from
`GET /api/status`. Search uses `GET /api/search?q=…&limit=20` and the documented
results/mode/durationMs/semanticAvailable envelope. Search is anonymous and never
sends Authorization. It does not depend on status credentials or their lifecycle.

Status refreshes three seconds after each completed attempt, never overlapping.
Failures preserve last-received values and both source and successful-refresh
timestamps. Inputs are not replaced by polling. A 401 reveals the read-token
form and suspends status polling until reconnection, without interrupting search.
The login explicitly governs indexing status only. Tokens stay in module memory;
submission clears the password field. No browser storage or token-bearing URLs.
Local portal-protected access can use the same UI without a bearer token.

All response text is rendered as text nodes. Image previews permit HTTPS only on
`emoji.slack-edge.com`, `a.slack-edge.com`, and `b.slack-edge.com`, without URL
credentials or nonstandard ports; other URLs receive a neutral placeholder.
Images are lazy-loaded, size-bounded, and use `no-referrer`.

## Verification boundary

The build is code-led per the approved brief. Static review covers semantic
labels, native keyboard controls, focus styles, read-only requests, and safe text
rendering. Parent integration owns live desktop/mobile inspection and API-backed
keyboard/authentication checks. The mechanical design detector's em-dash warning
is an intentional use of missing-data placeholders, not prose punctuation; its
heading-size advisory is retained for this compact Operate surface.
