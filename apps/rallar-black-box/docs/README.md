# Rallar Black Box Documentation

This folder documents the current state of `apps/rallar-black-box` after the first Iteration 23 full-stack harness and
Manual Rallar real-payload slices.

The app is a browser-based black-box test agent and visible debugging workbench for Rallar RTC, WebSocket, and HTTP test
flows. It uses the shared `rallar-bb-test` command contract, can connect to a WebSocket control server, streams results
and runtime events, and provides tabbed UI surfaces for manual testing, diagnostics, received data, reports, topology,
event inspection, and authenticated Rallar Server REST calls.

The default provider is simulated so the UI works without a backend. Real browser execution is available with
`provider=browser-rallar`; it uses the browser Rallar runtime for auth, connect, room join, realtime send, browser
WebSocket, and browser HTTP commands when a real Rallar environment is configured.

## Documents

- [Current State](./current-state.md): implemented components, known limitations, and verification status.
- [UI User Manual](./ui-user-manual.md): how to use each panel in the visible app.
- [Command Execution](./command-execution.md): how commands move from UI, recipes, or control server to runtime results.
- [Benefits And Use Cases](./benefits-and-use-cases.md): why this tool exists and what it is useful for.
- [Testing Showcases](./testing-showcases.md): examples from small manual tests to larger controlled runs.
- [Full-stack UI Automation Tests](./full-stack-ui-automation-tests.md): how to author Iteration 23-style Playwright
  tests for simulated UI, control-agent, API-backed, and live two-browser flows.

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
simulated, so the visible tabs, diagnostics, reports, and topology work without a Rallar account or backend login.

The active provider defaults to `simulated`. Real Rallar execution uses `provider=browser-rallar`, which requires a real
Rallar API base URL plus username/password or a restorable browser auth session. In that mode the SPA shows a login
screen before entering the tabbed app shell.

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
authenticated Rallar Server REST calls, control-server orchestration, and a two-browser Manual Rallar realtime flow that
sends real JSON through the `browser-rallar` provider. The API startup scripts load `apps/api-v1/.env.local`,
`apps/api-v1/.env`, and root `.env`.

## Main Source Files

- `src/client-defaults.ts`: out-of-the-box default values for local workbench and control-agent bootstrap.
- `src/app-tabs.ts`: tab IDs, URL parsing, aliases, and keyboard-order helpers for the operational shell.
- `src/ui-persistence.ts`: reload-safe tab, selected-command, Manual Rallar, Event Stream, and Rallar Server draft
  persistence with storage-time redaction.
- `src/rallar-server-workbench.ts`: request construction, endpoint presets, auth header injection, response parsing,
  redaction, cURL export, and black-box command export for the Rallar Server tab.
- `src/browser-rallar-runtime.ts`: lazy bridge from SPA provider mode to the browser Rallar runtime.
- `src/runtime-store.ts`: app state store, bootstrap modes, local command execution, and control client integration.
- `src/control-client.ts`: browser WebSocket control client.
- `src/control-protocol.ts`: protocol envelopes and command validation.
- `src/manual-workbench.ts`: manual UI command builders and received-message derivation.
- `src/rtc-diagnostics.ts`: event-derived RTC diagnostics.
- `src/topology-graph.ts`: graphology topology derivation used by the Sigma view.
- `apps/rallar-black-box-control-server`: minimal in-memory control server used for local orchestration and smoke tests.
- `packages/shared-test/rallar-bb-test`: shared command/result/event/runtime contract.
- `packages/shared-test/rallar-bb-test/provider-parity.ts`: portable SPA/runner parity recipes, runner conversion, and
  report comparison helpers.
