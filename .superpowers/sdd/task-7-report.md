# Task 7 report: authoritative shared contracts and OpenAPI

## Scope and implementation

- Base: `f1359859`.
- Implementation commit: `118eeb49` (`refactor: require authoritative state fields`).
- Authoritative client, group, event, topology, overlay, outbox, and mutation
  receipt contracts now require their identity, lifecycle, actor, causal,
  storage-revision, and effect fields. Meaningful absence is represented by a
  required `null`; sparse request, patch, query, and builder inputs remain
  sparse.
- `MutationActor` is an exact principal/session/service discriminated union.
  Audit stamps and state events carry a mandatory actor plus required nullable
  reason, trace, and request identifiers and a mandatory payload.
- Client and group lifecycle values are exact discriminated unions. Group
  members include every lifecycle audit slot, presence sessions include
  generation identity and exact terminal fields, and authoritative snapshots
  validate exact key sets at public and persistence boundaries.
- `GroupStateCausalRevision` is the shared required
  `{ groupRevision, presenceRevision }` tuple across snapshots, events,
  topology source metadata, caches, and transport contracts. Componentwise
  dominance distinguishes older, newer, equal, and incomparable observations;
  equal tuple with different content fails as corruption, while incomparable
  browser observations force a durable reread.
- Mutation receipts are compact mandatory authority records rather than full
  snapshots. RTC outbox, publication, execution, and cluster transport paths
  validate canonical identities, causal source metadata, sender identity, and
  complete receipt fields before authority work or replay.
- OpenAPI required/nullable declarations and lifecycle variants now match the
  hardened TypeScript surface. Compatibility tests cover required fields,
  discriminated group-member lifecycle shapes, and causal topology metadata.

## Persistence and migration rationale

- Current live readers and writers validate canonical complete contracts and
  fail closed on wrong-slot identity, explicit-null legacy identity/payload,
  malformed lifecycle state, or divergent equal authority.
- Explicit f135 persistence normalizers are confined to repository boundaries.
  They materialize fields omitted by known legacy rows, then run the same
  canonical validators; they do not permit malformed explicit values.
- Historical group storage keys with the absent-workspace `ws=_` segment are
  normalized to the now-mandatory default workspace. Literal `_` remains
  `%5F`, and noncanonical percent aliases are still rejected.
- RTC scalar-publication migration remains an offline-only operation guarded by
  `{ oldWritersStopped: true }`. It upgrades legacy scalar or three-field work
  claims to the canonical compact receipt and uses the documented
  `acceptedStorageRevision: 0` migration sentinel. Live validation was not
  weakened and new online writers cannot emit that legacy shape.
- These choices preserve rolling-data compatibility without dual-read runtime
  ambiguity, hidden retries, or optional authoritative output fields.

## Validation evidence

- `npm run test:unit` passed: 449 files passed, 2 configured-skip files; 4,549
  tests passed and 13 environment-gated tests skipped.
- `npm run test:deno` passed end to end: API tests 223/223, black-box control
  tests 79/79, Relic server `deno task check`, and shared-test RTC scenarios
  146/146.
- `npm run typecheck` passed the root shared check and every workspace
  typecheck.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit` each passed.
- The plan-mandated exact Vitest command passed 4 files and 56/56 tests:
  `authoritative-state-contracts`, `rallar-group-docs-compat`, `data-caches`,
  and `api-workflows`.
- The plan-mandated exact API Deno command passed 43/43 tests across client
  state service, group state service, and graph topology routes.
- The final PGlite/admin/OpenAPI focused command passed 55/55 tests. A
  post-format WebSocket authorizer/OpenAPI check passed 15/15 tests.
- Shared-web browser boundary, browser entrypoint, and public API snapshot
  tests passed 3 files and 26/26 tests. The first attempted selection used
  nonexistent legacy filenames and correctly exited with “No test files
  found”; the corrected current filenames produced the result above.
- `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` passed
  every browser bundle budget.
- `git diff --check` and `git diff --cached --check` passed. Added-line scans
  found no `as any`, `as never`, `as unknown`, or non-null assertions. The
  remaining added casts are literal/tuple `as const` narrowing and import
  aliases, not contract evasions.

## Baseline-red checks

- `npx tsc -p packages/tests/tsconfig.json --noEmit` remains red on the
  repository-wide Deno/Emscripten environment and stale test typing baseline.
  A normalized diagnostic count is 1,484 at this commit versus 1,704 at base
  `f1359859`: Task 7 reduces the baseline by 220 diagnostics and introduces no
  newly failing changed-file path. The plan's package and workspace
  typechecks, which are the governing compilations, all pass.
- `deno fmt --check` under `apps/api-v1` remains red on the same 12 files as
  base `f1359859`. The two Task 7 files that were newly outside the formatter
  (`api-v1-openapi.yaml` and `ws-topic-room-authorizer.test.ts`) were formatted;
  the check returned to the unchanged 12-file baseline.

## Follow-up

- No Task 7 implementation follow-up is required. Repository-wide cleanup of
  the known `packages/tests` TypeScript and API formatter baselines should be
  handled separately so it does not obscure the authoritative-contract change.
