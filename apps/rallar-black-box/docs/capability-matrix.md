# Capability Matrix

This matrix separates what the SPA can do today from what the shared-test runner already covers and what remains
planned for command-center UI work.

Legend:

- `simulated`: works out of the box in the SPA without Rallar Server.
- `real-provider`: uses `provider=browser-rallar` and the browser Rallar runtime.
- `full-stack gated`: requires local services, credentials, and explicit test env.
- `shared-test-runner-backed`: implemented in `packages/shared-test/black-box-runner`; selected catalog entries and
  artifacts are visible in the SPA `Shared Test` tab.
- `planned`: documented command-center work that is not implemented in the UI yet.

| Area | Current SPA Surface | Current Execution Layer | Status | Main Gap |
| --- | --- | --- | --- | --- |
| Auth/session | Login gate, Auth tab for login/register/restore/logout/local clear, WS-ticket creation, bad-credentials and missing-auth-ticket checks, redacted diagnostics, Rallar Server auth header injection | Browser Rallar runtime and API-v1 REST | simulated with mocked routes, real-provider, full-stack gated | Expired session, forbidden user, CORS/network denial, and ticket-expiry matrices still need deeper real-backend coverage. |
| Rooms/groups/clients | Groups/Clients tab for state variables, group/client/presence/event actions, latest-action feedback, group and client tables, state event rows, and expected-vs-observed client metrics; Manual Rallar create/join; Rallar Server presets | Browser Rallar runtime plus API-v1 REST | simulated with mocked routes, real-provider, full-stack gated | Saved state scenarios, assertions, cleanup flows, and large state pagination are still planned. |
| HTTP/REST | Rallar Server tab with presets, raw request editor, auth attachment, explicit request lifecycle feedback, Rallar Trace request events, cURL export, `http.request` export, persisted REST collections, variables, JSON-path extraction, status/body/header assertions, negative templates, and collection recipe export | Browser `fetch` and `rallar-bb-test` commands | simulated, real-provider, full-stack gated | Collection import is paste/edit based; richer visual flow editing and full shared-runner assertion execution remain planned. |
| WebSocket | WebSocket tab for configure, ticket creation, open, open API WS, send JSON, subscribe/listening status, latest-action feedback, wait, reconnect, close, cleanup, missing-ticket negative open, diagnostics copy, payload presets, WS recipe export, and WS/RTC parity recipe export; Manual WebSocket URL field; authenticated API WS recipe examples | Browser WebSocket through `rallar-bb-test` plus direct API-v1 WS-ticket REST calls | simulated, real-provider | Expired-ticket, unauthorized socket, server-restart/reconnect, and WS-vs-RTC parity matrices still need deeper real-backend automation. |
| RTC direct delivery | Manual Rallar connect/send, scoped application/workspace/scope/roomRef/minSnapshot controls, RTC/Realtimes latest-action feedback and subscription status, received-data inbox, RTC Diagnostics, topology, live one-agent, two-agent, Manual Rallar, and three-browser smokes | Browser Rallar runtime through `rallar-bb-test` | simulated, real-provider, full-stack gated | Direct delivery has UI and live coverage; permission/expiry negative fixtures still need deeper live hardening. |
| RTC multicast/broadcast/NACK | Manual RTC Delivery Matrix for realtime and `messages.rtc` direct/multicast/broadcast, NACK probe, negative recipe export, peer/lane/NACK diagnostics; shared-test browser recipes for multicast, NACK/stale-state, scoped workspaces, parity, soak, traffic, and parallel groups; live three-browser matrix baseline | Browser Rallar runtime through `rallar-bb-test`; shared-test runner providers | simulated, real-provider, shared-test-runner-backed, full-stack gated | A live three-browser baseline now exists; exact permission-denied, missing-peer, stale-agent, duplicate-session, expiry, and server-provided NACK fixture coverage remains planned. |
| Recipes/flows | Local Workbench JSON editor with schema validation and generated command snippets, built-in fixtures, app-local examples, schema-validated manual recipe output, Flow Builder templates and editable flow JSON, schema-validated SPA recipe export, schema-validated runner scenario export, Shared Test catalog, Distributed Recipes manifest builder with capability help, and Generate With AI prompt/schema/paste-back validation for distributed recipe authoring | `rallar-bb-test` runtime; shared-test runner for external JSON recipes | simulated, real-provider, shared-test-runner-backed | Flow composition, distributed manifest authoring, and prompt-assisted recipe drafting exist; durable flow storage, richer recording from other tabs, and full runner assertion execution remain planned. |
| Control server | Browser control client, Run Manager tab with schema-validated command enqueue and generated command snippets, Distributed Recipes tab, bounded run snapshots, agent selection, bulk enqueue, distributed-run create/stage/start/cancel/export, distributed monitor/history/compare views, reset/delete, retention cleanup, optional snapshot persistence, redacted artifact export, events/results JSONL, failure bundles, in-memory runs, commands, results, stats, reports, tokens, Swagger UI | `apps/rallar-black-box-control-server` | simulated, full-stack gated | Artifact search, saved history filters, and large-run virtualization are still planned. |
| Diagnostics | Rallar Trace with full redacted browser/direct/server payloads, RTC Diagnostics stage/membership/latency/time-series views, Event Stream with bounded windows, Failure Focus, Stats, Topology with search/node limits and route summaries, received-data inbox, redacted report snapshot, imported artifact event/RTC/failure views, distributed-run linked event/failure/timeline monitor | Runtime events and runner artifacts | simulated, real-provider, shared-test-runner-backed | Imported artifacts are visible, but true virtualization, artifact search, and larger cross-run browsing are still planned. |
| Artifacts | Redacted SPA reports, control-run artifact export/import validation, distributed-run artifact validation, events/results JSONL export, failure bundles, Playwright traces, and Shared Test artifact import/display | Shared-test artifact reader and handoff contract; control-server artifact exporter | simulated, full-stack gated, shared-test-runner-backed | Artifact search and large cross-run browsing are planned. |
| Scale/long runs | Control stats, reports, topology search/node limits, Event Stream windows, deterministic route summaries, deterministic runner scale, same-connection soak, seeded traffic replay, and bounded parallel groups | SPA plus shared-test runner | simulated, full-stack gated, shared-test-runner-backed | True virtualization/cursor paging, artifact search, cross-run comparison, and deeper accessibility/performance QA remain open. |

## Current Best Layer By Task

Use the SPA simulated provider when validating command previews, tab behavior, diagnostics rendering, topology, event
filters, report shape, and redaction.

Use `provider=browser-rallar` in the SPA when proving real auth, group creation/join, RTC connect, realtime send,
`messages.rtc`, browser WebSocket, or browser HTTP behavior.

Use the control server when a browser must be driven as a remote agent and the run needs server-side snapshots of
commands, results, stats, and reports.

Use `packages/shared-test/black-box-runner` when the task is an external JSON recipe with HTTP, WS, RTC, assertions,
same-connection soak, seeded traffic replay, bounded parallel groups, or artifact generation.

Use shared-web, shared-server, or app-specific tests when validating Rallar facade/server internals that are not external
network behavior.
