# Examples Index

This index lists the examples that are useful from Recipe Console and the preserved legacy workbenches, and where the
richer shared-test runner recipes live. Blank and provider-only URLs open Recipe Console `Execute`; its other primary
views are `Monitor`, `Analyze`, `Tune`, `Fleet`, and `Advanced`.

## App-local Recipes

These recipes live in `apps/rallar-black-box/examples/` and are intended for the preserved SPA `Local Workbench` while
running with `provider=browser-rallar`. Open it from Recipe Console `Advanced` or directly with
`/?experience=legacy&workspace=black-box-runner&tab=local-workbench`.

| Recipe | Purpose | Requirements | Expected Result |
| --- | --- | --- | --- |
| `rallar-server-group-ws-setup.recipe.json` | Create `bb-group` if needed, join it, acquire a WS ticket, and open the API WebSocket. | Logged-in browser session, API base URL, Rallar Server with auth and group endpoints. | REST calls succeed or tolerate existing group state; WebSocket opens with a fresh ticket. |
| `rallar-server-rtc-connect-send.recipe.json` | Reuse the group/session context and connect/send through RTC. | Logged-in browser session, group exists or is creatable, RTC provider can signal. | Connect succeeds and a realtime send command is executed. |

The recipes use these browser-session placeholders:

- `{auth.clientId}`
- `{auth.username}`
- `{auth.sessionId}`
- `{auth.accessToken}`
- `{auth.wsTicket}`
- `{config.apiBaseUrl}`
- `{config.wsBaseUrl}`

`{auth.wsTicket}` is resolved by requesting `/api/auth/ws-ticket` with the logged-in browser session before opening the
WebSocket URL.

## Shared-test Runner Catalog

The richer JSON recipe set lives under `packages/shared-test/black-box-runner/examples/`, with validation fixtures under
`packages/shared-test/black-box-runner/tests/`; both are indexed by
`packages/shared-test/black-box-runner/recipe-matrix.json`.

The SPA re-exports a browser-safe fixture catalog and artifact contract from:

```text
apps/rallar-black-box/src/shared-test-handoff-fixtures.ts
```

That bridge exposes:

- `RALLAR_BLACK_BOX_SHARED_TEST_RECIPE_CATALOG`
- `RALLAR_BLACK_BOX_SHARED_TEST_ARTIFACT_CONTRACT`
- `RALLAR_BLACK_BOX_SHARED_TEST_COVERAGE_HANDOFF`
- `parseRallarBlackBoxSharedTestArtifactBundle(...)`
- `validateRallarBlackBoxSharedTestRecipeCatalog(...)`
- `validateRallarBlackBoxSharedTestRecipeCatalogEntryFixture(...)`

The preserved SPA `Shared Test` tab, available from Recipe Console `Advanced` or
`/?experience=legacy&workspace=black-box-runner&tab=shared-test`, renders the browser-safe fixture catalog and validates
imported runner artifact bundles. It does not load the full `recipe-matrix.json` dynamically from disk or execute runner
commands from the browser.

## Shared-test Recipe Families

| Family | What It Covers | Typical Command |
| --- | --- | --- |
| Quick matrix | Fast dry-run and deterministic confidence across representative recipes. | `npm run test:shared-black-box:matrix:quick` |
| Dry matrix | Recipe shape and command generation without live services. | `npm run test:shared-black-box:matrix:dry` |
| Deterministic matrix | In-memory RTC delivery semantics, routing failures, same-connection soak, seeded traffic, and parallel groups. | `npm run test:shared-black-box:matrix:deterministic` |
| Composite conformance | Shared `rallar-bb-test` loop, parallel, wait/assert, cancellation, and negative delivery semantics across provider rows. | `npm run test:shared-black-box:composite-conformance` |
| Rallar Server live | REST auth, group setup, WS open/send, negative auth, and WS/RTC parity when services are configured. | `npm run test:shared-black-box:matrix:live` |
| Live soak | Gated browser/remote-browser same-connection RTC soak. | `npm run test:shared-black-box:matrix:live:soak` |
| Live traffic | Gated browser/remote-browser seeded RTC traffic plans with replay artifacts. | `npm run test:shared-black-box:matrix:live:traffic` |
| Live parallel | Gated browser/remote-browser bounded parallel RTC groups. | `npm run test:shared-black-box:matrix:live:parallel` |
| SPA live three-browser RTC | Gated command-center baseline for realtime/messages direct, multicast, broadcast, NACK/min-snapshot probing, stale-send failure, and control artifacts. | `npm run test:rallar:full-stack:postgres:live-rtc-3` |
| SPA live three-browser all scenarios | Exhaustive command-center matrix for all direct pairs, every sender multicast/broadcast, REST group readback, WS open/send/close, stale reconnect, and artifact validation. | `npm run test:rallar:full-stack:postgres:live-rtc-3:all` |

Live commands are skip-safe by default. Use the strict live matrix only in a provisioned environment where missing
services or credentials should fail the run:

```sh
npm run test:shared-black-box:matrix:live:strict
```

## Artifact Bundles

Shared-test runner artifacts use this file shape:

- `report.json`
- `events.jsonl`
- `failures.json`
- `metadata.json`
- optional `artifact-index.json`
- optional `expanded-recipe.json`
- optional `expanded-plan.json`
- optional `reduced-plan.json`
- optional `matrix-summary.json`

Use `parseRallarBlackBoxSharedTestArtifactBundle(...)` before rendering uploaded artifacts. The parser validates
required files, event kinds, summaries, artifact indexes, expanded recipes, redaction placeholders,
expanded-plan/reduced-plan replay data, matrix summaries, and legacy schema compatibility.
