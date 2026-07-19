# Task 5 report: convergent group topology configuration

## Scope and architecture

- Base: `e78881ef71b8cc0ab051b75405ef63458b6a7b05`.
- Current clean implementation commit:
  `8a5863ef8a56d6537ca2040ab6ca8b3687f52fdb`.
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
  `writeTopologyConfigMutation` opens the short transaction and orders the group
  authority fence first, followed by the conditional topology state guard,
  shared invariant-generation CAS, per-target generation CAS, optional
  first-writer request record, then the sole insert-only
  `rtc-topology-recompute` outbox record.
- Every retry uses `GroupStateRepository.readSnapshotWithAuthorityGuard`, which
  brackets the aggregate and child reads with the same stable-snapshot check and
  returns the exact raw persisted group entry as an authority guard. The
  mutation service requires this production repository seam and never falls
  back to a cache; ordinary read-only topology service construction remains
  compatible without it. Each retry reruns lifecycle, role, configuration,
  expiry, and invariant validation. Matching replay and conflicting request
  reuse recheck fresh durable status and actor/admin role, but do not
  materialize clock-dependent mutation-admission facts.
- The authority fence is the first transactional database statement. It CASes
  the exact observed group row, preserving its raw JSON bytes and physical
  expiry while advancing only its storage/causal revision. A concurrent archive,
  owner transfer, or membership/role change therefore conflicts before any
  topology, request-ledger, or outbox write and forces the full authorization
  path to rerun. The applied outbox and receipt use the predicted post-fence
  causal revision; a no-op still fences before its idempotency-only receipt.
- Mutation facts separate stable request data from attempt-local policy time.
  The first non-replay attempt fixes stored creation/update time, relative
  override expiry, command hash, and delete target. Every later non-replay CAS
  attempt obtains a fresh policy clock for active/unexpired lifecycle checks,
  so retries cannot authorize against stale time or extend TTL. Replay and
  conflicting request reuse still probe the immutable ledger before invoking
  the clock. Platform admins bypass membership/role only; the shared active and
  unexpired group lifecycle policy applies to every actor. A relative override
  expiry that elapses before a retry is rejected with the typed topology config
  validation error instead of being extended or committed already expired.
- Request IDs are immutable first-writer claims. The canonical command is
  normalized before its SHA-256 digest is computed once. Records contain
  exactly `{groupRef, requestId, commandHash, receipt}`. Mandatory nullable
  creation/update/override-expiry scalars in the receipt reconstruct the
  original PUT value from the verified command even after later overwrite or
  delete; no full accepted payload is retained. Replay explicitly binds the
  receipt operation to the freshly verified command before choosing a
  reconstruction branch. Record validation also binds scoped key/request ID,
  command ID/hash, operation/target, outcome/effect, version, storage revision,
  timestamps, and expiry. PUT receipts must be `applied`; only DELETE receipts
  may represent either an applied delete or a legitimate no-op. The compact
  receipt additionally carries a required nullable exact five-field
  `acceptedCausalRevision`; it is non-null only for applied mutations and null
  for no-ops. Replay recomputes the receipt-addressed outbox ID from the verified
  command, scope, and accepted causal identity instead of trusting a stored ID.
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

The v6 correction RED ran the same three focused suites and exited 1 with
exactly 8 failures and 89 passes across 97 tests. Both `putConfig` and
`putOverride` impossible no-op receipts passed the pure validator, repository,
and service replay boundaries, allowing reconstruction of state that had never
been accepted. The remaining two failures showed pure facts and a forced CAS
retry accepting stable expiry `6000` when attempt-local policy time was `7000`.
The first GREEN passed all 97 focused tests while retaining the clock-free replay
assertion and proving the failed retry committed no state, request record, or
outbox intent.

The v7 correction began with tests only. The focused RED command exited 1 with
exactly 5 failures and 53 passes: archive and owner-demotion operations that
overlapped the gap between a stable authority read and the transaction still
allowed the topology mutation to commit, while a receipt with only its outbox ID
tampered passed the pure validator, repository decoder, and service replay.
After the production authority fence and causal receipt binding were added, the
six focused server/performance files passed all 151 tests.

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
- archive, owner transfer, and membership/role changes committing after the
  mutation's stable authority read but before its first topology write;
- a structurally valid compact receipt whose stored outbox ID did not match the
  accepted group causal identity;
- an authority fence that could have normalized semantically valid legacy group
  JSON instead of preserving the exact observed raw bytes and expiry;
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
  outbox transaction back, including the group authority-fence revision. Winner
  reread happens only after the conflicted transaction has closed.
- A stale group authority guard cannot cross the first transactional statement.
  PGlite and independent-client PostgreSQL races pause immediately after the
  stable authority read, archive the group through another repository/client,
  and prove the resumed mutation returns 403 with no topology config,
  idempotency record, or outbox intent. Equivalent deterministic races cover
  owner transfer/demotion and administrative lifecycle changes.
- Stored update time is monotonic under clock skew. Stored write time and
  override expiry are resolved once from request-stable facts, while every
  non-replay retry supplies fresh lifecycle policy time; stale expiry cleanup
  remains revision guarded. If policy time reaches that stable expiry, the
  mutation fails with `override-expiry-not-in-future` and does not write state,
  a receipt, or an outbox record.
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
  rejects a receipt whose operation does not match that command. The receipt
  validator also rejects no-op PUT receipts at pure, repository, and replay
  boundaries, while preserving legitimate DELETE no-op claims.
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
v5 RED: 2 files failed; 13 tests failed; 68 tests passed (81 total)

npm run test:unit -- packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/group-topology-management-service.test.ts
v5 first GREEN: 3 files passed; 89 tests passed

npm run test:unit -- packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/group-topology-management-service.test.ts
v6 RED: 3 files failed; 8 tests failed; 89 tests passed (97 total)

npm run test:unit -- packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/group-topology-management-service.test.ts
v6 first GREEN: 3 files passed; 97 tests passed

npm run test:unit -- --run packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/group-topology-management-service.test.ts
v7 RED: 2 files failed; exactly 5 tests failed; 53 tests passed

npm run test:unit -- --run packages/tests/shared-server/group-state-authority-fence.test.ts packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/state-write-performance-harness.test.ts packages/tests/shared-server/group-list-fanout-performance-harness.test.ts
v7 GREEN: 6 files passed; 151 tests passed

npx vitest run packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/state-mutation-outbox.test.ts packages/tests/shared-web/api-workflows.test.ts packages/tests/shared-server/state-write-performance-harness.test.ts
6 files passed; 226 tests passed

npx vitest run packages/tests/shared-server/state-write-performance-harness.test.ts packages/tests/shared-server/group-list-fanout-performance-harness.test.ts
2 files passed; 46 tests passed

cd apps/api-v1 && deno test -A test/db/pglite-sql-adapter.test.ts
20 passed; 0 failed, including the authority-overlap archive race

RALLAR_POSTGRES_INTEGRATION=1 DATABASE_URL=postgres://app:app@localhost:5432/appdb npx vitest run packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts
9 passed; 0 failed (independent PostgreSQL clients)

cd apps/api-v1 && deno test --allow-env --allow-read test/services/runtime-state-expiry-startup.test.ts
2 passed; 0 failed

cd apps/api-v1 && deno test --allow-env --allow-read test/swagger-routes.test.ts
12 passed; 0 failed

cd apps/api-v1 && deno test --allow-env --allow-read test/services/runtime-state-expiry-startup.test.ts test/swagger-routes.test.ts
14 passed; 0 failed

cd apps/api-v1 && deno task test
210 passed; 0 failed

npm --workspace @ar-eye-hunter/shared-test run check
TypeScript and Deno checks passed

cd apps/api-v1 && deno task check
passed

npm run test:unit -- --run packages/tests/shared-web/api-workflows.test.ts
1 file passed; 34 tests passed

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
commit `8a5863ef8a56d6537ca2040ab6ca8b3687f52fdb`:

```text
DATABASE_URL=postgres://app:app@localhost:5432/appdb npm run perf:api-v1:state-write -- --backend=postgres --warmup=1 --runs=3 --concurrency=10 --out=tmp/perf/api-v1-state-write-task5.json
```

The resulting canonical artifact remains ignored and uncommitted at
`tmp/perf/api-v1-state-write-task5.json`. Its embedded `gitCommit` is exactly
`8a5863ef8a56d6537ca2040ab6ca8b3687f52fdb` and its SHA-256 is
`a9c647b2df93d942ccc540bbbcb6b5bb87d263097923b907ed889cefdfe0b49a`.

```text
validateStateWriteArtifact(finalArtifact)
[]

uncontended: 2100 accepted/receipts; 3900 required/actual intents; DBW []
shared:      1924 accepted/receipts; 3603 required/actual intents; DBW []
hot:         1014 accepted/receipts; 1925 required/actual intents; DBW []
```

The run used `warmup=1`, `runs=3`, and `concurrency=10`. Its measured summaries
were:

```text
uncontended: p50=11.400959ms p95=13.809291ms p99=15.103875ms throughput=857.045755/s conflicts=0 exhausted=0
shared:      p50=12.873750ms p95=34.645500ms p99=39.118960ms throughput=611.299283/s conflicts=576 exhausted=176
hot:         p50=13.796166ms p95=42.541000ms p99=49.045292ms throughput=286.860519/s conflicts=1368 exhausted=1086
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
`a9c647b2df93d942ccc540bbbcb6b5bb87d263097923b907ed889cefdfe0b49a`
before and after the comparison and was never relabeled. The fresh clean-commit
audit reported exactly these ten interim failures:

```text
shared throughput regressed: baseline=752.2423201768095, candidate=611.299282628854
hot throughput regressed: baseline=295.1851420383843, candidate=286.8605186747277
shared throughput must improve after presence is split from the group aggregate
uncontended median sql.statements increased without a recorded reason: baseline=11200, candidate=13000
uncontended median sql.rowsRead increased without a recorded reason: baseline=5400, candidate=7900
shared median sql.statements increased without a recorded reason: baseline=11352, candidate=13948
shared median sql.rowsRead increased without a recorded reason: baseline=27290, candidate=27500
hot median sql.statements increased without a recorded reason: baseline=11536, candidate=12379
shared retry exhaustion must remain zero; received 176
hot retry exhaustion exceeded baseline: baseline=0, candidate=1086
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
- The broad `npm run test:unit` owner run completed 447 files (443 passed and 2
  skipped) and 4192 tests (4174 passed, 10 skipped, and 8 failed). Rerunning the
  two failing files reproduced the same unrelated baseline failures in
  `rallar-workflow-options-compat.test.ts` (seven mock argument-shape
  expectations) and `data-caches.test.ts` (one legacy fixture missing a causal
  revision). Task 5 touches neither failing file; its only shared-web test edit,
  `api-workflows.test.ts`, passes all 34 tests.

## Follow-up and tradeoffs

- The immutable request record intentionally stores only command identity and
  the compact receipt. Mandatory nullable replay scalars plus the exact
  five-field accepted causal revision add a small fixed receipt cost while
  preserving the full accepted response and binding replay to its outbox intent
  without rereading mutable current state or retaining the full accepted
  payload.
- Authority fencing intentionally advances the persisted group storage/causal
  revision for both applied and idempotency-only no-op topology commands. The
  domain group JSON, group versions, and expiry remain byte-for-byte unchanged;
  min-revision cache reads refresh rather than treating a stale cached revision
  as mutation authority.
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
