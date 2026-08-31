# Shared-Test Architecture Notes

`packages/shared-test` owns reusable black-box, browser-agent, fixture, and
comparison tooling for Rallar. It should test observable network and browser
behavior without becoming another implementation of the Rallar browser facade or
server facade.

## Current Public Surface

- `black-box-runner/` is the provider-neutral scenario runner for JSON recipes.
  Its core step vocabulary is HTTP, WS, RTC, ASSERT, SET, PARALLEL, and related
  runner utilities.
- `black-box-runner/docs/` contains the active recipe guide, artifact docs,
  provider docs, and historical iteration plans.
- `rallar-bb-test/` is the browser/control-agent recipe runtime used by visible
  and remote browser workflows. It provides portable commands such as
  `configure`, `recipe.*`, `rtc.*`, `ws.*`, `http.request`, `wait`, `assert`,
  `health`, `stats`, `close`, and `reset`.
- `rallar-bb-test/docs/` documents schema contracts, distributed-run handoff,
  composite primitives, runtime diagnostics, and companion coverage boundaries.
- `json-compare/` and fixtures support stable artifact and result comparisons.
- `create-test-group.ts` is the single construction point for `Group` in tests.
  Its defaults are annotated `Group`, so a new required field on the aggregate
  fails to compile here instead of failing at runtime in every test that omits
  it. It lives in this package rather than `packages/tests` because the root
  `tsconfig.json` excludes `packages/tests` from type checking.

## Provider Truth

- `rallar-stub` is a fake provider for parser, reporting, and smoke tests.
- `rallar-memory` is deterministic and in-memory; use it for runner semantics
  without live browser/network cost.
- `rallar-signaling` is the explicit signaling-only Rallar provider.
- `rallar` remains a backward-compatible alias for the signaling-only provider
  and should be treated as legacy naming.
- `rallar-browser` and `rallar-remote-browser` are the browser-backed providers
  for real Rallar RTC/data-channel readiness and visible browser control.

## Boundaries

- Do not add first-class recipe commands for Rallar facade methods such as
  `auth.login`, `rooms.join`, `messages.rtc.send`, `messages.room`,
  `realtime.sendJson`, `realtime.room`, `data.open`, `calls.start`, or
  `media.start`.
- Express Rallar behavior through HTTP, WS, RTC, wait/assert, provider config,
  and observable artifacts.
- Provider adapters may call Rallar internals or browser facade methods, but the
  recipe contract should remain network/control oriented.
- Historical iteration docs are useful provenance. Active behavior contracts
  should live in schema, provider, recipe-guide, artifact, runbook, and
  companion-coverage docs.

## Rallar Black Box Contract Ownership

`packages/shared-test/rallar-bb-test` owns the reusable control-agent and
distributed-run contracts:

- command and recipe schemas;
- control protocol envelopes and parsers;
- control run and distributed run snapshot wire types;
- distributed artifact parsing and analysis;
- reusable black-box recipe fixtures and builders.

`apps/rallar-black-box` is a consumer and operator UI. It may expose
compatibility re-exports, but new shared protocol or artifact behavior should
start in `packages/shared-test`.

`apps/rallar-black-box-control-server` must import shared contracts from
`@shared-test/rallar-bb-test/*`, not from the SPA source tree.

## Browser Runtime Navigation

The browser runtime is one installed lifecycle owner, with separate authentication,
message, CRDT and observation effects. Start at
[`installBlackBoxRallarRuntime`](./black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts),
which installs the command surface on `window.__blackBoxRallar`.

| Entry and owner                                                                                                                                                                                                                                                                                                                              | Result and failure boundary                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Runtime composition](./black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts)                                                                                                                                                                                                                               | Constructs the real browser facade dependencies consumed by commands and observations.                            |
| [Connection runtime](./black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts) and [lifecycle controller](./black-box-runner/browser/rallar-browser-runtime/lifecycle-controller.ts)                                                                                                                                    | Serialize authentication/connect/close; generation changes cancel stale work and close drains owned effects.      |
| [Authentication](./black-box-runner/browser/rallar-browser-runtime/black-box-rallar-authentication.ts)                                                                                                                                                                                                                                       | Registration/login produce the connection session or a normalized authentication failure.                         |
| [Messaging controller](./black-box-runner/browser/rallar-browser-runtime/messaging-controller.ts) and [command decoder](./black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts)                                                                                                                          | Decode routing options once, preserve user payload, and return actual send outcomes and diagnostics.              |
| [CRDT controller](./black-box-runner/browser/rallar-browser-runtime/black-box-rallar-crdt-controller.ts), [input decoder](./black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts) and [resource controller](./black-box-runner/browser/rallar-browser-runtime/black-box-rallar-crdt-resource-controller.ts) | Validate commands before document effects; reserve handles, serialize operations and drain pending work on close. |
| [Director controller](./black-box-runner/browser/rallar-browser-runtime/director-controller.ts)                                                                                                                                                                                                                                              | Own director appointment and relay subscriptions through resign/stop/close.                                       |
| [Health reader](./black-box-runner/browser/rallar-browser-runtime/black-box-rallar-health-reader.ts) and [diagnostics](./black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts)                                                                                                                                    | Return connection/RTC/resource observations and emit normalized events without owning the observed services.      |

## Control And Artifact Navigation

The `rallar-bb-test` public entry is [`mod.ts`](./rallar-bb-test/mod.ts).
Browser execution and offline artifact analysis are distinct consumers of its
shared command and evidence contracts; they do not route through each other.

| Entry and owner                                                                                                                                   | Result and failure boundary                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [Browser control agent](./rallar-bb-test/browser-control-agent.ts)                                                                                | `createRallarBlackBoxBrowserControlAgent` composes transport and recipe execution into start/dispose plus observable snapshots.      |
| [Recipe runtime](./rallar-bb-test/runtime.ts) and [browser adapter](./rallar-bb-test/browser-adapter.ts)                                          | `createRallarBlackBoxTestRuntime` dispatches commands; the browser adapter returns transport observations to runtime results/events. |
| [SPA runtime bridge](./rallar-bb-test/browser-rallar-runtime-bridge.ts)                                                                           | `createSpaBrowserRallarRuntime` validates connection configuration and delegates commands to the installed browser owner.            |
| [Control client](./rallar-bb-test/control-client.ts) and [control protocol](./rallar-bb-test/control-protocol.ts)                                 | Exchange validated control envelopes, commands and snapshots; socket lifecycle belongs to the client.                                |
| [Distributed run](./rallar-bb-test/distributed-run.ts) and [run contract](./rallar-bb-test/docs/distributed-run-contract.md)                      | Validate manifests and resolve target agents; this contract layer does not open sockets or start browsers.                           |
| [Artifact pipeline](./rallar-bb-test/distributed-artifact-pipeline.ts) and [artifact analysis](./rallar-bb-test/distributed-artifact-analysis.ts) | `parseDistributedArtifactPipeline` validates files into evidence; analysis returns derived reports instead of executing commands.    |
| [Run monitor](./rallar-bb-test/distributed-run-monitor.ts) and [tuning](./rallar-bb-test/distributed-run-tuning.ts)                               | Derive operator views, verdicts and configurable tuning inputs from existing evidence.                                               |

Command/schema ownership is described in
[schemas and capabilities](./rallar-bb-test/docs/schema-and-capabilities.md);
observable event fields are defined by the
[runtime diagnostic contract](./rallar-bb-test/docs/runtime-diagnostic-contract.md).
These maps keep the independent command, control and analysis families directly
locatable without moving unrelated owners merely to change a directory count.

## Validation

Common package-focused checks:

```bash
npm --workspace @ar-eye-hunter/shared-test run check
npm --workspace @ar-eye-hunter/shared-test run bb:matrix:quick
```

For narrow changes, run the closest command from
`black-box-runner/docs/black-box-runner-recipe-guide.md`,
`black-box-runner/docs/black-box-runner-recipe-matrix.md`, or the relevant
`rallar-bb-test` contract test before the broad package check.
