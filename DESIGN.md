# semoji

## Search page

Operate mode, dark-only by explicit request. `/` has one search input, a Search
button, native Keyword / Semantic radio controls, and up to ten results.
Keyword is the default. A result shows a 48px emoji, its shortcode and summary.
No indexing ledger, status polling, login form, sidebar or maintenance controls.
`/dashboard` is a compatibility alias. Protected status remains an API operation.

Use a single 680px column, 20px mobile gutters, native sans-serif text and quiet
dividers between results. Canvas `#111413`, input `#1b201d`, text `#f1f3f2`, muted
`#a9b2ac`, rules `#343d37`, accent `#c1eacb`. Inputs/buttons have 44px minimum
targets and visible focus. Selection, caret and scrollbar use the same palette.
No decorative imagery, webfonts, animation, invented metrics or probability badges.

Search is anonymous and submit-driven; changing mode reruns a nonempty query.
New searches abort old requests. Announce loading, results, empty and error states
through one status line. Semantic failures offer keyword mode explicitly; never
silently label keyword results semantic. Coverage may be incomplete during backfill.
Render API text using text nodes and permit only validated Slack image URLs.

## API reference

`/docs` uses pinned, self-hosted Scalar 1.72.2 in forced dark mode. Use the
same-origin OpenAPI JSON and an external initializer. Disable external fonts,
Agent, telemetry, developer tools and authentication persistence. Do not configure
a proxy. Public docs list only public GET routes; preserve the strict script CSP.

Verify desktop/mobile search, keyboard mode selection, empty/error states,
ten-result limit and the Scalar request client in the rendered UI.
