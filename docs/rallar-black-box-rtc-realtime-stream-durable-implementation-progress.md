# Rallar Black Box RTC Realtime Stream Durable Implementation Progress

Date: 2026-06-27

## Scope

Track implementation of
`plans/rallar-black-box-rtc-realtime-stream-durable-fix-plan.md`.

Goal: replace high-rate Hetzner RTC realtime recipes that currently expand into
hundreds of sequential `rtc.send` commands with a shared-test `rtc.stream`
primitive, then surface stream performance and failure evidence in CLI analysis
and the `rallar-black-box` SPA.

## Context Reviewed

- [x] `AGENTS.md`
- [x] `plans/rallar-black-box-rtc-realtime-stream-durable-fix-plan.md`
- [x] `docs/README.md`
- [x] `docs/rallar-hetzner-distributed-recipes.md`
- [x] `docs/rallar-black-box-implementation-progress.md`
- [x] `docs/environment-variables.md`
- [x] `docs/rallar-troubleshooting-checklist.md`
- [x] `docs/rallar-quickstart-and-recipes.md`
- [x] `docs/rallar-api-v1-in-memory-performance-mode.md`
- [x] `docs/rallar-api-reference.md` RTC/realtime sections
- [x] `docs/codex-finish-line-verification-plan.md`
- [x] `skills/rallar-platform`
- [x] `skills/rallar-platform/references/package-map.md`
- [x] `skills/rallar-code-writing`
- [x] `skills/rallar-code-writing/references/package-code-style.md`
- [x] `skills/rallar-realtime`
- [x] `skills/rallar-testing`
- [x] `skills/rallar-testing/references/test-commands.md`
- [x] `skills/rallar-hetzner-ops`
- [x] `skills/rallar-hetzner-ops/references/github-action-workflow.md`
- [x] `skills/rallar-hetzner-ops/references/artifact-analysis.md`
- [x] `skills/rallar-hetzner-ops/references/performance-thresholds.md`

## Starting State

- Current branch at start: `codex/hetzner-logs-home-scripts`.
- Shared black-box contracts, control protocol, distributed monitor, artifact
  analysis, and recipe fixtures already live under
  `packages/shared-test/rallar-bb-test`.
- `apps/rallar-black-box/src/recipe-fixtures.ts` is a compatibility re-export.
- Hetzner realtime manifests `05` and `06` currently use
  `createRallarBlackBoxRtcRealtimeRecipe`, which emits a `loop` containing
  `rtc.send` commands.
- Remote evidence from run `28291384177` showed the ready-peer contract worked,
  but the 5s realtime recipe timed out because sequential `rtc.send` command
  execution could not complete 100 frames per agent inside the workflow timeout.

## Milestones

- [x] Iteration 1: add shared `rtc.stream` command contract, schema, protocol
  validation, and capability docs.
- [x] Iteration 2: add pure RTC stream planning, placeholder, metric, and
  threshold helpers.
- [x] Iteration 3: execute `rtc.stream` in the browser adapter without
  sequentially blocking frame scheduling.
- [x] Iteration 4: migrate the Hetzner realtime manifest builders to
  `rtc.stream` while keeping local looped recipes compatible.
- [x] Iteration 5: teach artifact analysis to derive stream metrics and
  stream-specific pending timeout evidence.
- [x] Iteration 6: show stream performance and failure evidence in the SPA
  imported artifact UI.
- [x] Iteration 7: update Hetzner/operator docs for stream manifests and
  performance reporting.
- [x] Iteration 8: run the local verification gate.
- [x] Iteration 9: remote Hetzner rollout/fast verification is documented as
  blocked until these changes are pushed or otherwise available on `main`.

## Verification Log

- [x] Iteration 1 red tests:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts`
  failed because `rtc.stream` was not a supported command kind in shared schema
  or control-protocol validation.
- [x] Iteration 1 green tests:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts`
  passed with 16 tests after adding the command type, schema branch,
  capability metadata, control validation, docs, and golden corpus entry.
- [x] Iteration 2 red test:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts`
  failed because `packages/shared-test/rallar-bb-test/rtc-stream.ts` was
  missing.
- [x] Iteration 2 green test:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts`
  passed with 3 tests after adding stream planning, placeholder replacement,
  summary, percentile, and threshold helpers.
- [x] Iteration 3 red tests:
  `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts`
  failed because `rtc.stream` fell through to the default fake command and did
  not call the browser Rallar runtime.
- [x] Iteration 3 green tests:
  `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts`
  passed with 56 tests after adding browser-adapter `rtc.stream` execution,
  bounded in-flight handling, stream diagnostics, and compact stats summaries.
- [x] Iteration 4 red tests:
  `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`
  failed because `createRallarBlackBoxRtcRealtimeRecipe` did not yet support
  `executionMode: "stream"` and Hetzner realtime manifests still used looped
  `rtc.send`.
- [x] Iteration 4 green tests:
  `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`
- [x] Manifest regeneration:
  `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`
  passed with escalated execution after the sandboxed run hit `tsx` local IPC
  `listen EPERM`; regenerated all checked-in Hetzner manifest JSON files.
- [x] Manifest determinism:
  `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`
  passed with escalated execution because `tsx` local IPC is blocked by the
  default sandbox.
- [x] Iteration 5 red tests:
  `npx vitest run packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts`
- [x] Iteration 5 green tests:
  `npx vitest run packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts`
  passed with 32 tests after adding stream timing aggregation, slowest stream
  agents, stream performance Markdown, and `events.jsonl` stream-progress
  timeout failure evidence.
- [x] Iteration 6 red test:
  `npx vitest run packages/tests/rallar-black-box/distributed-artifact-spa.test.ts`
- [x] Iteration 6 green tests:
  `npx vitest run packages/tests/rallar-black-box/distributed-artifact-spa.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`
  passed as part of
  `npx vitest run packages/tests/rallar-black-box/distributed-artifact-spa.test.ts packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`
  with 26 tests after adding imported artifact stream metrics for frame
  completion, stream percentiles, drops, backpressure, achieved Hz, and slowest
  stream agent.
- [x] Shared-test focused verification:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts`
  passed with 72 tests.
- [x] Rallar Black Box focused verification:
  `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts packages/tests/rallar-black-box/distributed-artifact-spa.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`
  passed with 78 tests.
- [x] SPA type-check:
  `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit`
  initially failed because adding `rtc.stream` to the shared command union made
  `apps/rallar-black-box/src/flow-builder.ts` non-exhaustive; passed after
  adding the `rtc.stream` runner-scenario mapping.
- [x] Shared-test type-check:
  `npm --workspace @ar-eye-hunter/shared-test run check:ts`
- [x] App build:
  `npm --workspace rallar-black-box run build`
  passed; Vite reported the existing large chunk-size warning.
- [x] Whitespace check:
  `git diff --check`
- [x] Iteration 9 blocked:
  remote Hetzner verification cannot run against this uncommitted workspace
  state because `scripts/hetzner/dispatch-distributed-recipe.sh --ref main`
  reads the GitHub workflow and checked-in manifest files from the remote
  `main` ref. Running it now would test the old mainline implementation, not
  this `rtc.stream` implementation.

## Remaining Limitations

- Remote verification cannot be completed until the implementation is available
  on the `main` ref used by the GitHub Action.
- After the changes are on `main`, run:
  `scripts/hetzner/dispatch-distributed-recipe.sh apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json --ref main`
  followed by
  `scripts/hetzner/dispatch-distributed-recipe.sh apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json --ref main --fast`.
  If `05` passes, run:
  `scripts/hetzner/dispatch-distributed-recipe.sh apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json --ref main --fast`.
- The first implementation pass will keep `rtc.stream` additive. Existing
  looped `rtc.send` recipes remain supported for deterministic command-rate
  tests and compatibility.
