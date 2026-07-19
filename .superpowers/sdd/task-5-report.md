# Task 5 report: convergent group topology configuration

## Scope and architecture

- Base: `e78881ef71b8cc0ab051b75405ef63458b6a7b05`.
- Durable config and temporary override writes now use entry-aware conditional
  insert/CAS/delete APIs. No topology config mutation uses locks,
  unconditional overwrite, compensating restore, synchronous recompute, or
  synchronous publication.
- Every effectful mutation conditionally advances a mandatory per-target
  generation record after the state guard in the same short transaction. The
  record never expires, so accepted versions remain monotonic across config
  deletion, recreation, and physical override TTL expiry. Its CAS also closes
  outside-transaction split-read races by rolling state back and retrying.
- Every effectful config or override mutation also advances one retained,
  group-scoped invariant generation. Reads bracket both target rows with this
  token; a changed bracket or transaction CAS forces a full reread. This
  serializes cross-target decisions without locks and prevents independently
  valid config/override writes from committing an invalid combined result.
- `group-topology-management-service.ts` owns the visible three-attempt
  `[0, 2, 8]` retry loop. `readTopologyConfigMutation` reads outside a
  transaction; pure compute/validate receive explicit facts; only
  `writeTopologyConfigMutation` opens the short transaction and orders the
  conditional state guard, shared invariant-generation CAS, per-target
  generation CAS, optional first-writer request record, then the sole
  insert-only `rtc-topology-recompute` outbox record.
- Every retry uses the distinct authoritative group snapshot reader and reruns
  lifecycle, role, configuration, expiry, and invariant validation. API-v1
  wires that reader to `readCurrentSnapshot`, while ordinary reads and explicit
  reconfigure retain their cache-aware behavior. The authoritative reader is
  mandatory and never falls back to the ordinary reader. Matching replay and
  conflicting request reuse recheck fresh durable status and actor/admin role,
  but do not materialize clock-dependent mutation-admission facts.
- Request IDs are immutable first-writer claims. The canonical command is
  normalized before its SHA-256 digest is computed once. Records contain the
  compact receipt plus a mandatory discriminated accepted result, so replay
  returns the original PUT value even after later overwrite or delete. Record
  validation binds scoped key/request ID, command ID/hash, operation/target,
  outcome/effect/storage revision, and accepted result/version.
- The repository boundary decodes exactly the legacy config/override key set
  that omitted `requestId`, normalizing it to mandatory `null` in memory. New
  writes and public types remain mandatory, malformed extra fields still fail,
  and reads do not rewrite legacy rows.
- Effectful config mutations return after commit and best-effort wake the
  durable mutation drainer. A synchronous wake failure is reported as a timing
  error but cannot replace an already accepted receipt or mutate committed
  state. Explicit `POST /topology/reconfigure` remains the only synchronous
  configuration endpoint.
- Each optimistic attempt emits distinct read, compute, validate, transaction,
  and write timing. DELETE browser helpers forward an optional stable
  `requestId` as `Idempotency-Key`, which is also documented in OpenAPI.

## RED evidence

The initial repository/management RED command exited 1 with 10 new failures
and 13 existing passes. Failures showed missing conditional repository APIs,
simultaneous puts both returning version 1, absent immutable request claims,
missing 409 reuse rejection, outbox failure not rolling state/receipt back, and
default PUT still invoking synchronous reconfigure.

The pure/performance RED command exited 1: the mutation module did not exist and
the performance suite reported two failures because Task 4 diagnostic
governance still omitted topology receipts/outbox evidence.

The API route RED command exited 1 with 5 passes and 2 failures because mutation
routes still forwarded/defaulted `reconfigure` and `publish`.

Later adversarial RED tests independently proved and then fixed:

- replay pairing an old receipt with a newer current row;
- replay succeeding after group archive or actor demotion;
- persisted records accepting a receipt command ID different from request ID;
- persisted operation/target and applied receipt/storage discriminant
  corruption;
- skewed service clocks producing an update timestamp older than its
  predecessor;
- a synchronous post-commit drainer wake exception turning an accepted
  mutation into a request failure;
- config recreation resetting `[1, 2]` to version `1` after delete, plus
  physical override expiry losing its prior generation;
- a generation-ledger CAS conflict not guarding the state write and a valid
  outside-transaction split read rejecting config that temporarily appeared
  ahead of its generation view;
- a missing authoritative reader silently falling back to the ordinary reader;
- replay/conflicting reuse invoking an injected throwing clock before the
  immutable request ledger was probed;
- topology timing omitting the transaction phase;
- shared-web DELETE calls omitting `Idempotency-Key` and OpenAPI omitting the
  header contract;
- persisted PUT results accepting another request ID or an impossible no-op
  receipt;
- true-overlap config `{meshParamK:4}` and override `{degreeLimit:3}` writes
  both committing after validating against absence, leaving an invalid
  effective aggregate;
- legacy durable config and override rows with an omitted `requestId` becoming
  unreadable under the new mandatory contract;
- a temporary override masking a durable/default invariant that would become
  invalid immediately after TTL expiry.

## Implemented behavior

- Concurrent PUTs rebase to distinct monotonic versions; stale DELETE captures
  its first observed predecessor and cannot remove a refreshed row.
- A retained generation ledger makes versions lifecycle-monotonic. State is
  guarded first, the shared invariant generation second, the per-target
  generation third, then request record and outbox; any guard conflict rolls
  the whole transaction back and reruns the complete read path.
- Durable config is validated both with server defaults alone and with the
  currently observed override, so override expiry cannot reveal an invalid
  durable/default projection.
- Absent DELETE is a no-op; with a request ID it still records the immutable
  first-writer result without creating an outbox effect.
- Receipt collision or outbox insertion failure rolls the entire state/record/
  outbox transaction back. Winner reread happens only after the conflicted
  transaction has closed.
- Stored update time is monotonic under clock skew. Override expiry is resolved
  once from stable facts and stale expiry cleanup remains revision guarded.
- API route types, shared browser helpers, OpenAPI schemas, black-box requests,
  and product documentation no longer expose synchronous mutation controls.
  PUT/DELETE responses require the compact receipt; OpenAPI advertises typed
  409 idempotency conflict and 503 bounded-retry exhaustion.
- Shared-web DELETE options accept `requestId` and forward it as
  `Idempotency-Key`; both topology DELETE operations publish that optional
  header in OpenAPI.
- The performance producer now emits governed
  `task5-production-evidence`, declares presence split, queries and validates
  real topology request records, projects the exact real outbox IDs/effects,
  consumes exact zero-based topology timing, and emits no topology DBW waiver.
  Counter-source disclosures explicitly include topology attempts and receipts.
  The comparator's exact Task 4 diagnostic exception remains unchanged and
  Task 10 candidate governance remains a separate later gate.

## Validation evidence

### Focused and public surfaces

```text
npx vitest run packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/state-mutation-outbox.test.ts
4 files passed; 98 tests passed

deno test -A --filter "PGlite topology config mutations" apps/api-v1/test/db/pglite-sql-adapter.test.ts
1 passed; 0 failed; 18 filtered

RALLAR_POSTGRES_INTEGRATION=1 ... -t "topology config transactions|config and override"
2 passed; 0 failed; 6 unrelated skipped/filtered (independent PostgreSQL clients)

cd apps/api-v1 && deno test -A test/routes/graph-topology-routes.test.ts test/swagger-routes.test.ts
19 passed; 0 failed

npx vitest run packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-server/state-write-performance-harness.test.ts
2 files passed; 79 tests passed

Six-file topology/shared-web/performance correction slice
6 files passed; 177 tests passed

npx vitest run packages/tests/shared-server/group-topology-management-service.test.ts -t "returns the accepted receipt when the post-commit outbox wake fails"
1 passed; 30 skipped

cd apps/api-v1 && deno test -A test/rallar-server.test.ts test/routes/graph-topology-routes.test.ts
11 passed; 0 failed

cd apps/api-v1 && deno task test
207 passed; 0 failed

npm run typecheck
all root/workspace TypeScript checks passed

cd apps/api-v1 && deno task check
passed

git diff --check
passed
```

The PGlite and live PostgreSQL proofs execute the production management
service/repository transaction and verify monotonic `[1,2]` accepted versions,
the retained per-target and invariant generations at version `2`, both
immutable request records, and both exact receipt-addressed RTC outbox records.
The PostgreSQL proof
synchronizes the first reads across two distinct SQL clients, proving true
overlap rather than fake-repository scheduling. Separate deterministic and live
PostgreSQL cross-target tests prove the shared invariant generation admits only
one side of an otherwise-invalid concurrent config/override pair.

Existing `state-mutation-outbox.test.ts` restart/downstream-failure coverage
uses the same `rtc-topology-recompute` effect and proves retryable delivery does
not mutate authoritative state; Task 5 tests separately prove config is already
durable and no topology publisher runs in the mutation call.

### Production performance evidence

Final artifact: `tmp/perf/api-v1-state-write-task5.json` (ignored, not committed),
SHA-256 `61bd75f0ac9eb8a807eb7358198bac4e4a6cf07669a63e516a1084681fee8c8d`.

```text
validateStateWriteArtifact(finalArtifact)
[]

uncontended: 2100 accepted/receipts; 3900 required/actual intents; DBW []
shared:      1947 accepted/receipts; 3646 required/actual intents; DBW []
hot:         1003 accepted/receipts; 1906 required/actual intents; DBW []
```

The immutable baseline remains byte-identical at SHA-256
`ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7`.
Baseline-to-Task-5 comparison exits 1 only with the expected later-governance
message: the artifact is not labeled `task10-post-remediation-candidate`.
Standalone Task 5 schema/correctness validation passes.

## Encountered non-product failures

- The first corrected producer invocation was sandbox-blocked from local
  PostgreSQL (`EACCES` on `127.0.0.1:5432`/`::1:5432`); the approved escalated
  rerun connected and completed. An earlier connected correction run exposed
  the valid outside-transaction split-read race described in RED evidence;
  after its RED/GREEN fix, the final producer completed all workloads.
- The recipes-only black-box command selected nine live HTTP recipes without a
  running external API; all nine skipped and the required-gates wrapper exited
  1.
- The managed PostgreSQL medium-scale command migrated all 17 migrations but
  skipped its recipe at preflight because group-create permission returned HTTP
  400; the matrix therefore exited 1 before executing topology steps. This is
  recorded as skipped evidence, not a passing black-box claim.
- The broad `npm run test:unit` owner run produced 4106 passes and 8 unrelated
  pre-existing failures in `rallar-workflow-options-compat.test.ts` (seven
  argument-shape expectations) and `data-caches.test.ts` (one fixture missing a
  causal revision). No failing file is touched by Task 5.

## Follow-up and tradeoffs

- The immutable request record intentionally stores the accepted result in
  addition to the compact receipt. This is required to preserve the existing
  full PUT response on replay without rereading mutable current state.
- Requests without `requestId` return a receipt but do not persist an immutable
  request record; effectful writes always persist the RTC recompute outbox.
- The medium-scale black-box environment needs its group-create permission
  preflight corrected before it can provide a Task 5 live recipe result.
