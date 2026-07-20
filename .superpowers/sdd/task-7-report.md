# Task 7 report: authoritative shared contracts and OpenAPI

## Scope and implementation

- Base: `f1359859`.
- Implementation commit: `118eeb49` (`refactor: require authoritative state fields`).
- OpenAPI YAML correction commit: `b362586c`
  (`fix: correct authoritative OpenAPI required list`).
- Completion correction commit: `83fe0648`
  (`fix: complete authoritative contract hardening`).
- Aggregate invariant correction commit: `31a6bb35`
  (`fix: enforce authoritative aggregate invariants`).
- Final boundary correction commit: `e953d388`
  (`fix: complete authoritative boundary validation`).
- Final read-invariant correction commit: `baf647b4`
  (`fix: close authoritative read invariants`).
- Receipt replay closure commit: `c00b0c76`
  (`fix: close mutation receipt replay invariants`).
- Producer-boundary closure commit: `0b962673`
  (`fix: close persisted AL producer boundary`).
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
- Canonical network group snapshots now reject duplicate member/session
  identities, presence for non-active members, owner divergence, non-empty
  inactive-group presence, and incoherent aggregate counts. Canonical topology
  snapshots now enforce scoped overlay identity, timestamp order, canonical
  identifiers and routing keys, reciprocal unique non-self edges, degree and
  connectivity limits, and empty removed-overlay edges.
- RTC topology APP_OUTBOX reads now reuse the complete persisted AL envelope
  validator, including every present optional section and nested QoS option.
  Persisted group-member validation and legacy normalization both require the
  terminal audit selected by status and require the other terminal audits to
  be `null`.
- Public REST and WebSocket event consumers validate complete canonical event
  values, exact identity/scope, actor variants, causal values, and event-page
  cursors before returning or dispatching them.
- Topology PUT receipts retain the five accepted effective-config scalars.
  Sparse durable and temporary PUT replay therefore reconstructs the exact
  accepted result from compact receipt authority without rereading mutable
  rows or consulting possibly changed process defaults; DELETE receipts carry
  an explicit `acceptedConfig: null`.
- Client snapshots now require every active session to reference a declared
  client instance and require top-level `lastSeenAtEpochMs` to equal the
  repository's canonical maximum of principal last-seen and active-session
  heartbeat time. The repository and public validator share one pure helper
  for this derivation.
- Group snapshots now enforce the canonical revision lower bounds used by
  group snapshot validation and reject active membership above `maxMembers`;
  presence revisions retain their valid zero lower bound.
- Persisted multicast and room-broadcast AL targets require a workspace-bearing
  `GroupRef` before queued RTC authority reads or publication.
- Client snapshots reject duplicate instance and active-session identities.
  Client and group persistence assemblers reuse the shared pure authoritative
  validators before returning snapshots, so storage corruption cannot bypass
  public aggregate invariants.
- Group persistence assembly fails closed when active membership exceeds
  `maxMembers`; it intentionally does not reinterpret `maxSessionsPerMember`
  as a read invariant because admission limits may be lowered below existing
  live sessions.
- Persisted topology mutation receipts bind both `commandId` and `requestId`
  to their enclosing record request. Persisted room broadcasts require a
  complete group ref; world and all broadcast modes remain unchanged.
- RallarAI server broadcast input is now a discriminated contract: default or
  explicit room scope requires a complete workspace-bearing `GroupRef`, while
  world and all scope intentionally carry no room ref. Runtime callers and
  room generation-topic forwarding are validated before publication, and the
  canonical group ID owns the room route context.
- The complete persisted AL envelope validator now lives at a dependency-safe
  shared AL boundary. The former shared-server module re-exports it for import
  compatibility, and `WsQueueBoxServerService` invokes it for durable outbound
  policy before any QueueBox enqueue. Live-only messages remain outside the
  persistence validator.

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

- `npm run test:unit` passed: 449 files passed, 2 configured-skip files; 4,559
  tests passed and 13 environment-gated tests skipped.
- `npm run test:deno` passed end to end: API tests 223/223, black-box control
  tests 79/79, Relic server `deno task check`, and shared-test RTC scenarios
  146/146.
- `npm run typecheck` passed the root shared check and every workspace
  typecheck.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit` each passed.
- The final exact plan-mandated four-file Vitest command passed 4 files and
  59/59 tests. The completion-correction matrix covering canonical network
  validation, REST/WS event rejection, exact topology replay, scope cleanup,
  and affected fixtures passed 197 tests; four opt-in PostgreSQL tests were
  skipped by configuration.
- The first report HEAD, `23cf8b17`, did **not** pass the plan-mandated exact
  Vitest command. It exited 1 while collecting
  `rallar-group-docs-compat.test.ts`: `js-yaml` rejected the formatter-produced
  multiline flow sequence at `api-v1-openapi.yaml:5085` with
  `deficient indentation`. The other three files passed 52 tests, but the
  four-file result was red. Commit `b362586c` replaces only that sequence with
  valid block-list YAML. A fresh run of the same exact command then passed all
  4 files and 56/56 tests: `authoritative-state-contracts`,
  `rallar-group-docs-compat`, `data-caches`, and `api-workflows`.
- The plan-mandated exact API Deno command passed 43/43 tests across client
  state service, group state service, and graph topology routes.
- The final PGlite/admin/OpenAPI focused command passed 55/55 tests before the
  formatting regression. A post-format WebSocket authorizer/OpenAPI Deno check
  passed 15/15 tests, but that server parser did not exercise `js-yaml` and was
  insufficient evidence for the documentation compatibility suite. After
  `b362586c`, a fresh `deno test --allow-env --allow-read
  test/swagger-routes.test.ts` passed 12/12 tests and the exact js-yaml-backed
  Vitest command passed as recorded above.
- Shared-web browser boundary, browser entrypoint, and public API snapshot
  tests passed 3 files and 26/26 tests. The first attempted selection used
  nonexistent legacy filenames and correctly exited with “No test files
  found”; the corrected current filenames produced the result above.
- `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles` passed
  every browser bundle budget.
- `git diff --check` and `git diff --cached --check` passed. Added-line scans
  found no `Reflect` calls, `as any`, `as never`, `as unknown`, or non-null
  assertions. Added-line lock scans found no row/table/advisory lock usage.

## Completion-correction evidence

- Canonical validator RED: six malformed-value tests failed before the
  correction while 46 tests passed. GREEN: the validator, REST workflow, and
  WebSocket event suites passed 52/52 after complete value and identity
  validation was installed.
- Sparse replay RED: the two new durable/override replay tests returned values
  reconstructed from unrelated defaults rather than the accepted authority.
  GREEN: topology management, config service, and repository suites passed
  112/112 after receipts gained mandatory compact `acceptedConfig` authority.
- OpenAPI/docs GREEN: docs compatibility passed 6/6, and API Swagger passed
  12/12. PUT input uses the sparse patch schema, stored config uses the
  effective schema, temporary view state uses the stored override schema, and
  every lifecycle branch constrains its correlated audit/null fields.
- Scope correction restored `admin-operations-service.test.ts`,
  `postgres-app-data-concurrency.test.ts`, and
  `postgres-runtime-state-prefix.test.ts` to their exact `f1359859` content.
  Task-7-added `Reflect` type evasions were removed from the remaining affected
  tests; the RallarAI dependency contract now requests only the app-data
  store's `set` capability used by the facade.
- Full final gates passed: `npm run test:unit` (4,559/4,559 with 13 configured
  skips), `npm run test:deno` (API 223/223, control 79/79, shared-test RTC
  146/146, plus Relic server check), `npm run typecheck`, the three package
  TypeScript commands, the 43/43 exact API Deno command, browser bundle budgets,
  touched API format checks, YAML-backed docs parsing, and diff/scope/lock
  guards.
- The first correction-wide unit run failed 21 RTC topology tests because one
  test factory still emitted legacy `metadataVersion: 0`; after making that
  fixture canonical, its focused suite passed 24/24. A later full run hit one
  nondeterministic client-state concurrency failure; the isolated suite passed
  14/14 immediately, and two subsequent full unit runs each passed all 4,559
  tests. The first correction-wide Deno run failed type-checking one banned
  member fixture whose spread retained an impossible terminal audit; explicit
  correlated nulls fixed it, after which the focused test and two full Deno
  runs passed.

## Aggregate-invariant correction evidence

- RED command:
  `npx vitest run packages/tests/shared/authoritative-state-validation.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-web/rallar-group-docs-compat.test.ts`.
  It failed 20 tests while 108 passed: five group aggregate cases, ten topology
  graph/identity cases, three malformed optional AL-envelope cases, one
  contradictory terminal-audit case, and one OpenAPI parity case.
- GREEN on implementation commit `31a6bb35`: the same four-file command passed
  4/4 files and 129/129 tests after an additional multiple-owner regression
  case was included.
- The exact Task 7 command passed 4/4 files and 59/59 tests:
  `npx vitest run packages/tests/shared/authoritative-state-contracts.test.ts packages/tests/shared-web/rallar-group-docs-compat.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/api-workflows.test.ts`.
- The exact API Deno command passed 43/43 tests:
  `deno test -A test/services/client-state-service.test.ts test/services/group-state-service.test.ts test/routes/graph-topology-routes.test.ts`.
  The API Swagger command passed 12/12:
  `deno test --allow-env --allow-read test/swagger-routes.test.ts`.
- OpenAPI now requires nullable
  `ReconfigureGroupTopologyResponse.previous`. The actual TypeScript receipt
  contract's required-null `GroupTopologyConfigMutationReceipt.eventId` is
  represented as OpenAPI 3.1 `type: 'null'`; both js-yaml compatibility and API
  Swagger tests assert the exact shapes.
- `npm run test:unit` first exposed two noncanonical active-group fixtures in
  `state-mutation-outbox.test.ts`; both tests were red because the fixture
  declared an owner but contained no owner member. After canonicalizing that
  fixture, the focused state-mutation/RTC outbox command passed 72/72 and a
  fresh full unit run passed 449 files with two configured-skip files: 4,579
  tests passed and 13 environment-gated tests skipped.
- `npm run test:deno` passed end to end: API 223/223, black-box control 79/79,
  Relic server `deno task check`, and shared-test RTC scenarios 146/146.
- `npm run typecheck`, `npx tsc -p packages/shared/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit` all exited 0.
  `deno fmt --check test/swagger-routes.test.ts resources/api-v1-openapi.yaml`
  and `git diff --check` also passed.
- The non-governing
  `npx tsc -p packages/tests/tsconfig.json --noEmit --pretty false` remained at
  exactly 1,490 known baseline diagnostics, unchanged from
  `83fe0648`; the fresh regression tests introduced no increase.

## Final boundary-correction evidence

- RED command:
  `npx vitest run packages/tests/shared/authoritative-state-validation.test.ts packages/tests/shared-server/al-message-persistence-validation.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts`.
  Before production changes it failed 8 tests while 50 passed: missing client
  instance membership, divergent client last-seen authority, group capacity,
  zero group/state revision bounds, direct multicast and broadcast refs without
  workspaces, and the queued RTC missing-workspace boundary.
- Focused GREEN passed 4/4 files and 62/62 tests after including
  `black-box-operator-token.test.ts`. The final focused run, also including the
  heartbeat fixture exposed by the broad suite, passed 5/5 files and 66/66
  tests. Four adjacent repository, inbox, and outbox suites passed 375/375.
- The exact Task 7 Vitest command passed 4/4 files and 59/59 tests. The exact
  API Deno command passed 43/43 tests, and API Swagger passed 12/12.
- The first full `npm run test:unit` run correctly rejected the heartbeat
  test's stale mocked client snapshot because its active session had no matching
  instance. After adding a canonical active instance to that fixture, the
  focused heartbeat suite passed 4/4 and a fresh full unit run passed 450 files
  with two configured-skip files: 4,587 tests passed and 13 environment-gated
  tests skipped.
- `npm run test:deno` completed its full `&&`-chained API, black-box control,
  Relic server, and shared-test RTC gates, reaching the final shared-test result
  of 146/146 passed. `npm run typecheck` and the explicit shared,
  shared-server, and shared-web TypeScript commands all exited 0.
- `black-box-operator-token.test.ts` is byte-for-byte identical to base
  `f1359859`; `git diff --exit-code f1359859 --` for that path exited 0 with
  empty output. `git diff --check` passed, and scans found no newly added type
  evasions or database locks.

## Final read-invariant correction evidence

- Exact RED command:
  `npx vitest run packages/tests/shared/authoritative-state-validation.test.ts packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/al-message-persistence-validation.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts`.
  Before production changes it failed 8 tests while 203 passed: public client
  duplicate identities; repository missing-instance, duplicate-session, and
  repeated-instance corruption; over-capacity group assembly; a persisted
  receipt request mismatch; and direct plus queued room broadcasts without a
  group ref.
- The requested adjacent audit found that a repeated inactive member could
  bypass GroupStateRepository's active-roster checks. Its separate RED run
  failed 1 test while 74 passed. Reusing the shared pure group snapshot
  validator at assembly closes that duplicate-identity gap without adding a
  `maxSessionsPerMember` read invariant.
- Focused GREEN passed all 6 files and 212/212 tests. Seven directly affected
  repository, snapshot-cache, replay, RTC outbox, and mutation-outbox suites
  passed 445/445.
- The exact Task 7 Vitest command passed 4/4 files and 59/59 tests. The exact
  API Deno command passed 43/43 tests, and API Swagger passed 12/12.
- `npm run typecheck` passed the root shared check and every workspace. The
  explicit shared, shared-server, and shared-web TypeScript commands also
  exited 0.
- A fresh full `npm run test:unit` passed 450 files with two configured-skip
  files: 4,596 tests passed and 13 environment-gated tests skipped. The broader
  Deno chain was not rerun for this correction; its directly affected exact API
  and Swagger commands are recorded above.
- `black-box-operator-token.test.ts` remains byte-for-byte identical to
  `f1359859`. `git diff --check` and added-line scans found no type evasions,
  `Reflect` calls, or database locks.

## OpenAPI YAML correction evidence

- RED on report HEAD `23cf8b17`: the exact four-file Vitest command exited 1
  with one failed suite, three passed files, and 52 passed tests because
  `js-yaml` reported `deficient indentation (5085:7)`.
- Root cause: `deno fmt` changed the six-item `required` flow sequence for
  `GroupTopologyConfigAcceptedCausalRevision` into an invalid multiline flow
  sequence. Nearby OpenAPI schemas use stable YAML block lists.
- GREEN on `b362586c`: the unchanged parser and required-field assertions in
  `rallar-group-docs-compat.test.ts` passed as part of the exact four-file
  command: 4 files and 56/56 tests.
- A fresh `npm run test:unit` after `b362586c` passed 449 files with 2
  configured-skip files; 4,549 tests passed and 13 environment-gated tests
  skipped.
- `deno test --allow-env --allow-read test/swagger-routes.test.ts` passed
  12/12 tests.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-server/tsconfig.json --noEmit`, and
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit` each exited 0.
- `deno fmt --check resources/api-v1-openapi.yaml` and `git diff --check`
  each exited 0 before the correction implementation commit.

## Receipt replay and causal-shape closure evidence

- The exact pre-production RED command was
  `npx vitest run packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-server/state-mutation-outbox.test.ts`.
  It exited 1 with 5 failing tests and 136 passing tests: malformed persisted
  client applied/no-op receipts, malformed group receipt outcome correlations,
  a client accepted-causal revision with an extra outer field, and a group
  causal tuple with an extra nested field were all incorrectly accepted.
- Two producer-driven adjacent RED cycles covered the remaining exact
  correlations. The client canonical-outbox and group authority-shape cases
  failed 2 tests while 92 passed before their checks were added. Removing only
  the new predecessor correlations made the divergent-revision regressions
  fail 3 tests while 91 passed; restoring the correlations made the same
  selection pass 94/94.
- Client persisted receipts now require a concrete nonnegative accepted storage
  revision, require `stateRevision = acceptedStorageRevision + 1`, require one
  canonical recomputed outbox ID for `applied`, and require no event or outbox
  effect for `no-op`. Valid revision-zero insert and no-op receipts remain
  accepted.
- Group receipts now enforce each producer outcome separately. Applied receipts
  require concrete accepted authority, positive group/snapshot authority, an
  event, and one outbox ID. No-op receipts require the exact group predecessor,
  positive snapshot authority, and no event, outbox, join-code, or rejection.
  Existing-group rejection binds the group predecessor; absent-group rejection
  preserves the valid null accepted revision and all-zero authority tuple.
- State mutation outbox construction and persisted reads now exact-check the
  four-field client accepted-causal revision and the two-field nested group
  causal tuple. Unknown fields fail at both boundaries instead of surviving or
  being projected away.
- The final directly affected Vitest command passed 7/7 files and 176/176
  tests. The exact Task 7 Vitest command passed 4/4 files and 59/59 tests. The
  exact API command passed 43/43 tests, and API Swagger passed 12/12.
- `npm run typecheck` and the explicit shared, shared-server, and shared-web
  TypeScript commands all exited 0. The non-governing
  `packages/tests/tsconfig.json` command remained red with 1,496 diagnostics;
  filtering the touched receipt/outbox paths reported only the two pre-existing
  `group-state-concurrency.test.ts` diagnostics at unchanged lines 538 and 740,
  with no diagnostics in the new tests or changed production files.
- `git diff --check` and `git diff --cached --check` passed. Added-line scans
  found no `Reflect` calls, `as any`, `as never`, `as unknown`, or database-lock
  additions. `state-write-performance-harness.test.ts` and
  `production-env-hardening.test.ts` are included in `c00b0c76` as intentional
  restorations and compare byte-for-byte equal to base `f1359859`.
- The broader `npm run test:unit` and `npm run test:deno` chains were not rerun
  for this narrow closure; the fresh directly affected, exact Task 7, exact API,
  Swagger, and compiler gates above are the governing evidence for this commit.

## Persisted AL producer-boundary closure evidence

- The exact pre-production RED command was
  `npx vitest run packages/tests/shared-server/rallar-ai-server.test.ts packages/tests/shared/ws-server-qos-policy.test.ts packages/tests/api-v1/rallar-server-ws-facade.test.ts`.
  It exited 1 with 5 failing tests and 36 passing tests: RallarAI did not derive
  the route context from its canonical room ref, accepted an incomplete
  workspace ref, forwarded a room generation result without a ref, and both
  the direct queue service and router persisted a room broadcast without a
  canonical target.
- The same focused command passed 41/41 after the correction. The final
  validator/RallarAI/queue/router/state-sync/RTC-outbox selection passed 6/6
  files and 81/81 tests. The RallarAI shared, browser, and server selection
  passed 36/36, and the receipt/outbox Task 7 selection passed 173/173.
- A producer audit found no direct shared-server `WS_OUTBOX` repository write:
  router and state-sync persistence both enter through
  `WsQueueBoxServerService.enqueueOutboxIfAbsent`. RallarAI now constructs a
  canonical target, topology publication already supplies one, and legacy
  router/game room helpers cannot persist an unscoped envelope because the
  generic boundary rejects it. State sync uses intentional `all` scope.
- A fresh `npm run test:unit` passed 450 files with two configured-skip files:
  4,604 tests passed and 13 environment-gated tests skipped. The exact Task 7
  command passed 59/59, the exact API Deno command passed 43/43, and Swagger
  passed 12/12.
- `npm run typecheck` and explicit shared, shared-server, and shared-web
  TypeScript commands all exited 0. The non-governing
  `packages/tests/tsconfig.json` command remained at exactly 1,496 baseline
  diagnostics. Touched-path filtering reported only the two existing
  `group-state-concurrency.test.ts` union diagnostics and the existing
  `ws-server-qos-policy.test.ts` Temporal diagnostic; the new RallarAI, router,
  queue, and persisted-validator code introduced none.
- Task-7-added non-null assertions in the two group-state persistence tests
  were replaced with explicit fixture narrowing. `git diff --check` and
  staged `git diff --cached --check` passed; added-line scans found no
  `Reflect` calls, `as any`, `as never`, `as unknown`, non-null assertions, or
  database locks. The two intentional restoration files remain byte-for-byte
  equal to base `f1359859`.

## Baseline-red checks

- `npx tsc -p packages/tests/tsconfig.json --noEmit` remains red on the
  repository-wide Deno/Emscripten environment and stale test typing baseline.
  A normalized diagnostic count is 1,490 at correction commit `83fe0648`
  versus 1,704 at base `f1359859`: Task 7 reduces the baseline by 214
  diagnostics. The requested restoration of unrelated pre-Task-7 admin/CRDT
  and PostgreSQL test typing is intentionally visible in this broad
  non-governing project; the package and workspace typechecks, which are the
  governing compilations, all pass.
- `deno fmt --check` under `apps/api-v1` remains red on the same 12 files as
  base `f1359859`. The two Task 7 files that were newly outside the formatter
  (`api-v1-openapi.yaml` and `ws-topic-room-authorizer.test.ts`) were formatted;
  the check returned to the unchanged 12-file baseline.

## Follow-up

- No Task 7 implementation follow-up is required after `0b962673`.
  Repository-wide cleanup of
  the known `packages/tests` TypeScript and API formatter baselines should be
  handled separately so it does not obscure the authoritative-contract change.
