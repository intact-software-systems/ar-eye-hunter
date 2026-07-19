# Task 5 report: convergent group topology configuration

## Scope and architecture

- Base: `e78881ef71b8cc0ab051b75405ef63458b6a7b05`.
- Current clean implementation commit:
  `22d13895a4b0c939ee5776fd242046306d3e9f98`.
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
- Config, override, mutation-record, target-generation, and
  invariant-generation records use the canonical group-state storage-key
  codec. An absent workspace is distinct from the literal `_`, delimiters,
  percent-encoded text, and Unicode lookalikes. Direct, list, and page reads
  bind the physical key, canonical decoded key, stored value identity/child,
  and trusted requested slot; corruption raises the typed repository invariant
  error. Wrong-scope expired overrides are rejected before lazy expiry can
  delete them.
- The same fail-closed ordering now covers the retained mutation, target
  generation, and invariant generation rows. Raw JSON, stored scope/child, and
  the mandatory non-expiring physical TTL are validated before generic lazy
  expiry can delete anything. Durable config also requires the exact
  non-expiring TTL, while override physical TTL must exactly match the stored
  `expiresAtEpochMs`; direct, source, list, page, and legacy-migration decoders
  share that contract.
- Older ambiguous config/override source keys are moved only by the explicit
  offline `migrateLegacyGroupTopologyConfigKeys` operation after old writers
  are stopped. It re-reads in an optimistic transaction, value-verifies any
  canonical destination, conditionally inserts when absent, deletes the source
  by its observed revision, rolls back on conflict, and uses bounded
  `[0, 2, 8]` retry without row/table/advisory locks. Ordinary per-group and
  all-scope generation readiness never migrate or permanently dual-read these
  keys. They fail closed until the operator migration is complete; API startup
  therefore keeps periodic runtime-state eviction disabled. Once keys are
  canonical, raw including-expired reads preserve config and already-expired
  override version floors in the generation ledger before eviction.
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
- Mutation facts separate stable request data from attempt-local policy time.
  The first non-replay attempt fixes stored creation/update time, relative
  override expiry, command hash, and delete target. Every later non-replay CAS
  attempt obtains a fresh policy clock for active/unexpired lifecycle checks,
  so retries cannot authorize against stale time or extend TTL. Replay and
  conflicting request reuse still probe the immutable ledger before invoking
  the clock. Platform admins bypass membership/role only; the shared active and
  unexpired group lifecycle policy applies to every actor.
- Request IDs are immutable first-writer claims. The canonical command is
  normalized before its SHA-256 digest is computed once. Records contain
  exactly `{groupRef, requestId, commandHash, receipt}`. Mandatory nullable
  creation/update/override-expiry scalars in the receipt reconstruct the
  original PUT value from the verified command even after later overwrite or
  delete; no full accepted payload is retained. Replay explicitly binds the
  receipt operation to the freshly verified command before choosing a
  reconstruction branch. Record validation also binds scoped key/request ID,
  command ID/hash, operation/target, outcome/effect, version, storage revision,
  timestamps, and expiry.
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

The mandatory optional-workspace correction first produced 5 failures with 17
passes, then an expanded repository matrix produced 8 failures with 17 passes.
Those failures showed literal `_` aliasing absent workspace, absent-workspace
validation rejection, inconsistent direct/list/page decoding, missing legacy
source movement, an absent source being claimed for `_`, unchecked destination
conflict/duplicate handling, and missing transactional rollback proof.

The final correction RED ran the repository and management suites before any
production edit. It exited 1 with exactly 13 failures and 68 passes across 81
tests: three expired retained-row wrong scope/child cases resolved `undefined`
and were deleted instead of raising typed corruption; three structurally valid
mutation/generation rows accepted a finite physical TTL; config and override
accepted inconsistent physical expiry at both direct and generation-source
boundaries; an active-but-expired group was accepted for a platform admin; an
owner retry reused first-attempt lifecycle time after a forced generation CAS
conflict; and a relative-TTL retry invoked the clock only once. The first GREEN
added the pure fact split and passed all 89 tests across repository, management,
and topology config service suites.

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
- an untouched expired legacy override at version `7` being lazily deleted
  before its generation was preserved and then recreated at version `1`;
- ordinary `readConfig` and explicit reconfigure combining config and override
  states that never coexisted when the shared invariant changed mid-read;
- the immutable request ledger retaining a full accepted result instead of the
  required compact receipt-only contract;
- a structurally valid tampered compact receipt keeping the correct command
  hash while changing `putConfig` to `putOverride`, selecting the wrong replay
  reconstruction branch;
- API startup wiring that was only source-order checked rather than proving
  eviction stays uninitialized while backfill is pending and after rejection;
- topology records inheriting the old ambiguous optional-workspace encoder,
  plus direct reads trusting the requested lookup key without binding the
  physical key and stored scope/child returned by the repository;
- an expired wrong-scope override being eligible for lazy deletion before its
  identity was rejected, and startup/readiness implicitly migrating legacy
  keys instead of requiring an explicit offline operator action.

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
- Stored update time is monotonic under clock skew. Stored write time and
  override expiry are resolved once from request-stable facts, while every
  non-replay retry supplies fresh lifecycle policy time; stale expiry cleanup
  remains revision guarded.
- Corrupt retained rows cannot disappear through lazy expiry: canonical key,
  raw JSON, stored scope/child, and exact physical retention are checked first.
  Config and retained ledger rows are physically non-expiring, while temporary
  overrides use the same expiry in their stored value and physical row.
- Explicit offline migration safely canonicalizes value-verified ambiguous
  source keys, while ordinary generation backfill only accepts canonical
  sources. Backfill preserves config and expired-override version floors,
  never downgrades a concurrently advanced generation, and uses no
  row/table/advisory locks. Deterministic API startup tests prove eviction
  starts only after all-scope backfill success and never starts after backfill
  failure or a pending legacy-key migration.
- Ordinary effective reads and explicit reconfigure use the same bounded
  invariant-token bracket, so a changed config/override pair is reread rather
  than exposing a combination that never existed.
- Idempotency rows are compact receipt-only records. PUT replay reconstructs
  from the verified normalized command plus accepted receipt scalars and
  rejects a receipt whose operation does not match that command.
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
npm run test:unit -- packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-management-service.test.ts
RED: 2 files failed; 13 tests failed; 68 tests passed (81 total)

npm run test:unit -- packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/group-topology-management-service.test.ts
first GREEN: 3 files passed; 89 tests passed

npx vitest run packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/state-mutation-outbox.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-server/state-write-performance-harness.test.ts
6 files passed; 213 tests passed

deno test -A --filter "PGlite topology config mutations" apps/api-v1/test/db/pglite-sql-adapter.test.ts
1 passed; 0 failed; 18 filtered

RALLAR_POSTGRES_INTEGRATION=1 ... -t "topology config transactions|config and override"
2 passed; 0 failed; 6 unrelated skipped/filtered (independent PostgreSQL clients)

cd apps/api-v1 && deno test --allow-env --allow-read test/services/runtime-state-expiry-startup.test.ts test/swagger-routes.test.ts
14 passed; 0 failed

cd apps/api-v1 && deno task test
209 passed; 0 failed

npm run typecheck
all root/workspace TypeScript checks passed

git diff --check
passed

git diff --unified=0 -- packages/shared-server/rallar-system packages/tests/shared-server/group-topology-config-repository.test.ts | rg '^\+.*(lockKey|FOR UPDATE|advisory|withLock)'
no matches
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

The full PostgreSQL producer was rerun from the clean Task 5 implementation
commit `22d13895a4b0c939ee5776fd242046306d3e9f98`:

```text
npm run perf:api-v1:state-write -- --backend=postgres --warmup=1 --runs=3 --concurrency=10 --out=tmp/perf/api-v1-state-write-task5.json
```

The resulting canonical artifact remains ignored and uncommitted at
`tmp/perf/api-v1-state-write-task5.json`. Its embedded `gitCommit` is exactly
`22d13895a4b0c939ee5776fd242046306d3e9f98` and its SHA-256 is
`5a7211be1c876e3b31c3ae3293ded52c8b063351c7dc6f4c611dffafee2de9b0`.

```text
validateStateWriteArtifact(finalArtifact)
[]

uncontended: 2100 accepted/receipts; 3900 required/actual intents; DBW []
shared:      1958 accepted/receipts; 3667 required/actual intents; DBW []
hot:          983 accepted/receipts; 1867 required/actual intents; DBW []
```

The immutable baseline remains byte-identical at SHA-256
`ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7`.
It also validates to `[]`. Standalone Task 5 schema/correctness validation
passes. Normal comparison of the unchanged canonical artifact returns this
governance error before the performance gates execute:

```text
node scripts/perf/compare-api-v1-state-write-results.mjs tmp/perf/api-v1-state-write-baseline.json tmp/perf/api-v1-state-write-task5.json
exit 1
- candidate must declare presenceSplitFromGroupAggregate=true with task10-post-remediation-candidate governance and evidence
```

That early return is not evidence that governance is the only failing gate. To
audit every gate without mutating either artifact, the implementer cloned the
candidate in memory and changed only the clone's governed feature label and
evidence. The clone validated to `[]`; the canonical Task 5 artifact remained
byte-identical at
`5a7211be1c876e3b31c3ae3293ded52c8b063351c7dc6f4c611dffafee2de9b0`
before and after the comparison and was never relabeled. The fresh clean-commit
audit reported exactly these ten interim failures:

```text
shared throughput regressed: baseline=752.2423201768095, candidate=628.16159436996
hot throughput regressed: baseline=295.1851420383843, candidate=291.9452224907553
shared throughput must improve after presence is split from the group aggregate
uncontended median sql.statements increased without a recorded reason: baseline=11200, candidate=12900
uncontended median sql.rowsRead increased without a recorded reason: baseline=5400, candidate=7900
shared median sql.statements increased without a recorded reason: baseline=11352, candidate=13871
shared median sql.rowsRead increased without a recorded reason: baseline=27290, candidate=27860
hot median sql.statements increased without a recorded reason: baseline=11536, candidate=12194
shared retry exhaustion must remain zero; received 142
hot retry exhaustion exceeded baseline: baseline=0, candidate=1117
```

The audit did not report an uncontended p95/p99 latency regression,
serialized-result-byte regression, or transaction-duration regression. The
list above is the complete comparator output, including every reported
throughput, SQL, latency, and retry gate.
Task 5 therefore claims correctness evidence only, not performance acceptance.
Later remediation tasks must address the measured contention/resource
regressions, and Task 10 owns the governed final candidate and comparator
acceptance.

## Encountered non-product failures

- The first corrected producer invocation was sandbox-blocked from local
  PostgreSQL; the approved escalated rerun connected and completed. A focused
  live test invocation without `DATABASE_URL` also failed its explicit
  preflight before the corrected invocation used the local compose URL. An
  earlier connected correction run exposed the valid outside-transaction
  split-read race described in RED evidence; after its RED/GREEN fix, the final
  producer completed all workloads.
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

- The immutable request record intentionally stores only command identity and
  the compact receipt. Three mandatory nullable replay scalars add a small
  fixed receipt cost while preserving the full accepted PUT response without
  rereading mutable current state or retaining the full accepted payload.
- API startup delays generic runtime-state eviction until strict all-scope
  generation backfill succeeds. A pending ambiguous legacy key or corrupt
  topology row therefore keeps eviction fail-closed. Operators must stop old
  writers and run the explicit migration before restart instead of relying on
  startup or first access to move keys and risk silent version loss.
- Requests without `requestId` return a receipt but do not persist an immutable
  request record; effectful writes always persist the RTC recompute outbox.
- The Task 5 performance artifact is an interim correctness/evidence sample.
  Its disclosed throughput, SQL, and retry regressions are not waived or
  accepted; final remediation and performance acceptance remain with later
  plan tasks and the governed Task 10 comparison.
- The medium-scale black-box environment needs its group-create permission
  preflight corrected before it can provide a Task 5 live recipe result.
