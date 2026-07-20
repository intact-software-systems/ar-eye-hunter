# Task 6 report: optimistic RTC topology and RTT convergence

## Scope and implementation

- Base: `d1ef2a6e1032583d756d1c13b4d82e64861ae889`.
- Clean implementation commit:
  `21d28525e048c92a9176f08682efb3cbd37314b2`.
- Initial Task 6 report commit:
  `fbd457667b31f59eb5fab29927c885a94a1cf1e7`.
- Review-correction implementation commit:
  `cad8207025188368153b1983b84ef64cf437c343`.
- Topology snapshots, immutable publication/work claims, topology execution,
  RTT latest values, endpoint admissions, RTT receipts, and recompute intents
  now use conditional insert, expected-revision CAS/delete, and short atomic
  transactions. No targeted topology/publication/RTT path calls `lockKey`, row
  locks, table locks, or advisory locks.
- The visible orchestration retry policy is bounded `[0, 2, 8]` ms. Every
  conflict returns to read and reloads the complete authority set before
  recomputing and revalidating. Repository compatibility methods do not hide a
  general mutation retry loop; explicit offline migration and lazy-expiry
  cleanup use their own bounded conflict handling.

## Architecture and behavior

- `rtc-topology-mutations.ts` defines the topology and RTT read, compute,
  validate, and write seams. Named compute/validate functions are synchronous
  and deterministic. Their branch matrix is called twice with deep-frozen
  inputs, including absent, duplicate, advanced, loaded, superseded, stale,
  policy rejection, endpoint-cap, and corruption outcomes.
- Graph planning is deliberately attempt-local read preparation. Each attempt
  loads fresh group, config, RTT, predecessor, and publication authority,
  captures time, and derives the graph candidate from those frozen facts.
  Only then do the named database-mutation compute/validate phases run. This
  preserves existing graph-planner metrics without permitting repository,
  clock, cache-observation, or other ambient access in mutation
  compute/validate. The same boundary is recorded in Task 10 of the plan.
- Repository-backed reconfigure, reconcile, and due-flush paths no longer make
  redundant group/config/RTT/snapshot pre-reads before the attempt loop.
  Repository-backed due flush claims due work without calling cache-mutating
  `updateGroupTopology`; the process cache is observed only after a durable
  accepted, duplicate, or superseding result. Three forced CAS conflicts leave
  no phantom local snapshot.
- Snapshot CAS rejects equal causal tuple with different content. Stale removal
  rereads current group authority and cannot remove a refreshed active
  topology. A winner is observed in the process cache only after the durable
  decision is known.
- A topology transaction guards the snapshot first, then conditionally claims
  scoped work and inserts its deterministic immutable publication. The work
  claim is the compact execution receipt and the publication payload is the
  retryable state-sync delivery intent. Failure at any dependent insert rolls
  the complete transaction back. Corrupt durable replay fails closed before
  fanout.
- Publication validation binds canonical physical key, full `GroupRef`, work
  ID, deterministic publication ID, source group revision, overlay version,
  recipients, and the complete validated topology payload. Scoped lookup
  distinguishes absent workspace from literal `_`, delimiters, percent text,
  and Unicode lookalikes.
- Cluster notifications preserve wire compatibility as an exact discriminated
  union. Current writers emit scoped v2 notifications. Exact legacy v1 messages
  remain readable through the validated unscoped publication lookup for rolling
  deployment; a v1 message carrying v2 fields is rejected. Tests cover legacy
  delivery and v2 separation of absent workspace from literal `_`.
- RTT acceptance reloads the current measurement, both endpoint admissions,
  every relevant measurement, group authority, topology, and reporting policy
  on each attempt. Endpoint admissions are expiring leases. Both endpoint
  guards are written in lexical statement order, followed atomically by the
  latest measurement, mandatory compact receipt, and mandatory per-group
  recompute intents. A capacity loser rereads and returns rejected without a
  measurement.
- RTT receipts and recompute intents have deterministic canonical IDs and an
  independent 24-hour retention contract. Restart-safe drainers enqueue before
  revision-guarded deletion; concurrent drainers may enqueue a coalescible
  duplicate but exactly one deletes the intent.
- Direct, list, prefix, and page reads validate raw JSON, exact keys, canonical
  decoded scope/child identity, trusted requested slot, mandatory fields, and
  physical expiry before lazy expiry can delete a row. Corruption raises
  `rtc-topology-repository-invariant-corruption`.
- Snapshot, publication/work-claim, and RTT legacy keys move only through
  explicit value-verified offline migrations requiring
  `{ oldWritersStopped: true }`. Conditional destination creation, equal-value
  partial-destination recovery, observed-revision source deletion, rollback,
  bounded retries, and idempotent reruns are covered. Runtime/startup paths do
  not dual-read or implicitly migrate ambiguous keys.
- Every optimistic attempt emits read, compute, validate, transaction, write,
  conflict, attempt, and backoff timing. Graph planning belongs to the read
  preparation timing boundary; no retry delay or domain read occurs inside the
  write transaction.
- The Task 6 shared-web gate exposed one stale test fixture that omitted the
  already-required group causal revision. The fixture now supplies the
  revision; no shared-web production behavior changed.

## RED evidence

- The initial snapshot/publication/RTT repository and WebSocket command exited
  1 with 12 failures and 24 passes. Failures demonstrated calls to lock-backed
  APIs, ambiguous keys, unsafe expiry, missing migration behavior, publication
  collision/race gaps, and non-atomic RTT endpoint-cap decisions.
- The first pure-mutation test command exited 1 before collecting tests because
  `rtc-topology-mutations.ts` did not exist.
- The management/WebSocket RED command exited 1 with 4 failures and 63 passes,
  exposing lock use, absent bounded backoff, and incomplete mutation phase
  timing.
- An intermediate full shared-server run exited 1 with 4 failures, 691 passes,
  and 12 configured skips. The four failures were old outbox tests assuming an
  immutable envelope snapshot and pre-CAS repository APIs; the production
  retry path and tests were corrected to resolve fresh authority and reuse the
  durable winner.
- The final plan-mandated shared-web matrix first exited 1 with 1 failure and
  157 passes because `data-caches.test.ts` supplied a pre-Task-4 group fixture
  without `causalRevision`; adding the mandatory fixture field made the same
  matrix pass 158/158.
- Review-driven adversarial tests additionally cover durable publication
  tampering before replay, v1/v2 exact notification shapes, literal `_` versus
  absent workspace routing, and an exhausted due-flush CAS sequence that must
  not create a process-cache snapshot.

## GREEN evidence

- `npx vitest run packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rtc-topology-cluster-transport.test.ts packages/tests/shared-server/rtc-topology-mutations.test.ts packages/tests/shared-server/rallar-rtc-topology-service.test.ts packages/tests/api-v1/rtc-topology-cluster-transport.test.ts packages/tests/shared-web/data-caches.test.ts`
  passed 9 files and 158/158 tests.
- `npx vitest run packages/tests/shared-server` passed 58 files with 2
  configured-skip files; 700 tests passed and 12 were skipped. The skipped
  tests are environment-gated PostgreSQL cases, not silent Task 6 omissions.
- `RALLAR_POSTGRES_INTEGRATION=1 DATABASE_URL=postgres://app:app@localhost:5432/appdb npx vitest run packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts`
  passed 1 file and 11/11 tests against live PostgreSQL. The Task 6 additions
  use independent clients and true overlap to prove one convergent topology
  winner and one bounded endpoint-cap RTT acceptance.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`,
  `npx tsc -p packages/shared-web/tsconfig.json --noEmit`, and
  `npm --workspace @ar-eye-hunter/shared-test run typecheck` passed.
- `npm run typecheck` passed the root shared check and every workspace
  typecheck, including shared-server, shared-web, shared-test, and all app
  workspaces.
- `deno task --config deno.json check` from `apps/api-v1` passed
  `deno check src/main.ts`.
- Targeted scans found no unconditional `.upsert`, `deleteByKey`, `lockKey`,
  deleted lock helper, `FOR UPDATE`, or `pg_advisory` reference in the Task 6
  topology/publication/RTT repositories and orchestration paths.
- `git diff --cached --check` passed before the implementation commit.

## Review-correction evidence

### Corrected invariants

- A claimed publication is compared with the independently read durable
  snapshot. An equal causal tuple requires semantic, object-key-order-neutral
  equality; divergent content is typed corruption. A newer durable snapshot
  may coexist with an older immutable publication, while a publication ahead
  of its snapshot is a retryable torn observation.
- A committed work claim is replayed even after group authority advances. The
  stale group-revision shortcut applies only before a claim exists, preserving
  restart-safe fanout of the durable immutable winner.
- Equal-version RTT values are duplicate only when every canonical field is
  equal. Divergent equal-version content is typed corruption in both the pure
  mutation and compatibility paths. A compatibility CAS race throws
  `RuntimeStateWriteConflictError`; only exact duplicate or strictly stale input
  returns `false`, and the method contains no hidden retry.
- RTC pair, endpoint-peer, weighted-edge, and topology tie-break ordering uses
  one exact UTF-16 code-unit comparator. No RTC identity decision depends on
  locale collation, including composed and decomposed Unicode identifiers.
- Publication expiry is a mandatory nullable mutation fact. Publication plus
  numeric expiry is a discriminated write invariant; expiry is materialized
  outside the transaction, validated before `begin`, and never obtained through
  a non-null assertion or transaction-time clock read.
- Direct topology reconfiguration and removal use the same named
  `readTopologyMutation` / `writeTopologyMutation` execution seam as outbox
  work. Transaction timing surrounds the actual transaction, and the
  unconditional snapshot overwrite helper was removed.
- RTT lifecycle facts are read and validated on every optimistic attempt. A
  conflict rereads current time and authority, re-evaluates expired endpoint
  leases and capacity, and derives a fresh purge expiry while the submitted
  measurement payload remains stable.

### Correction RED evidence

- The seven ranked review findings first failed the four focused files with 12
  failures and 94 passes. Failures covered publication-ahead torn reads,
  missing explicit expiry, equal-version RTT divergence, the unconditional
  snapshot helper, transaction-time clock access, locale-dependent Unicode
  pair keys, skipped claimed-work replay, corrupt/torn replay, and direct writes
  bypassing the shared execution transaction.
- The first correction GREEN attempt passed 105 tests and failed one obsolete
  test mock that still intercepted the removed snapshot helper. Moving that
  forced conflict to the shared transaction seam made the same four files pass
  106/106.
- A supplemental topology-planner Unicode test failed 1 test with 30 passing:
  locale collation preserved the wrong equal-weight edge order. The shared
  exact comparator made the file pass 31/31.
- Two binding lifecycle tests then failed with 2 failures and 31 passes: a
  malformed publication expiry entered and committed a transaction, and RTT
  retry reused absent/static lifecycle facts after a clock-crossing conflict.
  Explicit pre-transaction narrowing and mandatory attempt-local `readFacts`
  made the file pass 33/33.
- The final compatibility RED failed 1 test with 33 passing because a forced
  RTT CAS race returned `false`. It now raises the typed write conflict, and the
  repository file passes 34/34.

### Final correction GREEN evidence

- The final nine-file focused command covering topology mutations,
  repositories, outbox, direct management, WebSocket topics, cluster
  transports, topology planning, api-v1 transport adaptation, and browser data
  caches passed 9 files and 173/173 tests.
- `npx vitest run packages/tests/shared-server --reporter=dot` passed 58 files
  with 2 configured-skip files; 715 tests passed and 12 environment-gated tests
  were skipped.
- `npm run typecheck` passed the root shared check and every workspace
  typecheck. `npx tsc -p packages/shared-server/tsconfig.json --noEmit` also
  passed during the focused lifecycle correction.
- `deno task --config deno.json check` from `apps/api-v1` passed
  `deno check src/main.ts`.
- `RALLAR_POSTGRES_INTEGRATION=1 DATABASE_URL=postgres://app:app@localhost:5432/appdb npx vitest run packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts --reporter=dot`
  passed 1 file and 11/11 tests against live PostgreSQL after the expected
  sandbox-denied localhost attempt was rerun with local database access.
- Final scans found no unconditional `.upsert`, `.putValue`, `deleteByKey`,
  `lockKey`, `putSnapshot`, `FOR UPDATE`, `pg_advisory`, locale-sensitive RTC
  identifier comparison, or publication-expiry non-null assertion in the
  corrected paths. `git diff --check` and `git diff --cached --check` passed.
- A non-governing exploratory `packages/tests/tsconfig.json` check still sees
  the repository's broad pre-existing Deno/Emscripten and stale-fixture type
  baseline. The governing root/workspace and api-v1 checks above are green.

## Second review correction: receipt replay and persisted contract completeness

### Scope and commits

- Review-correction base:
  `614b64db93a13593656db86090c49182fbffa02d`.
- Second review implementation commit:
  `c123eac1d88ac1402ab2070a31d069f0d06f1af9`.
- A stale removal trigger now cancels only when fresh authority is active at
  the captured planning time. Newer archived, deleted, or logically expired
  authority replans a tombstone from that fresh snapshot; a topology CAS
  conflict returns to the complete authority and predecessor read.
- RTT mutation execution computes one canonical SHA-256 command hash from
  `{ rtt, alSenderId }` before attempt zero. Every attempt reads the immutable
  pair/version receipt. Matching receipts are explicit accepted replays with
  `updated: false`; a different hash raises typed
  `rtc-rtt-idempotency-conflict`, including after measurement and endpoint
  admission expiry. Receipts remain compact, while receipt and recompute
  intent validators require the exact lowercase hash shape. Recompute outbox
  IDs include the command hash, so first-writer identity is cryptographically
  bound without changing the pair/version receipt slot.
- `group-snapshot-validation.ts` is the single complete persisted
  `GroupSnapshot` validator for later Task 7 hardening. It composes the shared
  group/member/presence validators and enforces exact top-level fields,
  canonical scope, causal revision projection, owner and active-member facts,
  unique session/member identities, and online presence consistency.
- `al-message-persistence-validation.ts` validates the complete durable AL
  envelope while retaining documented optional sections. Topology publication
  validation additionally requires and binds the builder-mandatory id, route,
  payload, audit, room-broadcast targets/groupRef, and delivery sections to the
  exact RTC topic, route resource, and topology snapshot.

### Second correction RED evidence

- The initial four-file RED command failed exactly 12 tests with 109 passing
  across 121 tests. The failures covered newer-terminal removal, removal CAS
  reread, frozen receipt replay/divergence, post-expiry replay, concurrent
  first writers, receipt and nested snapshot validation-before-cleanup, AL
  envelope direct/list/page reads, and missing id/route/typeId before replay
  fanout.
- The first production attempt failed 14 tests with 107 passing. Four old pure
  RTT inputs omitted the newly mandatory receipt/hash facts; eight runtime RTT
  cases used a snapshot fixture whose state revision contradicted its causal
  tuple; one publication fixture used the obsolete sparse envelope; and one
  removal test expected a concurrent row that the fake transaction correctly
  rolled back. Fixtures were completed; validators were not weakened.
- Expanding the WebSocket gate exposed four more incomplete group fixtures:
  missing `activeMemberCount`/`ownerPrincipalId`, no owner member, and an
  invalid zero metadata revision. The five-file slice then passed 141/141.
- The first unsandboxed live PostgreSQL rerun exposed two equivalent strict
  fixture violations in the topology publication and RTT group helpers. After
  completing those contracts, the same live test passed 11/11.

### Second correction GREEN and baseline evidence

- The final nine-file Task 6 matrix passed 9/9 files and 188/188 tests.
- `npx vitest run packages/tests/shared-server --reporter=dot` passed 58 files
  with 2 configured-skip files; 730 tests passed and 12 environment-gated
  PostgreSQL tests were skipped.
- `npm run typecheck` passed the root shared check and every workspace
  typecheck. `deno task check` in `apps/api-v1` passed, and the full
  `deno task test` passed 210/210 tests.
- `RALLAR_POSTGRES_INTEGRATION=1 DATABASE_URL=postgres://app:app@localhost:5432/appdb npx vitest run packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts --reporter=dot`
  passed 1/1 file and 11/11 tests after the expected sandbox-denied localhost
  attempt was rerun with local database access.
- The root-wide `npm run test:unit` is **not claimed as passing**. It finished
  with 445 passed files, 2 configured-skip files, 1 failed file; 4,235 tests
  passed, 12 skipped, and 7 failed. All seven failures are the untouched
  `packages/tests/shared-web/rallar-workflow-options-compat.test.ts` baseline
  concerning pre-existing workflow mock argument positions and retry-policy
  expectations. The related shared-server cluster failures first exposed by
  the new envelope validator were corrected and are green.
- Final targeted scans found no unconditional `.upsert`, `.putValue`,
  `deleteByKey`, `lockKey`, `putSnapshot`, `FOR UPDATE`, `pg_advisory`,
  locale-sensitive RTC identity comparison, or publication-expiry non-null
  assertion in the corrected paths. Both `git diff --check` and the staged
  implementation `git diff --cached --check` passed, including the two new
  validator files.

## Final (fourth) review correction: replay purity and complete publication facts

### Scope and implementation commit

- Review-correction base:
  `879241ddcc526b7b63fccf241cc49ba390135c00`.
- Implementation commit:
  `e8ebe59d17ca7a6905dbf5cc69212393fe0de4c7`.
- Receipt replay now reads and validates the durable receipt first and returns
  from that receipt alone. Exact replay performs no measurement, admission,
  list, transaction, conditional-write, delete, or recompute-outbox work;
  divergent command hashes fail from the receipt alone.
- RTC topology publication facts are captured once before optimistic attempt
  zero. The retry loop reuses one deterministic message ID and requested time,
  and a pure materializer constructs the complete persisted AL candidate
  without clocks, randomness, or AL builders. The ambient compatibility helper
  is deprecated and explicitly restricted to non-retry publication paths.
- Persisted topology snapshots now validate the complete graph invariant on
  direct, list, page, and publication reads: scoped overlay identity, canonical
  unique sessions and routes, exact route keys, known non-self reciprocal
  peers, positive degree limit, connectivity and degree bounds for active
  graphs, empty edges for retained-session tombstones, and non-inverted
  timestamps. Production planners canonicalize session order and emit removed
  snapshots with a positive degree limit.
- Publications require `targetGroupSnapshotVersion` and bind it exactly to the
  room broadcast target. Publication ID, route, payload snapshot, recipient
  set, audit time, message time, and publication time are validated as one
  immutable contract before cleanup or fanout.
- The explicit `migrateLegacyRtcTopologyPublicationKeys` offline migration can
  upgrade true old rows that omit the target-version field. It validates the
  legacy AL envelope and topology, derives the version from the required room
  target, and rebinds message/audit time to the publication creation fact.
  Partial canonical destinations converge, reruns are idempotent, and
  divergent destinations fail closed. Normal reads still reject the old shape;
  repository-wide search confirms the value upgrade has no startup or runtime
  caller outside the explicit migration.
- A shared collision-safe unordered pair encoder uses exact UTF-16 code-unit
  order plus a JSON tuple. Weighted RTT graph deduplication and successor work
  identity both use it, preserving delimiter-bearing and Unicode-lookalike
  endpoint pairs.
- The topology-removal conflict proof now distinguishes a rolled-back
  transaction-local write from an independently committed moved predecessor.
  The retry rereads both group authority and the committed predecessor before
  producing the convergent tombstone.

### Final correction RED evidence

- The first four-file review RED command collected 209 tests and exited 1 with
  3 failed files, 1 passed file, 67 failures, and 142 passes. The failures
  covered receipt replay authority reads/effects, missing target-version
  binding, accepted timestamp drift, ambient retry randomness, corrupt graph
  replay fanout, delimiter pair collisions, and all four persisted topology
  validation surfaces.
- The follow-up migration/degree audit RED command collected 110 tests and
  exited 1 with 8 failures and 102 passes. Four failures showed that the
  explicit migration could not upgrade real missing-field legacy rows or
  recover partial destinations; four showed that zero-degree removed snapshots
  remained readable through direct, list, page, and publication surfaces.

### Final correction GREEN and baseline evidence

- The migration/degree repository file passed 110/110 tests. This includes
  strict normal-read rejection of the old shape, missing-field value upgrade,
  claim-only and publication-only destination recovery, idempotent rerun,
  divergent-destination rejection, positive-degree tombstone acceptance, and
  zero-degree rejection on all four read surfaces.
- The four-file focused review command passed 4/4 files and 216/216 tests. The
  final nine-file Task 6 matrix passed 9/9 files and 261/261 tests.
- `npx vitest run packages/tests/shared-server --reporter=dot` passed 58 files
  with 2 configured-skip files; 803 tests passed and 12 environment-gated tests
  were skipped.
- `npm run typecheck` passed the root shared check and every workspace
  typecheck. `deno task check` in `apps/api-v1` passed, and the full
  `deno task test` passed 210/210 tests.
- `RALLAR_POSTGRES_INTEGRATION=1 DATABASE_URL=postgres://app:app@localhost:5432/appdb npx vitest run packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts --reporter=dot`
  passed 1/1 file and 11/11 tests against live PostgreSQL after the expected
  sandbox-denied localhost attempt was rerun with local database access.
- The root-wide `npm run test:unit` remains **not claimed as passing**. It
  completed with 445 passed files, 2 configured-skip files, and 1 failed file;
  4,309 tests passed, 12 skipped, and 7 failed. The same seven untouched
  `packages/tests/shared-web/rallar-workflow-options-compat.test.ts` baseline
  failures concern pre-existing workflow mock argument positions and retry
  policy expectations.
- Final scans found no unconditional `.upsert`, `.putValue`, `deleteByKey`,
  `lockKey`, `putSnapshot`, `FOR UPDATE`, or `pg_advisory` reference in the
  Task 6 persistence/orchestration paths; pair-identity paths contain neither
  `localeCompare` nor the former `::` delimiter encoding. `git diff --check`
  and staged implementation `git diff --cached --check` passed.

## Environment, performance, and artifacts

- An early sandboxed live PostgreSQL attempt was denied local network access;
  the approved elevated rerun connected and passed all 11 tests. This was an
  execution-environment restriction, not a product failure.
- Task 6 changes no REST behavior, so no API black-box recipe was required by
  the repository handoff contract. Cluster protocol compatibility is covered
  at both shared-server and api-v1 adapter boundaries.
- Task 6 has no plan-owned candidate performance artifact. It removes targeted
  lock waits and redundant pre-reads and adds phase/conflict telemetry, but it
  does not claim the governed Task 10 performance budgets. Task 10 still owns
  candidate generation, baseline comparison, SQL/row/latency/throughput/retry
  acceptance, and the medium-scale/browser profiles.

## Residuals and follow-up

- `RuntimeStateTransactionalRepositoryLike.lockKey` remains because
  out-of-scope auth-ticket coordination still consumes the general interface.
  Task 10 must list that residual and must not treat it as topology precedent.
- Queue claiming semantics remain out of scope. RTT recompute intent draining
  is optimistic and idempotent, but changing the general queue coordination
  contract requires a separate reviewed plan.
- Exact v1 legacy cluster notification support remains for rolling deployment.
  New writers emit v2; removal of v1 requires an explicit old-publishers-stopped
  cutover rather than silently redefining v1.
- Tasks 7-10 were not started. Task 7 still owns the repository-wide
  authoritative optional-field/OpenAPI hardening, and Task 10 owns final
  performance and full black-box acceptance.
