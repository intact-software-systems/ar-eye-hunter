# Task 6 report: optimistic RTC topology and RTT convergence

## Scope and implementation

- Base: `d1ef2a6e1032583d756d1c13b4d82e64861ae889`.
- Clean implementation commit:
  `21d28525e048c92a9176f08682efb3cbd37314b2`.
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
