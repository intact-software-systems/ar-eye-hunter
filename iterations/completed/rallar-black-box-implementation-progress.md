# Rallar Black Box Shared-Test Extraction Progress

Date: 2026-06-27

## Scope

Track implementation of
`plans/rallar-black-box-shared-test-contract-extraction-plan.md`.

Goal: move reusable Rallar black-box protocol, snapshot, artifact-analysis, and
recipe-fixture contracts into `packages/shared-test/rallar-bb-test`, while
keeping the SPA, control server, Hetzner workflow, and artifact review behavior
working.

## Context Reviewed

- [x] `plans/rallar-black-box-shared-test-contract-extraction-plan.md`
- [x] `AGENTS.md`
- [x] `skills/rallar-platform`
- [x] `skills/rallar-code-writing`
- [x] `skills/rallar-testing`
- [x] `docs/README.md`
- [x] `docs/rallar-hetzner-distributed-recipes.md`
- [x] `docs/environment-variables.md`
- [x] `docs/rallar-troubleshooting-checklist.md`
- [x] `docs/rallar-api-reference.md`
- [x] `docs/codex-finish-line-verification-plan.md`

## Milestones

- [x] Iteration 1: promote `control-protocol.ts` into `packages/shared-test`.
- [x] Iteration 2: remove control-server app-to-app control protocol imports.
- [x] Iteration 3: promote control snapshot and artifact wire types.
- [x] Iteration 4: promote distributed monitor and artifact analysis.
- [x] Iteration 5: promote reusable recipe fixtures and manifest builder helpers.
- [x] Iteration 6: update documentation and ownership guidance.
- [x] Iteration 7: remove compatibility shims where no longer needed and enforce boundaries.
- [ ] Iteration 8: remote Hetzner health and realtime verification after merge to `main`.

## Verification Log

- [x] Iteration 1 red check:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts`
  failed because `packages/shared-test/rallar-bb-test/control-protocol.ts` was
  missing.
- [x] Iteration 1 behavior tests:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts`
  passed.
- [x] Iteration 1 shared-test type-check:
  `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- [x] Iteration 1 SPA type-check:
  `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit` passed.
- [x] Iteration 2 red check:
  `npx vitest run packages/tests/rallar-black-box/control-protocol-boundary.test.ts`
  failed while the control server still imported
  `../../rallar-black-box/src/control-protocol.ts`.
- [x] Iteration 2 behavior and boundary tests:
  `npx vitest run packages/tests/rallar-black-box/control-protocol-boundary.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts`
  passed.
- [x] Iteration 2 Deno control-server check:
  `cd apps/rallar-black-box-control-server && deno task check` passed.
- [x] Iteration 2 shared-test type-check:
  `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- [x] Iteration 2 SPA type-check:
  `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit` passed.
- [x] Iteration 3 red check:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts`
  failed after a side-effect import was added because
  `packages/shared-test/rallar-bb-test/control-snapshots.ts` was missing.
- [x] Iteration 3 focused tests:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/distributed-run-seeds.test.ts`
  passed.
- [x] Iteration 3 Deno control-server check:
  `cd apps/rallar-black-box-control-server && deno task check` passed.
- [x] Iteration 3 shared-test type-check:
  `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- [x] Iteration 3 SPA type-check:
  `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit` passed.
- [x] Iteration 4 red check:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts`
  failed because
  `packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts` was
  missing.
- [x] Iteration 4 shared artifact suite:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts`
  passed.
- [x] Iteration 4 focused artifact/monitor tests:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`
  passed.
- [x] Iteration 4 shared-test type-check:
  `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- [x] Iteration 4 SPA type-check:
  `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit` passed.
- [x] Iteration 5 red check:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts`
  failed because `packages/shared-test/rallar-bb-test/recipe-fixtures.ts` was
  missing.
- [x] Iteration 5 fixture and manifest tests:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-browser-adapter-auth.test.ts`
  passed.
- [x] Iteration 5 manifest determinism:
  `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`
  passed after rerun with sandbox escalation; the sandboxed attempt failed with
  `listen EPERM` on the local `tsx` IPC pipe.
- [x] Iteration 5 shared-test type-check:
  `npm --workspace @ar-eye-hunter/shared-test run check:ts` passed.
- [x] Iteration 5 SPA type-check:
  `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit` passed.
- [x] Iteration 6 documentation/boundary tests:
  `npx vitest run packages/tests/rallar-black-box/control-protocol-boundary.test.ts packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts`
  passed.
- [x] Iteration 6 whitespace check:
  `git diff --check` passed.
- [x] Iteration 7 focused verification:
  `npx vitest run packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/control-run-manager.test.ts packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`
  passed.
- [x] Iteration 7 shared-test package check:
  `npm --workspace @ar-eye-hunter/shared-test run check` passed after rerun
  with network escalation; the sandboxed run failed during Deno npm resolution
  for `@playwright/test`.
- [x] Iteration 7 SPA type-check:
  `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit` passed.
- [x] Iteration 7 control-server check:
  `cd apps/rallar-black-box-control-server && deno task check` passed.
- [x] Iteration 7 manifest determinism:
  `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`
  passed with sandbox escalation for local `tsx` IPC.
- [x] Iteration 7 app build:
  `npm --workspace rallar-black-box run build` passed with Vite large-chunk
  warnings.
- [x] Iteration 7 whitespace check:
  `git diff --check` passed.

## Starting State

- Before Iteration 1, `apps/rallar-black-box/src/control-protocol.ts` contained the
  `rtc.connect.readiness` validator fix from the prior remote failure.
- `packages/tests/rallar-black-box/control-client.test.ts` already contained
  coverage for accepting and rejecting `rtc.connect.readiness`.
- Before Iteration 2, the control server imported protocol symbols from the SPA
  source tree.

## Remaining

Iterations 1 through 3 are complete.

Iteration 4 is implemented for the shared analyzer path: shared artifact
analysis and a shared monitor module exist, the CLI analyzer imports shared
analysis directly, the SPA imports shared artifact analysis directly, and the
obsolete app artifact-analysis shim has been deleted. Remaining cleanup:
`apps/rallar-black-box/src/distributed-recipes.ts` still contains a local copy of
monitor derivation because it is mixed with catalog and preflight helpers.

Iteration 5 is implemented for reusable recipe fixture ownership: recipe
fixture builders are shared, app fixture imports are compatibility exports plus
the SPA manual-command example, and Hetzner manifests import fixtures from
shared-test. Remaining cleanup: `buildDistributedRunManifest` is available from
the extracted shared monitor module but has not yet been moved into
`distributed-run.ts` because it still depends on role-pattern/catalog helper
types from the mixed source file.

Iteration 7 is complete for local cleanup: the obsolete app
`control-protocol.ts` and `distributed-run-artifact-analysis.ts` shims were
deleted, and boundary tests were strengthened. Iteration 8 is blocked until
these changes are merged or pushed to the `main` ref that the Hetzner workflow
dispatches.
