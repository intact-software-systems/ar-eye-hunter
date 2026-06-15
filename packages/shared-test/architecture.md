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
