# IndexedDB Admission Concurrency Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` with the repository
> `adaptive-plan-execution`, `rallar-code-writing`, `rallar-platform`,
> `rallar-realtime`, `performance-analysis`, `rallar-testing`, and
> `publishing-plan-progress` skills when implementation is requested. This document
> is a reviewed implementation proposal; writing it does not execute its tasks.

**Goal:** Remove unnecessary contention between browser AL admission operations
while preserving atomic state/effect writes and existing delivery guarantees.

**Architecture:** Retain the existing admission stores, QueueBox, and retry owners.
Replace the database/store-wide Web Lock and global revision check with optimistic
checks of the exact records and prefixes used by an operation. Compute outside
IndexedDB's write transaction, then validate observations and commit the prepared
batch in one transaction.

**Tech stack:** Native IndexedDB, existing TypeScript and `Either`, existing
QueueBox and resilience code, Vitest, and the installed Playwright/Vite tooling.
No dependency addition, dependency upgrade, new retry framework, or queue library.

**Design context:** This document defines the admission correction within the
single proving PR described by the
[RTC performance baseline plan](2026-08-06-rallar-rtc-performance-baseline-plan.md#current-execution-horizon).
It does not change the B05/B06 measurement contracts or activate B07.

## 1. Decisions and corrections to the earlier proposal

- **The measured benefit is a hypothesis.** Removing the Web Lock permits
  unrelated reads/computation to overlap and removes the global revision as a
  cause of false conflicts. It does not permit simultaneous IndexedDB commits
  against the same object store. Measure the additional guard-read cost before
  claiming a performance improvement.
- **Reuse existing retry owners.** QueueBox-delivered work performs one admission
  attempt per delivery. Direct calls use their existing runtime policy. Durable
  effects use their existing lease, wake, and reschedule behavior. Do not wrap
  these owners in another retry loop or enlarge their attempt/time budgets.
- **Update the complete shared contract.** `ALAdmissionBackend` is implemented by
  IndexedDB, memory, generic persistence, and PostgreSQL adapters. A typed-conflict
  change must update all implementations and consumers together. It is not a
  browser-only signature edit.
- **Delete obsolete code; do not build a migration.** Keep one current contract
  throughout the repository. Do not retain overloads, compatibility readers,
  metadata cleanup on open, old-client fences, or upgrade/downgrade machinery.
- **Do not promise exactly-once external effects.** A transport send can succeed
  before recording its completion fails. Preserve existing message/effect
  identities and deduplication, and test replay at that boundary. There is no
  transaction spanning IndexedDB and a network send.
- **Reads are observational.** Expired values remain absent to readers after
  validation, but direct reads and lists do not synchronously delete them.
  Existing maintenance performs conditional expiry deletion.
- **Use a consistent comparison.** Baseline A is the current implementation with
  the store-wide Web Lock. Candidate B contains this correction. The earlier
  reference to an "unlocked baseline" was inconsistent and is superseded.
- **Keep one PR through proof.** Implement and validate within the current RTC
  correction PR while it remains open. Do not merge test-only hypotheses. Moving
  `main` is expected; record observation provenance without waiting for it to stop.

The established IndexedDB patterns supporting this design are short transactions,
batching the writes that belong to one atomic operation, targeted key/range reads,
and waiting for transaction completion before reporting success. Overlapping
`readwrite` scopes are serialized by the browser.
[IndexedDB transaction scheduling](https://www.w3.org/TR/IndexedDB/#transaction-scheduling)
and [transaction lifecycle](https://www.w3.org/TR/IndexedDB/#transaction-lifecycle).

A Web Lock remains held until its callback's promise settles, which explains why
the current outer lock also serializes asynchronous computation.
[Web Locks lifecycle](https://w3c.github.io/web-locks/#locks).
Do not await network work, timers, or other unrelated promises inside a live
IndexedDB write transaction; the existing native request handlers are sufficient.
[Official idb transaction-lifetime guidance](https://github.com/jakearchibald/idb#transaction-lifetime).
The `idb` project is a reference here, not a proposed dependency.

## 2. Current storage contract

### Current owners and retained boundaries

| Boundary                         | Existing owner                                                                                                                            | Planned responsibility                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Cross-runtime admission contract | `packages/shared/alm/al-admission-backend.ts`                                                                                             | One canonical typed write outcome across all adapters.                                                           |
| Browser storage                  | `packages/shared/alm/indexed-db-admission-backend.ts`, `read-indexed-db-admission-snapshot.ts`, `write-indexed-db-admission-mutations.ts` | Capture observations, buffer prepared mutations, and perform atomic conditional writes.                          |
| Stored format and opening        | `packages/shared/alm/indexed-db-admission-row.ts`, `open-indexed-db-admission-database.ts`                                                | Keep row tokens and the current schema; stop creating or using obsolete revision metadata.                       |
| Domain admission and effects     | `packages/shared/alm/inbound/**`, `packages/shared/alm/outbound/**`                                                                       | Keep sender-version policy, effect identity, decisions, and retry routing visible at their current owners.       |
| PostgreSQL adapters              | `packages/shared-server/al-runtime/postgres/p-sql-{inbound,outbound}-admission-backend.ts`                                                | Translate existing conditional-write conflicts to the shared outcome; preserve PostgreSQL transaction semantics. |
| Browser maintenance              | `packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts`                                                                    | Conditional expiry deletion and point-in-time session-prefix cleanup.                                            |

Do not introduce a storage manager, generic retry adapter, separate single-writer
service, per-namespace database, additional object store, or new index. Existing
sender-scoped ordering remains a separate runtime boundary; this proposal removes
the store-wide lock and does not claim to remove all serialization.

### Write outcome

Use the existing `Either` implementation with named admission contracts. Its right
value must wrap the callback result because `Either.ofRight(undefined)` is invalid
and many current write callbacks return `void`.

```ts
export interface ALAdmissionWriteConflict {
    readonly kind: 'conflict';
}

export interface ALAdmissionCommitted<T> {
    readonly value: T;
}

// Excerpt: replace this method in the existing interface, without an overload.
export interface ALAdmissionBackend {
    write<T>(
        fn: (tx: ALAdmissionWriteContext) => Promise<T>
    ): Promise<Either<ALAdmissionWriteConflict, ALAdmissionCommitted<T>>>;
}
```

The left outcome means no mutation from this attempt committed. The right outcome
is returned only after successful transaction completion, and preserves `T` even
when it is `undefined`. Preserve the existing admission-store
`'committed' | 'conflict'` result where it already represents the domain boundary;
flatten a backend conflict into that result rather than exposing nested outcomes.
Propagate the typed result from effect claims, completion, rescheduling, control
acceptance, and guarded predecessor reads to their actual caller.

Remove `ALAdmissionBackendConflictError` and its catches, tests, and imports while
updating all consumers. Translate the PostgreSQL adapter's existing
`RuntimeStateWriteConflictError` at that adapter boundary; do not remove that
independently used runtime-state contract. Corruption, invalid schema, quota,
transaction aborts, and other operational failures are never classified as an
optimistic conflict merely because a write failed.

### Observation guards

1. A point read records its physical key and observed `writeToken`, including
   explicit absence. An expired row is logically absent but its physical token
   still guards replacement or removal.
2. Each prefix list records the ordered physical key/token pairs observed under
   that exact prefix, including expired rows. Revalidate both membership and
   tokens so insertions, deletions, and replacements cannot evade the guard.
3. A blind `set` or `remove` obtains a point observation before buffering its first
   mutation. Later operations on that key retain the original guard and see the
   pending value. New write tokens and persistence-ready values are created before
   entering the IndexedDB write transaction.
4. Preserve every dependency across repeated or overlapping reads. Never replace
   an earlier guard with a later token and thereby validate a stale computation.
   Cache repeated observations where possible; incompatible observations make the
   attempt conflict. Read-your-writes overlays must not become database guards.
5. Validate guards and apply the complete mutation batch in one `readwrite`
   transaction. Queue only IndexedDB requests and database-result comparisons
   inside it. A failed guard aborts the entire batch; return the callback's value
   only after `complete`, never after a `put` request succeeds.
6. Guard-only writes still validate their observations: some current callers use
   `backend.write` to obtain a validated predecessor result without mutations.
   Only an attempt with neither guards nor mutations can skip the final transaction.

Use the existing ordered prefix cursor approach, stopping at the first
non-matching key. Do not scan the whole database for a narrow prefix and do not use
`prefix + '\uffff'` as a universal upper bound. Compare native key order; do not
substitute locale ordering. Deduplicate identical guards without dropping an
earlier observation. Point writes scale with their dependency set; a prefix guard
necessarily scales with the observed prefix. In particular, an effect claim that
lists an entire namespace can still conflict with another write in that namespace.
The performance proof must expose this cost, not label every such conflict false.

`read` and `list` continue to validate persisted envelopes and payloads, including
expired rows, before treating them as absent. Corruption is not a cache miss.
Remove their synchronous expiry-write side effects. Do not change the meaning of
domain sender versions or duplicate-message decisions.

### Expiry cleanup and removal of obsolete code

- Periodic expiry cleanup uses the existing expiry index and guards only the
  selected physical rows. A refreshed selected row conflicts with that batch;
  it must survive. An unrelated row or newly expired row does not invalidate the
  batch. The existing next sweep handles remaining work. Report actual committed
  deletion counts; an aborted batch reports no successful deletions.
- Session cleanup guards its complete requested prefixes, including an empty
  prefix result, and commits all selected deletions atomically. A phantom or
  replacement yields a typed conflict. Keep the current session lifecycle's
  best-effort cleanup policy and the periodic expiry fallback; add no cleanup
  retry loop. Success describes the commit instant, not a promise that another
  tab can never write a new row later.
- Preserve the existing database name, single object store, key path, expiry
  index, database version, application keys, and row envelope. An incompatible
  existing schema still fails without being rewritten.
- Stop creating the global revision record. Delete revision reads, revision
  writes, revision decoders, the exported revision constant, metadata-row skips,
  and lock-specific tests. Do not add a replacement marker or cleanup hook.
- Compatibility with old-format browser databases or older running clients is
  outside scope. Test newly created current-format databases and restart them
  using current code. Do not promise safe mixed-version writers, rewrite existing
  data, or automatically clear/reset a user's database.

## 3. Existing delivery and retry ownership

| Entry or failure                              | Required handling using current owners                                                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inbound stored QueueBox entry                 | `ALInboundMessageRuntime.dispatchStoredEntry` and `ALInboundAdmittedDelivery` return `'retry'` on conflict. Existing `QueueBoxUtilities.withRetryDisposition` and dequeue handling own redelivery.                                                                              |
| Outbound QueueBox dequeue                     | `ALOutboundMessageRuntime.dequeue` makes one admission attempt. Let the existing dequeue failure path release/retry the entry; bypass the direct-call `tryWithPolicy` loop for this entry.                                                                                      |
| Direct inbound/outbound and control calls     | Keep the existing inbound policy and `ALOutboundDispatchAdmission.COMMIT_RETRY_POLICY`. At these exception-based policy boundaries only, translate the typed conflict to existing `RetryableConflictError`. Each retry repeats the full read/compute/validate/commit operation. |
| Durable-effect claim conflict                 | Execute no uncommitted claim. Use the existing drain scheduler and retry delay to wake a later attempt; do not return an empty successful claim or immediately spin the drain.                                                                                                  |
| Durable-effect completion/reschedule conflict | Do not count completion or overwrite another lease owner. Retain durable work, use the existing drain scheduling/lease recovery, and re-read before another state mutation. Do not rerun a transport send inside a persistence retry callback.                                  |
| Persisted corruption or incompatible schema   | Keep the existing terminal corruption classification. Do not convert it into `'retry'` or log it as successful completion.                                                                                                                                                      |

The current inbound delivery helpers and outbound dequeue path contain nested
commit-policy calls. Split their single-attempt operation from the existing
direct-call retry entry at the current owner, so QueueBox does not acquire another
retry budget. Use explicit call paths, not a new public retry-mode option or a
generic retry service. A conflict during an ordered-delivery update returns to the
same delivery owner with fresh state on the next attempt.

Claims, transport effects, and completion are separate boundaries. Preserve
existing effect/message identity and lease-owner checks. Test the case where a
send succeeds and completion loses a race: another delivery can occur, but
deduplicated queue records and protected domain effects must remain consistent.
Do not claim exactly-once delivery at a raw transport sink.

If a concrete entry cannot use these existing owners, record that entry and the
missing behavior before proposing an extension. Ask for permission before adding
a dependency, a new queue, or a new retry mechanism. Ordinary wiring changes that
route typed outcomes into the listed existing owners are part of this plan.

## 4. The next two implementation slices

### Slice 1: Atomic guarded admission with consistent callers

**Deliverable:** Independent record writes can commit without the store-wide Web
Lock; actual conflicts are atomic and reach the correct existing retry owner.
Keep this slice in the current PR until Slice 2 supplies its performance proof.

- [ ] Replace the serialization test in
      `packages/tests/shared/alm/al-admission-backend.test.ts` with behavior tests for
      overlapping independent writes and same-key conflicts. Use explicit test
      barriers to control observations, with cleanup that releases barriers on failure.
      Prove the current implementation fails the new independent-progress behavior.
- [ ] Add the distinct guard/current-format cases in the acceptance matrix below.
      Retain current corruption, asynchronous callback rollback, and pending-write coverage.
- [ ] Update the backend return type and all memory, persistence, IndexedDB, and
      PostgreSQL implementations and consumers in one coherent change. Update mocks
      and fixtures too; keep no overload or exception-based admission fallback.
- [ ] Implement the observation buffer and atomic writer as specified in Section 2.
      Retain native request/transaction helpers and the existing connection owner.
      Read/compute callbacks run once per backend call and have no external effects.
- [ ] Make expiry reads observational, delete obsolete revision code, and update
      browser maintenance callers to explicit committed/conflict handling.
- [ ] Route QueueBox, direct calls, and durable-effect results as specified in
      Section 3. Do not translate a conflict into a successful claim, completion,
      accepted control message, cleanup count, or dequeue result.
- [ ] Run the focused unit/browser tests and package typechecks listed below.
      Follow each changed path from its registration to guard, durable result, and
      after-commit action. Review every changed human-authored file in full; support
      files changed during remediation enter that review recursively. Independent
      untouched code remains outside closure.

**Focused commands** (run from the repository root during implementation):

```sh
npx vitest run packages/tests/shared/alm packages/tests/shared/al-inbound-message-runtime.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/al-outbound-durable-effects.test.ts packages/tests/shared/ws-outbox-owner-miss-retry.test.ts packages/tests/shared/queuebox-utilities.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts
npx vitest run packages/tests/shared-web/al-runtime packages/tests/shared-web/session/browser-auth-session-cleanup.test.ts packages/tests/shared-server/al-runtime/postgres/p-sql-admission-validated-reads.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/browser-indexeddb-transaction-writes.spec.ts
```

Extend the existing browser IndexedDB fixture/spec for real transaction behavior.
Multiple same-origin pages must share one browser context/storage partition and
database name; separate Playwright contexts do not exercise shared-storage races.
Use the existing server configuration, reporting any unavailable service as a
validation limitation rather than weakening the assertions.

### Slice 2: Browser performance comparison and end-to-end proof

**Deliverable:** A reproducible comparison demonstrates the correction's behavior
and cost, and the existing RTC scenario still passes on the same implementation.

- [ ] Add one diagnostic workload under `packages/shared-rtc-bench/diagnostics/`
      named `indexeddb-admission-concurrency.ts`, with its mirrored package tests.
      It constructs production admission stores, runtimes, and QueueBox instances;
      it does not reimplement their commit or retry logic.
- [ ] Add its browser driver beside the existing IndexedDB Playwright spec as
      `indexeddb-admission-concurrency.spec.ts`. Load the workload through the
      existing Vite module path pattern. Use only installed tooling and document the
      exact invocation in the package README. Generated measurements belong under
      `tmp/perf/indexeddb-admission/`, outside accepted B05/B06 archives.
- [ ] Capture A from the pre-correction implementation and B from the candidate
      in separate clean checkouts using the same diagnostic workload and public
      runtime/admission-store boundaries. Keep old production code only in Git's
      comparison checkout, not in the candidate or a compatibility adapter. Record
      source identity and diagnostic source identity separately.
- [ ] Run the workload matrix and A-B-B-A protocol below. Compare committed
      throughput and end-to-end latency including existing retries. Record all
      attempts, failures, and durable readback, not just the fastest successful calls.
- [ ] Run the existing local memory RTC default, all-scenarios, and retention
      diagnostics, then the current PR's required independent diagnostic series.
      These remain diagnostic evidence until a post-merge observation is captured.
- [ ] Complete affected PostgreSQL, application, style/navigation, and branch
      validation after the focused checks. Because shared runtime retry routing and
      PostgreSQL admission contracts are affected, include their real-database
      regression evidence; do not describe this as an IndexedDB-only validation.
- [ ] Review the full change and affected legacy, then update the same PR with
      behavior, measured results, and limitations. Merge only after correctness and
      performance evidence support the correction. After merge,
      use the existing RTC plan's next observation from then-current `main`.

**Workload and measurement protocol:**

| Case                                     | Fixture and purpose                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sequential                               | One lane, 600 operations; determine uncontended overhead.                                                                                        |
| Independent namespaces                   | Six lanes, 100 operations per lane, one shared database/store; expose the unnecessary store-wide wait.                                           |
| Independent senders within one namespace | Six lanes with distinct sender/version/effect keys; distinguish record independence from namespace-level scans.                                  |
| Shared sender/key                        | Six lanes contend on one domain predecessor using existing runtime/QueueBox delivery; verify convergence and account for every retry/exhaustion. |
| Prefix-dependent effects                 | Concurrent admission and effect draining in one namespace; expose real range conflicts, claim cost, and successful recovery.                     |

Run each case with 32, 512, and 4,096 pre-existing rows, using the same distribution
and 1 KiB payloads for A and B. Use valid rows constructed through the production
store boundary. Exclude seeding, database opening, and final evidence readback
from steady-state timing; report opening time separately. Recreate only the
test-owned database between measurements. For cross-tab cases, use three
same-origin pages in one browser context, with two lanes per page. Synthetic
delay/barrier tests prove correctness separately and do not count as throughput
evidence.

Use four capture positions in order A-B-B-A. At each position discard one warmup
and retain five executions of each case: ten retained executions per implementation
in total. Use the same browser build, machine, configuration, workload, storage
partition policy, and durability setting. This controls a comparison without
pinning `main` or invalidating other observations when `main` changes.

One driver invocation owns one capture position, using those fixed workload,
warmup, and retained-execution counts. Run it serially with Playwright retries
disabled so a failed attempt cannot be replaced invisibly. Write measurements
through `testInfo.outputPath` inside the selected capture directory. For example,
the first baseline position runs from A's checkout as:

```sh
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/indexeddb-admission-concurrency.spec.ts --workers=1 --retries=0 --output=tmp/perf/indexeddb-admission/A1
```

Use separate `B1`, `B2`, and `A2` output directories for the remaining positions.
Use fresh browser/server processes for each checkout so a reused Vite process
cannot serve the other implementation. Fail if the intended server port is
already owned by another run; do not terminate an unrelated process.

Retain raw operation timings and outcome identities; derive p50/p95 latency,
successful operations/second, conflict/attempt counts, and exact final state.
Separate complete-operation duration from IndexedDB transaction duration. Only
report internal request counts, transaction timing, or memory when the diagnostic
actually captures them at the real boundary. No new production diagnostic API is
required merely to fill an artifact field.

Correctness gates require no lost writes, no partial batches, no execution of
uncommitted claims, no false conflicts between disjoint point dependency sets,
and correct persisted state after existing retry handling. Test deliberate retry
exhaustion separately; do not silently discard exhausted measured operations.
Prefix membership changes are real dependencies, not automatically false conflicts.

The comparison uses the previously chosen 5% tolerance: candidate uncontended p95
must be at most 1.05 times A, and independent-workload committed throughput must be
at least 0.95 times A. Report per-case/per-size results without hiding a regression
in an aggregate. Show sample spread and the two A/B capture positions. If their
variation prevents interpreting a 5% difference, mark performance inconclusive
and investigate the workload or environment; do not manufacture a pass, loosen
limits, or repeatedly run until a favorable sample appears. No-regression is not
proof of a speedup, and failure to establish a speedup does not invalidate correct
observations elsewhere in the RTC stream.

**Additional implementation validation:**

```sh
npm --workspace @ar-eye-hunter/shared-rtc-bench run check
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
npm run test:rallar:full-stack:memory:live-rtc-3
RALLAR_BLACK_BOX_LIVE_ALL_SCENARIOS=1 npm run test:rallar:full-stack:memory:live-rtc-3
RALLAR_BLACK_BOX_LIVE_RETENTION_SOAK=1 RALLAR_BLACK_BOX_LIVE_RETENTION_CYCLES=100 npm run test:rallar:full-stack:memory:live-rtc-3
npm run test:postgres:integration
npm run test:api-v1:black-box:postgres:medium-scale
npm run perf:api-v1:state-write -- --backend=postgres --warmup=1 --runs=3 --concurrency=10 --out=tmp/perf/indexeddb-admission/api-state-write-candidate.json
node scripts/perf/compare-api-v1-state-write-results.mjs tmp/perf/indexeddb-admission/api-state-write-baseline.json tmp/perf/indexeddb-admission/api-state-write-candidate.json
```

Capture the PostgreSQL baseline with the same existing harness/options in A's
checkout before the comparative command. Follow `scripts/perf/README.md` for
database isolation and order-balanced measurement when required. This server
regression evidence is not a substitute for the browser A/B comparison or an
accepted RTC-B06 E4-pg observation. Run API-v1's Deno check and affected public API
snapshots/browser bundle checks when their actual exports or consumers change.

Before broad final validation, inspect `npm run pr:delivery -- status`. Repair a
real merge conflict first; `BEHIND` alone creates no rebase work. Run the repository
style/structure checks and the navigation report for the affected AL, browser
maintenance, and PostgreSQL adapter roots, then perform the manual 5/5 navigation
probe. Finish with full unit/branch gates selected by the affected change and one
`npm run pr:delivery -- ready` handoff. This document-writing task does not mark
the existing implementation ready or trigger a workflow.

## 5. Acceptance and legacy review

| Risk                               | Required independent behavior proof                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lost updates/write skew            | Two writers read the same point or dependency pair; one loses its stale guard, the whole losing batch remains absent, and the existing outer retry recomputes from the winner.                                                     |
| False conflicts                    | Independent point writes in different namespaces and within one namespace both commit, including when one callback yields across a macrotask.                                                                                      |
| Phantoms and guard weakening       | Cover empty prefixes, insert/delete/replace, overlapping prefixes, repeated reads, read-your-writes, missing keys, and maximum UTF-16 suffixes. An earlier stale observation is never overwritten by a later guard.                |
| Transaction lifetime               | A callback can fail after buffering writes with no partial commit. Prepared payloads/tokens exist before native transaction entry, and request success followed by abort is not reported as committed.                             |
| Guard-only and void results        | A validated predecessor read can conflict even without mutations; a successful void callback is represented without constructing an invalid `Either`.                                                                              |
| Expiry and cleanup                 | Expired values are absent without read-time mutation, corrupt expired rows still fail, refreshed rows survive cleanup, session prefix phantoms conflict, and deletion counts reflect commits.                                      |
| QueueBox retry multiplication      | One queued admission attempt per delivery; the next existing redelivery re-reads/recomputes. Existing attempts, delay, release, and exhaustion handling remain observable.                                                         |
| Durable effects                    | A lost claim performs no effect; stale completion/reschedule cannot alter another lease; replay after successful send/failed completion preserves protected domain and queue identities.                                           |
| Current-format storage and restart | New databases contain token-bearing application rows without global revision metadata; current-code restart preserves those rows; an incompatible schema fails without repair. No old-format or mixed-version support is required. |
| Cross-runtime consistency          | Memory, provider, IndexedDB, and PostgreSQL callers consume the same result, preserve successful values, and keep corruption/operational errors distinct from conflicts.                                                           |

Remove the temporary store-wide lock, global-revision machinery, obsolete
exception, old return signatures/overloads, and tests that only pin those
implementations. Preserve the row `writeToken`, domain sender versions, QueueBox
identities, and existing retry policies because they still implement the chosen
contract. Do not delete unrelated storage, add a migration, or retain a dormant
old implementation. A new library, queue, or retry mechanism requires the user's
permission before implementation; none is currently proposed.

Completion requires a full review of every changed human-authored file; every
support file changed by that remediation enters closure recursively. Independent
untouched code remains outside closure. Report which correctness, package,
browser, performance, and remote checks passed, failed, or were unavailable.
No production behavior or performance result is claimed by this written plan.
