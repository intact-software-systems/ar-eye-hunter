# Rallar Black Box Documentation

This folder documents the current state of `apps/rallar-black-box` after Iteration 15C.

The app is a browser-based black-box test agent and visible debugging workbench for Rallar RTC, WebSocket, and HTTP test
flows. It uses the shared `rallar-bb-test` command contract, can connect to a WebSocket control server, streams results
and runtime events, and provides UI panels for manual testing, diagnostics, received data, reports, and topology.

The default provider is simulated so the UI works without a backend. Real browser execution is available with
`provider=browser-rallar`; it uses the browser Rallar runtime for auth, connect, room join, realtime send, browser
WebSocket, and browser HTTP commands when a real Rallar environment is configured.

## Documents

- [Current State](./current-state.md): implemented components, known limitations, and verification status.
- [UI User Manual](./ui-user-manual.md): how to use each panel in the visible app.
- [Command Execution](./command-execution.md): how commands move from UI, recipes, or control server to runtime results.
- [Benefits And Use Cases](./benefits-and-use-cases.md): why this tool exists and what it is useful for.
- [Testing Showcases](./testing-showcases.md): examples from small manual tests to larger controlled runs.

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

No login is required for the current local UI. The client starts with demo defaults and the current SPA executor is
simulated, so the visible workbench, diagnostics, reports, and topology work without a Rallar account or backend login.

The active provider defaults to `simulated`. Real Rallar execution uses `provider=browser-rallar`, which requires a real
Rallar API base URL plus username/password or a restorable browser auth session.

Open the SPA as a control agent:

```text
http://localhost:5176/?mode=control&controlUrl=ws%3A%2F%2Flocalhost%3A5180%2Fcontrol&runId=demo-run&agentId=agent-1
```

Run the browser-agent smoke test:

```sh
npm run test:e2e:rallar-black-box
```

The live browser-Rallar smoke is included in that suite but skipped unless the required `VITE_RALLAR_*` environment
variables are provided.

## Main Source Files

- `src/client-defaults.ts`: out-of-the-box default values for local workbench and control-agent bootstrap.
- `src/browser-rallar-runtime.ts`: lazy bridge from SPA provider mode to the browser Rallar runtime.
- `src/runtime-store.ts`: app state store, bootstrap modes, local command execution, and control client integration.
- `src/control-client.ts`: browser WebSocket control client.
- `src/control-protocol.ts`: protocol envelopes and command validation.
- `src/manual-workbench.ts`: manual UI command builders and received-message derivation.
- `src/rtc-diagnostics.ts`: event-derived RTC diagnostics.
- `src/topology-graph.ts`: graphology topology derivation used by the Sigma view.
- `apps/rallar-black-box-control-server`: minimal in-memory control server used for local orchestration and smoke tests.
- `packages/shared-test/rallar-bb-test`: shared command/result/event/runtime contract.
