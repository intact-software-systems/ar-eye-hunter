# Rallar Black Box Documentation

This folder documents the current state of `apps/rallar-black-box` after the command-center distributed recipe
Iterations 43-50 and the shared-test Iterations 1-19 runner/handoff work.

The app is a browser-based black-box test agent and visible debugging workbench for Rallar RTC, WebSocket, and HTTP test
flows. It uses the shared `rallar-bb-test` command contract, can connect to a WebSocket control server, streams results
and runtime events, and provides tabbed UI surfaces for auth/session testing, rooms/client state inspection, manual
testing, WebSocket command-center flows, diagnostics, received data, reports, topology, event inspection,
authenticated Rallar Server REST calls and REST collections, scoped RTC delivery matrices, Flow Builder recipe
composition, control-server Run Manager orchestration, control-run artifact export, shared-test recipe discovery, and
runner artifact import. It also documents the full-stack QA coverage matrix, expanded Rallar Trace diagnostics, bounded
Event Stream/Topology controls,
and the gated live three-browser RTC matrix baseline.

The default provider is simulated so the UI works without a backend. Real browser execution is available with
`provider=browser-rallar`; it uses the browser Rallar runtime for auth, connect, room join, realtime send, browser
WebSocket, and browser HTTP commands when a real Rallar environment is configured.

## Documents

- [Current State](./current-state.md): implemented components, known limitations, and verification status.
- [UI User Manual](./ui-user-manual.md): how to use each panel in the visible app.
- [Command Execution](./command-execution.md): how commands move from UI, recipes, or control server to runtime results.
- [Benefits And Use Cases](./benefits-and-use-cases.md): why this tool exists and what it is useful for.
- [Testing Showcases](./testing-showcases.md): examples from small manual tests to larger controlled runs.
- [Capability Matrix](./capability-matrix.md): what is simulated, real-provider, full-stack gated,
  shared-test-runner-backed, or still planned.
- [Rallar Mode Split Iteration Plan](./mode-split-iteration-plan.md): proposed split between direct Rallar operations
  and black-box-runner recipe/artifact workflows.
- [Distributed Recipe Execution Iterations](./distributed-recipe-execution-iterations.md): planned group-aware
  distributed recipe execution, ACK/readiness, monitoring, historical runs, and JSON schema work.
- [Distributed Recipe Full-stack QA](./distributed-recipe-full-stack-qa.md): how to run simulated and live
  three-browser distributed recipe Playwright coverage.
- [Shared-test Schema And Capabilities](../../../packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md):
  shared command, recipe, control-envelope, distributed-manifest, and runner-scenario schema ownership.
- [Distributed Run Contract](../../../packages/shared-test/rallar-bb-test/docs/distributed-run-contract.md): shared
  distributed-run manifest fields, lifecycle states, target policy, and rollup rules.
- [Examples Index](./examples-index.md): app-local and shared-test recipe entry points with prerequisites.
- [Full-stack UI Automation Tests](./full-stack-ui-automation-tests.md): how to author Playwright tests for simulated
  UI, control-agent, API-backed, shared-test handoff, and live two-browser flows.

## Quick Start

Run the visible SPA:

```sh
npm run dev:rallar-black-box
```

Run the local control server in a second terminal:

```sh
npm run dev:rallar-black-box-control
```

Open the SPA in local workbench mode:

```text
http://localhost:5176/
```

No login is required for the local simulated UI. The client starts with demo defaults and the current SPA executor is
simulated, so the visible tabs, diagnostics, reports, topology, Auth, Groups/Clients, and WebSocket surfaces work without
a Rallar account or backend login.

The active provider defaults to `simulated`. Real Rallar execution uses `provider=browser-rallar`, which requires a real
Rallar API base URL plus username/password or a restorable browser auth session. In that mode the SPA shows a login
screen before entering the tabbed app shell.

After login, the app shell exposes a global command-center context above the tabs. It keeps API base URL, application,
workspace, room/group, client, and session values aligned across Quick Test, Manual Rallar, Groups/Clients, WebSocket, RTC
Diagnostics, Rallar Server, and Flow Builder defaults.

Groups/Clients, WebSocket, and RTC/Realtimes now use the same prominent action-feedback pattern as the Rallar Server
REST workbench: the latest operation shows target, status, duration, and failure text. WebSocket and RTC/Realtimes also
surface whether this browser is currently subscribed/listening, and RTC Diagnostics includes event/message/failure and
phase-duration time-series charts.

The SPA is responsive across phone, tablet, laptop, and large desktop widths. iPhone Max-sized screens use safe-area
padding, one-column command panels, touch-sized buttons, mobile-safe form inputs, stacked state/event cards, and
horizontal tab scrolling. The top `Rallar Kit` runtime header, `Global Context`, `Rallar Browser Trace`, direct-operation
boundary, and command input sections are collapsible, and the logout button stays compact when the header is expanded.
iPad and laptop widths keep denser two-column layouts where they fit; ultra-wide screens keep the same desktop layout
inside the maximum-width app shell.

Rallar trace rows include wall-clock time, relative age, delta from the previous trace event, source, kind, severity,
transport, connection, actor when available, and a short payload summary before the expanded redacted payload in the
`Rallar Trace` tab.

The direct-operation panels keep status visible while large input areas can be collapsed. Quick Test separates summary,
input, and payload/receive sections; Auth, Groups/Clients, WebSocket, RTC/Realtimes, Rallar Data, Media, Rallar Server,
Manual Rallar, and Local Workbench expose the same collapse pattern for their main inputs.

The app shell now has a `Workspace Mode` switch. `Rallar` mode shows direct live-operation tabs. `Rallar
black-box-runner` mode shows recipe, control-run, flow-builder, and artifact workflows. Existing `tab` deep links still
work and infer the correct workspace for runner-owned tabs. Switching into runner mode with the browser-rallar provider
does not reset or close the live direct Rallar facade; explicit reset/close actions still perform cleanup.

`Rallar` mode also has a direct-operation boundary panel. The first direct action, `Check Direct Rallar`, calls the
browser Rallar facade directly and emits `rallar.direct.*` diagnostics instead of creating black-box-runner command
results. The default `Quick Test` tab uses the same direct boundary for the common real-data path: create/join a group
using the current Group text as the explicit Rallar group ID, subscribe this browser to WS group messages, send JSON
through `rallar.messages.ws.send(...)`, wait for receives, and copy redacted diagnostics. Browser Rallar signaling uses
fresh API-v1 WS tickets for each socket open/reconnect because server tickets are consumed during upgrade.

Rallar mode also includes focused direct tabs for `WebSocket`, `RTC/Realtimes`, `Rallar Data`, optional `Media`, and
`Rallar Trace` checks. Those tabs call Rallar/Rallar Server directly, not the SPA `browser-rallar-runtime.ts` adapter.
Runner mode owns the command-oriented `Manual Rallar` scratchpad and has a boundary panel that keeps recipes, control
runs, flow exports, and imported artifacts separate from direct facade operations. The local sample recipe bootstrap and
header `Replay Sample` action are runner-only, so the default Rallar workspace does not auto-run the simulated black-box
scaffold.

Open the SPA as a control agent:

```text
http://localhost:5176/?mode=control&controlUrl=ws%3A%2F%2Flocalhost%3A5180%2Fcontrol&runId=demo-run&agentId=agent-1
```

Run the browser-agent smoke test:

```sh
npm run test:e2e:rallar-black-box
```

Start only the backend pieces used by real-data testing:

```sh
npm run dev:rallar-black-box:servers
```

Start the API, control server, and SPA together for manual UI work:

```sh
npm run dev:rallar-black-box:all
```

Run the gated full-stack automation slice in skip-safe mode:

```sh
npm run test:e2e:rallar-black-box:full-stack
```

Run the real-data full-stack suite. Playwright starts missing services and reuses already-running services:

```sh
npm run test:e2e:rallar-black-box:full-stack:real
```

The full-stack suite is skipped unless the required local services and environment are enabled. It currently covers
authenticated Rallar Server REST calls, control-server orchestration, command-center QA cross-checks, and a two-browser
Manual Rallar realtime flow that sends real JSON through the `browser-rallar` provider. The API startup scripts load
`apps/api-v1/.env.local`, `apps/api-v1/.env`, and root `.env`.

Run the provisioned live three-browser RTC matrix when you have three users or restored sessions:

```sh
npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3
```

That command is gated by `RALLAR_BLACK_BOX_LIVE_RTC_MATRIX=1` and covers real direct, multicast, broadcast,
not-yet-in-sync/NACK probing, stale-send failure, and control artifact export across `realtime` and `messages.rtc`.

Run the distributed recipe full-stack slice when you want to validate the control-server distributed-run workflow:

```sh
npm run test:e2e:rallar-black-box:full-stack:real:distributed
```

The simulated distributed coverage runs with the full-stack gate. The live WS and RTC delivery section additionally
requires `RALLAR_BLACK_BOX_DISTRIBUTED_RECIPES=1`. Local API-v1 fixture runs use `alice/secret`, `bob/secret`, and
`charlie/secret` by default; override them with `VITE_RALLAR_AGENT_A/B/C_USERNAME` and
`VITE_RALLAR_AGENT_A/B/C_PASSWORD`, or restored-session variables, for provisioned environments.
The live distributed slice also runs a short `rtc-realtime` composite recipe,
asserts visible frame/drilldown evidence, links received WS/RTC/realtime
payloads back to distributed-run monitor rows, and attaches console warning
artifacts while failing only on configured high-severity diagnostics.
Live distributed WS recipes use `room.*` topics because Rallar Server reserves
`rallar.*` for system traffic and will reject those topics before dynamic fanout.
For the exhaustive sender/receiver matrix, run:

```sh
npm run test:e2e:rallar-black-box:full-stack:real:live-rtc-3:all
```

The `:all` variant also sets `RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1` and runs every direct sender/receiver pair, every
sender-to-other-two multicast, and every sender broadcast across both RTC transports, plus live REST group readback, WS
open/send/close for all three agents, reconnect-after-stale-send, and unexpected-delivery checks.

Run the shared-test recipe matrix without live services:

```sh
npm run test:shared-black-box:matrix:quick
```

Run deterministic runner coverage for same-connection soak, seeded traffic, and bounded parallel groups:

```sh
npm run test:shared-black-box:matrix:deterministic
```

Run deterministic `rallar-bb-test` composite conformance coverage for loop,
parallel, wait/assert, cancellation, and negative delivery cases:

```sh
npm run test:shared-black-box:composite-conformance
```

The matrix commands execute through `packages/shared-test/black-box-runner`.
The composite conformance command executes the shared `rallar-bb-test` runtime
contract directly. The SPA `Shared Test` tab renders the browser-safe fixture
catalog, app-local examples, copyable runner commands, coverage ownership, and
imported artifact bundles. It still leaves actual shell execution to explicit
local tooling or the control server.

## Main Source Files

- `src/client-defaults.ts`: out-of-the-box default values for local workbench and control-agent bootstrap.
- `src/app-tabs.ts`: tab IDs, URL parsing, aliases, and keyboard-order helpers for the operational shell.
- `src/direct-rallar-operations.ts`: direct browser Rallar facade operations used by Rallar-mode UI actions.
- `src/ui-persistence.ts`: reload-safe tab, selected-command, Manual Rallar, Event Stream, and Rallar Server draft
  persistence with storage-time redaction.
- `src/rallar-server-workbench.ts`: request construction, endpoint presets, auth header injection, response parsing,
  redaction, cURL export, black-box command export, collection templates, variable substitution, assertions,
  extraction, and collection recipe export for the Rallar Server tab.
- `src/flow-builder.ts`: flow templates, variable substitution, SPA recipe export, runner scenario export, and flow-step
  insertion for the Flow Builder tab.
- `src/control-run-manager.ts`: typed control-server snapshot loading, run/agent row derivation, bulk enqueue,
  reset/delete, artifact export loading, JSONL/failure-bundle fetches, distributed-run lifecycle calls, and control URL
  normalization for the Run Manager and Distributed Recipes tabs.
- `src/distributed-recipes.ts`: Distributed Recipes target-resolution, role-pattern, manifest-building, composite
  preflight, composite monitor drilldowns, history-filter, compare, artifact-validation, and state-tone helpers.
- `src/distributed-recipe-authoring-prompts.ts`: schema-aware Distributed Recipes prompt templates, schema context
  snippets, prompt-variable redaction, and validation-feedback rendering for assisted recipe authoring.
- `src/schema-authoring.ts`: browser-side schema validation and capability summaries for command JSON, recipes,
  distributed-run manifests, runner scenarios, and generated command examples.
- `src/full-stack-qa-matrix.ts`: full-stack command-center QA ownership and evidence mapping.
- `src/live-rtc-three-browser-coverage.ts`: coverage accounting for the live three-browser RTC matrix.
- `src/browser-rallar-runtime.ts`: lazy bridge used by black-box-runner command execution and runner-owned Manual
  Rallar recipes, not by direct Rallar-mode WebSocket/RTC/Data/Media tabs.
- `src/runtime-store.ts`: app state store, bootstrap modes, local command execution, and control client integration.
- `src/control-client.ts`: browser WebSocket control client.
- `src/control-protocol.ts`: protocol envelopes and command validation.
- `src/manual-workbench.ts`: manual UI command builders and received-message derivation.
- `src/rtc-diagnostics.ts`: event-derived RTC diagnostics.
- `src/topology-graph.ts`: graphology topology derivation used by the Sigma view.
- `src/shared-test-handoff-fixtures.ts`: browser-safe re-export of the shared-test recipe catalog, artifact contract,
  coverage handoff, artifact parser, distributed-run helpers, command capabilities, and schema validators for
  command-center work.
- `src/run-manager-presets.ts`: schema-validated Run Manager command presets.
- `apps/rallar-black-box-control-server`: local control server used for orchestration, smoke tests, optional snapshot
  persistence, and redacted run artifact export.
- `packages/shared-test/rallar-bb-test`: shared command/result/event/runtime contract.
- `packages/shared-test/rallar-bb-test/provider-parity.ts`: portable SPA/runner parity recipes, runner conversion, and
  report comparison helpers.
- `packages/shared-test/black-box-runner/handoff-contract.ts`: shared-test recipe catalog, artifact contract, and
  coverage ownership contract consumed by the command center.
- `packages/shared-test/black-box-runner/artifact-reader.ts`: browser-safe parser and validator for runner artifact
  bundles.
