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

## Fifth review correction: receipt-first orchestration and durable intent identity

Implementation commit: `151e4fd2` (`fix(rtc): enforce receipt-first convergence contracts`),
based on reviewed Task 6 report commit `a52c452c`.

### Corrected behavior

- The websocket/runtime RTT path now hashes the stable request before attempt
  zero and reads the immutable receipt before any group, topology, policy,
  lifecycle, measurement, admission, or recompute-intent state. Exact receipt
  replay uses explicit receipt-only command/fact variants with required `null`
  fields and does not invoke the authority or lifecycle readers. Divergent
  receipts fail closed before those readers or any write effect.
- Effectful RTT orchestration moved to
  `services/rtc-rtt-mutation-service.ts`. The mutation module is synchronous
  and pure; the service visibly performs read, compute, validate, and write in
  order, and only `writeRttMutation` opens the transaction. Stable `[0, 2, 8]`
  millisecond retry waits remain outside transactions, and every conflict
  rereads from the receipt boundary.
- A single recursive semantic equality helper now provides object-key-order
  neutrality while preserving array order. Snapshot decisions, persisted
  snapshot/publication/work comparisons, migrations, service reconciliation,
  and cluster replay use this contract instead of serialization order.
- Publication message IDs are derived deterministically from `workId`. Direct,
  list, page, and replay paths validate the binding strictly. The explicit
  offline legacy migration reconstructs deterministic message ID, target
  version, and publication/audit time before conditional convergence.
- RTT receipt affected-group references are canonical, unique, and strictly
  sorted, with exactly one recompute intent per reference. Every live intent is
  cross-checked against its immutable receipt ID, command hash, accepted time,
  group reference, active group lifetime, and pair-session membership/lifetime.
  Direct, list, page, and drain surfaces fail closed, while expired intent and
  receipt cleanup remains joint and idempotent.

### Fifth correction RED evidence

- The initial focused four-file command collected 199 tests and failed 49
  tests, with 150 passing. The failures covered the missing pure/effect split,
  receipt-only null contracts, receipt-first runtime behavior, canonical group
  references, semantic object-order replay, deterministic publication IDs and
  legacy migration, tampered direct/list/page/replay publications, receipt
  reference validation, and intent/receipt cross-checking.
- A supplemental filtered liveness test failed 4 of 8 exercised cases before
  the fix, demonstrating that expired active groups were accepted through
  direct, list, page, and drain intent surfaces. Expired pair-session cases were
  already rejected by persisted-group validation and stayed covered.

### Fifth correction GREEN, baseline, and architecture evidence

- The final focused four-file review command passed 4/4 files and 207/207
  tests. The nine-file Task 6 matrix passed 9/9 files and 310/310 tests.
- `npx vitest run packages/tests/shared-server --reporter=dot` passed 58 files
  with 2 configured-skip files; 852 tests passed and 12 environment-gated tests
  were skipped.
- The live PostgreSQL concurrency command passed 1/1 file and 11/11 tests. The
  first attempt was sandbox-denied; after local database access was approved,
  one legacy random publication fixture exposed the new deterministic-ID
  contract, was corrected, and the rerun passed fully.
- `npm run typecheck` passed the root and all workspace checks. In
  `apps/api-v1`, `deno task --config deno.json check` passed and
  `deno task --config deno.json test` passed 210/210 tests.
- Root-wide `npm run test:unit` remains explicitly **not claimed as passing**:
  445 files passed, 2 were configured skips, and 1 failed; 4,350 tests passed,
  12 skipped, and the same 7 tests failed in the untouched
  `packages/tests/shared-web/rallar-workflow-options-compat.test.ts` baseline.
  That file is absent from this correction's diff.
- Final targeted scans found no `.upsert`, `deleteByKey`, or `lockKey` in the
  governed client/group/topology repositories and services. The exact RTC pure
  module scan found no lowercase `repository`, transaction, ambient clock,
  randomness/environment, command hashing, timing, or async API. Repository-wide
  lock matches are limited to the documented out-of-scope queue/auth/admission
  implementations, the general lock interface, docs, and test doubles; no Task
  6 topology, publication, or RTT path matched.
- `git diff --check` and staged implementation `git diff --cached --check`
  passed. Tasks 7-10 were not started by this correction.

## Sixth review correction: lifecycle-safe retained receipt authority

Implementation commit: `8c9f1eba` (`fix(rtc): enforce convergent receipt lifecycles`),
based on reviewed Task 6 report commit `2f4a7126`.

### Corrected behavior

- Explicit legacy publication migration now also upgrades a legacy publication
  already stored at its canonical key. It accepts only the documented raw
  legacy publication and claim shapes inside the offline migration, compares
  structured values semantically rather than by serialized property order,
  repairs partial canonical destinations with conditional writes, fails closed
  on divergent destinations, and remains idempotent. Normal runtime reads stay
  strict before and after migration.
- Every RTT policy attempt now evaluates the candidate group and both named
  sessions against one explicit attempt timestamp. The group must be active and
  unexpired, and both sessions must be active, belong to the pair, and be
  unexpired. A compare-and-set conflict rereads the command and all authority
  facts, captures a fresh attempt time, and reruns the complete policy rather
  than retrying a stale final write.
- Immutable mutation receipt probing is now a raw, clock-free, effect-free
  operation. An exact retained receipt replay succeeds and a divergent replay
  conflicts even after its physical expiry, without invoking lifecycle,
  measurement, policy, admission, transaction, cleanup, or enqueue effects.
  Ordinary receipt list/page projections may hide physically expired receipts,
  but do not delete receipt authority independently.
- Receipt and recompute-intent expiry is physically joint. Cleanup runs in a
  bounded optimistic transaction after waiting outside the transaction,
  rereads the receipt and every sibling intent, validates exact receipt binding
  and equal physical expiry, requires all rows to be jointly expired, and
  requires the remaining sibling group-reference set to equal the receipt's
  complete affected-group set. Missing, extra, duplicate, live, mismatched, or
  corrupt siblings fail closed and preserve all authority. Only an exact
  complete set is conditionally deleted, with conflicts causing a full reread
  and retry; no row or advisory lock was added.

### Sixth correction RED evidence

- The initial exact four-file focused command collected 235 tests and exited 1
  with 28 failures and 207 passes. The failures covered canonical-key legacy
  publication and claim migration, group/session lifecycle checks, full retry
  revalidation after expiry, five receipt/intent physical-expiry combinations
  through direct/list/page/drain surfaces, and clock-free exact/divergent raw
  receipt replay.
- Before sibling cleanup was implemented, the filtered sibling command failed
  both exercised tests: exact jointly expired siblings were retained, while a
  live sibling incorrectly allowed partial cleanup. Before exact affected-set
  equality was implemented, the missing-sibling case failed while the other two
  sibling cases passed. Production changes followed each demonstrated failure.

### Sixth correction GREEN, baseline, and architecture evidence

- The final exact four-file focused command passed 4/4 files and 238/238 tests.
  The final nine-file Task 6 matrix passed 9/9 files and 341/341 tests.
- `npx vitest run packages/tests/shared-server --reporter=dot` passed 58 files
  with 2 configured-skip files; 883 tests passed and 12 environment-gated tests
  were skipped.
- `npm run typecheck` passed the root and every workspace typecheck. In
  `apps/api-v1`, `deno task --config deno.json check` passed and
  `deno task --config deno.json test` passed 210/210 tests.
- The live PostgreSQL concurrency command passed 1/1 file and 11/11 tests after
  the expected sandbox-denied localhost attempt was rerun with local database
  access. The denied attempt reached 3 non-network tests and failed the 8 tests
  needing PostgreSQL solely with `connect EPERM`.
- Root-wide `npm run test:unit` remains explicitly **not claimed as passing**:
  445 files passed, 2 were configured skips, and 1 failed; 4,389 tests passed,
  12 skipped, and the same 7 tests failed in the untouched
  `packages/tests/shared-web/rallar-workflow-options-compat.test.ts` baseline.
  That file is absent from this correction's diff.
- Targeted scans found no `.upsert`, `deleteByKey`, or `lockKey` in the governed
  client/group/topology repositories and services. The exact RTC pure-module
  scan found no repository, transaction, ambient clock, randomness/environment,
  hashing, timing, or async API. Repository-wide lock matches remain limited to
  documented out-of-scope queue/auth/admission implementations, the general
  interface, docs, and tests; no changed Task 6 path matched. Serialization in
  the corrected repositories is confined to persistence and raw parsing, not
  semantic equality. `git diff --check` and staged implementation
  `git diff --cached --check` passed.
- Task 7 and later tasks were not started by this correction.

## Seventh review correction: retained delivery proofs and specialized family cleanup

Implementation commit: `5b829134611dc8f74c1953c4ce41e3df9739f196`
(`fix(rtc): retain delivery proofs across cleanup`), based on reviewed Task 6
report commit `a41a249e9767cf53456cde3e2582ca9a86c5ff28`.

### Corrected behavior

- Every authoritative RTT recompute intent now has a mandatory nested delivery
  discriminant: either `{ state: 'pending' }` or
  `{ state: 'delivered', deliveredAtEpochMs }`. Normal reads reject the former
  delivery-less legacy shape. The explicit old-writers-stopped migration is the
  only compatibility path and upgrades an exact legacy intent to `pending`
  with bounded optimistic retries.
- The drainer skips retained delivered proofs. It preflights the family
  lifetime, performs the idempotent enqueue, captures the successful delivery
  time outside any transaction, then compare-and-set transitions the observed
  pending intent to delivered without changing identity or physical expiry.
  Concurrent drainers may both reach the idempotent enqueue, but only one
  delivery-state CAS applies and subsequent/restarted drains do not enqueue the
  retained proof again.
- Receipt and intent namespaces are excluded from generic runtime-state expiry.
  A dedicated stoppable periodic initializer performs their cleanup first at
  API startup; generic eviction starts only after topology-generation backfill
  and the first specialized cleanup succeed. Initial failures reject the
  startup barrier, later failures are surfaced through the injected error
  callback, and neither path silently permits generic deletion of protected
  rows.
- Specialized cleanup captures one time fact, then executes explicit
  read, compute, validate, and write phases. Receipt and sibling reads and all
  exact-set, receipt-binding, delivery-shape, and joint-expiry validation occur
  outside the transaction. The write-only transaction first CAS-guards the
  receipt revision as the family aggregate, conditionally deletes the observed
  siblings, and deletes the guarded receipt. A conflict rolls the transaction
  back, waits on the shared `[0, 2, 8]` schedule outside the transaction, and
  rereads the complete family. Missing, extra, duplicate, live,
  mismatched-expiry, or corrupt families fail closed and remain retained.
- Generic PostgreSQL expiry accepts caller-owned namespace exclusions and
  emits distinct safe SQL for empty and nonempty exclusion sets. PGlite and
  live PostgreSQL coverage prove that ordinary expired rows are removed while
  the protected receipt and recompute-intent namespaces remain untouched.
- Concurrent legacy publication migration now owns a complete bounded retry
  attempt. Every attempt rereads source and destination authority. A vanished
  source is successful only when one semantically and physically exact
  canonical publication/claim winner remains and no legacy claim remains;
  divergent values or physical expiry are typed corruption, while conditional
  conflicts retry and three conflicts raise the typed retry-exhausted error.
- A source/order architecture gate protects the specialized cleanup boundary:
  read, compute, validate, and write calls must remain ordered, the write seam
  must own the transaction, no domain read may occur inside it, and the receipt
  CAS guard must precede conditional deletes. No row, table, or advisory lock
  was added.

### Seventh correction RED evidence

- The initial five-file Vitest command collected 256 tests and exited 1 with
  20 failures and 236 passes. Failures covered concurrent/exhausted publication
  migration, mandatory delivery shape and explicit legacy migration, retained
  restart proofs, delivery-time bounds, concurrent/no-repeat drain behavior,
  complete and partial multi-intent families, safe specialized sweeping,
  initializer lifecycle, and generic namespace exclusions.
- The initial focused api-v1 Deno command collected 25 tests and exited 1 with
  4 failures and 21 passes. It demonstrated incorrect startup ordering,
  generic eviction starting after specialized-cleanup failure, missing
  middleware protection, and PGlite generic deletion of protected rows.
- The pre-commit architecture audit added two more REDs. The filtered command
  exited 1 with exactly 2 failures: cleanup still read domain state inside
  `begin`, and the delivery proof recorded a pre-enqueue clock value. The
  read/compute/validate plus write-only aggregate-guard refactor and
  post-success delivery timestamp made both pass.
- A final adversarial publication RED resolved instead of rejecting when a
  simulated concurrent winner had a divergent physical expiry. Exact
  publication and claim expiry validation made the same test reject with typed
  invariant corruption.

### Seventh correction GREEN, baseline, and architecture evidence

- The final five-file focused command passed 5/5 files and 259/259 tests. The
  expanded ten-file Task 6 cross-package matrix passed 10/10 files and 362/362
  tests.
- `npx vitest run packages/tests/shared-server --reporter=dot
  --silent=passed-only` passed 58 files with 2 configured-skip files; 902 tests
  passed and 13 opt-in environment tests were skipped.
- `npm run typecheck` passed the root and every workspace typecheck. In
  `apps/api-v1`, `deno task --config deno.json check` passed and
  `deno task --config deno.json test` passed 213/213 tests.
- The live PostgreSQL concurrency command passed 1/1 file and 12/12 tests,
  including direct proof that generic expiry preserves both protected RTC
  namespaces while deleting an ordinary expired row. The first sandboxed
  attempt reached the non-network tests and failed the database cases only with
  localhost `connect EPERM`; the approved local-database rerun passed fully.
- Root-wide `npm run test:unit -- --reporter=dot --silent=passed-only` remains
  explicitly **not claimed as passing**: 445 files passed, 2 were configured
  skips, and 1 failed; 4,408 tests passed, 13 skipped, and the same 7 tests
  failed in the untouched
  `packages/tests/shared-web/rallar-workflow-options-compat.test.ts` baseline.
  That file is absent from this correction's diff.
- Targeted scans found no `.upsert`, `deleteByKey`, `lockKey`, `FOR UPDATE`, or
  advisory-lock use in the changed Task 6 production paths. The only
  transaction-local domain reads found in `RtcRttRepository` belong to the
  explicit old-writers-stopped migration; the runtime cleanup write seam is
  source-gated as read-free. `git diff --check` and staged implementation
  `git diff --cached --check` passed before the implementation commit.
- Task 7 and later tasks were not started by this correction.

## Eighth review correction: immutable expiry, exact retention, and owned cleanup

Implementation commit: `c85269d5ad1b0653d23b1e3afca478b3c8fd9fe3`
(`fix(rtc): close retained authority lifecycle gaps`), based on reviewed Task 6
report commit `d693507d`.

### Corrected behavior

- Offline publication migration no longer repairs the physical expiry of an
  immutable canonical publication or work claim. A semantically equal
  destination with expiry different from the source is typed corruption and
  both rows remain intact. Legacy value/message-ID shape is upgraded by
  expected-revision CAS only when destination and source expiries are exactly
  equal; bounded attempts still reread and revalidate the complete migration
  authority.
- Recompute intents are bound explicitly to receipt direction and measurement
  version in addition to receipt ID, command hash, acceptance time, group, and
  pair membership. This keeps the authority rule local even though canonical
  IDs also encode pair/version today.
- Receipt and intent physical expiry is exactly
  `acceptedAtEpochMs + DEFAULT_RTC_RTT_MUTATION_RETENTION_MS`. Raw receipt
  probes, direct/list/page projections, direct receipt insertion, intent
  validation, replay, migration, drain, and cleanup reject early or late
  jointly shifted families. Safe-integer overflow is rejected before a write
  can claim authority.
- Specialized cleanup enumerates the union of physical receipt and intent
  namespaces, including receiptless intents and malformed physical keys. It
  processes candidates in canonical key order, preserves each corrupt family,
  continues cleaning unrelated healthy expired families through the existing
  bounded full-reread optimistic path, then raises
  `RtcRttReceiptFamilyCleanupError` with the removed-family count and ordered
  per-family errors. Aggregate details are sanitized and do not expose raw
  persisted values. Periodic cleanup continues after first-run and later
  failures without overlapping runs.
- `initRuntimeStateExpiryEviction(repository, intervalMs?: number)` is restored
  as a public compatibility overload alongside default and object-options
  forms. Protected namespace exclusions remain available only through the
  object form.
- API startup now owns the specialized cleanup handle before awaiting its
  first run, stops the previous handle on reinitialization, and exposes an
  idempotent unload shutdown seam. A specialized corruption still rejects and
  is logged, but protected generic eviction is initialized first so unrelated
  namespaces do not lose expiry maintenance.
- `deno task rtc:migrate-persisted-state` is the explicit operator cutover.
  It requires `--old-writers-stopped` before opening a database connection,
  supports a connection-free `--dry-run`, closes the SQL client, and executes
  snapshot keys, publication/claim keys, RTT measurement keys, then retained
  intent delivery state. The runbook documents backup, restart, rollback, and
  the strict no-dual-read/no-mixed-writer boundary.

### Eighth correction RED evidence

- The focused shared RED command collected 249 tests and exited 1 with 27
  failures and 222 passes. Failures covered two immutable canonical migration
  expiry collisions; missing-receipt cleanup; reversed intent direction on
  direct/list/page/sweep; early and late jointly shifted retention across
  probe, receipt direct/list/page, intent, drain, and sweep; safe-integer
  overflow; noncanonical receipt insertion; corrupt-family starvation;
  receiptless orphans; malformed physical rows; and the legacy numeric expiry
  initializer. Version mismatch was already rejected transitively by
  canonical IDs on all five surfaces; the explicit local binding was still
  added and remains covered.
- The focused API RED command collected 9 tests and exited 1 with 7 failures
  and 2 passes. It demonstrated the missing operator entrypoint/task/runbook,
  missing stopped-writer/dry-run/error behavior, generic expiry starvation
  after specialized corruption, lost/replaced timer ownership, and absent
  middleware unload shutdown.

### Eighth correction GREEN and baseline evidence

- The focused shared repository/expiry command passed 2/2 files and 249/249
  tests. After the final aggregate-error sanitization assertion, the repository
  file passed 242/242. Focused API startup/operator tests passed 9/9.
- The expanded Task 6 matrix passed 10/10 files and 405/405 tests.
  `npx vitest run packages/tests/shared-server --reporter=dot
  --silent=passed-only` passed 58 files with 2 configured-skip files; 945 tests
  passed and 13 opt-in environment tests were skipped.
- `npm run typecheck`, focused shared-server and shared-web `tsc` checks,
  `deno task --config deno.json check`, and the explicit script check all
  passed. Full API-v1 Deno tests passed 218/218. Deno lint passed for every
  touched API source/test/script, and those files were formatted. A
  repository-wide API `deno fmt --check` remains not claimed: it reports 12
  pre-existing unformatted files outside this correction.
- The first live PostgreSQL command reached 3 non-network tests and failed the
  9 database cases solely with localhost `connect EPERM`. The approved local
  rerun passed 1/1 file and 12/12 tests.
- With database environment variables removed, the operator dry run exited 0
  and reported the exact four-step order without connecting. The no-argument
  command exited 1 at argument parsing with the required acknowledgement
  error. A PGlite-memory actual cutover exited 0 and completed the same four
  steps in order.
- Root `npm run test:unit -- --reporter=dot --silent=passed-only` remains
  explicitly not claimed as passing: 445 files passed, 2 were configured
  skips, and 1 failed; 4,451 tests passed, 13 skipped, and the same 7 untouched
  `packages/tests/shared-web/rallar-workflow-options-compat.test.ts` baseline
  tests failed. That file is absent from this correction.
- Targeted corrected-path scans found no unconditional `.upsert`,
  `deleteByKey`, `lockKey`, `FOR UPDATE`, or advisory-lock use. The general
  PostgreSQL runtime-state lock method remains the documented out-of-scope
  interface implementation; this correction changes only its generic expiry
  initializer compatibility seam. Cleanup write transactions remain free of
  domain reads. `git diff --check` and staged `git diff --cached --check`
  passed before the implementation commit.
- Task 7 and later tasks were not started by this correction.

## Ninth review correction: autonomous delivery and generation-fenced startup

Implementation commit: `f598f7750dd9599d445a0b4a5d77071575c139e4`
(`fix(rtc): harden replay and delivery lifecycle`), based on reviewed Task 6
report commit `a874a22a`.

### Corrected behavior

- RTT recompute intent delivery is owned by one stoppable, single-flight
  background worker. It drains immediately at startup, wakes after accepted
  writes, polls every second while healthy, and retries indefinitely with the
  capped `[2, 8, 32, 128, 512, 1000]` ms schedule. Wakes coalesce while a drain
  is running; stop cancels pending timers and prevents stale in-flight
  completion from rescheduling. Request handlers no longer await recompute
  delivery. Exact receipt replay remains effect-free, while retained delivered
  proofs prevent restart redelivery. Failure observations expose only a fixed
  message plus bounded safe name/code, and a failing observer cannot disable
  durable retries.
- Claimed topology work now reads and validates the immutable execution claim,
  durable snapshot, and publication before consulting mutable group/config/RTT
  planning authority. Exact replay fans out the stored winner directly. A
  claim-miss path alone reads mutable authority and captures publication expiry;
  an impossible loaded outcome on that path fails closed.
- Middleware synchronously reserves an expiry-startup generation before
  initialization. A newer startup invalidates and stops older cleanup ownership;
  any delayed old handle is stopped immediately, and unload stops both cleanup
  and system-topic workers idempotently. When specialized receipt-family cleanup
  rejects, protected generic eviction starts detached and its later rejection is
  observed separately, so the specialized failure surfaces promptly even when
  generic eviction is long-running.
- Explicit legacy topology snapshot migration materializes new canonical rows
  with `NEVER_EXPIRE_AT_TIMESTAMP`. Existing canonical destinations remain
  subject to strict non-expiring decode and semantic equality before the legacy
  source may be removed.
- RTT authorization and retained-intent validation use the complete active
  interval `connectedAtEpochMs <= requestedAtEpochMs < expiresAtEpochMs`.
  Future sessions are rejected, equality at connection time is accepted, and a
  retry rereads the clock and full authority before re-evaluating the interval.
- Strict synchronous neutral modules now validate the complete persisted
  topology publication envelope and complete RTT receipt/intent family. The RTT
  write seam validates receipt identity/hash/order/retention, full group
  snapshots, exact measurement and pending-intent bindings before opening the
  transaction. Publication compute validates the full deterministic envelope,
  message identity, targets, timestamps, payload snapshot, and recipients.
  Repository reads reuse the same validators and retain typed corruption
  translation. The pure modules have no repository imports, async APIs, ambient
  clock, randomness, or environment access.

### Ninth correction RED evidence

- `npx vitest run packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts packages/tests/shared-server/rtc-topology-mutations.test.ts`
  collected 290 tests and exited 1 with exactly 9 intended failures and 281
  passes. The failures demonstrated request-coupled/no-autonomous recompute
  delivery, missing wake/stop/single-flight ownership, mutable-authority reads
  before durable replay, expiring canonical migration output, incomplete active
  interval checks, and persisted candidates reaching a transaction before full
  neutral validation.
- `deno test --allow-read --config deno.json test/services/runtime-state-expiry-startup.test.ts`
  collected 7 tests and exited 1 with exactly 2 intended failures and 5 passes.
  They demonstrated a delayed older startup retaining cleanup ownership and a
  specialized failure waiting indefinitely for generic eviction.
- Before implementation, source assertions also proved that the WebSocket RTT
  request path called the drainer inline and that middleware did not reserve a
  startup generation synchronously. Production changes followed those RED
  checkpoints; no Task 7 work was introduced.

### Ninth correction GREEN, baseline, and architecture evidence

- The final three-file architecture command passed 3/3 files and 291/291 tests.
  The API startup/lifecycle command passed 7/7 tests. The expanded Task 6 matrix
  passed 10/10 files and 458/458 tests.
- `npx vitest run packages/tests/shared-server --reporter=dot
  --silent=passed-only` passed 58 files with 2 configured-skip files; 960 tests
  passed and 13 opt-in environment tests were skipped. Full API-v1 Deno tests
  passed 220/220.
- `npm run typecheck` passed the root and every workspace typecheck. In
  `apps/api-v1`, `deno check --config deno.json src/main.ts` passed. Targeted
  Deno format and lint checks passed for all four changed API source/test files.
- The live PostgreSQL concurrency command passed 1/1 file and 12/12 tests after
  the expected sandbox-denied localhost attempt failed its 9 database cases
  solely with `connect EPERM`; all 3 non-network cases passed on that attempt.
- Root `npm run test:unit -- --reporter=dot --silent=passed-only` remains
  explicitly **not claimed as passing**: 445 files passed, 2 were configured
  skips, and 1 failed; 4,466 tests passed, 13 skipped, and the same 7 untouched
  `packages/tests/shared-web/rallar-workflow-options-compat.test.ts` baseline
  tests failed. That file is absent from this correction's diff.
- Final governed-path scans found no unconditional `.upsert`, `deleteByKey`,
  `lockKey`, `FOR UPDATE`, or advisory-lock use. WebSocket source contains no
  direct recompute drainer call; it only wakes the owned worker. The replay
  branch contains no mutable planning-authority read or expiry-clock capture.
  `git diff --check` and staged `git diff --cached --check` passed before the
  implementation commit.
- Task 7 and later tasks were not started by this correction.

## Tenth review correction: complete RTT guards and owned generic expiry

Implementation commit: `e8f573c2d768d6359a76b61028b056b2a11dd835`
(`fix(rtc): validate guards and own expiry workers`), based on ninth-correction
report commit `7108b8cae0a52639dba68902f954931cbcab9fd3`.

### Corrected behavior

- The synchronous neutral RTT persistence gate now validates the exact complete
  write-candidate discriminant and field set before `runtime.begin`. It binds
  the canonical affected groups, receipt, and mandatory pending intents; exactly
  two unique endpoint guards in lexical pair order; exact guard/admission/peer
  fields; safe create/update revisions; endpoint/value/counterpart identities;
  accepted-time lifecycle; purge coverage; canonical peers; and physical expiry
  equal to the latest lease. The measurement guard has exact fields, a safe
  revision, a strict full measurement, a purge time after acceptance, exact
  receipt pair/version binding, and semantic equality with every intent RTT.
  Repository measurement and endpoint writes reuse the same pure validators as
  defense in depth.
- Offline topology snapshot migration requires one explicit stable
  `observedAtEpochMs`. Every retry rereads the legacy source and rejects
  `expireAtTimestamp <= observedAtEpochMs` as typed topology corruption before
  any canonical insertion. A future retained source may become a permanent
  canonical snapshot. An existing canonical destination must still decode as
  non-expiring and be semantically equal before conditional source deletion.
  The operator script captures the observation once for the whole cutover.
- Generic runtime-state expiry no longer delegates recurring ownership to the
  unstoppably scheduled `tryRunInIntervals` promise. Its public initializer now
  returns `{ firstRun, stop }` for default, numeric-interval, and object-options
  forms. The worker runs immediately, remains single-flight, owns and cancels
  its timer, retries failure, stops idempotently, and checks stop after an
  in-flight completion before scheduling again.
- One middleware startup generation now owns both the specialized RTT-family
  cleanup and protected generic eviction handles. Reinitialization and shutdown
  invalidate and stop both. A handle created by a delayed stale generation is
  stopped immediately, and replacing a handle in one current generation stops
  its predecessor. The startup barrier keeps a narrow numeric first-run result;
  specialized failure still surfaces promptly while generic first-run starts
  detached and its rejection remains observed.

### Tenth correction RED evidence

- `npx vitest run packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts --reporter=dot`
  collected 273 tests and exited 1 with exactly 20 failures and 253 passes.
  Seventeen direct write-seam failures showed missing/extra/misordered endpoint
  guards, wrong identities, unsafe revisions, malformed peer leases/expiry,
  incomplete measurement guards, lifecycle/purge mismatches, and affected-group
  divergence entering `runtime.begin` or committing instead of failing
  preflight. Three migration failures showed boundary/expired legacy rows and a
  source that expired between retries being promoted to permanent authority.
- `npx vitest run packages/tests/shared-server/runtime-state-expiry-eviction.test.ts --reporter=dot`
  collected 8 tests and exited 1 with exactly 4 failures and 4 passes. The
  default, numeric, and object initializer forms exposed no stoppable handle,
  and stop during an in-flight run could not prevent the orphan loop from
  scheduling again.
- `deno test --allow-read --config deno.json test/services/runtime-state-expiry-startup.test.ts`
  collected 8 tests and exited 1 with exactly 2 failures and 6 passes. Startup
  generations could not own generic eviction, and middleware initialized the
  generic loop outside generation ownership.

### Tenth correction GREEN, baseline, and architecture evidence

- The final repository/mutation/generic-expiry focused command passed 3/3 files
  and 301/301 tests. The API startup lifecycle command passed 8/8 tests. The
  expanded Task 6 cross-package matrix, including generic expiry, passed 11/11
  files and 488/488 tests.
- `npx vitest run packages/tests/shared-server --reporter=dot
  --silent=passed-only` passed 58 files with 2 configured-skip files; 983 tests
  passed and 13 opt-in environment tests were skipped. Full API-v1 Deno tests
  passed 221/221.
- `npm run typecheck` passed the root and every workspace typecheck. Focused
  shared-server `tsc` passed. In `apps/api-v1`, main and migration-script
  `deno check` passed. Targeted Deno format and lint checks passed all four
  changed API source/test/script files.
- The live PostgreSQL concurrency command passed 1/1 file and 12/12 tests.
- Root `npm run test:unit -- --reporter=dot --silent=passed-only` remains
  explicitly **not claimed as passing**: 445 files passed, 2 were configured
  skips, and 1 failed; 4,489 tests passed, 13 skipped, and the same 7 untouched
  `packages/tests/shared-web/rallar-workflow-options-compat.test.ts` baseline
  tests failed. That file is absent from this correction's diff.
- Final scans found no unconditional `.upsert`, `deleteByKey`, `lockKey`,
  `FOR UPDATE`, or advisory-lock use in the governed paths. The neutral
  persistence module contains no async/repository/transaction/ambient
  clock/random/environment access. The generic expiry implementation contains
  no `tryRunInIntervals`; its tests use the actual exported handle/options and
  no compatibility casts. `git diff --check` and staged
  `git diff --cached --check` passed before the implementation commit.
- Task 7 and later tasks were not started by this correction.
