# ALM P1b: probes on the engine's cadence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the three per-send probes off a durable send's window by building on the QueueBox engine's own cadence designs, so a warm durable send runs at most 6 IndexedDB transactions between `enqueueIfAbsent` and the carrier send (8 today), 8 in all (11) and 15 operations (18); add a count cap to the cache library and move the canonical hand-off onto it; add a receipted command-shaped send to the plain-page harness and record its reading as I2b evidence; fix the head-of-line stall that plan exposed (an ACK completes the send's ACK-timeout work row).

**Architecture:** The readiness memory the commit suspends is restored after a clean batch and handed to the engine through its existing `wakeAt`, so no probe follows a send (D112). The two sweeps (finalize-exhausted, lease-timeout reserve) run behind a per-lane pair of `RateLimiter` lock limiters in the role the ResourceInbox dequeuer's status checks play, one sweep per lease window on the lane's clock, with the readiness scan treating lease ends as not due while a sweep's limiter is closed (D113); every outbound lane shares that design, the inbound owner is configured to sweep every batch. `LatestRepository` and `ObservableLatestRepository` gain `maxEntries` and the hand-off becomes a capped `LatestRepository` with a per-entry deadline (D114). The harness gains a receipted command plan (D115). The target is pinned by the ledger on a lane-controlled clock (D117).

**Tech Stack:** TypeScript, Vitest with fake-indexeddb and fake clocks, Playwright (Chromium, persistent profile), esbuild for the harness page, dprint.

**Spec:** `playground/alm/alm-p1-design-proposal.md` §9–§13; decisions D112–D118 in `playground/alm/alm-improvement-plan.md`; QoS plan §3.1, §7.3, §10 in `playground/alm/alm-qos-product-plan.md`. The surveys the spec rests on are in the session scratchpad (`p1b-survey/`); their measured facts are restated in the spec's §9 and §11.

## Global Constraints

- **The maintainer's notes bind every task, verbatim: "no migration code, avoid duplications, reuse existing repo patterns, use repo guidance."** No compatibility path and no data migration: the old per-send cadence is removed, and the inbound owner's every-batch sweep is a configuration of the one port input, not a legacy path. One limiter design shared by every outbound lane, browser and server; one cap implementation in the cache library. Build on `ResourceInboxResilience` and `RateLimiter`, `InboxOutboxEngine.wakeAt`, `LatestRepository`. Follow `.agents/skills/rallar-code-writing/references/repo-code-style.md`. Every task records its D8 reuse inspection against `packages/shared/cache` and `packages/shared/resilience` in its commit message body (one line: what was reused, what was not and why).
- **No guarantee changes** except the recovery bound D113 states: a crashed lease or an exhausted row is recovered at most lease end + 19.1 s (today + 6.6 s). Supersedence, settlement, expiry, the D17 fence, the group commit path and the volatile lane (the D55 pin 0/0) are unchanged. A due RETRY or `not-ready` row keeps 0 ms added delay; a row another tab or a reload added is found within 6.6 s.
- **No schema bump, no new dependency, no worker, no new timer** (the limiter pair is spent inside batches; `deleteExpiredIntervalMs` is never set on the hand-off).
- **Pins only fall** (D87, D117). Targets: warm durable send chain ≤ 6, total ≤ 8, `al-admission` 10, `al-work` ≤ 5, on the ledger's lane-controlled clock; the cold pin set by measurement in the task that moves it; the inbound pins (chain 9/11, total 11/13, `al-work` 5/7) do not move. Each pin is lowered in the commit of the production change that lowers it, with the reason string naming what is gone.
- **Bundle budgets:** `packages/shared-web/bundle-budgets.json` (rallar.ts 230 KiB; 229.026 at P1a) and `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (293; 292.497). A crossed budget is raised to the next whole KiB with the measured figure in the commit message, never further.
- **Code standard:** canonical verbs, functions ≤ 40 lines, ≤ 3 positional parameters, required fields by default (an optional field only where absence has a distinct meaning, stated in its doc line), `Either` for expected failure, kebab-case files named after the primary export, no role folders, no comments except an essential invariant (test-intent comments fine), never a plan/decision/task/PR id in code or tests, no attribution lines in commit messages.
- **Formatting:** dprint only on touched files (`npx dprint fmt <file> <file>`), never a glob.
- **Per-task checks:** focused tests for the touched package, `npx tsc -p packages/shared/tsconfig.json --noEmit`, `npm --workspace @ar-eye-hunter/shared-web run typecheck`, `npm --workspace @ar-eye-hunter/shared-server run typecheck`, `cd apps/api-v1 && deno task check`, `node scripts/check-tests-typecheck.mjs`, `npm run check:repo-style:changed -- origin/main HEAD`, `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`; `npm run test:unit:main` once before the commit of every production task (sandbox disabled); `npm run check:test-reachability` when a test file is added.
- **Navigation maps** (`packages/shared/alm/outbound/README.md`, the work handler's doc, `packages/shared/cache` docs, `runtime-diagnostic-contract.md`) are updated in the task that changes what they describe and never claim behaviour the code lacks.
- **Git:** one commit per task by the implementer; the controller pushes after the task's review; never `git stash`, never push, never merge, never `pr:delivery ready`, never `db:down`; the Postgres container `ar-eye-hunter-postgres` is never stopped or recreated.
- **Hosted proofs** from the PR branch only (`--ref claude/alm-p1b-probe-cadence -f ref=…`); at most two hosted ALM full reads, the variable `RALLAR_BLACK_BOX_ALM_SCOPE=full` set just before and deleted right after each (verify none remain).

## File structure

| Area               | Files                                                                                                                                                                                                                                                                                                                                                                 | Responsibility                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Cache cap          | `packages/shared/cache/LatestRepository.ts`, `ObservableLatestRepository.ts`; tests in `packages/tests/shared/`                                                                                                                                                                                                                                                       | `maxEntries`: oldest first insertion evicted on accept/set; the observable one emits its delete event                      |
| Hand-off           | `packages/shared/alm/outbound/lane/al-outbound-canonical-handoff.ts`, its construction in the lane/runtime; `packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts`                                                                                                                                                                                | A capped `LatestRepository` with the send's deadline per entry; take = `readAt` then `delete`                              |
| Readiness          | `packages/shared/alm/work/al-work-handler.ts`, `packages/shared/services/InboxOutboxEngine.ts` (comment); tests in `packages/tests/shared/alm/work/`, `outbound-readiness-probe-diagnostics.test.ts`, the ledger's idle wait, the harness's per-send end                                                                                                              | Suspend at the commit, restore after a clean batch through `wakeAt`; exact invalidation label                              |
| Sweeps             | `packages/shared/alm/work/al-work-queue-port.ts`, `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts`, `al-outbound-work-entry.ts` (scan clamp), `al-inbound-store-lane.ts` (every-batch), `packages/shared/queuebox/resource-inbox/resource-inbox-resilience.ts` (clock-taking status-check export) or one lane function; the test ports; fake-clock tests | The lease-recovery input; a limiter pair per lane; the clamp; the first batch sweeps                                       |
| Harness            | `tests/playwright/alm/**`; `packages/shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts` (the client's planner, exported)                                                                                                                                                                                                                    | The receipted command plan beside the minimal plan, planned the way the WS client plans it                                 |
| Receipt completion | `packages/shared/alm/outbound/**` (the receipt's completing commit), tests in `packages/tests/shared/alm/`                                                                                                                                                                                                                                                            | An ACK that completes a receipt also completes the send's ACK-timeout work row in the same commit (the head-of-line stall) |
| Ledger and pins    | `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts`, `al-indexeddb-operation-counts.test.ts`                                                                                                                                                                                                                                                          | The targets on a lane-controlled clock                                                                                     |
| Docs               | `packages/shared/alm/outbound/README.md`, `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`, `playground/alm/alm-qos-product-plan.md` §7.1, the PR body                                                                                                                                                                                       | Navigation maps and figures                                                                                                |

## Task order

1 (cache cap) → 2 (hand-off) → 3 (readiness restore) → 4 (sweeps) → 5 (receipted harness plan) → 6 (the receipt completes the ACK-timeout row) → 7 (close). Task 2 consumes Task 1's option; Task 4's ledger figures are measured on Task 3's result; Task 5 follows Task 3's change of the harness's per-send end; Task 6 is measured by Task 5's receipted plan.

---

## Rulings made while writing the plan

Each is a choice the spec does not settle, taken by the plan's author from the writers' prototypes. The maintainer
can undo any of them; the cost column says what a wrong ruling costs.

| Id       | Ruling                                                                                                                                                                                                                                                                                                                                                           | Why                                                                                                                                                                                                                                                                                                                                                      | Cost if wrong                                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-P1b-1  | `WriteThroughObservableLatestRepository` and `WriteBehindObservableLatestRepository` refuse `maxEntries` (their option types `Omit` it), added as a step of Task 1.                                                                                                                                                                                              | They pass options to an inner observable repository, and an eviction's `Deleted` event would make write-behind delete the row from persistence: a cache cap must never delete stored data without a decision.                                                                                                                                            | A caller that wants a capped write-behind cache later needs a recorded decision on persistence semantics first.                                                                                |
| R-P1b-2  | The cap evicts the oldest first insertion even when an expired entry exists; no expiry sweep on an over-cap insert.                                                                                                                                                                                                                                              | D114 says oldest insertion; `acceptAt` already runs the rate-limited expiry sweep; the hand-off's deadlines grow with insertion order so the oldest is also the first to expire.                                                                                                                                                                         | A capped repository whose entries expire out of insertion order holds an expired entry one slot longer.                                                                                        |
| R-P1b-3  | `compareAndSet` on a missing key still creates an empty entry (pre-existing), which a cap can now count; left as is, noted in the PR body as a follow-up.                                                                                                                                                                                                        | No capped user calls `compareAndSet`; fixing it is outside P1b.                                                                                                                                                                                                                                                                                          | None for P1b's callers.                                                                                                                                                                        |
| R-P1b-4  | The hand-off takes `nowMs` per call (`setCommitted(bundle, nowMs)`, `takeCanonical(key, nowMs)`) from the lane's `readNowMs()`; the runtime's constructor input is unchanged.                                                                                                                                                                                    | The lane owns the clock; threading it per call keeps the hand-off a pure function of its inputs.                                                                                                                                                                                                                                                         | None.                                                                                                                                                                                          |
| R-P1b-5  | The cap helpers (`MaxEntriesOptions`, `assertMaxEntries`, `deleteOldestEntriesPastMax`) live in `LatestRepository.ts` and are imported by the observable repository; no new file.                                                                                                                                                                                | `packages/shared/cache` holds 29 files against the directory-density limit of 20; the changed-style gate refused a new file.                                                                                                                                                                                                                             | If the cache directory is ever split, they move with the repository.                                                                                                                           |
| R-P1b-6  | `ALWorkHandler.committed(writtenDueByMs)`: a batch restores the suspended memory only if it started at or after the latest due time of every row the commit wrote (the outbound commit passes the latest `retryAtMs` of its effects; control admissions, the `commitAll` error path and the inbound lane pass `undefined` = no restore).                         | The spec's "clean batch" rule is unsound for a receipted send, whose commit also writes its `ack-timeout` row due at the acknowledgement deadline; without the guard the timeout fired up to 6.6 s late (measured), against "a due retry gains 0 ms" and "no guarantee changes". A receipted send keeps its post-batch probe; the minimal plan restores. | The total pin of 8 after Task 4 holds for the minimal plan only; a receipted send spends one more transaction per send (its probe), stated in the PR body and the harness's receipted figures. |
| R-P1b-7  | The readiness memory moves into its own module `packages/shared/alm/work/al-work-readiness-memory.ts` (`ALWorkReadinessMemory`).                                                                                                                                                                                                                                 | The grown handler scored 57 on cognitive load (warn tier 50, base 42); after the split the handler scores 40 and the module 19.                                                                                                                                                                                                                          | One more file in `work/`; the handler's navigation map names it.                                                                                                                               |
| R-P1b-8  | The invalidation label is set only when it is clear AND the forget empties something (a standing answer, a suspended answer or a probe in flight).                                                                                                                                                                                                               | The literal "set only when clear" would label the very first probe `batch` (from the bootstrap batch) instead of `no-memory`; with the refinement an invalidation that discards an in-flight probe names the next probe exactly.                                                                                                                         | None.                                                                                                                                                                                          |
| R-P1b-9  | An answer that had already aged out when the batch started is not restored.                                                                                                                                                                                                                                                                                      | Restoring it costs the same probe anyway, and it makes the inbound owner (memory 0) strictly unchanged down to its `wakeAt` value and probe labels.                                                                                                                                                                                                      | None.                                                                                                                                                                                          |
| R-P1b-10 | The limiter pair is built by one lane function in a new module `packages/shared/alm/work/al-work-lease-recovery.ts` (`createLimitedALWorkLeaseRecovery(leaseMs, nowMs)` = two `RateLimiter.initWithTs(leaseMs, 1, nowMs)`), not by exporting a clock-taking `createResourceInboxStatusChecks`.                                                                   | The status-check factory builds an `isEntryRateLimiter` ALM never uses (the clamp plays that role), reads `Date.now`, and a clock-taking export would add a queuebox surface for one caller; `RateLimiter` itself is the reused primitive and `Resilience.ts` is unchanged.                                                                              | If the dequeuer and ALM ever need one factory, the lane function folds into it.                                                                                                                |
| R-P1b-11 | The clamp hides ALL of a closed sweep's RESERVED rows from the readiness scan, not only those whose lease has ended.                                                                                                                                                                                                                                             | Zero empty batches while a window is closed (12 400 without the clamp, measured) with the same bound; hiding only ended leases would cost one empty batch whenever a lease end falls before the window reopens.                                                                                                                                          | A lease end that falls after the window reopens is recovered at the next scan instead of exactly at the lease end: inside the stated bound.                                                    |
| R-P1b-12 | The loop a missing clamp causes is a zero-delay loop (a past lease end re-arms the engine at delay 0), not one batch per 100 ms; the proposal §11.C wording is corrected in the close task's document step.                                                                                                                                                      | Measured by the writer.                                                                                                                                                                                                                                                                                                                                  | None.                                                                                                                                                                                          |
| R-P1b-13 | The limiter's time is clamped to its creation (`toLimiterNowMs`): a clock stepped back before the lane's construction cannot make `RateLimiter.allowAt` throw "No bucket found" and fail every claim.                                                                                                                                                            | A browser clock can step back; the server dequeuer carries the same hazard today, which is a follow-up there.                                                                                                                                                                                                                                            | None.                                                                                                                                                                                          |
| R-P1b-14 | The recovery bound (lease end + 19.1 s) assumes the readiness scan (16 rows per type) or a sweep (64 rows) sees the row; a crashed row hidden behind 16 live leases is recovered at the first batch that sweeps with its window open. Stated as a caveat beside the bound in the PR body and the README.                                                         | The scan page is 16 and the sweep page 64; no page change is in P1b.                                                                                                                                                                                                                                                                                     | A busy owner with more than 16 live leases recovers a hidden crashed row later than the bound says.                                                                                            |
| R-P1b-15 | Three existing tests that pinned recovery exactly at the lease end now advance by the lease end plus a fixture constant `OUTBOUND_LEASE_RECOVERY_BOUND_MS`; three tests that were races the faster batch exposed hold the batch's claims with `holdOutboundClaims`.                                                                                              | They pinned the old cadence or won only because the batch spent two transactions on sweeps first.                                                                                                                                                                                                                                                        | None: the semantics they assert are unchanged.                                                                                                                                                 |
| R-P1b-16 | The WS client's private dispatch planner moves verbatim into an exported `toWsQueueBoxClientDispatchPlan(msg, context)` in `packages/shared/services/ws-queue-box-client/`, pinned by a unit test; the client delegates to it.                                                                                                                                   | The harness must plan a receipted command the way the client does without copying the plan literal (the no-duplication note); behaviour unchanged (240 client tests).                                                                                                                                                                                    | A new shared export; if the planner changes shape, one more caller.                                                                                                                            |
| R-P1b-17 | The receipted plan waits for the ACK's batch to drain before the next send; the profile runs on the minimal plan only; the reading is the measured p95, with the ≤ 500 ms percentiles as a diagnostic in the evidence file.                                                                                                                                      | The next send starts on an idle owner (the minimal plan's rule); the profile stays comparable with P1a's nine; the reading must not hide the stall.                                                                                                                                                                                                      | None.                                                                                                                                                                                          |
| R-P1b-18 | (Maintainer, 2026-10-01) The head-of-line stall the receipted plan exposed is fixed in P1b as Task 6: an ACK that completes a receipt also completes the send's ACK-timeout work row in the same commit, with a counter-case test (a due row found behind 16 not-yet-due rows); the key-order paging of the readiness scan and the claim stays a recorded limit. | 6 of every 90 receipted sends stalled 0.7–1.9 s on main today (any app sending 16+ receipted durable messages within 2 s); the fix removes the common cause and a no-op batch per receipted send.                                                                                                                                                        | A receipt that completes late still leaves its timeout row until the ACK; paging by readiness is the deeper fix, a later slice.                                                                |
| R-P1b-19 | The key-order paging limit stays and is recorded: 16 or more UNACKNOWLEDGED receipted sends within one 2 s ACK timeout (a slow or absent server) still hide the next send's row behind the page; a readiness-ordered claim and scan is a later slice (it touches the QueueBox index).                                                                            | P1b's constraints forbid a new scan order; Task 6 removes the common cause (acknowledged sends).                                                                                                                                                                                                                                                         | A client whose server does not acknowledge within 2 s under a burst of 16+ receipted sends sees the stall.                                                                                     |
| R-P1b-20 | Task 6 completes the timeout row only while it is `NEW` or `RETRY` (a row a batch already leased is left to that batch); a terminal NACK that ends a receipt also completes it, and Task 6 adds a NACK case to its test; a partial ACK keeps the row (pinned). No receipted-send ledger pin (the row-status pin and the 17-send test guard the behaviour).       | Settlements unchanged; the leased row's batch completes it itself.                                                                                                                                                                                                                                                                                       | None.                                                                                                                                                                                          |
| R-P1b-21 | The headless budget rise 293 → 294 KiB lands in Task 5 (where the planner's own module crosses it on Task 3's head, 293.120 measured), not in Task 4 as first expected; the PR body lists it.                                                                                                                                                                    | The crossing commit raises the budget, per the standing ruling.                                                                                                                                                                                                                                                                                          | None.                                                                                                                                                                                          |

---

### Task 1: `maxEntries` on `LatestRepository` and `ObservableLatestRepository`

Prototyped in `scratch-1` as commit `52d5c963a` on `9e8b9fc07` (red then green). Decision D114,
proposal §11.A, survey `p1b-code-survey.md` §D.

**Files**

- Modify: `packages/shared/cache/LatestRepository.ts` — new `MaxEntriesOptions` type (`:10-16`),
  `LatestRepositoryOptions` extends it (`:18`), new `assertMaxEntries` (`:32-36`) and
  `deleteOldestEntriesPastMax` (`:38-53`), a `maxEntries` field (`:65`) set in the constructor
  (`:84-85`), the cap applied in `getOrCreate` (`:420-430`, the new line `:426`).
- Modify: `packages/shared/cache/ObservableLatestRepository.ts` — imports the three from
  `./LatestRepository.ts` (`:6-10`), `ObservableLatestRepositoryOptions` intersects
  `MaxEntriesOptions` (`:28-37`), a `maxEntries` field (`:44`) set in the constructor (`:56-57`),
  the cap applied in `getOrCreate` (`:362-377`, the new line `:374`).
- Test (create): `packages/tests/shared/latest-repository-max-entries.test.ts` (136 lines), beside
  `latest-repository-expiry.test.ts` and `observable-latest-repository.test.ts`.
- Not touched: `LatestValue.ts`, `RepositoryInterfaces.ts` (not needed). No cache README exists
  (`packages/shared/cache` has none and no `*.md` in the repo documents the cache options); the
  option's doc comment on `MaxEntriesOptions.maxEntries` is the documentation.

**Interfaces**

- Consumes: nothing new.
- Produces (exported from `packages/shared/cache/LatestRepository.ts`):
  ```ts
  export type MaxEntriesOptions = Readonly<{ maxEntries?: number; }>;
  export function assertMaxEntries(maxEntries: number | undefined): void;
  export function deleteOldestEntriesPastMax<K, V>(
      entries: ReadonlyMap<K, V>,
      maxEntries: number | undefined,
      deleteEntry: (key: K) => void
  ): void;
  export interface LatestRepositoryOptions<V> extends ExpiredEntryEvictionOptions, MaxEntriesOptions { … }
  export type ObservableLatestRepositoryOptions<K, V> = Readonly<
      & ExpiredEntryEvictionOptions & MaxEntriesOptions & { … }>;   // in ObservableLatestRepository.ts
  ```
  Behaviour: every path that adds a key goes through the private `getOrCreate` (`acceptAt`,
  `readOrAcceptAt`, `accept`/`set`/`next`/`asCallback`, `latest`, `compareAndSet`, `getAndSet`,
  `updateOrCreate`, `updateIfNewer`, `setIfAbsent`), so the cap is applied once there, right after
  a new key is inserted: while `size > maxEntries` the oldest first-inserted key is deleted through
  the repository's own `delete` (the observable one's `delete` clears the value, which emits its
  ordinary `Deleted` event with `previous`; no new event kind). A re-set key keeps its Map position,
  so eviction is by first insertion; a caller that wants a re-set key newest deletes it first
  (Task 2 does). `maxEntries` absent = unbounded, as today. A `maxEntries` that is not a positive
  integer throws `Error('maxEntries must be a positive integer')` at construction, mirroring how the
  constructor already refuses `evictWindowMs`/`evictsPerWindow` (`throw new Error(...)`, `:78-83`).

**D8 reuse inspection.** This is the reuse target: the cap lives in `packages/shared/cache` and uses
each repository's own insertion-ordered `Map` and its own `delete`, so the observable repository's
existing listener path carries the eviction. Reused: `Map` insertion order, `delete`, the
constructor's existing refusal style. Not added: no LRU (a read or re-set does not refresh
position), no ring buffer, no separate bounded-FIFO type (D114 parks that until a third keyless
user), no second event kind, no new file (a new `cache/` file was tried first and the changed-style
gate reported `layout.directory-density` for the 29-file directory, so the helper sits beside its
first owner in `LatestRepository.ts` and the observable repository imports it — one cap
implementation for both). `packages/shared/resilience` is not involved. The write-behind and
write-through repositories pass their options to an inner `ObservableLatestRepository`, so they
accept `maxEntries` too; no production caller sets it (see the open decision in the report).

- [ ] **Step 1: Write the failing test.** Create `packages/tests/shared/latest-repository-max-entries.test.ts`:

```ts
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { ObservableLatestRepository } from '@shared/cache/ObservableLatestRepository.ts';
import {
    ObservableValueEventType,
    type ObservableKeyedValueEvent
} from '@shared/cache/RepositoryInterfaces.ts';
import { describe, expect, it } from 'vitest';

describe('LatestRepository maxEntries', () => {
    it('keeps the two newest first insertions and drops the oldest', () => {
        const repository = new LatestRepository<string, number>({ maxEntries: 2 });

        repository.acceptAt({ key: 'a', value: 1, nowEpochMs: 0 });
        repository.acceptAt({ key: 'b', value: 2, nowEpochMs: 0 });
        repository.acceptAt({ key: 'c', value: 3, nowEpochMs: 0 });

        expect([...repository.keys()]).toEqual(['b', 'c']);
        expect(repository.readAt('a', 0)).toBeUndefined();
        expect(repository.readAt('c', 0)).toBe(3);
    });

    // Every write that can add a key is bounded, not only acceptAt.
    it('caps every path that adds a key', () => {
        const repository = new LatestRepository<string, number>({ maxEntries: 1 });

        repository.set('a', 1);
        repository.setIfAbsent('b', () => 2);
        expect([...repository.keys()]).toEqual(['b']);

        repository.getAndSet('c', 3);
        expect([...repository.keys()]).toEqual(['c']);

        repository.updateIfNewer('d', 4, { versionOf: (value) => value });
        expect([...repository.keys()]).toEqual(['d']);
        expect(repository.size()).toBe(1);
    });

    // Eviction is by first insertion: re-setting a key keeps its position, so
    // a caller that wants a re-set key to count as newest deletes it first.
    it('does not treat a re-set key as a new insertion', () => {
        const repository = new LatestRepository<string, number>({ maxEntries: 2 });

        repository.set('a', 1);
        repository.set('b', 2);
        repository.set('a', 10);
        repository.set('c', 3);

        expect([...repository.keys()]).toEqual(['b', 'c']);
    });

    it('leaves the repository unbounded without a cap', () => {
        const repository = new LatestRepository<string, number>();

        for (let index = 0; index < 100; index += 1) {
            repository.set(`key-${index}`, index);
        }

        expect(repository.size()).toBe(100);
    });

    // An expiry sweep frees room under the cap, and the cap then counts only
    // the entries that remain.
    it('applies the cap and deleteExpiredAt together', () => {
        const repository = new LatestRepository<string, number>({
            maxEntries: 2,
            evictsPerWindow: 0
        });

        repository.acceptAt({ key: 'a', value: 1, nowEpochMs: 0, expireAtEpochMs: 100 });
        repository.acceptAt({ key: 'b', value: 2, nowEpochMs: 0, expireAtEpochMs: 10_000 });
        expect(repository.deleteExpiredAt(100)).toBe(1);

        repository.acceptAt({ key: 'c', value: 3, nowEpochMs: 100, expireAtEpochMs: 10_000 });
        expect([...repository.keys()]).toEqual(['b', 'c']);

        repository.acceptAt({ key: 'd', value: 4, nowEpochMs: 100, expireAtEpochMs: 10_000 });
        expect([...repository.keys()]).toEqual(['c', 'd']);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
        'refuses maxEntries %s',
        (maxEntries) => {
            expect(() => new LatestRepository<string, number>({ maxEntries })).toThrow(
                'maxEntries must be a positive integer'
            );
        }
    );
});

describe('ObservableLatestRepository maxEntries', () => {
    it('emits the ordinary delete event for an evicted key', async () => {
        const repository = new ObservableLatestRepository<string, number>({ maxEntries: 2 });
        const events: Array<ObservableKeyedValueEvent<string, number>> = [];
        repository.onChangeDo((event) => {
            events.push(event);
        });

        repository.set('a', 1);
        repository.set('b', 2);
        repository.set('a', 10);
        repository.set('c', 3);
        await repository.whenIdle();

        expect([...repository.keys()]).toEqual(['b', 'c']);
        // Events are ordered per key; the repository does not order them across keys.
        const eventsOfA = events.filter((event) => event.key === 'a');
        expect(eventsOfA.map((event) => event.type)).toEqual([
            ObservableValueEventType.Created,
            ObservableValueEventType.Updated,
            ObservableValueEventType.Deleted
        ]);
        expect(eventsOfA[2]).toMatchObject({ key: 'a', previous: 10 });
        expect(events.filter((event) => event.type === ObservableValueEventType.Deleted))
            .toHaveLength(1);
    });

    it('notifies delete listeners of the eviction', async () => {
        const repository = new ObservableLatestRepository<string, number>({ maxEntries: 1 });
        const deleted: string[] = [];
        repository.onDeletedDo((event) => {
            deleted.push(event.key);
        });

        repository.set('a', 1);
        repository.set('b', 2);
        await repository.whenIdle();

        expect(deleted).toEqual(['a']);
    });

    it('leaves the repository unbounded without a cap', () => {
        const repository = new ObservableLatestRepository<string, number>();

        for (let index = 0; index < 100; index += 1) {
            repository.set(`key-${index}`, index);
        }

        expect(repository.size()).toBe(100);
    });

    it('refuses a maxEntries that is not a positive integer', () => {
        expect(() => new ObservableLatestRepository<string, number>({ maxEntries: 0 })).toThrow(
            'maxEntries must be a positive integer'
        );
    });
});
```

- [ ] **Step 2: Run it and see it fail.**

```sh
npx vitest run packages/tests/shared/latest-repository-max-entries.test.ts
```

Expected (measured at `9e8b9fc07`): `Tests  12 failed | 2 passed (14)`. The two "leaves the
repository unbounded without a cap" cases pass; every cap, re-set, expiry, event and refusal case
fails (`keys()` still holds `a`, no `Deleted` event, the constructor does not throw). Vitest does not
typecheck, so the unknown `maxEntries` option runs; `node scripts/check-tests-typecheck.mjs` would
also fail on it at this point.

- [ ] **Step 3: Add the cap to `packages/shared/cache/LatestRepository.ts`.** Replace the options
      interface (`:10-15` at base) and add the two helpers after `AcceptLatestEntryInput`:

```ts
export type MaxEntriesOptions = Readonly<{
    /**
     * Absent means no cap. Past the cap the oldest first-inserted key is deleted;
     * re-setting a key keeps its position, so a caller that wants it newest deletes it first.
     */
    maxEntries?: number;
}>;

export interface LatestRepositoryOptions<V> extends ExpiredEntryEvictionOptions, MaxEntriesOptions {
    ttlMs?: number;
    isValid?: ValueValidityChecker<V>;
    evictWindowMs?: number;
    evictsPerWindow?: number;
}

export interface AcceptLatestEntryInput<K, V> {
    readonly key: K;
    readonly value: V;
    readonly nowEpochMs: number;
    readonly expireAtEpochMs?: number;
}

export function assertMaxEntries(maxEntries: number | undefined): void {
    if (maxEntries !== undefined && (!Number.isInteger(maxEntries) || maxEntries < 1)) {
        throw new Error('maxEntries must be a positive integer');
    }
}

export function deleteOldestEntriesPastMax<K, V>(
    entries: ReadonlyMap<K, V>,
    maxEntries: number | undefined,
    deleteEntry: (key: K) => void
): void {
    if (maxEntries === undefined) {
        return;
    }

    for (const key of entries.keys()) {
        if (entries.size <= maxEntries) {
            return;
        }
        deleteEntry(key);
    }
}
```

In the class, add the field after `evictsPerWindow`:

```ts
private readonly evictsPerWindow: number;
private readonly maxEntries: number | undefined;
```

In the constructor, after the `evictsPerWindow` refusal and before `startExpiredEntryEviction`:

```ts
if (!Number.isInteger(this.evictsPerWindow) || this.evictsPerWindow < 0) {
    throw new Error('evictsPerWindow must be a non-negative integer');
}
assertMaxEntries(options.maxEntries);
this.maxEntries = options.maxEntries;
```

And `getOrCreate` becomes:

```ts
    private getOrCreate(key: K): LatestValue<V> {
        let entry = this.entries.get(key);

        if (!entry) {
            entry = new LatestValue<V>(this.defaultValueOptions);
            this.entries.set(key, entry);
            deleteOldestEntriesPastMax(this.entries, this.maxEntries, (oldest) => this.delete(oldest));
        }

        return entry;
    }
```

- [ ] **Step 4: Add the cap to `packages/shared/cache/ObservableLatestRepository.ts`.** Add the import
      after the `ExpiredEntryEviction.ts` import:

```ts
import {
    assertMaxEntries,
    deleteOldestEntriesPastMax,
    type MaxEntriesOptions
} from './LatestRepository.ts';
```

The options type becomes:

```ts
export type ObservableLatestRepositoryOptions<K, V> = Readonly<
    & ExpiredEntryEvictionOptions
    & MaxEntriesOptions
    & {
        ttlMs?: number;
        isValid?: (value: V) => boolean;
        equals?: ValueEqualityChecker<V>;
        onObserverError?: ObservableKeyedValueErrorHandler<K, V>;
    }
>;
```

Add the field after `expiredEntryEviction`:

```ts
private readonly expiredEntryEviction?: ExpiredEntryEvictionHandle;
private readonly maxEntries: number | undefined;
```

In the constructor, after `this.onObserverError = options.onObserverError;`:

```ts
assertMaxEntries(options.maxEntries);
this.maxEntries = options.maxEntries;
```

And in `getOrCreate`, after `this.entries.set(key, entry);`:

```ts
this.entries.set(key, entry);
deleteOldestEntriesPastMax(this.entries, this.maxEntries, (oldest) => this.delete(oldest));
```

(`this.delete` is the existing method: `entry.clear()` emits `Deleted` when the entry held a value,
then the Map entry goes.)

- [ ] **Step 5: Format the touched files.**

```sh
npx dprint fmt packages/shared/cache/LatestRepository.ts packages/shared/cache/ObservableLatestRepository.ts packages/tests/shared/latest-repository-max-entries.test.ts
```

- [ ] **Step 6: Run the new test and every repository test beside it.**

```sh
npx vitest run packages/tests/shared/latest-repository-max-entries.test.ts packages/tests/shared/latest-repository-expiry.test.ts packages/tests/shared/observable-latest-repository.test.ts packages/tests/shared/write-behind-observable-latest-repository.test.ts packages/tests/shared/write-through-observable-latest-repository.test.ts packages/tests/shared/latest-value.test.ts packages/tests/shared/observable-latest-value.test.ts
```

Expected (measured): `Test Files  7 passed (7)`, `Tests  73 passed (73)` (14 new, 59 existing
unchanged: no cap = today's behaviour).

- [ ] **Step 6b: The write-through and write-behind repositories refuse the cap.** They pass their options to an
      inner `ObservableLatestRepository`, and an eviction's `Deleted` event would make the write-behind repository delete
      the row from persistence; a cache cap must never delete stored data without a decision of its own. Narrow both
      option types so `maxEntries` cannot reach them:

```ts
// packages/shared/cache/WriteThroughObservableLatestRepository.ts:10-11
export type WriteThroughObservableLatestRepositoryOptions<K, V> = Omit<
    ObservableLatestRepositoryOptions<K, V>,
    'maxEntries'
>;
```

```ts
// packages/shared/cache/WriteBehindObservableLatestRepository.ts:21-22
export type WriteBehindObservableLatestRepositoryOptions<K, V> = Omit<
    ObservableLatestRepositoryOptions<K, V>,
    'maxEntries'
>;
```

(keep the rest of each intersection as it is). Add one type-level assertion to the new test file, beside the cap
cases, that a `maxEntries` option on either type is a compile error (`// @ts-expect-error` on an object literal
passed to the constructor, inside a never-called function so no runtime is involved). Re-run the repository tests
and `npx tsc -p packages/shared/tsconfig.json --noEmit` (expected: unchanged counts, exit 0), and add the two files
to Step 8's `git add` list.

- [ ] **Step 7: Constraint checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit          # exit 0
npx tsc -p packages/shared-web/tsconfig.json --noEmit      # exit 0
npx tsc -p packages/shared-graph/tsconfig.json --noEmit    # exit 0
npx tsc -p packages/shared-server/tsconfig.json --noEmit   # exit 0
node scripts/check-tests-typecheck.mjs
# check-tests-typecheck: 1404 test files enforced, 0 files carrying known debt (0 errors).
# PASS: no new type errors in the maintained test project
npx dprint check packages/shared/cache/LatestRepository.ts packages/shared/cache/ObservableLatestRepository.ts packages/tests/shared/latest-repository-max-entries.test.ts   # exit 0
```

The production constructors of both repositories (`packages/shared/repository/{rtt,overlays,
client-state-snapshots,group-state-snapshots}-repository.ts`, `packages/shared-graph/repository/
{vivaldi,graphs}-repository.ts`, `packages/shared-server/http/rate-limit-service.ts`,
`packages/shared-server/rallar-system/rtc-rtt/topic/rtc-rtt-refinement-service.ts`, the two
`shared-rtc-bench` workloads, and the write-behind/write-through wrappers) typecheck unchanged: the
option is optional. (`check-tests-typecheck` needs the app-nested `node_modules` of
`apps/rallar-black-box`; without it it reports a `vite.config.ts` `@vitejs/plugin-react` error that is
environmental, not this change.)

- [ ] **Step 8: Commit.**

```sh
git add packages/shared/cache/LatestRepository.ts packages/shared/cache/ObservableLatestRepository.ts packages/tests/shared/latest-repository-max-entries.test.ts
git commit -m "Cap LatestRepository and ObservableLatestRepository at maxEntries

An accept or set that adds a key past maxEntries deletes the oldest
first-inserted key; the observable repository emits its ordinary delete
event for it. Without the option both repositories are unbounded as before."
```

- [ ] **Step 9: Changed-range gates (need the commit).**

```sh
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings (90d358f7f… -> HEAD).
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS: no current structure-coupled test candidates
# PASS: changed-range structure-coupling review has complete individual classifications
# PASS: registry entries are complete and current
```

(Measured note: a first version with the helper in a new `cache/delete-oldest-entries-past-max.ts`
failed this gate with `layout.directory-density` (29 direct files, threshold 20) and
`boundary.unknown` (`ReadonlyMap<K, unknown>`); hence the generic `V` and no new file.)

**Measured bundle figures (brotli q11, same method as the gates).** `rallar.ts` 229.026 → 229.220 KiB
(+0.194; minified +413 bytes), headless agent 292.497 → 292.626 KiB (+0.129). Both under budget
(230 / 293). `test:unit:main` runs once before Task 2's commit (Task 1 is library-only and is
covered by that run).

---

### Task 2: The canonical hand-off on `LatestRepository`

Prototyped in `scratch-1` as commit `e28ef1cdd` on top of Task 1 (`52d5c963a`), red then green.
Decision D114, proposal §11.A, survey `p1b-code-survey.md` §D. Depends on Task 1 (`maxEntries`).

**Files**

- Modify: `packages/shared/alm/outbound/lane/al-outbound-canonical-handoff.ts` (whole file, 62 → 64
  lines): the raw `Map` and trim loop become a `LatestRepository<string, ResourceEntry>` with
  `maxEntries: input.limit`; `setCommitted(bundle, nowMs)`, `takeCanonical(workKey, nowMs)`,
  `clear()`. Class name, namespace `Input` (`namespace`, `limit`) and
  `AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT` unchanged.
- Modify: `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts:171` and `:287` — pass the
  lane clock (`this.readNowMs()`, `:425-427`, i.e. `runtime.clock.nowMs()`) to the two calls.
  `al-outbound-message-runtime.ts:429-432` is unchanged: the constructor input does not change, the
  clock arrives per call from the lane that already owns it.
- Modify: `packages/shared/alm/outbound/README.md:177-180` — the hand-off paragraph (4 lines → 6).
- Test: `packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts` — the
  `recordHandoffCommits` spy forwards `nowMs` (`:78-92`), the two bound tests pass a clock
  (`:95-141`), a new deadline test (`:143-172`) with its helper `toSendDeadlineMs` (`:175-181`), the
  dispose test's two takes pass `Date.now()` (`:327`, `:331`).
- Not touched: `al-outbound-admission-effect-store.ts:191-206` (the store's deadline guard stays the
  authority), `al-outbound-message-runtime.ts`.

**Interfaces**

- Consumes (Task 1): `new LatestRepository<string, ResourceEntry>({ maxEntries })`, and the existing
  `acceptAt({ key, value, nowEpochMs, expireAtEpochMs })` (`cache/LatestRepository.ts:93-98` after
  Task 1), `readAt(key, nowEpochMs)`, `delete(key)`, `clearAll()`.
- Produces:
  ```ts
  export class ALOutboundCanonicalHandoff {
      constructor(input: ALOutboundCanonicalHandoff.Input); // { namespace: string; limit: number }
      setCommitted<TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>, nowMs: number): void;
      takeCanonical(workKey: Key, nowMs: number): ResourceEntry | undefined;
      clear(): void;
  }
  ```
  `setCommitted` deletes each send's work key first, then `acceptAt` with the lane clock and
  `effect.payload.message.expiresAtMs` (a number on `ALOutboundMessageReference`) as the per-entry
  deadline, so a re-set key is the newest under the cap. `takeCanonical` is `readAt` then `delete`
  (never `take`, which returns an expired value: `cache/LatestValue.ts:116-120`). The deadline is
  inclusive in `LatestRepository` (`expireAt <= now` is expired), matching the store guard's
  `reference.expiresAtMs > this.nowMs()` for live. No `deleteExpiredIntervalMs` (no `setInterval`);
  expired entries a claim never took are swept by `acceptAt`'s rate-limited
  `evictExpiredWhenAllowed` (default 2 sweeps per 5 s, on the lane clock).

**D8 reuse inspection.** `LatestRepository` from `packages/shared/cache` is reused as is, with
Task 1's `maxEntries`; the hand-off keeps only its ALM knowledge (which effects hand over, the work
key, the deadline source). No wrapper, no ALM-side trim loop, no ring buffer, no
`ObservableLatestRepository` (nothing observes the hand-off, and its writes queue observer
promises). Its write-path sweep already uses `RateLimiter` from `packages/shared/resilience`, which
the bundle already ships; nothing else from `resilience` applies.

- [ ] **Step 1: Write the failing tests.** In
      `packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts`:

Add the import after the `open-indexed-db-admission-database.ts` import:

```ts
import type { ALOutboundCommitBundle } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
```

`recordHandoffCommits` forwards the clock:

```ts
/** The canonical key of every bundle a lane's hand-off is given, in order; the hand-off still holds each. */
function recordHandoffCommits(): Key[] {
    const committed: Key[] = [];
    const setCommitted = ALOutboundCanonicalHandoff.prototype.setCommitted;
    vi.spyOn(ALOutboundCanonicalHandoff.prototype, 'setCommitted').mockImplementation(function (
        this: ALOutboundCanonicalHandoff,
        bundle,
        nowMs
    ) {
        if (bundle.canonicalEntry !== undefined) {
            committed.push(bundle.canonicalEntry.key);
        }
        setCommitted.call(this, bundle, nowMs);
    });
    return committed;
}
```

Replace the whole `describe('the canonical hand-off bound', …)` block and add the helper after it:

```ts
describe('the canonical hand-off bound', () => {
    it('keeps the newest committed sends up to its limit and gives each one up once', async () => {
        const nowMs = Date.now();
        const store = createDefaultOutboundTestStores().admissionStore;
        const peers = Array.from(
            { length: AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT + 1 },
            (_, index) => ({ peer: `p${index}` })
        );
        const bundle = await computeOutboundTestAdmission(
            store,
            createOutboundMessage('bounded'),
            (msg) => ({ msg, dropReasonCode: undefined, persist: true, preparedMessages: peers })
        );
        const sends = bundle.durableEffects.filter((effect) =>
            effect.payload.kind === 'send-prepared'
        );
        expect(sends).toHaveLength(AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT + 1);
        const handoff = new ALOutboundCanonicalHandoff({
            namespace: store.namespace,
            limit: AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT
        });

        handoff.setCommitted(bundle, nowMs);

        const oldest = toALOutboundWorkKey(store.namespace, sends[0]!.effectId);
        const newest = toALOutboundWorkKey(store.namespace, sends.at(-1)!.effectId);
        expect(handoff.takeCanonical(oldest, nowMs), 'the oldest send past the limit is dropped')
            .toBeUndefined();
        expect(handoff.takeCanonical(newest, nowMs)).toBe(bundle.canonicalEntry);
        expect(handoff.takeCanonical(newest, nowMs), 'a claim consumes what it was handed')
            .toBeUndefined();
    });

    it('holds nothing after it is cleared', async () => {
        const nowMs = Date.now();
        const store = createDefaultOutboundTestStores().admissionStore;
        const bundle = await computeOutboundTestAdmission(
            store,
            createOutboundMessage('cleared'),
            OUTBOUND_TEST_SEND_PLANNER
        );
        const [send] = bundle.durableEffects;
        const handoff = new ALOutboundCanonicalHandoff({ namespace: store.namespace, limit: 4 });
        handoff.setCommitted(bundle, nowMs);

        handoff.clear();

        expect(handoff.takeCanonical(toALOutboundWorkKey(store.namespace, send!.effectId), nowMs))
            .toBeUndefined();
    });

    it('neither returns nor retains a row past its send\'s deadline', async () => {
        const store = createDefaultOutboundTestStores().admissionStore;
        const handoff = new ALOutboundCanonicalHandoff({ namespace: store.namespace, limit: 4 });
        const expiring = await computeOutboundTestAdmission(
            store,
            createOutboundMessage('expiring', { ttlMs: 1_000 }),
            OUTBOUND_TEST_SEND_PLANNER
        );
        const [send] = expiring.durableEffects;
        const workKey = toALOutboundWorkKey(store.namespace, send!.effectId);
        const deadlineMs = toSendDeadlineMs(expiring);
        handoff.setCommitted(expiring, deadlineMs - 1_000);

        expect(
            handoff.takeCanonical(workKey, deadlineMs),
            'at its deadline the row is not handed over'
        )
            .toBeUndefined();

        handoff.setCommitted(expiring, deadlineMs - 1_000);
        const later = await computeOutboundTestAdmission(
            store,
            createOutboundMessage('committed-after-the-deadline'),
            OUTBOUND_TEST_SEND_PLANNER
        );
        const laterKey = toALOutboundWorkKey(store.namespace, later.durableEffects[0]!.effectId);
        handoff.setCommitted(later, deadlineMs + 10_000);

        // Read on an instant before the deadline: only a row that is gone can miss here.
        expect(
            handoff.takeCanonical(workKey, deadlineMs - 1),
            'a later commit sweeps the expired row'
        )
            .toBeUndefined();
        expect(handoff.takeCanonical(laterKey, deadlineMs + 10_000)).toBe(later.canonicalEntry);
    });
});

function toSendDeadlineMs(bundle: ALOutboundCommitBundle<OutboundTestPayload>): number {
    const [send] = bundle.durableEffects;
    if (send?.payload.kind !== 'send-prepared') {
        throw new Error('expected a prepared send');
    }
    return send.payload.message.expiresAtMs;
}
```

In `it('is dropped when its runtime is disposed', …)` the two takes pass the clock:

```ts
expect(handoff!.takeCanonical(held!, Date.now()), 'held while the runtime lives').toBeDefined();

runtime.dispose();

expect(handoff!.takeCanonical(dropped!, Date.now())).toBeUndefined();
```

All other cases (hit, miss ×2, replay, reset, dispose, reset-on-open, the store-level deadline test,
mismatch, group, volatile, supplied backend, no listener, late commit) are unchanged.

- [ ] **Step 2: Run them and see the new case fail.**

```sh
npx vitest run packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts
```

Expected (measured on Task 1's commit): `Tests  1 failed | 16 passed (17)`, the failure
`neither returns nor retains a row past its send's deadline` with
`AssertionError: at its deadline the row is not handed over: expected { key: { …(3) }, …(6) } to be undefined`
(the `Map` ignores the extra `nowMs` argument and has no deadline).

- [ ] **Step 3: Rewrite `packages/shared/alm/outbound/lane/al-outbound-canonical-handoff.ts`.**

```ts
import { LatestRepository } from '../../../cache/LatestRepository.ts';
import { toKeyAsString, type Key, type ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALOutboundCommitBundle } from '../admission/al-outbound-admission-store.ts';
import { AL_OUTBOUND_WORK_PAGE_SIZE, toALOutboundWorkKey } from '../al-outbound-work-entry.ts';

/** Four work pages: what the commits between two claiming batches of one lane can hand over. */
export const AL_OUTBOUND_CANONICAL_HANDOFF_LIMIT = 4 * AL_OUTBOUND_WORK_PAGE_SIZE;

export namespace ALOutboundCanonicalHandoff {
    export interface Input {
        readonly namespace: string;
        readonly limit: number;
    }
}

/**
 * The canonical row a commit of one lane wrote, held for the claim of each prepared send that
 * references it so that claim need not read it back. A cache of an immutable row, never a source:
 * a claim that finds nothing here reads storage.
 */
export class ALOutboundCanonicalHandoff {
    private readonly namespace: string;
    private readonly canonicalByWorkKey: LatestRepository<string, ResourceEntry>;

    constructor(input: ALOutboundCanonicalHandoff.Input) {
        this.namespace = input.namespace;
        this.canonicalByWorkKey = new LatestRepository({ maxEntries: input.limit });
    }

    /**
     * Holds a committed bundle's canonical row for each prepared send it wrote, until that send's
     * deadline; past the limit the oldest go.
     */
    setCommitted<TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>, nowMs: number): void {
        const canonical = bundle.canonicalEntry;
        if (canonical === undefined) {
            return;
        }
        for (const effect of bundle.durableEffects) {
            if (effect.payload.kind === 'send-prepared') {
                const workKey = toKeyAsString(toALOutboundWorkKey(this.namespace, effect.effectId));
                this.canonicalByWorkKey.delete(workKey);
                this.canonicalByWorkKey.acceptAt({
                    key: workKey,
                    value: canonical,
                    nowEpochMs: nowMs,
                    expireAtEpochMs: effect.payload.message.expiresAtMs
                });
            }
        }
    }

    /** The live row held for one claimed work slot, given up as it is handed over: a retried claim reads storage. */
    takeCanonical(workKey: Key, nowMs: number): ResourceEntry | undefined {
        const keyString = toKeyAsString(workKey);
        const canonical = this.canonicalByWorkKey.readAt(keyString, nowMs);
        this.canonicalByWorkKey.delete(keyString);
        return canonical;
    }

    clear(): void {
        this.canonicalByWorkKey.clearAll();
    }
}
```

- [ ] **Step 4: Thread the lane clock in `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts`.**
      At `:171` (in `setCanonicalHandoff`):

```ts
this.input.canonicalHandoff?.setCommitted(result.computed.bundle, this.readNowMs());
```

At `:287` (in `readOutboundWork`):

```ts
: await this.input.stores.admissionStore.readWorkSnapshot(
    entry,
    this.input.canonicalHandoff?.takeCanonical(entry.key, this.readNowMs())
);
```

`dispose` (`:130`) and the storage-reset listener (`:117`) keep calling `clear()`.

- [ ] **Step 5: Update the README hand-off paragraph** (`packages/shared/alm/outbound/README.md:177-180`).
      Replace these four lines

```md
committed canonical row for each prepared send the commit wrote, keyed by that send's work slot and
bounded to four work pages, oldest dropped first; the claim takes it and checks it against the
reference exactly as it checks a stored pair. It is a cache of an immutable row, never a source:
another tab's claim, a reload, a replayed pending admission, a retried claim and a row at its
```

with these six (the following line, `deadline read storage. Its safety rests on …`, stays):

```md
committed canonical row for each prepared send the commit wrote, keyed by that send's work slot,
in a `LatestRepository` capped at four work pages (`maxEntries`, oldest dropped first) whose
entries each expire at their send's deadline on the lane clock; the claim takes a live one and
checks it against the reference exactly as it checks a stored pair. It is a cache of an
immutable row, never a source: another tab's claim, a reload, a replayed pending admission, a
retried claim and a row at its
```

- [ ] **Step 6: Format the touched files.**

```sh
npx dprint fmt packages/shared/alm/outbound/lane/al-outbound-canonical-handoff.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts packages/shared/alm/outbound/README.md
```

- [ ] **Step 7: Run the hand-off tests and the ledger pins.**

```sh
npx vitest run packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
```

Expected (measured): `Test Files  2 passed (2)`, `Tests  21 passed (21)` (17 hand-off, 4 ledger; the
ledger file is untouched, so its pins are unchanged). Then the ALM folder:

```sh
npx vitest run packages/tests/shared/alm
```

Expected (measured): `Test Files  90 passed (90)`, `Tests  1143 passed (1143)`.

- [ ] **Step 8: Constraint checks.**

```sh
npx tsc -p packages/shared/tsconfig.json --noEmit          # exit 0
npx tsc -p packages/shared-web/tsconfig.json --noEmit      # exit 0
npx tsc -p packages/shared-server/tsconfig.json --noEmit   # exit 0
(cd apps/api-v1 && deno task check)                        # exit 0 (the server lane builds the hand-off)
node scripts/check-tests-typecheck.mjs
# PASS: no new type errors in the maintained test project
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
# | browser/rallar.ts | 1073.8 KiB | 279.2 KiB | 229.2 KiB | < 230.0 KiB | ok | …   Bundle budget check passed.
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
# Tests  1 passed (1)
npx dprint check packages/shared/alm/outbound/lane/al-outbound-canonical-handoff.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts packages/shared/alm/outbound/README.md   # exit 0
```

Measured bundle figures (brotli q11, the gates' method, three decimals):

| Head             |      `rallar.ts` |   headless agent |
| ---------------- | ---------------: | ---------------: |
| base `9e8b9fc07` |          229.026 |          292.497 |
| Task 1           | 229.220 (+0.194) | 292.626 (+0.129) |
| Task 2           | 229.242 (+0.022) | 292.470 (−0.156) |
| P1b so far       |           +0.216 |           −0.027 |

No budget is crossed (230 / 293); nothing to raise.

- [ ] **Step 9: `npm run test:unit:main` once, sandbox off.**

```sh
npm run test:unit:main
```

Measured twice under a machine load average of ~38 (four writers running in parallel): run 1
`Tests 2 failed | 12333 passed | 12 skipped (12347)`, run 2 `6 failed | 12329 passed`, every failure
`Test timed out in 5000ms` (one 45000ms): the two bundle-boundary tests (`headless-bundle-boundary`,
`shared-web-browser-bundle-boundaries`), `recipe-console-analyze-artifact-projection`,
`al-inbound-queue-work` (256-message drain), `room-membership`, `group-presence-summary-storage-revision`.
All six files re-run in isolation pass (`Test Files 6 passed (6)`, `Tests 44 passed (44)`). Expected on
an unloaded machine: all pass; on a loaded one, re-run any timed-out file alone before diagnosing.

- [ ] **Step 10: Commit.**

```sh
git add packages/shared/alm/outbound/lane/al-outbound-canonical-handoff.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts packages/tests/shared/alm/outbound/al-outbound-canonical-handoff.test.ts packages/shared/alm/outbound/README.md
git commit -m "Hold the canonical hand-off in a LatestRepository

The hand-off keeps its four-page cap through maxEntries and gives each
entry its send's deadline on the lane clock, so a row past its deadline is
neither handed over nor retained. The store's deadline guard stays the
authority."
```

- [ ] **Step 11: Changed-range gates.**

```sh
npm run check:repo-style:changed -- origin/main HEAD
# PASS: no new repository style findings (90d358f7f… -> HEAD).
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
# PASS: no current structure-coupled test candidates / complete individual classifications / registry entries are complete and current
```

---

### Task 3: The readiness restore and the `readinessInvalidation` fix (D112)

A commit suspends the outbound owner's remembered readiness answer instead of discarding it; the batch the
commit runs restores it, with its original `observedAtMs`, when the batch left storage as that answer saw it,
and hands the restored due time to the engine through the existing `wakeAt`. Every other batch drops it and the
next engine pass probes as today. The probe's invalidation label is read and cleared when a probe starts and set
only by the first change since. The two "another tab wakes this owner" comments are corrected.

**One addition to the spec's guard list (open decision, see the hand-back):** the restore also requires that
the batch started once every row the commit wrote was due. Without it a receipted send (`ackTracking`) is
unsound: its commit writes the send row (due now) and the `ack-timeout` row (due at the acknowledgement
deadline) together (`compute-al-outbound-dispatch.ts:90-92, 395-412`); the batch claims and completes the send,
looks "clean", restores "no work", and the timeout's due time never reaches the engine until the age bound
(measured in the scratch tree: `wakeAt` received only `undefined` after the batch, and no probe ran in two engine
passes). The guard is carried by `ALWorkHandler.committed(writtenDueByMs)`: the outbound lane passes the latest
`retryAtMs` of the effects its committed dispatches wrote (`computeALOutboundWrittenDueByMs`), every other caller
passes `undefined` ("cannot say", no restore). A receipted send therefore still probes after its batch, so a due
acknowledgement timeout gains 0 ms; the minimal plan restores.

The readiness memory moves into its own module, `ALWorkReadinessMemory`, because the changed-range style gate
scored the grown handler at file cognitive load 57 (warn tier, base 42); after the split the handler scores 40
and the new module 19.

**Files**

- Create: `packages/shared/alm/work/al-work-readiness-memory.ts` (1-143): the answer slot, the suspended slot,
  the generation fence, the invalidation label, the in-flight flag, and the pure restore decision
  `resolveALWorkRestoredReadiness`.
- Modify: `packages/shared/alm/work/al-work-handler.ts` (base lines 5 import; 118-124 `AL_WORK_READINESS_MEMORY_MS`
  doc; 133-137 the record moves out; 157-170 fields; 181-190 the wake-listener comment; 213-227 `committed`;
  239-306 `readReadyAtMs`, `forgetReadiness` and `runBatch` become `readReadyAtMs`, `settleReadiness`, `runBatch`,
  `endBatch`, `failBatch`; 328-357 `runSelectedWork` returns an `ALWorkBatchEnd` and no longer calls `wakeAt`;
  472 the retained release).
- Modify: `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts` (145, 157, 162, 182 the `committed`
  call sites; a new `computeALOutboundWrittenDueByMs` after `hasWrittenWork` at 508-510).
- Modify: `packages/shared/alm/inbound/lane/al-inbound-store-lane.ts` (187, 198: `committed(undefined)`).
- Modify: `packages/shared/services/InboxOutboxEngine.ts` (126-130, comment only).
- Modify: `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (188-192, the cause list).
- Test: `packages/tests/shared/alm/work/al-work-handler.test.ts` (imports 3-9; `committed()` call sites 54, 452,
  457, 1127; the probe-count case 741-799 and the cause case 800-852 move; a restore fixture and two new describe
  blocks before `function collectProbe` at 1138).
- Test: `packages/tests/shared/alm/outbound-readiness-probe-diagnostics.test.ts` (rewritten: the `own-commit`
  probe after a plain send is gone; a receipted send still probes; the idle case is unchanged).
- Test: `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts` (4 import; 33-41 a reason string;
  50-101 the outbound pins; 186-235 `readWarmOutboundSendLedger`, `sendUntilOwnerIdle`, `isProbedAfterNthRelease`).
- Test (harness): `tests/playwright/alm/harness/durable-send-harness-contract.ts` (22-32, 41-44),
  `tests/playwright/alm/harness/durable-send-observation.ts` (4-96), `tests/playwright/alm/harness/create-durable-send-harness.ts`
  (85-102), `tests/playwright/alm/durable-send-report.ts` (23-26, 88-90), `tests/playwright/alm/durable-send-plain-page.spec.ts`
  (26, 117-137).

**Interfaces**

- Consumes: `InboxOutboxEngine.wakeAt(taskId: string, readyAtMs: number | undefined): void`
  (`InboxOutboxEngine.ts:78-94`; `executeOnce` drops a past entry, `:165-170`);
  `ALOutboundDispatchAdmission.Result<TPrepared>` (`committed`, `computed.bundle?.durableEffects[].retryAtMs`).
- Produces:
  - `ALWorkHandler.committed(writtenDueByMs: number | undefined): void` (was `committed(): void`).
  - `class ALWorkReadinessMemory { constructor(memoryMs: number); getStandingAnswer(nowMs: number): ALWorkReadinessAnswer | undefined;
    readProbe(nowMs: number, read: () => Promise<number | undefined>): Promise<ALWorkReadinessProbe>;
    forget(cause: ALWorkReadinessInvalidation): void; suspend(writtenDueByMs: number | undefined): void;
    settle(batch: ALWorkReadinessBatch | undefined): ALWorkReadinessAnswer | undefined }` with the exported types
    `ALWorkReadinessAnswer`, `ALWorkReadinessInvalidation`, `ALWorkReadinessProbe`, `ALWorkReadinessBatch`.
  - `ALWorkReadinessProbeCause` is unchanged (`own-commit` stays: a commit whose batch is not clean still owns
    the probe after it).
  - Harness: `type DurableSendBatchEnd = 'effect-drain' | 'timeout'`; `DurableSendSample.batchEnd` replaces
    `probeEnd`; `DurableSendDispatch.batchDrain: Promise<DurableSendBatchDrain>` replaces `ownProbe`;
    `DurableSendRunFigures.batchEnds` replaces `probeCauses`; `DURABLE_SEND_OWN_PROBE_CAUSES` and
    `DurableSendProbeEnd` are deleted.
- For Task 4 (W3, prototyped on the base): the lanes' `this.work.committed()` calls now take an argument;
  `runSelectedWork` no longer calls `wakeAt` (the batch's end does, in `endBatch`); the ledger's
  `sendUntilOwnerIdle` is replaced (it takes one named input and waits for the release, the durable
  `effect-drain` and `liveCount() === 0`, after a `runtime.ready()` plus first-probe wait). Task 4's pins apply on
  top of chain 8 / total 10 / requests 39 / `al-work` 7.
- For Task 5 (W4): each send now ends on its batch's durable `effect-drain`. A receipted send still probes
  after its batch (its `ack-timeout` row is due later), and that probe lands after the drain; if the next send
  starts before it completes, the spec's "no send's wait saw a durable probe" check would count it. The receipted
  configuration needs its own end condition (for example: the drain, then the `own-commit` probe that follows it).

**D8 reuse inspection.** Reused: the existing readiness memory and its generation fence (moved, not rebuilt),
`InboxOutboxEngine.wakeAt` for the restored due time, `commitPending` as the "commit behind the batch" signal, and
the existing `effect-drain` diagnostic as the harness and ledger end-of-batch signal; no new timer, registry,
wake path or constant. `packages/shared/cache`: `LatestValue` (`acceptAt`/`readAt`/`expiredAt` on an injected time)
and `MementoValue` (undo) were inspected for the answer slot and the suspend/restore; not used, because the answer
"no work" is `undefined`, which `LatestValue.readAt` cannot tell from "no value", the memory needs the
clock-stepped-back rule and the generation fence that discards an in-flight probe's answer, and moving the existing
slot onto either would rewrite code P1b does not otherwise change. `packages/shared/resilience`: only `toError`
(already used) is reused; no limiter or breaker applies to this decision.

- [ ] **Step 1: Write the failing handler tests.** Apply this patch to `packages/tests/shared/alm/work/al-work-handler.test.ts` (new restore fixture and cases, the two moved probe-count cases, the `committed(writtenDueByMs)` call sites):

```diff
diff --git a/packages/tests/shared/alm/work/al-work-handler.test.ts b/packages/tests/shared/alm/work/al-work-handler.test.ts
index 7aededda0..a43dd6569 100644
--- a/packages/tests/shared/alm/work/al-work-handler.test.ts
+++ b/packages/tests/shared/alm/work/al-work-handler.test.ts
@@ -1,12 +1,13 @@
 import { Temporal } from '@js-temporal/polyfill';
 import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
 import type {
+    ALWorkAttemptResult,
     ALWorkBatchDiagnostics,
     ALWorkDiagnostics,
     ALWorkReadinessProbeDiagnostics,
     ALWorkReadySelection
 } from '@shared/alm/work/al-work-handler.ts';
-import { AL_WORK_READINESS_MEMORY_MS, ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
+import { AL_WORK_PROBE_EVERY_ROUND, AL_WORK_READINESS_MEMORY_MS, ALWorkHandler } from '@shared/alm/work/al-work-handler.ts';
 import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
 import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort, ALWorkRelease } from '@shared/alm/work/al-work-queue-port.ts';
 import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
@@ -51,7 +52,7 @@ describe('ALWorkHandler', () => {
         expect(released).toEqual(['w-1:completed', 'w-2:retry']);
 
         const before = Date.now();
-        handler.committed();
+        handler.committed(1_000);
         expect(Date.now() - before).toBeLessThan(5);
         handler.dispose();
     });
@@ -449,12 +450,12 @@ describe('ALWorkHandler', () => {
         // Seed the claim that a mid-batch commit must reach only through the follow-up batch: wait
         // for the claim() call of this batch to run and capture it before the second entry exists.
         pending.push(toFakeALWorkClaim('first'));
-        handler.committed();
+        handler.committed(1_000);
         await firstClaimEntered;
 
         // A second commit lands, and its work becomes claimable, while the first entry is still in flight.
         pending.push(toFakeALWorkClaim('second'));
-        handler.committed();
+        handler.committed(1_000);
 
         releaseFirst?.();
         await expect.poll(() => released).toEqual(['first:completed', 'second:completed']);
@@ -738,7 +739,7 @@ describe('ALWorkHandler', () => {
         handler.dispose();
     });
 
-    it('re-probes storage after its own commit, and after a batch that claimed, exactly once each', async () => {
+    it('reads nothing for its own commit whose batch claimed it clean, and probes once after an engine batch', async () => {
         const released: string[] = [];
         const pending: ALWorkClaim[] = [];
         let probeCount = 0;
@@ -771,27 +772,24 @@ describe('ALWorkHandler', () => {
         }
         expect(probeCount).toBe(1);
 
-        // A commit of this owner's own invalidates the answer; the batch it runs claims the row it wrote.
+        // A commit of this owner's own sets the answer aside; the batch it runs claims and completes the
+        // row it wrote, which leaves storage as the answer saw it.
         pending.push(toFakeALWorkClaim('committed-row'));
-        handler.committed();
+        handler.committed(10_000);
         await new Promise((resolve) => setTimeout(resolve, 0));
         expect(released).toEqual(['committed-row:completed']);
-        expect(probeCount).toBe(1);
-
-        // One probe re-establishes the answer the batch invalidated; the rounds after it read nothing.
         for (let round = 0; round < 25; round += 1) {
             await engine.executeOnce();
         }
-        expect(probeCount).toBe(2);
+        expect(probeCount).toBe(1);
 
         // A batch the engine itself starts is worth exactly one probe to open it and one to close it.
         pending.push(toFakeALWorkClaim('engine-row'));
-        handler.committed();
-        await new Promise((resolve) => setTimeout(resolve, 0));
-        expect(released).toEqual(['committed-row:completed', 'engine-row:completed']);
+        engine.wakeAfterExternalWrite();
         for (let round = 0; round < 25; round += 1) {
             await engine.executeOnce();
         }
+        expect(released).toEqual(['committed-row:completed', 'engine-row:completed']);
         expect(probeCount).toBe(3);
 
         handler.dispose();
@@ -817,7 +815,7 @@ describe('ALWorkHandler', () => {
             readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
             readNextReadyAtMs: async () => nextReadyAtMs,
             selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
-            runClaim: async () => ({ status: 'completed' }),
+            runClaim: async (claim) => claim.entry.key.contextId === 'retried-row' ? { status: 'retry' } : { status: 'completed' },
             diagnostics: (event) => collectProbe(probes, event)
         });
 
@@ -825,9 +823,9 @@ describe('ALWorkHandler', () => {
         await handler.ready();
         await engine.executeOnce();
 
-        // A commit runs a batch, and that batch's own invalidation must not take the commit's credit.
+        // A commit whose batch completes everything it claimed costs no probe at all.
         pending.push(toFakeALWorkClaim('committed-row'));
-        handler.committed();
+        handler.committed(nowMs);
         await new Promise((resolve) => setTimeout(resolve, 0));
         await engine.executeOnce();
 
@@ -839,12 +837,19 @@ describe('ALWorkHandler', () => {
         nowMs += AL_WORK_READINESS_MEMORY_MS;
         await engine.executeOnce();
 
+        // A commit whose batch leaves a row behind runs that batch, and the batch's own invalidation
+        // must not take the commit's credit.
+        pending.push(toFakeALWorkClaim('retried-row'));
+        handler.committed(nowMs);
+        await new Promise((resolve) => setTimeout(resolve, 0));
+        await engine.executeOnce();
+
         // The clock never moves here, so every probe reports the read it made as free.
         expect(probes).toEqual([
             { kind: 'readiness-probe', workerId: 'probe-cause-worker', cause: 'no-memory', readyAtMs: 'none', durationMs: 0 },
-            { kind: 'readiness-probe', workerId: 'probe-cause-worker', cause: 'own-commit', readyAtMs: 'none', durationMs: 0 },
             { kind: 'readiness-probe', workerId: 'probe-cause-worker', cause: 'external-wake', readyAtMs: 15_000, durationMs: 0 },
-            { kind: 'readiness-probe', workerId: 'probe-cause-worker', cause: 'age-bound', readyAtMs: 15_000, durationMs: 0 }
+            { kind: 'readiness-probe', workerId: 'probe-cause-worker', cause: 'age-bound', readyAtMs: 15_000, durationMs: 0 },
+            { kind: 'readiness-probe', workerId: 'probe-cause-worker', cause: 'own-commit', readyAtMs: 15_000, durationMs: 0 }
         ]);
 
         handler.dispose();
@@ -1124,7 +1129,7 @@ describe('ALWorkHandler', () => {
         try {
             await handler.ready();
             shouldCorrupt = true;
-            handler.committed();
+            handler.committed(1_000);
             await new Promise((resolve) => setTimeout(resolve, 0));
 
             expect(unhandled).toEqual([]);
@@ -1138,6 +1143,419 @@ describe('ALWorkHandler', () => {
     });
 });
 
+interface RestoreFixture {
+    readonly handler: ALWorkHandler;
+    readonly engine: InboxOutboxEngine;
+    readonly clock: { atMs: number; };
+    /** What the next storage probe answers. */
+    readonly storage: { readyAtMs: number | undefined; };
+    readonly pending: ALWorkClaim[];
+    readonly exhausted: ALWorkClaim[];
+    readonly released: string[];
+    readonly probes: ALWorkReadinessProbeDiagnostics[];
+    /** Every time this owner handed the engine, in order. */
+    readonly wakeAtCalls: (number | undefined)[];
+}
+
+/** What a claim may reach while it runs: the engine it shares and its own owner's commit. */
+interface RestoreFixtureClaimScope {
+    readonly engine: InboxOutboxEngine;
+    readonly commit: () => void;
+}
+
+interface RestoreFixtureInput {
+    readonly pageSize: number;
+    readonly readinessMemoryMs: number;
+    /** What storage probes answer until a test changes it. */
+    readonly probedReadyAtMs: number | undefined;
+    readonly runClaim: (claim: ALWorkClaim, scope: RestoreFixtureClaimScope) => Promise<ALWorkAttemptResult>;
+}
+
+interface UncleanBatchCase {
+    readonly name: string;
+    readonly pageSize: number;
+    /** Rows the exhaustion sweep finalizes in the commit's batch. */
+    readonly exhaustedRows: readonly string[];
+    readonly runClaim: RestoreFixtureInput['runClaim'];
+}
+
+const UNCLEAN_BATCHES: readonly UncleanBatchCase[] = [
+    { name: 'a retried claim', pageSize: 16, exhaustedRows: [], runClaim: async () => ({ status: 'retry' }) },
+    {
+        name: 'a claim not ready yet',
+        pageSize: 16,
+        exhaustedRows: [],
+        runClaim: async () => ({ status: 'not-ready', readyAtMs: 11_000 })
+    },
+    {
+        name: 'a retained claim',
+        pageSize: 16,
+        exhaustedRows: [],
+        runClaim: async () => ({ status: 'retained', settled: new Promise<ALWorkOutcome>(() => {}) })
+    },
+    { name: 'a rejected claim', pageSize: 16, exhaustedRows: [], runClaim: async () => ({ status: 'non-retryable' }) },
+    {
+        name: 'an exhausted row the sweep finalized',
+        pageSize: 16,
+        exhaustedRows: ['exhausted-row'],
+        runClaim: async () => ({ status: 'completed' })
+    },
+    { name: 'a full page', pageSize: 1, exhaustedRows: [], runClaim: async () => ({ status: 'completed' }) },
+    {
+        name: 'an external wake',
+        pageSize: 16,
+        exhaustedRows: [],
+        runClaim: async (_claim, scope) => {
+            scope.engine.wakeAfterExternalWrite();
+            return { status: 'completed' };
+        }
+    },
+    {
+        name: 'a commit behind it',
+        pageSize: 16,
+        exhaustedRows: [],
+        runClaim: async (_claim, scope) => {
+            scope.commit();
+            return { status: 'completed' };
+        }
+    }
+];
+
+function createRestoreFixture(input: RestoreFixtureInput): RestoreFixture {
+    const engine = createEngine();
+    const clock = { atMs: 10_000 };
+    const storage = { readyAtMs: input.probedReadyAtMs };
+    const pending: ALWorkClaim[] = [];
+    const exhausted: ALWorkClaim[] = [];
+    const released: string[] = [];
+    const probes: ALWorkReadinessProbeDiagnostics[] = [];
+    const wakeAtCalls: (number | undefined)[] = [];
+    const wakeAt = engine.wakeAt.bind(engine);
+    vi.spyOn(engine, 'wakeAt').mockImplementation((taskId, readyAtMs) => {
+        wakeAtCalls.push(readyAtMs);
+        wakeAt(taskId, readyAtMs);
+    });
+    const handler: ALWorkHandler = new ALWorkHandler({
+        workerId: 'restore-worker',
+        port: {
+            ...fakePort({ claims: [], onRelease: (claim, outcome) => released.push(`${claim.entry.key.contextId}:${outcome.status}`) }),
+            claim: async ({ maxCount }) => pending.splice(0, maxCount),
+            finalizeExhausted: async (maxCount) => exhausted.splice(0, maxCount)
+        },
+        queueEngine: engine,
+        ownsQueueEngine: false,
+        clock: { nowMs: () => clock.atMs },
+        pageSize: input.pageSize,
+        readinessMemoryMs: input.readinessMemoryMs,
+        readNextReadyAtMs: async () => storage.readyAtMs,
+        selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
+        runClaim: (claim) => input.runClaim(claim, { engine, commit: () => handler.committed(clock.atMs) }),
+        diagnostics: (event) => collectProbe(probes, event)
+    });
+    return { handler, engine, clock, storage, pending, exhausted, released, probes, wakeAtCalls };
+}
+
+/** One row this owner wrote, due now, and announced, and the batch its commit runs, to the end. */
+async function commitRow(fixture: RestoreFixture, effectId: string): Promise<void> {
+    await commitRowDueBy(fixture, effectId, fixture.clock.atMs);
+}
+
+async function commitRowDueBy(
+    fixture: RestoreFixture,
+    effectId: string,
+    writtenDueByMs: number | undefined
+): Promise<void> {
+    fixture.pending.push(toFakeALWorkClaim(effectId));
+    fixture.handler.committed(writtenDueByMs);
+    await new Promise((resolve) => setTimeout(resolve, 0));
+}
+
+describe('ALWorkHandler readiness restore', () => {
+    it('restores the answer its commit suspended once a clean batch ends, at its own age, and hands its due time to the engine', async () => {
+        const fixture = createRestoreFixture({
+            pageSize: 16,
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            probedReadyAtMs: 15_000,
+            runClaim: async () => ({ status: 'completed' })
+        });
+        await fixture.handler.ready();
+        await fixture.engine.executeOnce();
+        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory']);
+
+        fixture.clock.atMs = 12_000;
+        await commitRow(fixture, 'clean-row');
+        expect(fixture.released).toEqual(['clean-row:completed']);
+        // The selection advertised no time of its own, so the engine is handed the restored one.
+        expect(fixture.wakeAtCalls.at(-1)).toBe(15_000);
+        for (let round = 0; round < 25; round += 1) {
+            await fixture.engine.executeOnce();
+        }
+        expect(fixture.probes).toHaveLength(1);
+
+        // The answer was taken at 10 000, not when the batch restored it, so it ages out on time.
+        fixture.clock.atMs = 10_000 + AL_WORK_READINESS_MEMORY_MS;
+        await fixture.engine.executeOnce();
+        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'age-bound']);
+        fixture.handler.dispose();
+    });
+
+    it.each(UNCLEAN_BATCHES)('probes after a batch with $name, naming the commit', async (unclean) => {
+        const fixture = createRestoreFixture({
+            pageSize: unclean.pageSize,
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            probedReadyAtMs: undefined,
+            runClaim: unclean.runClaim
+        });
+        await fixture.handler.ready();
+        await fixture.engine.executeOnce();
+        fixture.exhausted.push(...unclean.exhaustedRows.map((effectId) => toFakeALWorkClaim(effectId)));
+
+        await commitRow(fixture, 'unclean-row');
+        await fixture.engine.executeOnce();
+
+        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'own-commit']);
+        fixture.handler.dispose();
+    });
+
+    it.each([
+        { name: 'a row due only after its batch started', writtenDueByMs: 10_001 },
+        { name: 'work it cannot describe', writtenDueByMs: undefined }
+    ])('probes after a clean batch whose commit wrote $name', async ({ writtenDueByMs }) => {
+        const fixture = createRestoreFixture({
+            pageSize: 16,
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            probedReadyAtMs: undefined,
+            runClaim: async () => ({ status: 'completed' })
+        });
+        await fixture.handler.ready();
+        await fixture.engine.executeOnce();
+
+        // A receipted send writes its acknowledgement timeout beside the send: the batch completes the
+        // send, and the timeout row it never saw is due later.
+        await commitRowDueBy(fixture, 'sent-row', writtenDueByMs);
+        await fixture.engine.executeOnce();
+
+        expect(fixture.released).toEqual(['sent-row:completed']);
+        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'own-commit']);
+        fixture.handler.dispose();
+    });
+
+    it('probes after a batch during which a claim an earlier batch retained released', async () => {
+        let settleHeld: ((outcome: ALWorkOutcome) => void) | undefined;
+        const held = new Promise<ALWorkOutcome>((resolve) => {
+            settleHeld = resolve;
+        });
+        const fixture = createRestoreFixture({
+            pageSize: 16,
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            probedReadyAtMs: undefined,
+            runClaim: async (claim) => {
+                if (claim.entry.key.contextId === 'held-row') {
+                    return { status: 'retained', settled: held };
+                }
+                settleHeld?.({ status: 'completed' });
+                await new Promise((resolve) => setTimeout(resolve, 0));
+                return { status: 'completed' };
+            }
+        });
+        await fixture.handler.ready();
+        await commitRow(fixture, 'held-row');
+        await fixture.engine.executeOnce();
+        expect(fixture.probes).toHaveLength(1);
+
+        await commitRow(fixture, 'releasing-row');
+        await vi.waitFor(() => expect(fixture.released).toEqual(['held-row:completed', 'releasing-row:completed']));
+        await fixture.engine.executeOnce();
+
+        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'own-commit']);
+        fixture.handler.dispose();
+    });
+
+    it('probes after a clean batch whose suspended answer had come due before the batch started', async () => {
+        const fixture = createRestoreFixture({
+            pageSize: 16,
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            probedReadyAtMs: 12_000,
+            runClaim: async () => ({ status: 'completed' })
+        });
+        await fixture.handler.ready();
+        await fixture.engine.executeOnce();
+        fixture.storage.readyAtMs = undefined;
+
+        // Restoring a due answer would start a batch that claims nothing, on every engine round.
+        fixture.clock.atMs = 12_000;
+        await commitRow(fixture, 'late-row');
+        await fixture.engine.executeOnce();
+
+        expect(fixture.probes.map((probe) => probe.cause)).toEqual(['no-memory', 'own-commit']);
+        fixture.handler.dispose();
+    });
+
+    it('probes every round as before when its answers never stand, and hands the engine only the selection\'s time', async () => {
+        const fixture = createRestoreFixture({
+            pageSize: 16,
+            readinessMemoryMs: AL_WORK_PROBE_EVERY_ROUND,
+            probedReadyAtMs: 15_000,
+            runClaim: async () => ({ status: 'completed' })
+        });
+        await fixture.handler.ready();
+        await fixture.engine.executeOnce();
+
+        await commitRow(fixture, 'inbound-row');
+        expect(fixture.wakeAtCalls.at(-1)).toBeUndefined();
+        for (let round = 0; round < 3; round += 1) {
+            await fixture.engine.executeOnce();
+        }
+
+        expect(fixture.probes.map((probe) => probe.cause))
+            .toEqual(['no-memory', 'own-commit', 'age-bound', 'age-bound']);
+        fixture.handler.dispose();
+    });
+
+    it('finds a row another tab wrote, unannounced, once the restored answer reaches its age bound', async () => {
+        let nowMs = 10_000;
+        const claimed: string[] = [];
+        const queue = new InMemoryQueueBox();
+        const engine = createEngine();
+        const handler = new ALWorkHandler({
+            workerId: 'foreign-row-worker',
+            port: createALWorkQueuePort({
+                queue,
+                workTypes: AL_TEST_TYPES,
+                leaseMs: 30_000,
+                nowMs: () => nowMs,
+                random: () => 0.5
+            }),
+            queueEngine: engine,
+            ownsQueueEngine: false,
+            clock: { nowMs: () => nowMs },
+            pageSize: 16,
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            readNextReadyAtMs: () => readTestALWorkReadyAtMs(queue, AL_TEST_TYPES, nowMs),
+            selectReady: async (claimable, size) => toTestALWorkReadySelection(await claimable.claim({ maxCount: size, observedEntries: undefined })),
+            runClaim: async (claim) => {
+                claimed.push(claim.entry.key.contextId);
+                return { status: 'completed' };
+            },
+            diagnostics: undefined
+        });
+        await handler.ready();
+        await engine.executeOnce();
+
+        nowMs = 11_000;
+        await queue.enqueue(newWorkEntry('AL_TEST', 'own-row'));
+        handler.committed(nowMs);
+        await new Promise((resolve) => setTimeout(resolve, 0));
+        expect(claimed).toEqual(['own-row']);
+
+        // No browser code announces another tab's write: the row reaches the queue and nothing else.
+        await queue.enqueue(newWorkEntry('AL_TEST', 'foreign-row'));
+        nowMs = 10_000 + AL_WORK_READINESS_MEMORY_MS - 1;
+        await engine.executeOnce();
+        await new Promise((resolve) => setTimeout(resolve, 0));
+        expect(claimed).toEqual(['own-row']);
+
+        nowMs = 10_000 + AL_WORK_READINESS_MEMORY_MS;
+        await engine.executeOnce();
+        await new Promise((resolve) => setTimeout(resolve, 0));
+        expect(claimed).toEqual(['own-row', 'foreign-row']);
+        handler.dispose();
+    });
+});
+
+describe('ALWorkHandler readiness invalidation label', () => {
+    it('names the probe after a discarded one with the invalidation that discarded it', async () => {
+        const probes: ALWorkReadinessProbeDiagnostics[] = [];
+        const pending: ALWorkClaim[] = [];
+        let releaseProbe: (() => void) | undefined;
+        let gateNextProbe = false;
+        const engine = createEngine();
+        const handler = new ALWorkHandler({
+            workerId: 'discarded-probe-worker',
+            port: { ...fakePort({ claims: [], onRelease: () => {} }), claim: async ({ maxCount }) => pending.splice(0, maxCount) },
+            queueEngine: engine,
+            ownsQueueEngine: false,
+            clock: { nowMs: () => 10_000 },
+            pageSize: 16,
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            readNextReadyAtMs: async () => {
+                if (gateNextProbe) {
+                    gateNextProbe = false;
+                    await new Promise<void>((resolve) => {
+                        releaseProbe = resolve;
+                    });
+                }
+                return undefined;
+            },
+            selectReady: async (p, size) => toTestALWorkReadySelection(await p.claim({ maxCount: size, observedEntries: undefined })),
+            runClaim: async () => ({ status: 'completed' }),
+            diagnostics: (event) => collectProbe(probes, event)
+        });
+        await handler.ready();
+        await engine.executeOnce();
+
+        engine.wakeAfterExternalWrite();
+        gateNextProbe = true;
+        const probing = engine.executeOnce();
+        await vi.waitFor(() => expect(releaseProbe).toBeDefined());
+
+        // The commit lands while the external wake's probe is reading: that answer is discarded, and
+        // the commit, not the wake the discarded probe already reported, owes the next one.
+        pending.push(toFakeALWorkClaim('mid-probe-row'));
+        handler.committed(10_000);
+        await new Promise((resolve) => setTimeout(resolve, 0));
+        releaseProbe?.();
+        await probing;
+        await engine.executeOnce();
+
+        expect(probes.map((probe) => probe.cause)).toEqual(['no-memory', 'external-wake', 'own-commit']);
+        handler.dispose();
+    });
+
+    it('labels a probe no-memory once the probe before it took the invalidation and failed', async () => {
+        const probes: ALWorkReadinessProbeDiagnostics[] = [];
+        let failNextProbe = false;
+        const engine = createEngine();
+        const handler = new ALWorkHandler({
+            workerId: 'failed-probe-worker',
+            port: fakePort({ claims: [], onRelease: () => {} }),
+            queueEngine: engine,
+            ownsQueueEngine: false,
+            clock: { nowMs: () => 10_000 },
+            pageSize: 16,
+            readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
+            readNextReadyAtMs: async () => {
+                if (failNextProbe) {
+                    failNextProbe = false;
+                    throw new Error('storage unavailable');
+                }
+                return undefined;
+            },
+            selectReady: async () => toTestALWorkReadySelection([]),
+            runClaim: async () => ({ status: 'completed' }),
+            diagnostics: (event) => collectProbe(probes, event)
+        });
+        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
+        try {
+            await handler.ready();
+            await engine.executeOnce();
+
+            engine.wakeAfterExternalWrite();
+            failNextProbe = true;
+            await engine.executeOnce();
+            await engine.executeOnce();
+
+            // The failed read reported nothing, and the wake it answered is spent: the retry is no
+            // wake's probe, only an owner with no answer at all.
+            expect(probes.map((probe) => probe.cause)).toEqual(['no-memory', 'no-memory']);
+        }
+        finally {
+            consoleErrorSpy.mockRestore();
+            handler.dispose();
+        }
+    });
+});
+
 function collectProbe(probes: ALWorkReadinessProbeDiagnostics[], event: ALWorkDiagnostics): void {
     if (event.kind === 'readiness-probe') {
         probes.push(event);
```

- [ ] **Step 2: Rewrite the outbound probe-diagnostics test.** Replace `packages/tests/shared/alm/outbound-readiness-probe-diagnostics.test.ts` with:

```ts
import { expect, it } from 'vitest';

import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { AL_WORK_READINESS_MEMORY_MS } from '@shared/alm/work/al-work-handler.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import '../../setup-browser-indexeddb.ts';
import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

type ReadinessProbeEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'readiness-probe'; }>;
type EffectDrainEvent = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'effect-drain'; }>;

const CLOCK_START_MS = 1_760_000_000_000;
const ACK_TIMEOUT_MS = 1_000;

function createStores(kind: 'memory' | 'indexeddb', nowMs: () => number) {
    const backend = kind === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), nowMs)
        : new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `outbound-readiness-probe-${crypto.randomUUID()}`,
            storeName: 'entries',
            nowMs,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
    const admissionStore = createALOutboundAdmissionStore({
        nowMs,
        canonicalScope: 'outbound-readiness-probe',
        decodePrepared: decodeOutboundTestPayload,
        namespace: 'outbound-readiness-probe',
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { admissionStore, workQueue: backend.workQueue };
}

function probesOf(
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]
): readonly ReadinessProbeEvent[] {
    return diagnostics.filter((event): event is ReadinessProbeEvent =>
        event.kind === 'readiness-probe'
    );
}

function drainsOf(
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]
): readonly EffectDrainEvent[] {
    return diagnostics.filter((event): event is EffectDrainEvent => event.kind === 'effect-drain');
}

/** Runs engine rounds until the owner spends the probe the last invalidation owed it. */
async function runProbedRound(
    engine: InboxOutboxEngine,
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]
): Promise<void> {
    const observed = probesOf(diagnostics).length;
    await expect.poll(async () => {
        await engine.executeOnce();
        return probesOf(diagnostics).length;
    }).toBeGreaterThan(observed);
}

/** Sends one message and waits for the batch its commit runs to report its drain. */
async function sendThroughOwnBatch(
    runtime: ALOutboundMessageRuntime<OutboundTestPayload>,
    diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[],
    resourceId: string
): Promise<EffectDrainEvent | undefined> {
    const drained = drainsOf(diagnostics).length;
    const enqueued = await runtime.enqueueIfAbsent(createOutboundMessage(resourceId));
    expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: true });
    await expect.poll(() => drainsOf(diagnostics).length).toBeGreaterThan(drained);
    return drainsOf(diagnostics)[drained];
}

function createProbedRuntime(input: {
    readonly kind: 'memory' | 'indexeddb';
    readonly engine: InboxOutboxEngine;
    readonly clock: { atMs: number; };
    readonly diagnostics: ALOutboundRuntimeDiagnosticsEvent[];
    readonly ackTracking: ALOutboundAckTrackingPlan | undefined;
}): ALOutboundMessageRuntime<OutboundTestPayload> {
    return createDefaultOutboundTestRuntime({
        stores: createStores(input.kind, () => input.clock.atMs),
        queueEngine: input.engine,
        nowMs: () => input.clock.atMs,
        diagnostics: (event) => input.diagnostics.push(event),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [{ kind: 'send' }],
            ackTracking: input.ackTracking
        }),
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
    });
}

it.each(['memory', 'indexeddb'] as const)(
    'names the invalidation behind every storage probe the outbound owner spends over %s',
    async (kind) => {
        const clock = { atMs: CLOCK_START_MS };
        const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const engine = new InboxOutboxEngine();
        const runtime = createProbedRuntime({
            kind,
            engine,
            clock,
            diagnostics,
            ackTracking: undefined
        });

        await runtime.ready();
        await runProbedRound(engine, diagnostics);

        // The send's own batch claims and completes the one row its commit wrote, so the answer the
        // commit set aside describes storage again: no engine round reads it back.
        const drain = await sendThroughOwnBatch(runtime, diagnostics, 'msg-readiness-probe');
        expect(drain).toMatchObject({ lane: 'durable', claimedCount: 1, completedCount: 1 });
        for (let round = 0; round < 25; round += 1) {
            await engine.executeOnce();
        }
        expect(probesOf(diagnostics)).toHaveLength(1);

        // The announcement another writer makes to every owner on the engine, not this owner's work.
        engine.wakeAfterExternalWrite();
        await runProbedRound(engine, diagnostics);

        clock.atMs += AL_WORK_READINESS_MEMORY_MS;
        await runProbedRound(engine, diagnostics);

        const probes = probesOf(diagnostics);
        expect(probes.map((probe) => probe.cause)).toEqual([
            'no-memory',
            'external-wake',
            'age-bound'
        ]);
        // Each of those is one storage read the page charges to `work-page`, and the drained owner's
        // answer is the same every time: the reads are the invalidations, not the work.
        expect(probes.map((probe) => probe.readyAtMs)).toEqual(['none', 'none', 'none']);
        // The clock this owner runs on never moves inside a probe, so every relayed read cost is
        // exactly zero -- a field the relay dropped would read as `undefined` here instead.
        expect(probes.map((probe) => probe.durationMs)).toEqual([0, 0, 0]);
        expect(new Set(probes.map((probe) => probe.workerId)).size).toBe(1);
        expect(probes[0]?.workerId).toMatch(/^al-outbound:/);
        runtime.dispose();
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'probes after a receipted send\'s batch, which never saw the acknowledgement timeout its commit wrote, over %s',
    async (kind) => {
        const clock = { atMs: CLOCK_START_MS };
        const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
        const engine = new InboxOutboxEngine();
        const runtime = createProbedRuntime({
            kind,
            engine,
            clock,
            diagnostics,
            ackTracking: {
                enabled: true,
                timeoutMs: ACK_TIMEOUT_MS,
                maxAttempts: 3,
                expectedPeerIds: ['peer-1'],
                nextHopPeerIds: ['peer-1'],
                mode: 'hop'
            }
        });

        await runtime.ready();
        await runProbedRound(engine, diagnostics);
        await sendThroughOwnBatch(runtime, diagnostics, 'msg-receipted-probe');
        await runProbedRound(engine, diagnostics);

        // The timeout row's due time reaches the engine from this probe, not from the age bound.
        expect(probesOf(diagnostics).map((probe) => [probe.cause, probe.readyAtMs])).toEqual([
            ['no-memory', 'none'],
            ['own-commit', CLOCK_START_MS + ACK_TIMEOUT_MS]
        ]);
        runtime.dispose();
    }
);

it('reports the idle owner\'s probes even where its batch has nothing to report', async () => {
    const clock = { atMs: CLOCK_START_MS };
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const engine = new InboxOutboxEngine();
    const runtime = createProbedRuntime({
        kind: 'memory',
        engine,
        clock,
        diagnostics,
        ackTracking: undefined
    });

    await runtime.ready();
    for (let round = 0; round < 3; round += 1) {
        await runProbedRound(engine, diagnostics);
        clock.atMs += AL_WORK_READINESS_MEMORY_MS;
    }

    // An owner with nothing to do still reads storage once per aged-out answer, and no batch runs to
    // report it: without the probe those reads are invisible to every consumer of this topic.
    expect(probesOf(diagnostics).map((probe) => probe.cause)).toEqual([
        'no-memory',
        'age-bound',
        'age-bound'
    ]);
    expect(drainsOf(diagnostics)).toHaveLength(1);
    runtime.dispose();
});
```

- [ ] **Step 3: Move the ledger's idle wait onto the batch drain and lower its pins.** Apply to `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts`:

```diff
diff --git a/packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts b/packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
index 0e28f3ecd..e637e2758 100644
--- a/packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
+++ b/packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
@@ -1,7 +1,10 @@
 import 'fake-indexeddb/auto';
 import { afterEach, describe, expect, it, vi } from 'vitest';
 
-import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
+import type {
+    ALOutboundMessageRuntime,
+    ALOutboundRuntimeDiagnosticsEvent
+} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
 import type { IndexedDbOperationKind } from '@shared/persistence/indexed-db-operation-observer.ts';
 
 import {
@@ -36,6 +39,8 @@ const CANONICAL_HANDOFF_REASON = 'no canonical read: the claim takes the canonic
     'over instead of reading it back';
 const SEND_GUARDS_SESSION_REASON = 'one guard read: a prepared send reads its supersedence and receipt guards in ' +
     'one session';
+const READINESS_RESTORE_REASON = 'no readiness probe after the batch: the batch claimed and completed the one row ' +
+    'its commit wrote, so it restores the answer that commit set aside';
 const WORK_ROW_PARSES = 'each read that decodes the work row parses its 4 timestamps (date, created, expiry and ' +
     'its one dequeue instant) once; a row the owner wrote is never parsed back';
 
@@ -47,7 +52,7 @@ describe('outbound warm send IndexedDB transaction ledger', () => {
         vi.restoreAllMocks();
     });
 
-    it('reaches the carrier in 8 transactions and the idle owner in 11', async () => {
+    it('reaches the carrier in 8 transactions and the idle owner in 10', async () => {
         const ledger = await readWarmOutboundSendLedger();
         const chain = computeIndexedDbLedgerTotals(ledger, ['chain']);
         const total = computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']);
@@ -62,14 +67,13 @@ describe('outbound warm send IndexedDB transaction ledger', () => {
         ).toBe(8);
         expect(
             total.transactions,
-            'the chain\'s 8, then the release read, the release write and the readiness probe the ' +
-                'batch\'s end owes' + table
-        ).toBe(11);
+            'the chain\'s 8, then the release read and the release write; ' + READINESS_RESTORE_REASON + table
+        ).toBe(10);
         expect(
             total.requests,
-            'every get, getAll and put those 11 transactions issue; the guard read issues its 2 gets ' +
+            'every get, getAll and put those 10 transactions issue; the guard read issues its 2 gets ' +
                 'in one session' + table
-        ).toBe(42);
+        ).toBe(39);
         expect(total.droppedRequests, 'every request ran on a transaction the ledger recorded' + table)
             .toBe(0);
         expect(
@@ -79,9 +83,9 @@ describe('outbound warm send IndexedDB transaction ledger', () => {
         ).toBe(10);
         expect(
             total.byOwner['al-work'],
-            '3 decision work reads, 2 empty probes, the reservation, the release and the readiness ' +
-                'page; ' + CANONICAL_HANDOFF_REASON + table
-        ).toBe(8);
+            '3 decision work reads, 2 empty probes, the reservation and the release; ' +
+                CANONICAL_HANDOFF_REASON + '; ' + READINESS_RESTORE_REASON + table
+        ).toBe(7);
     });
 
     it('parses 9 timestamps up to the carrier and 13 up to the idle owner', async () => {
@@ -95,8 +99,8 @@ describe('outbound warm send IndexedDB transaction ledger', () => {
         ).toEqual({ instant: 5, plainTime: 2, plainDateTime: 2 });
         expect(
             computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']).temporalParses,
-            'the chain\'s 9, then the release read decodes the work row (4); the release write and ' +
-                'the readiness probe parse nothing' + table
+            'the chain\'s 9, then the release read decodes the work row (4); the release write parses ' +
+                'nothing' + table
         ).toEqual({ instant: 7, plainTime: 3, plainDateTime: 3 });
     });
 });
@@ -185,9 +189,11 @@ describe('inbound warm admit-and-deliver IndexedDB transaction ledger', () => {
 
 async function readWarmOutboundSendLedger(): Promise<IndexedDbTransactionLedger> {
     const recorded = recordIndexedDbTransactionLedger();
+    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
     let phaseAtSend: IndexedDbLedgerPhase = 'before';
     const runtime = createDefaultOutboundTestRuntime({
         stores: createIndexedDbOutboundTestStores({ observer: recorded.observer, namespace: OUTBOUND_NAMESPACE }),
+        diagnostics: (event) => diagnostics.push(event),
         planOutgoingMessage: (msg) => ({
             msg,
             dropReasonCode: undefined,
@@ -199,39 +205,48 @@ async function readWarmOutboundSendLedger(): Promise<IndexedDbTransactionLedger>
             return { status: 'sent' as const, submissionAttempted: true };
         }
     });
-    await sendUntilOwnerIdle(runtime, recorded, 'msg-ledger-warm-up');
+    // The owner's first probe takes the answer each send's commit sets aside and its batch restores.
+    await runtime.ready();
+    await vi.waitFor(() => {
+        expect(diagnostics.some((event) => event.kind === 'readiness-probe')).toBe(true);
+        expect(recorded.liveCount()).toBe(0);
+    });
+    await sendUntilOwnerIdle({ runtime, recorded, diagnostics, resourceId: 'msg-ledger-warm-up' });
     recorded.setPhase('chain');
     phaseAtSend = 'after-send';
-    await sendUntilOwnerIdle(runtime, recorded, 'msg-ledger-pinned');
+    await sendUntilOwnerIdle({ runtime, recorded, diagnostics, resourceId: 'msg-ledger-pinned' });
     return recorded.getLedger();
 }
 
+interface OutboundSendUntilIdleInput {
+    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
+    readonly recorded: RecordedIndexedDbTransactionLedger;
+    readonly diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[];
+    readonly resourceId: string;
+}
+
 /**
- * The commit's own batch sends the message; the owner is idle once this send's release has been
- * followed by the readiness probe the batch's end schedules. Waiting for that probe keeps it out of
- * the next send's chain.
+ * The commit's own batch sends the message; the owner is idle once that batch has released the row,
+ * reported its drain and left no transaction open. A clean batch restores the readiness answer its
+ * commit set aside, so no probe follows it.
  */
-async function sendUntilOwnerIdle(
-    runtime: ALOutboundMessageRuntime<OutboundTestPayload>,
-    recorded: RecordedIndexedDbTransactionLedger,
-    resourceId: string
-): Promise<void> {
+async function sendUntilOwnerIdle(input: OutboundSendUntilIdleInput): Promise<void> {
+    const { recorded, diagnostics } = input;
     const releasesBefore = computeOperationCount(recorded.getLedger(), 'work-release');
-    const enqueued = await runtime.enqueueIfAbsent(createOutboundMessage(resourceId));
+    const drainsBefore = computeEffectDrainCount(diagnostics);
+    const enqueued = await input.runtime.enqueueIfAbsent(createOutboundMessage(input.resourceId));
     expect(enqueued.verdict).toMatchObject({ kind: 'admitted', durable: true });
-    // The warm-up's release and probe are already in the ledger, so only counts taken before this
-    // send can tell its own release and probe from theirs.
+    // The warm-up's release and drain are already recorded, so only counts taken before this send
+    // can tell its own from theirs.
     await vi.waitFor(() => {
-        expect(isProbedAfterNthRelease(recorded.getLedger(), releasesBefore + 1)).toBe(true);
+        expect(computeOperationCount(recorded.getLedger(), 'work-release')).toBe(releasesBefore + 1);
+        expect(computeEffectDrainCount(diagnostics)).toBe(drainsBefore + 1);
         expect(recorded.liveCount()).toBe(0);
     });
 }
 
-function isProbedAfterNthRelease(ledger: IndexedDbTransactionLedger, nth: number): boolean {
-    const kinds = ledger.operations.map((operation) => operation.kind);
-    const releaseIndexes = kinds.flatMap((kind, index) => kind === 'work-release' ? [index] : []);
-    const release = releaseIndexes[nth - 1];
-    return release !== undefined && kinds.lastIndexOf('work-page') > release;
+function computeEffectDrainCount(diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]): number {
+    return diagnostics.filter((event) => event.kind === 'effect-drain' && event.lane === 'durable').length;
 }
 
 /**
```

- [ ] **Step 4: Run the three files against the unchanged production code.**

```sh
npx vitest run packages/tests/shared/alm/work/al-work-handler.test.ts packages/tests/shared/alm/outbound-readiness-probe-diagnostics.test.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
```

Expected (measured on 9e8b9fc07's production code; vitest does not typecheck, so `committed(1_000)` runs):

```text
     × reads nothing for its own commit whose batch claimed it clean, and probes once after an engine batch
     × names what emptied the memory every probe replaces
     × restores the answer its commit suspended once a clean batch ends, at its own age, and hands its due time to the engine
     × finds a row another tab wrote, unannounced, once the restored answer reaches its age bound
     × names the probe after a discarded one with the invalidation that discarded it
     × labels a probe no-memory once the probe before it took the invalidation and failed
   × names the invalidation behind every storage probe the outbound owner spends over memory
   × names the invalidation behind every storage probe the outbound owner spends over indexeddb
     × reaches the carrier in 8 transactions and the idle owner in 10
AssertionError: expected 2 to be 1 // Object.is equality
AssertionError: expected [ …(5) ] to deeply equal [ …(4) ]
AssertionError: expected undefined to be 15000 // Object.is equality
AssertionError: expected [ 'own-row', 'foreign-row' ] to deeply equal [ 'own-row' ]
AssertionError: expected [ 'no-memory', 'external-wake', …(1) ] to deeply equal [ 'no-memory', 'external-wake', …(1) ]
AssertionError: expected [ 'no-memory', 'external-wake' ] to deeply equal [ 'no-memory', 'no-memory' ]
AssertionError: expected [ …(2) ] to have a length of 1 but got 2
AssertionError: the chain's 8, then the release read and the release write; no readiness probe after the batch: ...
 Test Files  3 failed (3)
      Tests  9 failed | 41 passed (50)
```

The guard cases (every unclean batch, the due answer, the inbound owner, the commit that wrote a later row, the
receipted send) pass before and after: they pin that the restore never fires where today's probe is needed.

- [ ] **Step 5: Create the readiness memory.** `packages/shared/alm/work/al-work-readiness-memory.ts`:

```ts
import type { ALWorkReadinessProbeCause } from './al-work-handler.ts';

/** One probe's answer; `readyAtMs` undefined is the probe reporting no work at all. */
export interface ALWorkReadinessAnswer {
    readonly readyAtMs: number | undefined;
    readonly observedAtMs: number;
}

/** The changes that empty a remembered answer; the other two causes describe a probe, not a change. */
export type ALWorkReadinessInvalidation = Exclude<
    ALWorkReadinessProbeCause,
    'no-memory' | 'age-bound'
>;

/** What storage answered, and why the owner had to ask it. */
export interface ALWorkReadinessProbe {
    readonly cause: ALWorkReadinessProbeCause;
    readonly readyAtMs: number | undefined;
}

/** What a batch that ran to its end did, as the restore of a suspended answer needs it. */
export interface ALWorkReadinessBatch {
    readonly claimedCount: number;
    readonly completedCount: number;
    readonly rejectedCount: number;
    readonly pageSize: number;
    readonly startedAtMs: number;
    /** A commit landed while the batch ran, so its page may not hold that commit's rows. */
    readonly commitPending: boolean;
}

/** An answer a commit set aside, and when the last row that commit wrote becomes claimable. */
interface ALWorkSuspendedReadiness {
    readonly answer: ALWorkReadinessAnswer;
    readonly writtenDueByMs: number;
}

/**
 * How long a probe's answer stands, and what empties it. **Any change to the owner's rows performed
 * outside its batch must reach `forget` or `suspend`**, or the owner keeps answering from a picture
 * storage no longer supports.
 */
export class ALWorkReadinessMemory {
    private readonly memoryMs: number;
    private answer: ALWorkReadinessAnswer | undefined;
    private suspended: ALWorkSuspendedReadiness | undefined;
    /** Bumped by every invalidation, so a probe that started before one cannot store its stale answer. */
    private generation = 0;
    /** The first invalidation since the last probe started: what the next probe without an answer reports. */
    private invalidation: ALWorkReadinessInvalidation | undefined;
    private probeInFlight = false;

    constructor(memoryMs: number) {
        this.memoryMs = memoryMs;
    }

    /** The remembered answer while it stands, or undefined when storage must answer. */
    getStandingAnswer(nowMs: number): ALWorkReadinessAnswer | undefined {
        const { answer } = this;
        return answer !== undefined && isALWorkReadinessAnswerStanding(answer, nowMs, this.memoryMs)
            ? answer
            : undefined;
    }

    /** Reads storage through `read` and remembers its answer, unless an invalidation landed meanwhile. */
    async readProbe(
        nowMs: number,
        read: () => Promise<number | undefined>
    ): Promise<ALWorkReadinessProbe> {
        const cause = this.answer === undefined ? this.invalidation ?? 'no-memory' : 'age-bound';
        this.invalidation = undefined;
        const generation = this.generation;
        this.probeInFlight = true;
        try {
            const readyAtMs = await read();
            if (generation === this.generation) {
                this.answer = { readyAtMs, observedAtMs: nowMs };
            }
            return { cause, readyAtMs };
        }
        finally {
            this.probeInFlight = false;
        }
    }

    forget(cause: ALWorkReadinessInvalidation): void {
        const discards = this.answer !== undefined || this.suspended !== undefined ||
            this.probeInFlight;
        if (discards && this.invalidation === undefined) {
            // The first change since the last probe owns the next one: a commit runs a batch, and
            // that batch's own invalidation must not take the credit from the commit.
            this.invalidation = cause;
        }
        this.answer = undefined;
        this.suspended = undefined;
        this.generation += 1;
    }

    /** A commit invalidates the answer, but keeps it aside for the batch it runs to restore. */
    suspend(writtenDueByMs: number | undefined): void {
        const standing = this.answer;
        this.forget('own-commit');
        this.suspended = standing === undefined || writtenDueByMs === undefined
            ? undefined
            : { answer: standing, writtenDueByMs };
    }

    /**
     * A batch's end: the answer its commit set aside comes back, with its own age, when the batch
     * left storage as that answer saw it, and every other answer is dropped. Returns the restored one.
     */
    settle(batch: ALWorkReadinessBatch | undefined): ALWorkReadinessAnswer | undefined {
        const restored = batch === undefined
            ? undefined
            : resolveALWorkRestoredReadiness(this.suspended, batch, this.memoryMs);
        this.forget('batch');
        if (restored !== undefined) {
            this.answer = restored;
            this.invalidation = undefined;
        }
        return restored;
    }
}

/** An answer stands from its probe until the memory bound; a clock that stepped back behind the probe ends it. */
function isALWorkReadinessAnswerStanding(
    answer: ALWorkReadinessAnswer,
    nowMs: number,
    memoryMs: number
): boolean {
    return nowMs >= answer.observedAtMs && nowMs - answer.observedAtMs < memoryMs;
}

/**
 * The suspended answer still describes storage only when the commit's batch could claim every row
 * the commit wrote and finished each one: it started once they were all due, claimed fewer than a
 * page, completed every claim, rejected and retained nothing, and no commit landed behind it. The
 * answer must also still stand when the batch started, and not be due by then: a due answer would
 * start a batch that claims nothing on every engine round.
 */
function resolveALWorkRestoredReadiness(
    suspended: ALWorkSuspendedReadiness | undefined,
    batch: ALWorkReadinessBatch,
    memoryMs: number
): ALWorkReadinessAnswer | undefined {
    if (
        suspended === undefined || batch.commitPending ||
        suspended.writtenDueByMs > batch.startedAtMs
    ) {
        return undefined;
    }
    const { answer } = suspended;
    const clean = batch.claimedCount < batch.pageSize && batch.rejectedCount === 0 &&
        batch.completedCount === batch.claimedCount;
    const notDue = answer.readyAtMs === undefined || answer.readyAtMs > batch.startedAtMs;
    return clean && notDue && isALWorkReadinessAnswerStanding(answer, batch.startedAtMs, memoryMs)
        ? answer
        : undefined;
}
```

- [ ] **Step 6: Move the handler onto it, suspend on commit, settle at the batch end.** Apply to `packages/shared/alm/work/al-work-handler.ts`:

```diff
diff --git a/packages/shared/alm/work/al-work-handler.ts b/packages/shared/alm/work/al-work-handler.ts
index a466851cf..9eede0f99 100644
--- a/packages/shared/alm/work/al-work-handler.ts
+++ b/packages/shared/alm/work/al-work-handler.ts
@@ -3,6 +3,7 @@ import { toError } from '../../resilience/to-error.ts';
 import { INBOX_OUTBOX_ENGINE_MAX_IDLE_MS, type InboxOutboxEngine } from '../../services/InboxOutboxEngine.ts';
 import { ALAdmissionCorruptionError } from '../al-admission-decoder.ts';
 import type { ALWorkClaim, ALWorkOutcome, ALWorkQueuePort, ALWorkRelease } from './al-work-queue-port.ts';
+import { ALWorkReadinessMemory, type ALWorkReadinessAnswer } from './al-work-readiness-memory.ts';
 
 export type ALWorkAttemptResult =
     | ALWorkOutcome
@@ -116,10 +117,10 @@ export interface ALWorkReadinessProbeDiagnostics {
 }
 
 /**
- * How long an owner that has neither committed nor run a batch keeps answering from its last probe.
- * It is the engine's own idle ceiling, derived from it so the two cannot drift apart: work another
- * tab wrote, or a row a crashed owner's lease still holds, is discovered on that idle cadence
- * instead of costing a storage read on every engine round.
+ * How long one probe's answer stands, counted from that probe whatever batches ran since. It is the
+ * engine's own idle ceiling, derived from it so the two cannot drift apart: work another tab wrote,
+ * or a row a crashed owner's lease still holds, is discovered on that idle cadence instead of
+ * costing a storage read on every engine round.
  */
 export const AL_WORK_READINESS_MEMORY_MS = INBOX_OUTBOX_ENGINE_MAX_IDLE_MS;
 
@@ -130,12 +131,6 @@ export const AL_WORK_READINESS_MEMORY_MS = INBOX_OUTBOX_ENGINE_MAX_IDLE_MS;
  */
 export const AL_WORK_PROBE_EVERY_ROUND = 0;
 
-/** The last probe's answer; `readyAtMs` undefined is the probe reporting no work at all. */
-interface ALWorkReadinessMemory {
-    readonly readyAtMs: number | undefined;
-    readonly observedAtMs: number;
-}
-
 interface ALWorkCounts {
     claimedCount: number;
     completedCount: number;
@@ -155,22 +150,26 @@ interface ALWorkBatchProgress extends ALWorkCounts {
     releaseDurationMs: number;
 }
 
+/** A batch that flushed its releases: what it counted, and its run unless disposal cut the claims short. */
+interface ALWorkBatchEnd {
+    readonly progress: ALWorkBatchProgress;
+    readonly run: ALWorkClaimedRun | undefined;
+    readonly startedAtMs: number;
+}
+
 /** Generic ALM work loop: the port owns reservation and retry policy, this owns the engine task, the batch lifecycle, and how long a probe's answer stands. */
 export class ALWorkHandler {
     private readonly dependencies: ALWorkHandlerDependencies;
     private batch: Promise<void> | undefined;
     private bootstrapped = false;
-    private readiness: ALWorkReadinessMemory | undefined;
-    /** Bumped by every invalidation, so a probe that started before one cannot store its stale answer. */
-    private readinessGeneration = 0;
-    /** What emptied the memory the next probe replaces; `no-memory` until the first invalidation. */
-    private readinessInvalidation: ALWorkReadinessProbeCause = 'no-memory';
+    private readonly readiness: ALWorkReadinessMemory;
     /** Set when committed() lands while a batch is running; drained by one follow-up batch at that batch's end. */
     private commitPending = false;
     private readonly shutdown = new AbortController();
 
     constructor(dependencies: ALWorkHandlerDependencies) {
         this.dependencies = dependencies;
+        this.readiness = new ALWorkReadinessMemory(dependencies.readinessMemoryMs);
         dependencies.queueEngine.includeTask(dependencies.workerId, {
             name: dependencies.workerId,
             maxConcurrency: () => 1,
@@ -178,15 +177,11 @@ export class ALWorkHandler {
             runnable: () => this.runBatch().catch((error) => this.reportBatchFailure(toError(error))),
             ongoingTasks: []
         });
-        // Every writer this engine does not own announces its row with an external-write wake -- a
-        // server AppInbox transaction, a pub/sub requeue, another tab. That wake is the moment the
-        // remembered answer stopped describing storage, and it reaches every owner sharing the
-        // engine, because the writer cannot say which of them the row belongs to. Only those wakes
-        // do: the owners' own progress reaches `wake`, which reschedules and announces nothing, so
-        // one owner running a batch no longer costs every other owner its memory.
+        // Only the server announces a write this engine did not make; a row another tab or a reload
+        // wrote is found when the remembered answer reaches its age bound.
         dependencies.queueEngine.includeWakeListener(
             dependencies.workerId,
-            () => this.forgetReadiness('external-wake')
+            () => this.readiness.forget('external-wake')
         );
     }
 
@@ -213,10 +208,12 @@ export class ALWorkHandler {
     /**
      * After a commit: wakes the engine and runs one batch if idle; never blocks on delivery of
      * unrelated work. It is also the invalidation an owner owes for any write of its own rows it
-     * made outside `runBatch`.
+     * made outside `runBatch`. `writtenDueByMs` is when the last row the commit wrote becomes
+     * claimable, or undefined when the owner cannot say: only a batch that starts by then can have
+     * claimed every one of them.
      */
-    committed(): void {
-        this.forgetReadiness('own-commit');
+    committed(writtenDueByMs: number | undefined): void {
+        this.readiness.suspend(writtenDueByMs);
         this.dependencies.queueEngine.wake();
         if (this.batch === undefined) {
             void this.runBatch().catch((error) => this.reportBatchFailure(toError(error)));
@@ -238,51 +235,46 @@ export class ALWorkHandler {
 
     /**
      * Storage answers only when memory cannot. A remembered "ready at T" answers every round until T
-     * arrives without reading anything; a remembered "no work" stands until this owner commits, runs a
-     * batch, or the memory ages out.
+     * arrives without reading anything; a remembered "no work" stands until an invalidation empties it
+     * or the memory ages out.
      */
     private async readReadyAtMs(nowMs: number): Promise<number | undefined> {
-        const remembered = this.readiness;
-        if (
-            remembered !== undefined && nowMs >= remembered.observedAtMs &&
-            nowMs - remembered.observedAtMs < this.dependencies.readinessMemoryMs
-        ) {
-            return remembered.readyAtMs;
+        const { clock, diagnostics, port, readNextReadyAtMs, workerId } = this.dependencies;
+        const standing = this.readiness.getStandingAnswer(nowMs);
+        if (standing !== undefined) {
+            return standing.readyAtMs;
         }
-        const cause = remembered === undefined ? this.readinessInvalidation : 'age-bound';
-        const generation = this.readinessGeneration;
-        const probedAtMs = this.dependencies.clock.nowMs();
-        const readyAtMs = await this.dependencies.readNextReadyAtMs(this.dependencies.port);
-        if (generation === this.readinessGeneration) {
-            this.readiness = { readyAtMs, observedAtMs: nowMs };
-        }
-        this.dependencies.diagnostics?.({
+        const probedAtMs = clock.nowMs();
+        const probe = await this.readiness.readProbe(nowMs, () => readNextReadyAtMs(port));
+        diagnostics?.({
             kind: 'readiness-probe',
-            workerId: this.dependencies.workerId,
-            cause,
-            readyAtMs: readyAtMs ?? 'none',
-            durationMs: computeElapsedMs(probedAtMs, this.dependencies.clock.nowMs())
+            workerId,
+            cause: probe.cause,
+            readyAtMs: probe.readyAtMs ?? 'none',
+            durationMs: computeElapsedMs(probedAtMs, clock.nowMs())
         });
-        return readyAtMs;
+        return probe.readyAtMs;
     }
 
     /**
-     * A commit and a batch both change the rows a probe read, so the answer they invalidate is
-     * dropped. That is the rule the memory rests on: **any change to this owner's rows performed
-     * outside `runBatch` must reach this method**, or the owner keeps answering from a picture
-     * storage no longer supports. The three ways it does are `committed()`, a retained claim's
-     * settlement, and the engine wake every writer that is not this owner announces its row with.
+     * The batch's end settles the readiness memory: a commit and a batch both change the rows a probe
+     * read, so the answer is dropped unless the batch restores the one its commit set aside. The other
+     * ways a change reaches the memory are `committed()`, a retained claim's settlement, and the
+     * engine wake every writer that is not this owner announces its row with.
      */
-    private forgetReadiness(
-        cause: 'external-wake' | 'own-commit' | 'batch' | 'retained-release'
-    ): void {
-        if (this.readiness !== undefined) {
-            // The one that emptied a standing memory owns the probe that replaces it: a commit runs
-            // a batch, and that batch's own invalidation must not take the credit from the commit.
-            this.readinessInvalidation = cause;
+    private settleReadiness(ended: ALWorkBatchEnd | undefined): ALWorkReadinessAnswer | undefined {
+        if (ended?.run === undefined) {
+            return this.readiness.settle(undefined);
         }
-        this.readiness = undefined;
-        this.readinessGeneration += 1;
+        const { claimedCount, completedCount, rejectedCount } = ended.progress;
+        return this.readiness.settle({
+            claimedCount,
+            completedCount,
+            rejectedCount,
+            pageSize: this.dependencies.pageSize,
+            startedAtMs: ended.startedAtMs,
+            commitPending: this.commitPending
+        });
     }
 
     private runBatch(): Promise<void> {
@@ -292,19 +284,33 @@ export class ALWorkHandler {
         if (this.batch !== undefined) {
             return this.batch;
         }
-        this.batch = this.runSelectedWork().then((counts) => this.wakeAfterProgress(counts)).catch((error) => {
-            if (error instanceof ALAdmissionCorruptionError) {
-                throw error;
-            }
-            this.reportBatchFailure(toError(error));
-        }).finally(() => {
-            this.batch = undefined;
-            this.forgetReadiness('batch');
-            this.runPendingCommit();
-        });
+        this.batch = this.runSelectedWork()
+            .then((ended) => this.endBatch(ended))
+            .catch((error) => this.failBatch(toError(error)))
+            .finally(() => {
+                this.batch = undefined;
+                this.runPendingCommit();
+            });
         return this.batch;
     }
 
+    private endBatch(ended: ALWorkBatchEnd): void {
+        const restored = this.settleReadiness(ended);
+        if (ended.run !== undefined) {
+            const { queueEngine, workerId } = this.dependencies;
+            queueEngine.wakeAt(workerId, ended.run.selection.nextReadyAtMs ?? restored?.readyAtMs);
+        }
+        this.wakeAfterProgress(ended.progress);
+    }
+
+    private failBatch(error: Error): void {
+        this.settleReadiness(undefined);
+        if (error instanceof ALAdmissionCorruptionError) {
+            throw error;
+        }
+        this.reportBatchFailure(error);
+    }
+
     /**
      * A batch that touched work may have written more the page read before it could not see. A batch
      * that touched none advertised its own next time through `wakeAt` and must not re-enter this tick.
@@ -325,8 +331,8 @@ export class ALWorkHandler {
         void this.runBatch().catch((error) => this.reportBatchFailure(toError(error)));
     }
 
-    private async runSelectedWork(): Promise<ALWorkBatchProgress> {
-        const { clock, workerId, queueEngine } = this.dependencies;
+    private async runSelectedWork(): Promise<ALWorkBatchEnd> {
+        const { clock } = this.dependencies;
         const startedAtMs = clock.nowMs();
         const progress: ALWorkBatchProgress = {
             claimedCount: 0,
@@ -348,12 +354,10 @@ export class ALWorkHandler {
             // throws must not leave them waiting for their leases to expire.
             await this.flushReleases(releases, progress);
         }
-        if (run === undefined) {
-            return progress;
+        if (run !== undefined) {
+            this.reportBatch(run, startedAtMs, progress);
         }
-        queueEngine.wakeAt(workerId, run.selection.nextReadyAtMs);
-        this.reportBatch(run, startedAtMs, progress);
-        return progress;
+        return { progress, run, startedAtMs };
     }
 
     /**
@@ -469,7 +473,7 @@ export class ALWorkHandler {
             .finally(() => {
                 // This release lands after its batch ended, so it is the one row change no batch
                 // boundary covers: the remembered answer still describes the row as reserved.
-                this.forgetReadiness('retained-release');
+                this.readiness.forget('retained-release');
                 this.dependencies.queueEngine.wake();
             });
     }
```

- [ ] **Step 7: Pass the written-due bound from the lanes.** Apply to the two lanes:

```diff
diff --git a/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts b/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
index bf5025974..635d1efb9 100644
--- a/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
+++ b/packages/shared/alm/outbound/lane/al-outbound-store-lane.ts
@@ -142,7 +142,7 @@ export class ALOutboundStoreLane<TPrepared> {
         this.setCanonicalHandoff(result);
 
         if (hasWrittenWork(result)) {
-            this.work.committed();
+            this.work.committed(computeALOutboundWrittenDueByMs([result]));
         }
 
         return this.toStoreComputed(result.computed);
@@ -154,12 +154,12 @@ export class ALOutboundStoreLane<TPrepared> {
     ): Promise<readonly ALOutboundComputedDto<TPrepared>[]> {
         const results = await this.dispatchAdmission.commitAll(dispatches).catch((error) => {
             // A group rethrows only after every member ran, so members before the throw may have landed.
-            this.work.committed();
+            this.work.committed(undefined);
             throw error;
         });
         results.forEach((result) => this.setCanonicalHandoff(result));
         if (results.some(hasWrittenWork)) {
-            this.work.committed();
+            this.work.committed(computeALOutboundWrittenDueByMs(results));
         }
         return results.map((result) => this.toStoreComputed(result.computed));
     }
@@ -179,7 +179,7 @@ export class ALOutboundStoreLane<TPrepared> {
         const admitted = await this.repairAdmission.acceptControlMessage(msg, source);
         // A foreign control and a rejected one write nothing, so they owe no batch.
         if (admitted.kind === 'committed' || admitted.kind === 'pending-control') {
-            this.work.committed();
+            this.work.committed(undefined);
         }
         return admitted;
     }
@@ -509,6 +509,30 @@ function hasWrittenWork<TPrepared>(result: ALOutboundDispatchAdmission.Result<TP
     return result.committed || result.computed.verdict.kind === 'pending';
 }
 
+/**
+ * When the last work row these commits wrote becomes claimable, or undefined when one of them wrote
+ * work its result does not describe: a receipted send's acknowledgement timeout is due after its
+ * send, so the batch that sends it cannot have claimed it.
+ */
+function computeALOutboundWrittenDueByMs<TPrepared>(
+    results: readonly ALOutboundDispatchAdmission.Result<TPrepared>[]
+): number | undefined {
+    let writtenDueByMs = 0;
+    for (const result of results.filter(hasWrittenWork)) {
+        const effects = result.committed ? result.computed.bundle?.durableEffects : undefined;
+        if (effects === undefined) {
+            return undefined;
+        }
+        for (const { retryAtMs } of effects) {
+            if (retryAtMs === undefined) {
+                return undefined;
+            }
+            writtenDueByMs = Math.max(writtenDueByMs, retryAtMs);
+        }
+    }
+    return writtenDueByMs;
+}
+
 /** The effect kinds whose queue row expires exactly when the message it carries does. */
 function statesMessageDeadline<TPrepared>(kind: ALOutboundDurableEffect<TPrepared>['kind']): boolean {
     return kind === 'send-prepared' || kind === 'admit-message' || kind === 'dequeue-message';
diff --git a/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts b/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
index a4f924f07..12ff81e7f 100644
--- a/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
+++ b/packages/shared/alm/inbound/lane/al-inbound-store-lane.ts
@@ -184,7 +184,7 @@ export class ALInboundStoreLane {
 
     private commitWork(): void {
         this.workSelector.requestHeadRead();
-        this.work.committed();
+        this.work.committed(undefined);
     }
 
     /**
@@ -195,7 +195,7 @@ export class ALInboundStoreLane {
         this.evictWhenDue();
         const selection = await this.workSelector.selectReady(port, pageSize);
         if (this.workSelector.isHeadReadPending()) {
-            this.work.committed();
+            this.work.committed(undefined);
         }
         return selection;
     }
```

- [ ] **Step 8: Correct the engine comment** (the handler's own comment is corrected in Step 6):

```diff
diff --git a/packages/shared/services/InboxOutboxEngine.ts b/packages/shared/services/InboxOutboxEngine.ts
index 2e7d2bdc4..5cd2bcda8 100644
--- a/packages/shared/services/InboxOutboxEngine.ts
+++ b/packages/shared/services/InboxOutboxEngine.ts
@@ -125,8 +125,8 @@ export class InboxOutboxEngine {
 
     /**
      * The announcement that a writer this engine does not own put work in a queue: a server AppInbox
-     * transaction, a pub/sub requeue, another tab. Such a writer cannot say which owner the row
-     * belongs to, so every owner drops its remembered readiness and re-reads storage once.
+     * transaction or a pub/sub requeue; no browser code makes it. Such a writer cannot say which owner
+     * the row belongs to, so every owner drops its remembered readiness and re-reads storage once.
      */
     wakeAfterExternalWrite(): void {
         this.notifyWake();
```

- [ ] **Step 9: Run the focused tests.**

```sh
npx vitest run packages/tests/shared/alm/work/al-work-handler.test.ts packages/tests/shared/alm/outbound-readiness-probe-diagnostics.test.ts packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts
```

Expected: `Test Files  4 passed (4)`, `Tests  70 passed (70)`.

Measured ledger (warm durable send, window #19-#28 of the run, `readWarmOutboundSendLedger`):

|                                                                     |                                       base (P1a) |                                                                                        after Task 3 |
| ------------------------------------------------------------------- | -----------------------------------------------: | --------------------------------------------------------------------------------------------------: |
| chain transactions                                                  |                                                8 |                                                                                                   8 |
| total transactions                                                  |                                               11 |                                                       10 (the post-batch `work-page` probe is gone) |
| requests                                                            |                                               42 |                                                                                                  39 |
| `al-admission`                                                      |                                               10 |                                                                                                  10 |
| `al-work`                                                           |                                                8 |                                                                                                   7 |
| temporal parses chain / total                                       |                                           9 / 13 |                                                                                              9 / 13 |
| cold default send (`al-indexeddb-operation-counts.test.ts:215-238`) |                                          10 + 11 | 10 + 11 (unchanged: the cold send's commit finds no answer to set aside, so its batch still probes) |
| idle pin, inbound pins                                              | 4 `work-page` / 10 s; 9/11, 11/13, `al-work` 5/7 |                                                                                           unchanged |

- [ ] **Step 10: Run the wider suites the change reaches.**

```sh
npx vitest run packages/tests/shared/alm packages/tests/shared/queuebox packages/tests/shared/services packages/tests/shared-test/alm-observation-regime.test.ts
npx vitest run packages/tests/shared-test/alm-observation-regime.test.ts packages/tests/shared-web
```

Expected: `Test Files  123 passed (123)`, `Tests  1545 passed (1545)`; then `Test Files  159 passed (159)`,
`Tests  1327 passed (1327)` (the shared-web run includes the browser bundle-boundary tests).

- [ ] **Step 11: End each harness send on its batch's drain.** Apply:

```diff
diff --git a/tests/playwright/alm/harness/durable-send-harness-contract.ts b/tests/playwright/alm/harness/durable-send-harness-contract.ts
index 71fa35c4a..759b24836 100644
--- a/tests/playwright/alm/harness/durable-send-harness-contract.ts
+++ b/tests/playwright/alm/harness/durable-send-harness-contract.ts
@@ -19,17 +19,8 @@ export interface FrameLoadObservation {
     readonly frameLatenessMs: readonly number[];
 }
 
-/**
- * The causes a send's own progress gives the durable probe that follows its batch: its commit emptied
- * the owner's readiness memory (and keeps the credit over the batch that ran behind it).
- * Probes from an external wake, the age bound, a retained release or a first read are not its own.
- */
-export const DURABLE_SEND_OWN_PROBE_CAUSES: readonly ALWorkReadinessProbeCause[] = [
-    'own-commit',
-    'batch'
-];
-
-export type DurableSendProbeEnd = ALWorkReadinessProbeCause | 'timeout';
+/** How a send's wait for its own batch ended: on that batch's durable `effect-drain`, or at the bound. */
+export type DurableSendBatchEnd = 'effect-drain' | 'timeout';
 
 export interface DurableSendSample {
     /** `enqueueIfAbsent` call to the carrier's `sendPreparedMessage`. */
@@ -38,8 +29,8 @@ export interface DurableSendSample {
     readonly phaseOffsetMs: number | undefined;
     /** Frame starts between the send's start and its dispatch. */
     readonly framesStraddled: number;
-    /** The durable probe that ended the wait for the send's batch to go idle, or the bound. */
-    readonly probeEnd: DurableSendProbeEnd;
+    /** What ended the wait for the send's batch to go idle. */
+    readonly batchEnd: DurableSendBatchEnd;
     /** Every durable probe seen from the dispatch to the end of that wait. */
     readonly observedProbeCauses: readonly ALWorkReadinessProbeCause[];
 }
diff --git a/tests/playwright/alm/harness/durable-send-observation.ts b/tests/playwright/alm/harness/durable-send-observation.ts
index 3dc092b95..c199811aa 100644
--- a/tests/playwright/alm/harness/durable-send-observation.ts
+++ b/tests/playwright/alm/harness/durable-send-observation.ts
@@ -1,10 +1,7 @@
 import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
 import type { ALWorkReadinessProbeCause } from '@shared/alm/work/al-work-handler.ts';
 
-import {
-    DURABLE_SEND_OWN_PROBE_CAUSES,
-    type DurableSendProbeEnd
-} from './durable-send-harness-contract.ts';
+import type { DurableSendBatchEnd } from './durable-send-harness-contract.ts';
 import type { PacedFrameLoad } from './paced-frame-load.ts';
 
 const SETTLE_BOUND_MS = 2_000;
@@ -16,28 +13,28 @@ export class DurableSendDispatchTimeoutError extends Error {
     }
 }
 
-export interface DurableSendOwnProbe {
-    readonly endedOn: DurableSendProbeEnd;
-    readonly observedCauses: readonly ALWorkReadinessProbeCause[];
+export interface DurableSendBatchDrain {
+    readonly endedOn: DurableSendBatchEnd;
+    readonly observedProbeCauses: readonly ALWorkReadinessProbeCause[];
 }
 
 export interface DurableSendDispatch {
     readonly atMs: number;
     readonly framesStarted: number;
-    /** Armed at the dispatch, so it ends only on a send-owned probe that came after it. */
-    readonly ownProbe: Promise<DurableSendOwnProbe>;
+    /** Armed at the dispatch, so it ends on the drain of the batch that dispatched it. */
+    readonly batchDrain: Promise<DurableSendBatchDrain>;
 }
 
-interface OwnProbeWaiter {
-    readonly observedCauses: ALWorkReadinessProbeCause[];
-    readonly end: (endedOn: DurableSendProbeEnd) => void;
+interface BatchDrainWaiter {
+    readonly observedProbeCauses: ALWorkReadinessProbeCause[];
+    readonly end: (endedOn: DurableSendBatchEnd) => void;
 }
 
-/** The carrier's send calls and the durable lane's readiness probes, as the page observes them. */
+/** The carrier's send calls and the durable lane's drains and readiness probes, as the page observes them. */
 export class DurableSendObservation {
     private readonly frameLoad: PacedFrameLoad;
     private readonly dispatchWaiters = new Map<string, (dispatch: DurableSendDispatch) => void>();
-    private ownProbeWaiters: OwnProbeWaiter[] = [];
+    private batchDrainWaiters: BatchDrainWaiter[] = [];
 
     constructor(frameLoad: PacedFrameLoad) {
         this.frameLoad = frameLoad;
@@ -53,18 +50,19 @@ export class DurableSendObservation {
         resolveDispatch({
             atMs,
             framesStarted: this.frameLoad.getFramesStarted(),
-            ownProbe: this.startOwnProbeWait()
+            batchDrain: this.startBatchDrainWait()
         });
     }
 
     observeDiagnostics(event: ALOutboundRuntimeDiagnosticsEvent): void {
-        if (event.kind !== 'readiness-probe' || event.lane !== 'durable') {
-            return;
+        if (event.kind === 'readiness-probe' && event.lane === 'durable') {
+            for (const waiter of this.batchDrainWaiters) {
+                waiter.observedProbeCauses.push(event.cause);
+            }
         }
-        for (const waiter of [...this.ownProbeWaiters]) {
-            waiter.observedCauses.push(event.cause);
-            if (DURABLE_SEND_OWN_PROBE_CAUSES.includes(event.cause)) {
-                waiter.end(event.cause);
+        else if (event.kind === 'effect-drain' && event.lane === 'durable') {
+            for (const waiter of [...this.batchDrainWaiters]) {
+                waiter.end('effect-drain');
             }
         }
     }
@@ -82,16 +80,16 @@ export class DurableSendObservation {
         });
     }
 
-    private startOwnProbeWait(): Promise<DurableSendOwnProbe> {
+    private startBatchDrainWait(): Promise<DurableSendBatchDrain> {
         return new Promise((resolve) => {
-            const observedCauses: ALWorkReadinessProbeCause[] = [];
-            const end = (endedOn: DurableSendProbeEnd) => {
+            const observedProbeCauses: ALWorkReadinessProbeCause[] = [];
+            const end = (endedOn: DurableSendBatchEnd) => {
                 clearTimeout(timer);
-                this.ownProbeWaiters = this.ownProbeWaiters.filter((waiter) => waiter.end !== end);
-                resolve({ endedOn, observedCauses });
+                this.batchDrainWaiters = this.batchDrainWaiters.filter((waiter) => waiter.end !== end);
+                resolve({ endedOn, observedProbeCauses });
             };
             const timer = setTimeout(() => end('timeout'), SETTLE_BOUND_MS);
-            this.ownProbeWaiters.push({ observedCauses, end });
+            this.batchDrainWaiters.push({ observedProbeCauses, end });
         });
     }
 }
diff --git a/tests/playwright/alm/harness/create-durable-send-harness.ts b/tests/playwright/alm/harness/create-durable-send-harness.ts
index 2bb2bacf9..324e6ea0f 100644
--- a/tests/playwright/alm/harness/create-durable-send-harness.ts
+++ b/tests/playwright/alm/harness/create-durable-send-harness.ts
@@ -82,7 +82,7 @@ class PlainPageDurableSendHarness implements DurableSendHarness {
         return samples;
     }
 
-    /** One durable send, then the wait for the probe its own commit earns so the next send starts on an idle owner. */
+    /** One durable send, then the wait for its own batch's drain so the next send starts on an idle owner. */
     private async sendOnce(input: DurableSendRunInput, index: number): Promise<DurableSendSample> {
         const msg = toHarnessMessage(this.sessionId, `${input.runId}-${index}`);
         const start = await new Promise<DurableSendStart>((resolve) =>
@@ -93,13 +93,13 @@ class PlainPageDurableSendHarness implements DurableSendHarness {
         );
         const [admission, dispatch] = await Promise.all([start.admission, start.dispatch]);
         assertDurableAdmission(admission);
-        const ownProbe = await dispatch.ownProbe;
+        const batchDrain = await dispatch.batchDrain;
         return {
             sendToDispatchMs: dispatch.atMs - start.startedAtMs,
             phaseOffsetMs: start.phase.offsetMs,
             framesStraddled: dispatch.framesStarted - start.phase.framesStarted,
-            probeEnd: ownProbe.endedOn,
-            observedProbeCauses: ownProbe.observedCauses
+            batchEnd: batchDrain.endedOn,
+            observedProbeCauses: batchDrain.observedProbeCauses
         };
     }
 
diff --git a/tests/playwright/alm/durable-send-report.ts b/tests/playwright/alm/durable-send-report.ts
index dc6db72b2..293138183 100644
--- a/tests/playwright/alm/durable-send-report.ts
+++ b/tests/playwright/alm/durable-send-report.ts
@@ -20,8 +20,8 @@ export interface DurableSendRunFigures {
     readonly p50Ms: number;
     readonly p95Ms: number;
     readonly unsettledCount: number;
-    /** Ending cause of each send's wait for its batch to go idle, counted; the suite expects only send-owned causes. */
-    readonly probeCauses: Readonly<Record<string, number>>;
+    /** What ended each send's wait for its batch to go idle, counted; the suite expects only `effect-drain`. */
+    readonly batchEnds: Readonly<Record<string, number>>;
     /** Every durable probe seen during those waits, counted by cause. */
     readonly observedProbeCauses: Readonly<Record<string, number>>;
     /** Share of sends faster than one frame interval; null on an idle page. */
@@ -85,8 +85,8 @@ function toRunFigures(
     const frameIntervalMs = configuration.frameLoad?.frameIntervalMs;
     return {
         ...computeSendToDispatchPercentiles(sendToDispatchMs),
-        unsettledCount: run.samples.filter((sample) => sample.probeEnd === 'timeout').length,
-        probeCauses: computeCountByKey(run.samples.map((sample) => sample.probeEnd)),
+        unsettledCount: run.samples.filter((sample) => sample.batchEnd === 'timeout').length,
+        batchEnds: computeCountByKey(run.samples.map((sample) => sample.batchEnd)),
         observedProbeCauses: computeCountByKey(run.samples.flatMap((sample) => sample.observedProbeCauses)),
         fastModeShare: frameIntervalMs === undefined
             ? null
diff --git a/tests/playwright/alm/durable-send-plain-page.spec.ts b/tests/playwright/alm/durable-send-plain-page.spec.ts
index 60a51ba34..402beff0d 100644
--- a/tests/playwright/alm/durable-send-plain-page.spec.ts
+++ b/tests/playwright/alm/durable-send-plain-page.spec.ts
@@ -23,7 +23,6 @@ import {
     type DurableSendConfigurationFigures,
     type DurableSendMethod
 } from './durable-send-report.ts';
-import { DURABLE_SEND_OWN_PROBE_CAUSES } from './harness/durable-send-harness-contract.ts';
 import {
     DURABLE_SEND_HARNESS_SCRIPT_URL,
     profileDurableSends,
@@ -116,9 +115,9 @@ function expectProfileAttribution(
 
 function expectRunsSettled(configurations: readonly DurableSendConfigurationFigures[]): void {
     // Evidence, not a gate: the suite fails only when a run lost figures, a send started before its
-    // predecessor's own batch was idle again (a wait ends only on a probe that send earned), a wait
-    // saw a probe it did not end on, or the profile could not attribute its samples; never on a
-    // latency value.
+    // predecessor's own batch was idle again (a wait ends only on the drain of the batch that sent),
+    // a durable probe ran inside a send's batch, or the profile could not attribute its samples;
+    // never on a latency value.
     for (const configuration of configurations) {
         expect(
             configuration.runs.map((run) => [run.sendToDispatchMs.length, run.unsettledCount]),
@@ -126,14 +125,13 @@ function expectRunsSettled(configurations: readonly DurableSendConfigurationFigu
         )
             .toEqual(Array(METHOD.runCount).fill([METHOD.measuredCount, 0]));
         expect(
-            configuration.runs.flatMap((run) => Object.keys(run.probeCauses))
-                .filter((cause) => !DURABLE_SEND_OWN_PROBE_CAUSES.includes(cause as never)),
-            `${configuration.name}: every wait ended on a probe its own send earned`
-        ).toEqual([]);
+            configuration.runs.map((run) => run.batchEnds),
+            `${configuration.name}: every wait ended on its own batch's drain`
+        ).toEqual(Array(METHOD.runCount).fill({ 'effect-drain': METHOD.measuredCount }));
         expect(
             configuration.runs.map((run) => run.observedProbeCauses),
-            `${configuration.name}: each send's wait saw exactly the one probe it ended on`
-        ).toEqual(configuration.runs.map((run) => run.probeCauses));
+            `${configuration.name}: no send's wait saw a durable probe`
+        ).toEqual(Array(METHOD.runCount).fill({}));
     }
 }
```

- [ ] **Step 12: Update the probe-cause paragraph of the diagnostic contract.**

```diff
diff --git a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
index 9fdca93db..d44c40be5 100644
--- a/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
+++ b/packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md
@@ -189,7 +189,11 @@ every session the page opens. The event's `data` is the event itself:
   `batch` and `retained-release` are this owner's own progress, `external-wake`
   is the announcement another writer made to every owner on the engine,
   `age-bound` is the memory reaching `AL_WORK_READINESS_MEMORY_MS`, and
-  `no-memory` is an owner that has not probed yet. `readyAtMs` is the answer: an
+  `no-memory` is an owner that has not probed yet, or whose last probe failed.
+  The first of these since the last probe names the next one. A commit whose
+  own batch claims fewer than a page, completes every claim and starts once
+  every row the commit wrote is due restores the answer the commit set aside,
+  so a plain send reports no probe after its `effect-drain`. `readyAtMs` is the answer: an
   epoch-ms time work is next due, or `none` for no work at all. `durationMs` is
   what that read cost, and this is where it is charged: an owner whose probe
   answers "due now" holds the page for the batch that follows, which reads none
```

- [ ] **Step 13: Run the harness once** (sandbox off, foreground, 10-minute timeout).

```sh
npm run -s perf:alm:durable-send
```

Expected: `2 passed`; the artifact has, for each of the four configurations, three runs of
`[90 figures, unsettledCount 0, batchEnds {"effect-drain": 90}, observedProbeCauses {}]`. Measured at the
committed head (bd477f3f4, clean tree, load average 17.98 at start, figures are not evidence):

```text
idle               p50   3.1 ms  p95   3.6 ms
cpu-4x             p50  10.5 ms  p95  12.2 ms
frame-load         p50  11.5 ms  p95  23.5 ms  fast 0.72
cpu-4x-frame-load  p50  34.2 ms  p95  55.1 ms  fast 0.04
idle [[90,0,{"effect-drain":90},{}],[90,0,{"effect-drain":90},{}],[90,0,{"effect-drain":90},{}]]
cpu-4x [[90,0,{"effect-drain":90},{}],[90,0,{"effect-drain":90},{}],[90,0,{"effect-drain":90},{}]]
frame-load [[90,0,{"effect-drain":90},{}],[90,0,{"effect-drain":90},{}],[90,0,{"effect-drain":90},{}]]
cpu-4x-frame-load [[90,0,{"effect-drain":90},{}],[90,0,{"effect-drain":90},{}],[90,0,{"effect-drain":90},{}]]
  2 passed (33.9s)
```

- [ ] **Step 14: Constraint checks.**

```sh
npx dprint fmt <the 14 touched files>            # touched files only
npx tsc -p packages/shared/tsconfig.json --noEmit  # no output
node scripts/check-tests-typecheck.mjs
npm run check:repo-style:changed -- origin/main HEAD    # after the commit
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
(cd apps/api-v1 && deno task check)
(cd packages/shared-server && npx tsc -p tsconfig.json --noEmit)
(cd packages/shared-web && node scripts/measure-browser-bundles.mjs --check)
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
npm run -s test:unit:main                          # sandbox off, once
```

Measured:

- `tsc` shared: clean. Harness files (not in any tests project): a temporary config extending
  `packages/tests/tsconfig.json` with `include: ["tests/playwright/alm/**/*.ts"]` typechecks 12 files, 0 errors.
- `check-tests-typecheck`: `1403 test files enforced ... FAIL: new type errors in an enforced file:
  apps/rallar-black-box/vite.config.ts (1)` — environmental in the scratch tree (`@vitejs/plugin-react` is not
  installed under its `node_modules`); no touched file has an error. Expect a clean pass in a full install.
- `check:repo-style:changed`: `PASS: no new repository style findings`. (Before the module split it reported
  `file.cognitive-load 57` on the handler and `boundary.unknown` on `failBatch(error: unknown)`; both fixed.)
- coupling `--changed`: `PASS` (no candidates, classifications complete, registry current).
- `deno task check` (api-v1): exit 0. shared-server `tsc`: exit 0.
- Bundles: `browser/rallar.ts` 229.4 KiB brotli (base 229.0; budget 230, ok). Headless agent 292.926 KiB
  (base 292.497; budget 293, 0.074 KiB left — Task 4 will likely cross it; raise to 294 with the figure).
- `test:unit:main`: `Tests  1 failed | 12325 passed | 12 skipped (12338)`, `Test Files  2 failed | 1321 passed`;
  both failures are the same missing `@vitejs/plugin-react` (`rallar-black-box/control-bootstrap.test.ts`,
  `recipe-console-build-boundary.test.ts`), untouched by this task. Expect 0 failures in a full install.
- Skipped here: `test:deno`, black-box memory/Postgres/cluster/medium-scale (Task 6). The restore applies to the
  api-v1 Postgres ALM lane too (same `ALOutboundStoreLane`); external wakes there still empty the suspended answer.

- [ ] **Step 15: Commit.**

```sh
git add packages/shared/alm/work/al-work-readiness-memory.ts packages/shared/alm/work/al-work-handler.ts \
  packages/shared/services/InboxOutboxEngine.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts \
  packages/shared/alm/inbound/lane/al-inbound-store-lane.ts packages/tests/shared/alm/work/al-work-handler.test.ts \
  packages/tests/shared/alm/outbound-readiness-probe-diagnostics.test.ts \
  packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts \
  packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md \
  tests/playwright/alm/durable-send-plain-page.spec.ts tests/playwright/alm/durable-send-report.ts \
  tests/playwright/alm/harness/create-durable-send-harness.ts \
  tests/playwright/alm/harness/durable-send-harness-contract.ts \
  tests/playwright/alm/harness/durable-send-observation.ts
git commit -m "Restore the readiness answer a commit set aside after its clean batch

A commit now suspends the outbound owner's remembered readiness instead of
discarding it. The batch the commit runs restores it, with its original
age, when that batch started once every row the commit wrote was due,
claimed fewer than a page, completed every claim and saw no external
wake, retained release or later commit; the restored due time reaches
the engine through wakeAt. Every other batch drops it and the next pass
probes as before, so a receipted send, whose acknowledgement timeout is
due after its send, still probes. The probe's invalidation label is read
and cleared when a probe starts and set only by the first change since.

The warm durable send ledger loses its post-batch readiness probe: 10
transactions in all (was 11), 39 requests (42), 7 al-work operations (8);
the chain stays at 8. The ledger and the durable-send harness now end a
send on its batch's effect drain."
```

---

### Task 4: The two sweeps on the ResourceInbox limiter design (D113)

Prototyped red then green in `scratch-3` on the base `9e8b9fc07`; one commit, `09bfa3448` ("Sweep lapsed leases
once per lease on each outbound lane's clock"). Figures are stated on the base and, where Task 3 moves them, on
Task 3's result: the combined tree was built by `git cherry-pick --no-commit bd477f3f4` (Task 3) onto `09bfa3448`,
measured, and discarded. Section "Applying onto Task 3" at the end lists every hunk that lands on a file Task 3
also changed.

**Files**

- Create: `packages/shared/alm/work/al-work-lease-recovery.ts` (1-80): the lease-recovery input, the limiter pair,
  the spend, the non-spending read, the per-row deferral.
- Modify: `packages/shared/alm/work/al-work-queue-port.ts` — import `:19`; `CreateALWorkQueuePortInput.leaseRecovery`
  `:97`; `createALWorkQueuePort` `:100-118` (claim and finalize delegate); new `claimALWork` `:120-132`,
  `reserveALWorkTimeouts` `:134-152`, `finalizeExhaustedALWork` `:154-168` (replace base `:105-130`).
- Modify: `packages/shared/alm/outbound/al-outbound-work-entry.ts` — import `:15`; new `ALOutboundWorkDeferral`
  `:125-129`; `readALOutboundWorkReadyAt` doc `:131-140`, third parameter `:144`, the clamp `:153-160`.
- Modify: `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts` — import `:15-19`, `:41-42`; field `:83`;
  constructor `:93-94`; `readNextReadyAtMs` `:108`; new `readWorkDeferral` `:246-251`; `createALOutboundLaneWorkPort`
  `:453-470`.
- Modify: `packages/shared/alm/inbound/lane/al-inbound-store-lane.ts:456-458` (every-batch).
- Modify: `packages/shared/alm/outbound/README.md:606-613` (one paragraph after the queued-work terminal boundary).
- Modify: `packages/shared-test/shared/create-test-al-outbound-work-port.ts:11,27-31,45`,
  `packages/shared-test/shared/create-test-al-inbound-work-port.ts:17-21,29`.
- Test (create): `packages/tests/shared/alm/work/al-work-lease-recovery.test.ts` (1-236, lane-level, fake timers).
- Test (modify): `packages/tests/shared/alm/work/al-work-queue-port.test.ts` (import `:2`; 8 sites `leaseRecovery`;
  new describe `:285-390`), `packages/tests/shared/alm/work/al-work-handler.test.ts:610,915`,
  `packages/tests/shared/alm/outbound-runtime-test-fixture.ts:44,55-60,240,244-256`,
  `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts:20,28,75-78,142-148,224-249,724`,
  `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts:39-40,52-102,190-194`,
  `packages/tests/shared/al-outbound-durable-effects.test.ts:33,93,268,629-630`,
  `packages/tests/shared/alm/outbound-control-handoff.test.ts:32,98-99,112,145-149`,
  `packages/tests/shared/alm/outbound/al-outbound-control-handoff-two-tabs.test.ts:18,125`.

The 14 call sites that build a port: the two test ports, `outbound-runtime-test-fixture.ts:229`,
`al-indexeddb-operation-counts.test.ts:713`, `al-work-handler.test.ts:605,909` and the 8 in
`al-work-queue-port.test.ts`. `ALWorkHandler` constructions are unchanged (the handler is untouched; the gate lives in
the port, which owns reservation, `al-work-handler.ts:158`).

**Interfaces**

- Produces (`al-work-lease-recovery.ts`):
  - `interface ALWorkLeaseSweepLimiters { readonly timeout: RateLimiter; readonly finalization: RateLimiter; }`
  - `type ALWorkLeaseRecovery = Readonly<{ kind: 'every-batch'; }> | Readonly<{ kind: 'limited'; limiters: ALWorkLeaseSweepLimiters; }>`
  - `interface ALWorkLeaseSweepState { readonly isTimeoutOpen: boolean; readonly isFinalizationOpen: boolean; }`
  - `createLimitedALWorkLeaseRecovery(leaseMs: number, nowMs: number): ALWorkLeaseRecovery`
  - `spendALWorkLeaseSweep(recovery: ALWorkLeaseRecovery, sweep: 'timeout' | 'finalization', nowMs: number): boolean`
  - `computeALWorkLeaseSweepState(recovery: ALWorkLeaseRecovery, nowMs: number): ALWorkLeaseSweepState`
  - `isALWorkLeaseSweepDeferred(entry: ResourceEntry, state: ALWorkLeaseSweepState): boolean`
- Produces (`al-outbound-work-entry.ts`): `interface ALOutboundWorkDeferral { readonly dequeue: ALOutboundDequeueDeferral; readonly leaseSweeps: ALWorkLeaseSweepState; }`;
  `readALOutboundWorkReadyAt(port: ALWorkQueuePort, nowMs: number, deferral: ALOutboundWorkDeferral)` (third
  parameter was `ALOutboundDequeueDeferral`).
- Produces (`al-work-queue-port.ts`): `CreateALWorkQueuePortInput.leaseRecovery: ALWorkLeaseRecovery` (required).
- Produces (test fixture): `export const OUTBOUND_LEASE_RECOVERY_BOUND_MS = 19_100`.
- Consumes: `RateLimiter.initWithTs`, `RateLimiter.allowAt`, `RateLimiter.slidingWindow`, `RateLimiter.policy`,
  `SlidingWindowCounter.sumInWindowWithNow`, `SlidingWindowCounter.createdTs` (all public,
  `packages/shared/resilience/Resilience.ts:99-505`, unchanged); `DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts`;
  `ALOutboundMessageRuntime.Dependencies.clock`.
- Task 3 interfaces this task does not touch: `ALWorkHandler.committed(writtenDueByMs)`, `endBatch`,
  `al-work-readiness-memory.ts`. No hunk of this task lands in `al-work-handler.ts` or in a lane's `committed()` call.

**D8 reuse inspection.** `packages/shared/resilience`: the pair is two `RateLimiter`s, the exact role
`StatusChecks.lockEntryRateLimiter` plays in `create-default-resource-inbox-dequeuer.ts:186-207, 253-278`, built
with the public `initWithTs` and spent with `allowAt` on the lane clock; the clamp reads the same window with the
public `SlidingWindowCounter.sumInWindowWithNow`, which plays `isEntryRateLimiter`'s advertisement role for ALM's
own scan. `Resilience.ts` is unchanged; no `isAllowedAt` was added. Not reused: `createResourceInboxStatusChecks`
(`resource-inbox-resilience.ts:128`), because it builds an `isEntryRateLimiter` ALM would never call (the clamp
replaces it), reads `Date.now` through `RateLimiter.init`, and exporting a clock-taking variant would add a queuebox
surface for one caller; one lane function in `packages/shared/alm/work/` (two `initWithTs` lines) is the smaller
duplication, and every outbound lane (browser durable, browser volatile, api-v1's Postgres lane through
`WsQueueBoxServerService.createOutboundRuntime` -> `new ALOutboundMessageRuntime` -> `ALOutboundStoreLane`,
`ws-queue-box-server-service.ts:270-281`, `al-outbound-message-runtime.ts:419-447`) builds its pair through it, so
no server-specific code exists. Not reused: `dequeue.resilience`'s `StatusChecks` (shared by both lanes and, on the
server fallback, by AppInbox). `packages/shared/cache`: nothing applies (no keyed state; the limiter window is the
state). `RateLimiter.tryToExecuteOrDefault` is not used: it reads `Date.now` and spends before the call runs.

---

- [ ] **Step 1: Write the failing port tests.** In `packages/tests/shared/alm/work/al-work-queue-port.test.ts` add
      the import after the Temporal import:

```ts
import { createLimitedALWorkLeaseRecovery } from '@shared/alm/work/al-work-lease-recovery.ts';
```

In each of the 8 existing `createALWorkQueuePort({ ... })` calls (`:27, :58, :83, :109, :137, :182, :214, :258`
on the base) replace `random: () => 0.5` with:

```ts
random: () => 0.5,
leaseRecovery: { kind: 'every-batch' }
```

and add after the existing `describe('ALWorkQueuePort', ...)` block (before `function byEffectId`):

```ts
describe('ALWorkQueuePort lease recovery', () => {
    it('sweeps for timed-out leases on its first claim, then at most once per lease of its own clock', async () => {
        let now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createLimitedTestPort(queue, () => now);

        expect(await port.claim({ maxCount: 4, observedEntries: undefined })).toEqual([]);
        now += 5_000;
        await port.retainIfAbsent(
            newReservedWorkEntry('crashed', { startMs: now - 6_000, attempts: 1 })
        );
        expect(await port.claim({ maxCount: 4, observedEntries: undefined })).toEqual([]);
        // The limiter counts in quarter-window buckets: the first sweep closes the window for 1.25 leases.
        now = 10_000 + 6_250;
        expect(await port.claim({ maxCount: 4, observedEntries: undefined })).toEqual([]);
        now += 1;
        expect(toEffectIds(await port.claim({ maxCount: 4, observedEntries: undefined }))).toEqual([
            'crashed'
        ]);
    });

    it('spends no timeout allowance on a claim whose reservation filled the page', async () => {
        const now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createLimitedTestPort(queue, () => now);
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'fills-the-page'));
        await port.retainIfAbsent(newReservedWorkEntry('crashed', { startMs: 0, attempts: 1 }));

        expect(toEffectIds(await port.claim({ maxCount: 1, observedEntries: undefined }))).toEqual([
            'fills-the-page'
        ]);
        // Still inside the first lease: only an allowance the first claim left unspent recovers the row.
        expect(toEffectIds(await port.claim({ maxCount: 1, observedEntries: undefined }))).toEqual([
            'crashed'
        ]);
    });

    it('finalizes exhausted reservations on its first batch, then at most once per lease of its own clock', async () => {
        let now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createLimitedTestPort(queue, () => now);
        await port.retainIfAbsent(
            newReservedWorkEntry('exhausted-first', { startMs: 0, attempts: 20 })
        );

        const finalized = await port.finalizeExhausted(4);
        expect(toEffectIds(finalized)).toEqual(['exhausted-first']);
        await port.releaseAll(
            finalized.map((claim) => ({ claim, outcome: { status: 'non-retryable' } as const }))
        );
        await port.retainIfAbsent(
            newReservedWorkEntry('exhausted-second', { startMs: 0, attempts: 20 })
        );
        expect(await port.finalizeExhausted(4)).toEqual([]);
        now = 10_000 + 6_251;
        expect(toEffectIds(await port.finalizeExhausted(4))).toEqual(['exhausted-second']);
    });

    it('keeps claiming and sweeping when its clock steps back behind the limiters it built', async () => {
        let now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createLimitedTestPort(queue, () => now);
        now = 8_000;
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'after-the-step'));
        await port.retainIfAbsent(newReservedWorkEntry('crashed', { startMs: 0, attempts: 1 }));

        expect(await port.finalizeExhausted(4)).toEqual([]);
        expect(toEffectIds(await port.claim({ maxCount: 4, observedEntries: undefined }))).toEqual([
            'after-the-step',
            'crashed'
        ]);
    });

    it('sweeps on every claim and every batch when configured to', async () => {
        const now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5,
            leaseRecovery: { kind: 'every-batch' }
        });

        for (let batch = 0; batch < 3; batch += 1) {
            await port.retainIfAbsent(
                newReservedWorkEntry(`exhausted-${batch}`, { startMs: 0, attempts: 20 })
            );
            await port.retainIfAbsent(
                newReservedWorkEntry(`crashed-${batch}`, { startMs: 0, attempts: 1 })
            );
            expect(toEffectIds(await port.finalizeExhausted(4))).toEqual([`exhausted-${batch}`]);
            expect(toEffectIds(await port.claim({ maxCount: 4, observedEntries: undefined })))
                .toEqual([`crashed-${batch}`]);
        }
    });
});

function createLimitedTestPort(queue: InMemoryQueueBox, nowMs: () => number) {
    return createALWorkQueuePort({
        queue,
        workTypes: new Set(['AL_TEST']),
        leaseMs: 5_000,
        nowMs,
        random: () => 0.5,
        leaseRecovery: createLimitedALWorkLeaseRecovery(5_000, nowMs())
    });
}

/** A reservation an owner took at `startMs` and never released, as a crashed owner leaves it. */
function newReservedWorkEntry(
    effectId: string,
    input: { startMs: number; attempts: number; }
): ResourceEntry {
    const entry = newWorkEntry('AL_TEST', effectId);
    return {
        ...entry,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            ...entry.dequeueAudit,
            attempts: input.attempts,
            startTs: Temporal.Instant.fromEpochMilliseconds(input.startMs)
        }
    };
}

function toEffectIds(claims: readonly ALWorkClaim[]): string[] {
    return claims.map((claim) => claim.entry.key.contextId);
}
```

The assertions pin behaviour, not spy call counts: a first version that asserted `toHaveBeenCalledTimes` on the
queue's sweep methods was flagged by `check-test-structure-coupling.mjs --changed` (4 unclassified
`mock-invocation-count-or-order` candidates) and rewritten to this form, which passes it.

- [ ] **Step 2: Run them red.**

```sh
npx vitest run packages/tests/shared/alm/work/al-work-queue-port.test.ts
```

Expected: `Error: Cannot find package '@shared/alm/work/al-work-lease-recovery.ts'`, `Test Files 1 failed`,
`Tests no tests`. (With the module present but the port unchanged, measured: `Tests 2 failed | 10 passed (12)` —
the two "at most once per lease" cases, `expected [ { …(3) } ] to deeply equal []`; the fill-the-page, step-back
and every-batch cases pin properties of the limited implementation and pass against an unlimited port.)

- [ ] **Step 3: Write the failing lane tests and the bound constant.** In
      `packages/tests/shared/alm/outbound-runtime-test-fixture.ts`, after the last import block:

```ts
/**
 * How long after its lease end an outbound lane recovers a crashed lease or an exhausted row at worst:
 * a sweep closes its window for 1.25 leases (the limiter counts in quarter-window buckets), then the
 * remembered readiness answer ages for 3 s and the idle engine waits at most 3.6 s for its next pass.
 */
export const OUTBOUND_LEASE_RECOVERY_BOUND_MS = 19_100;
```

Create `packages/tests/shared/alm/work/al-work-lease-recovery.test.ts`:

```ts
import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { AL_OUTBOUND_WORK_LEASE_MS } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { createDefaultALOutboundDequeueResilience } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    OUTBOUND_LEASE_RECOVERY_BOUND_MS
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

const START_MS = 1_700_000_000_000;
const DEQUEUE_TYPE = 'outbox';
const MESSAGE_TTL_MS = 120_000;
const ENGINE_PASS_MS = 100;

interface LeaseRecoveryRun {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly queue: InMemoryQueueBox;
    readonly sent: string[];
    /** Every durable batch, at the lane clock when it ended. */
    readonly batchesAtMs: number[];
    readonly timeoutSweepsAtMs: number[];
    readonly finalizationSweepsAtMs: number[];
    /** Every sweep that returned a row, at the lane clock when it did. */
    readonly recoveredAtMs: number[];
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('outbound lease recovery on the lane clock', () => {
    it('sweeps both on the bootstrap batch and neither on a send inside the window', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();

        expect(run.timeoutSweepsAtMs).toEqual([START_MS]);
        expect(run.finalizationSweepsAtMs).toEqual([START_MS]);

        await vi.advanceTimersByTimeAsync(1_000);
        await run.runtime.enqueueIfAbsent(
            createOutboundMessage('inside-the-window', { ttlMs: MESSAGE_TTL_MS })
        );
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);

        expect(run.sent).toEqual(['inside-the-window']);
        expect(run.timeoutSweepsAtMs).toEqual([START_MS]);
        expect(run.finalizationSweepsAtMs).toEqual([START_MS]);
    });

    it('recovers a crashed lease within its lease end plus 19.1 s when a send spent the window just before', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        const leaseEndMs = await writeCrashedLease(run, 'crashed', 1);
        await vi.advanceTimersByTimeAsync(AL_OUTBOUND_WORK_LEASE_MS - ENGINE_PASS_MS);
        // This send's batch sweeps a moment before the lease ends, so the window stays closed past it.
        await run.runtime.enqueueIfAbsent(
            createOutboundMessage('spends-the-window', { ttlMs: MESSAGE_TTL_MS })
        );

        const recoveredAtMs = await advanceUntilRecovered(run);

        expect(run.timeoutSweepsAtMs.at(-2)).toBe(leaseEndMs - ENGINE_PASS_MS);
        expect(recoveredAtMs).toBeGreaterThan(leaseEndMs);
        expect(recoveredAtMs).toBeLessThanOrEqual(leaseEndMs + OUTBOUND_LEASE_RECOVERY_BOUND_MS);
    });

    it('finalizes an exhausted reservation within its lease end plus 19.1 s when a send spent the window just before', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        const leaseEndMs = await writeCrashedLease(run, 'exhausted', 20);
        await vi.advanceTimersByTimeAsync(AL_OUTBOUND_WORK_LEASE_MS - ENGINE_PASS_MS);
        await run.runtime.enqueueIfAbsent(
            createOutboundMessage('spends-the-window', { ttlMs: MESSAGE_TTL_MS })
        );

        const recoveredAtMs = await advanceUntilRecovered(run);

        expect(run.finalizationSweepsAtMs.at(-2)).toBe(leaseEndMs - ENGINE_PASS_MS);
        expect(recoveredAtMs).toBeGreaterThan(leaseEndMs);
        expect(recoveredAtMs).toBeLessThanOrEqual(leaseEndMs + OUTBOUND_LEASE_RECOVERY_BOUND_MS);
        expect((await run.queue.getItem(toCrashedKey('exhausted')))?.status).toBe(
            EntityStatus.NON_RETRYABLE
        );
    });

    it('runs no batch while a lease end waits for its closed window', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        const leaseEndMs = await writeCrashedLease(run, 'crashed', 1);
        await vi.advanceTimersByTimeAsync(AL_OUTBOUND_WORK_LEASE_MS - ENGINE_PASS_MS);
        await run.runtime.enqueueIfAbsent(
            createOutboundMessage('spends-the-window', { ttlMs: MESSAGE_TTL_MS })
        );
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);
        const batchesBefore = run.batchesAtMs.length;

        const recoveredAtMs = await advanceUntilRecovered(run);

        // The batch that recovers the lease is the only one the wait owed.
        expect(run.batchesAtMs.filter((atMs) => atMs > leaseEndMs && atMs < recoveredAtMs)).toEqual(
            []
        );
        expect(run.batchesAtMs.length - batchesBefore).toBeLessThanOrEqual(2);
    });

    it('recovers a crashed lease the readiness scan cannot see behind a full page of live leases', async () => {
        const run = createLeaseRecoveryRun();
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        await writeCrashedLease(run, 'z-crashed', 1, Date.now() - AL_OUTBOUND_WORK_LEASE_MS - 1);
        for (let index = 0; index < 16; index += 1) {
            await writeCrashedLease(run, `a-live-${String(index).padStart(2, '0')}`, 1);
        }

        // The scan reads 16 reserved rows and the sweep 64: a send's batch reaches past the live page.
        await run.runtime.enqueueIfAbsent(
            createOutboundMessage('reaches-past-the-page', { ttlMs: MESSAGE_TTL_MS })
        );
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);

        expect(run.recoveredAtMs).toEqual([START_MS + 13_000]);
        expect((await run.queue.getItem(toCrashedKey('z-crashed')))?.dequeueAudit.attempts).toBe(2);
    });

    it('spends the volatile lane\'s own window, never the durable lane\'s', async () => {
        const run = createLeaseRecoveryRun({ withVolatileLane: true });
        await run.runtime.ready();
        await vi.advanceTimersByTimeAsync(13_000);
        await run.runtime.enqueueIfAbsent(
            createOutboundMessage('volatile-first', { ttlMs: MESSAGE_TTL_MS })
        );
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);
        const durableSweepsBefore = run.timeoutSweepsAtMs.length;

        await run.runtime.enqueueIfAbsent(
            createOutboundMessage('durable-after', { ttlMs: MESSAGE_TTL_MS })
        );
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);

        expect(run.sent).toEqual(['volatile-first', 'durable-after']);
        expect(run.timeoutSweepsAtMs.length - durableSweepsBefore).toBe(1);
    });
});

function createLeaseRecoveryRun(options: { withVolatileLane?: boolean; } = {}): LeaseRecoveryRun {
    vi.useFakeTimers({ now: START_MS });
    // The engine's idle jitter at its widest, so the bound is measured at its worst.
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const queue = new InMemoryQueueBox(
        undefined,
        () => Temporal.Instant.fromEpochMilliseconds(Date.now())
    );
    const sent: string[] = [];
    const batchesAtMs: number[] = [];
    const sweeps = recordLeaseSweeps(queue);
    const runtime = createDefaultOutboundTestRuntime({
        outbox: queue,
        stores: createDefaultOutboundTestStores(queue),
        volatileStores: options.withVolatileLane === true
            ? createVolatileALOutboundRuntimeStores(
                { decodePrepared: decodeOutboundTestPayload },
                undefined
            )
            : undefined,
        dequeue: {
            types: new Set([DEQUEUE_TYPE]),
            resilience: createDefaultALOutboundDequeueResilience()
        },
        diagnostics: (event) => {
            if (event.kind === 'effect-drain' && event.lane === 'durable') {
                batchesAtMs.push(Date.now());
            }
        },
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: msg.route.resourceId !== 'volatile-first',
            preparedMessages: [{ peer: 'receiver' }]
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage.route.resourceId);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return { runtime, queue, sent, batchesAtMs, ...sweeps };
}

function recordLeaseSweeps(
    queue: InMemoryQueueBox
): Pick<LeaseRecoveryRun, 'timeoutSweepsAtMs' | 'finalizationSweepsAtMs' | 'recoveredAtMs'> {
    const recorded = {
        timeoutSweepsAtMs: [] as number[],
        finalizationSweepsAtMs: [] as number[],
        recoveredAtMs: [] as number[]
    };
    const reserveTimeouts = queue.reserveTimeoutEntries.bind(queue);
    vi.spyOn(queue, 'reserveTimeoutEntries').mockImplementation(async (request) => {
        recorded.timeoutSweepsAtMs.push(Date.now());
        const reserved = await reserveTimeouts(request);
        if (reserved.size > 0) {
            recorded.recoveredAtMs.push(Date.now());
        }
        return reserved;
    });
    const reserveFinalizations = queue.reserveRetryExhaustionFinalizations.bind(queue);
    vi.spyOn(queue, 'reserveRetryExhaustionFinalizations').mockImplementation(
        async (types, input) => {
            recorded.finalizationSweepsAtMs.push(Date.now());
            const reserved = await reserveFinalizations(types, input);
            if (reserved.size > 0) {
                recorded.recoveredAtMs.push(Date.now());
            }
            return reserved;
        }
    );
    return recorded;
}

/** A dequeue row an owner reserved at `startMs` and never released, as a crashed owner leaves it; returns its lease end. */
async function writeCrashedLease(
    run: LeaseRecoveryRun,
    resourceId: string,
    attempts: number,
    startMs = Date.now()
): Promise<number> {
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(
        createOutboundMessage(resourceId, { ttlMs: MESSAGE_TTL_MS }),
        DEQUEUE_TYPE
    );
    await run.queue.enqueueIfAbsent(toReservedEntry(entry, startMs, attempts));
    return startMs + AL_OUTBOUND_WORK_LEASE_MS;
}

function toReservedEntry(entry: ResourceEntry, startMs: number, attempts: number): ResourceEntry {
    return {
        ...entry,
        status: EntityStatus.RESERVED,
        dequeueAudit: {
            ...entry.dequeueAudit,
            attempts,
            startTs: Temporal.Instant.fromEpochMilliseconds(startMs)
        }
    };
}

function toCrashedKey(resourceId: string) {
    return createOutboundMessage(resourceId).route;
}

async function advanceUntilRecovered(run: LeaseRecoveryRun): Promise<number> {
    const recoveredBefore = run.recoveredAtMs.length;
    for (let elapsedMs = 0; elapsedMs < 60_000; elapsedMs += ENGINE_PASS_MS) {
        await vi.advanceTimersByTimeAsync(ENGINE_PASS_MS);
        if (run.recoveredAtMs.length > recoveredBefore) {
            return run.recoveredAtMs[recoveredBefore];
        }
    }
    throw new Error('Expected the lease to be recovered within a minute');
}
```

How the fake clock reaches every party: `vi.useFakeTimers({ now: START_MS })` fakes `Date.now`, which is the
runtime's default lane clock (`createOutboundTestRuntimeFor` passes `options.nowMs ?? Date.now`), the admission
stores' clock (`createDefaultOutboundTestStores`) and the engine's scheduler; the queue's clock is passed
explicitly. The runtime owns and starts its engine on `ready()`, so the bound includes the real engine cadence
(idle backoff to 3 s, jitter at +20 % through `Math.random = 1`). The crashed rows are foreign `outbox` dequeue rows
written RESERVED directly, so the recovering claim needs no admission record.

- [ ] **Step 4: Run them red.**

```sh
npx vitest run packages/tests/shared/alm/work/al-work-lease-recovery.test.ts
```

Expected on the base production code (measured with the base `al-work-queue-port.ts`, `alm/outbound` and
`alm/inbound`): `Tests 4 failed | 2 passed (6)` —
`sweeps both on the bootstrap batch …` (`expected [ 1700000000000, 1700000001000 ] to deeply equal [ 1700000000000 ]`:
the send's batch sweeps), the crashed-lease and exhausted-row bounds (`expected 1700000023000 to be 1700000022900`:
every batch sweeps, so the last-but-one sweep is not the send's), and `runs no batch while …`
(`expected 1700000023000 to be greater than 1700000023000`: recovered at the lease end itself). The full-page and
volatile cases pass on the base. Step 6 shows the red the clamp owes.

- [ ] **Step 5: Implement the pair, the gated port and the lane's own pair (no clamp yet).** Create
      `packages/shared/alm/work/al-work-lease-recovery.ts` whole (Step 7 only wires its `computeALWorkLeaseSweepState`
      and `isALWorkLeaseSweepDeferred` into the scan and the lane):

```ts
import { EntityStatus, type ResourceEntry } from '../../queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '../../queuebox/ResourceInboxRetryPolicy.ts';
import { RateLimiter, SlidingWindowCounter } from '../../resilience/Resilience.ts';

/**
 * One lock limiter per lease sweep, in the role `lockEntryRateLimiter` plays in the ResourceInbox
 * dequeuer, counted on the work owner's clock rather than `Date.now`.
 */
export interface ALWorkLeaseSweepLimiters {
    readonly timeout: RateLimiter;
    readonly finalization: RateLimiter;
}

/** How often a work owner sweeps for reservations whose lease ended without a release. */
export type ALWorkLeaseRecovery =
    | Readonly<{ kind: 'every-batch'; }>
    | Readonly<{ kind: 'limited'; limiters: ALWorkLeaseSweepLimiters; }>;

/** Which sweeps may read now, taken without spending an allowance. */
export interface ALWorkLeaseSweepState {
    readonly isTimeoutOpen: boolean;
    readonly isFinalizationOpen: boolean;
}

/** One sweep of each kind per lease. A fresh pair holds both allowances, so the owner's first batch sweeps. */
export function createLimitedALWorkLeaseRecovery(
    leaseMs: number,
    nowMs: number
): ALWorkLeaseRecovery {
    return {
        kind: 'limited',
        limiters: {
            timeout: RateLimiter.initWithTs(leaseMs, 1, nowMs),
            finalization: RateLimiter.initWithTs(leaseMs, 1, nowMs)
        }
    };
}

/** Spends the sweep's allowance; false means the sweep must not read. Call it only when the sweep would read. */
export function spendALWorkLeaseSweep(
    recovery: ALWorkLeaseRecovery,
    sweep: 'timeout' | 'finalization',
    nowMs: number
): boolean {
    if (recovery.kind === 'every-batch') {
        return true;
    }
    const limiter = recovery.limiters[sweep];
    return limiter.allowAt(toLimiterNowMs(limiter, nowMs));
}

export function computeALWorkLeaseSweepState(
    recovery: ALWorkLeaseRecovery,
    nowMs: number
): ALWorkLeaseSweepState {
    if (recovery.kind === 'every-batch') {
        return { isTimeoutOpen: true, isFinalizationOpen: true };
    }
    return {
        isTimeoutOpen: isLeaseSweepOpen(recovery.limiters.timeout, nowMs),
        isFinalizationOpen: isLeaseSweepOpen(recovery.limiters.finalization, nowMs)
    };
}

/**
 * A reserved row waits for the sweep that recovers it: the finalization sweep once the row has spent
 * the retry policy's attempts, the timeout sweep before that.
 */
export function isALWorkLeaseSweepDeferred(
    entry: ResourceEntry,
    state: ALWorkLeaseSweepState
): boolean {
    if (entry.status !== EntityStatus.RESERVED) {
        return false;
    }
    return entry.dequeueAudit.attempts >= DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        ? !state.isFinalizationOpen
        : !state.isTimeoutOpen;
}

function isLeaseSweepOpen(limiter: RateLimiter, nowMs: number): boolean {
    return SlidingWindowCounter.sumInWindowWithNow(
        limiter.slidingWindow,
        toLimiterNowMs(limiter, nowMs)
    ) <
        limiter.policy.maxNumberToAllow;
}

/** The limiter finds no bucket for a time before its creation, so a clock stepped back reads as its creation. */
function toLimiterNowMs(limiter: RateLimiter, nowMs: number): number {
    return Math.max(nowMs, limiter.slidingWindow.createdTs);
}
```

(`toLimiterNowMs` exists because `SlidingWindowCounter.updateWithNow` throws `Error: No bucket found` for a time
before the window's creation — measured: `RateLimiter.initWithTs(10_000, 1, 1_000_000).allowAt(999_000)` throws.
Without it a lane clock stepped back behind the lane's construction fails every batch's claim until the clock
catches up; the step-back port test of Step 1 pins it, red `Error: No bucket found` before the helper.)

In `packages/shared/alm/work/al-work-queue-port.ts` add the import after `toError`:

```ts
import { spendALWorkLeaseSweep, type ALWorkLeaseRecovery } from './al-work-lease-recovery.ts';
```

add the required field to `CreateALWorkQueuePortInput` (after `random`):

```ts
readonly leaseRecovery: ALWorkLeaseRecovery;
```

and replace `createALWorkQueuePort` (base `:98-141`) with:

```ts
export function createALWorkQueuePort(input: CreateALWorkQueuePortInput): ALWorkQueuePort {
    const { queue, workTypes } = input;
    return {
        retainIfAbsent: (entry) => queue.enqueueIfAbsent(entry),
        readPage: (pageInput) => readMergedALWorkPage(queue, workTypes, pageInput),
        readPages: (scanInputs) => readMergedALWorkPageScans(queue, workTypes, scanInputs),
        claim: (claimInput) => claimALWork(input, claimInput),
        finalizeExhausted: (maxCount) => finalizeExhaustedALWork(input, maxCount),
        releaseAll: (releases) =>
            releaseALWorkClaims(
                queue,
                releases.map((release) => ({
                    entry: release.claim.entry,
                    disposition: toReleaseDisposition(release.outcome, release.claim, input)
                }))
            ),
        readEntry: (key) => queue.getItem(key)
    };
}

async function claimALWork(
    input: CreateALWorkQueuePortInput,
    { maxCount, observedEntries }: ClaimALWorkInput
): Promise<readonly ALWorkClaim[]> {
    const pending = await input.queue.reserveEntries({
        typeIds: new Set(input.workTypes),
        statusIds: new Set(NEW_AND_RETRY_STATUSES),
        reservationInput: {
            maxToReserve: maxCount,
            maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        },
        observedEntries
    });
    const recovered = await reserveALWorkTimeouts(input, maxCount - pending.size, observedEntries);
    return [...pending.values(), ...recovered.values()].map((entry) =>
        toALWorkClaim(entry, input.leaseMs)
    );
}

/** The lease-timeout sweep reads only for the room the claim left, and only while its allowance holds. */
async function reserveALWorkTimeouts(
    input: CreateALWorkQueuePortInput,
    maxToRecover: number,
    observedEntries: ClaimALWorkInput['observedEntries']
): Promise<Map<Key, ResourceEntry>> {
    if (
        maxToRecover <= 0 || observedEntries?.length === 0 ||
        !spendALWorkLeaseSweep(input.leaseRecovery, 'timeout', input.nowMs())
    ) {
        return new Map();
    }
    return await input.queue.reserveTimeoutEntries({
        typeIds: new Set(input.workTypes),
        reservationInput: {
            maxToReserve: maxToRecover,
            maxAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts
        },
        timeSinceStartTs: Temporal.Duration.from({ milliseconds: input.leaseMs }),
        observedEntries
    });
}

async function finalizeExhaustedALWork(
    input: CreateALWorkQueuePortInput,
    maxCount: number
): Promise<readonly ALWorkClaim[]> {
    const { queue, workTypes, leaseMs } = input;
    if (
        maxCount === 0 || !spendALWorkLeaseSweep(input.leaseRecovery, 'finalization', input.nowMs())
    ) {
        return [];
    }
    const reserved = await queue.reserveRetryExhaustionFinalizations(new Set(workTypes), {
        processingAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts,
        maxToReserve: maxCount,
        staleAfterMs: leaseMs
    });
    return [...reserved.values()].map(({ entry }) => toALWorkClaim(entry, leaseMs));
}
```

(The two skip conditions mirror the queue's own early returns, `indexed-db-queue-box.ts:361-363, 473-475`: the
allowance is spent only when the sweep would read.)

In `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts` import the pair (after the `al-work-handler.ts`
import):

```ts
import {
    computeALWorkLeaseSweepState,
    createLimitedALWorkLeaseRecovery,
    type ALWorkLeaseRecovery
} from '../../work/al-work-lease-recovery.ts';
```

add the field after `private readonly work: ALWorkHandler;`:

```ts
private readonly leaseRecovery: ALWorkLeaseRecovery;
```

replace `const workPort = createALOutboundLaneWorkPort(input);` in the constructor with:

```ts
this.leaseRecovery = createLimitedALWorkLeaseRecovery(
    AL_OUTBOUND_WORK_LEASE_MS,
    runtime.clock.nowMs()
);
const workPort = createALOutboundLaneWorkPort(input, this.leaseRecovery);
```

and replace `createALOutboundLaneWorkPort` (base `:438-448`) with:

```ts
/**
 * The lane's own work types, plus the foreign dequeue rows only the durable lane admits. Each lane sweeps
 * on its own limiters, so the volatile lane never spends the durable lane's allowance.
 */
function createALOutboundLaneWorkPort<TPrepared>(
    input: ALOutboundStoreLane.Input<TPrepared>,
    leaseRecovery: ALWorkLeaseRecovery
): ALWorkQueuePort {
    const { stores, runtime } = input;
    return createALWorkQueuePort({
        queue: stores.workQueue,
        workTypes: new Set([
            toALOutboundWorkType(stores.admissionStore.namespace),
            ...input.dequeueTypes
        ]),
        leaseMs: AL_OUTBOUND_WORK_LEASE_MS,
        nowMs: () => runtime.clock.nowMs(),
        random: runtime.random,
        leaseRecovery
    });
}
```

In `packages/shared/alm/inbound/lane/al-inbound-store-lane.ts` (`createALInboundLaneWorkPort`, base `:450-458`)
replace `random: dependencies.random` with:

```ts
random: dependencies.random,
// The rotation's probe has no lease clamp: a limited sweep would run empty batches until it reopened.
leaseRecovery: { kind: 'every-batch' }
```

Test ports. `packages/shared-test/shared/create-test-al-outbound-work-port.ts`: import
`import { createLimitedALWorkLeaseRecovery } from '@shared/alm/work/al-work-lease-recovery.ts';`, doc line
"with the lease, work types, lease-sweep limiters and deterministic jitter the runtime composes", and
`random: () => 0.5,` + `leaseRecovery: createLimitedALWorkLeaseRecovery(AL_OUTBOUND_WORK_LEASE_MS, input.nowMs())`.
`packages/shared-test/shared/create-test-al-inbound-work-port.ts`: doc line "with the lease, work type, lease
recovery and deterministic jitter the runtime composes", and `random: () => 0.5,` +
`leaseRecovery: { kind: 'every-batch' }`.
`packages/tests/shared/alm/outbound-runtime-test-fixture.ts` (`createOutboundWorkPort`): import
`createLimitedALWorkLeaseRecovery` and `random: Math.random,` +
`leaseRecovery: createLimitedALWorkLeaseRecovery(AL_OUTBOUND_WORK_LEASE_MS, Date.now())` (each call builds a fresh
port, so each holds its allowance, as the base port swept every call).
`packages/tests/shared/alm/work/al-work-handler.test.ts` `:605` and `:909` (base): `random: () => 0.5,` +
`leaseRecovery: { kind: 'every-batch' }` (the bare-handler cases pin the handler, not the cadence).
`packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` (`createOutboundWorkPort`, base `:700`): import
`createLimitedALWorkLeaseRecovery` and `random: () => 0.5,` +
`leaseRecovery: createLimitedALWorkLeaseRecovery(AL_OUTBOUND_WORK_LEASE_MS, NOW_MS)` (it stands for the outbound
lane's port; its idle pin runs no batch after the bootstrap, so the pin is unchanged).

- [ ] **Step 6: Run the port and lane tests; the loop test is red without the clamp.**

```sh
npx vitest run packages/tests/shared/alm/work
```

Expected (measured): port tests 12/12 green (13 with the step-back case); lane tests
`5 passed`, `runs no batch while a lease end waits for its closed window` red:
`AssertionError: expected [ 1700000023001, …(12399) ] to deeply equal []` — 12,400 empty durable batches between
the lease end and the recovery. The loop is not "every 100 ms" (survey §B(1) 1, proposal §11.C): the probe answers
the past lease end, `wakeAt` re-arms the engine at delay 0 (`InboxOutboxEngine.ts:94`, `scheduleEngine` takes the
minimum of the 100 ms delay and the readiness entry), so the engine spins one empty batch per scheduler tick for the
whole 12.4 s the window stays closed.

- [ ] **Step 7: Implement the clamp.** In `packages/shared/alm/outbound/al-outbound-work-entry.ts` add the import:

```ts
import {
    isALWorkLeaseSweepDeferred,
    type ALWorkLeaseSweepState
} from '../work/al-work-lease-recovery.ts';
```

add after `ALOutboundDequeueDeferral`:

```ts
/** What the lane's gates hold back from the readiness scan: an open dequeue circuit and a closed lease sweep. */
export interface ALOutboundWorkDeferral {
    readonly dequeue: ALOutboundDequeueDeferral;
    readonly leaseSweeps: ALWorkLeaseSweepState;
}
```

and replace the doc and head of `readALOutboundWorkReadyAt` and its row filter (base `:124-149`) with:

```ts
/**
 * Retained work is due now, retried work at its own `nextTs`, gated dequeue work no earlier than the
 * breaker allows, and an expired row is never advertised. A reserved row is advertised at its lease end
 * only while the sweep that recovers it may run: a closed sweep would leave every batch it started empty.
 * A page that held more rows than it returned and holds a due row answers `nowMs`: one status never
 * hides the next. A truncated page whose visible rows are all expired or gated answers from those rows
 * alone, so a full page of expired rows advertises nothing and leaves the remainder to the queue's own
 * expiry cleanup. Every status is read in one scan, so the probe the engine runs on each round costs one
 * round trip to storage.
 */
export async function readALOutboundWorkReadyAt(
    port: ALWorkQueuePort,
    nowMs: number,
    deferral: ALOutboundWorkDeferral
): Promise<number | undefined> {
    const scans = await port.readPages(
        AL_OUTBOUND_SCAN_STATUSES.map((status) => ({
            status,
            maxToRead: AL_OUTBOUND_WORK_PAGE_SIZE
        }))
    );
    let readyAtMs: number | undefined;
    for (const scan of scans) {
        let hasDueEntry = false;
        for (const entry of scan.entries) {
            if (
                entry.audit.expiryTs.epochMilliseconds <= nowMs ||
                isALWorkLeaseSweepDeferred(entry, deferral.leaseSweeps)
            ) {
                continue;
            }
            const candidateAtMs = computeALOutboundEntryReadyAt(entry, deferral.dequeue);
            hasDueEntry ||= candidateAtMs <= nowMs;
            readyAtMs = Math.min(readyAtMs ?? candidateAtMs, candidateAtMs);
        }
        if (hasDueEntry && scan.hasMoreEntries) {
            return nowMs;
        }
    }
    return readyAtMs;
}
```

In `al-outbound-store-lane.ts` extend the scan import with `type ALOutboundWorkDeferral`, replace
`this.readDequeueDeferral()` in `readNextReadyAtMs` with `this.readWorkDeferral()`, and add beside
`readDequeueDeferral` (the circuit-open deferral):

```ts
private readWorkDeferral(): ALOutboundWorkDeferral {
    return {
        dequeue: this.readDequeueDeferral(),
        leaseSweeps: computeALWorkLeaseSweepState(this.leaseRecovery, this.readNowMs())
    };
}
```

The scan's three test callers take the new shape: `al-indexeddb-operation-counts.test.ts`

```ts
const NO_DEFERRAL: ALOutboundWorkDeferral = {
    dequeue: { types: new Set<string>(), readyAtMs: undefined },
    leaseSweeps: { isTimeoutOpen: true, isFinalizationOpen: true }
};
```

(type import `ALOutboundWorkDeferral` in place of `ALOutboundDequeueDeferral`) and its gated-dequeue case

```ts
expect(
    await readALOutboundWorkReadyAt(port, NOW_MS, {
        ...NO_DEFERRAL,
        dequeue: { types: new Set(WORK_TYPES), readyAtMs: NOW_MS + 60_000 }
    })
)
    .toBe(NOW_MS + 60_000);
```

and the fixture's `peekOutboundWorkReadyAt` (doc: "The readiness the outbound owner advertises with every gate
open: undefined once work is drained.") passes

```ts
{
    dequeue: { types: new Set<string>(), readyAtMs: undefined },
    leaseSweeps: { isTimeoutOpen: true, isFinalizationOpen: true }
}
```

- [ ] **Step 8: Run green, and record the bound.**

```sh
npx vitest run packages/tests/shared/alm/work
```

Expected: `Tests 43 passed (43)` (port 13, lane 6, handler 24; measured). Measured with the lane clock, `Math.random = 1`:
the crashed lease and the exhausted row are both recovered **14.42 s after the lease end** (the send's sweep at
lease end − 0.1 s; the window reopens 12.4 s after the lease end; the remembered answer and one idle pass add
2.02 s), inside the 19.1 s bound; no durable batch runs between the lease end and the recovery, and the wait
costs 2 batches in all (the recovering batch and its follow-up), against 12,400 without the clamp.

- [ ] **Step 9: Repin the recovery-timing tests the bound moved and the races the shorter batch exposed.** These
      tests were red after Step 5 (measured):
      `al-outbound-durable-effects.test.ts` `recovers a retained send when its claim release fails after native
  settlement` (`expected [ Array(1) ] to deeply equal [ …(2) ]`, `:93`), `replays a sent effect when the claim
  release fails after transport send` (`:268`), `retains a control admission conflict as replayable work without an
  inner retry` (`expected [] to deeply equal [ 'admit-control' ]`, `:645`); `outbound-control-handoff.test.ts`
      `converges two runtime handoffs …` (`expected 1 to be +0`, `:108`) and `does not duplicate a 'RESERVED' | 'RETRY' |
  'COMPLETED' control handoff owner` (`IndexedDbQueueWriteConflictError`, `:144`);
      `al-outbound-control-handoff-two-tabs.test.ts` `retries a control the closed tab never finished sending only once
  that tab lease lapses` (`expected [ Array(1) ] to deeply equal [ { tab: 'first', …(1) }, …(1) ]`, `:128`).
      The first two and the two-tab case pinned recovery at the lease end; D113 moves it to at most lease end + 19.1 s.
      The other three raced the commit's own batch against the test's next read or claim and won only because the batch
      spent two extra transactions on sweeps first; holding the batch's claims states the ordering they meant.

  `al-outbound-durable-effects.test.ts`: import `OUTBOUND_LEASE_RECOVERY_BOUND_MS` from the fixture, then

```ts
await vi.advanceTimersByTimeAsync(retryAt - Date.now() + OUTBOUND_LEASE_RECOVERY_BOUND_MS);
```

(was `retryAt - Date.now()`, `:92`),

```ts
await vi.advanceTimersByTimeAsync(1 + OUTBOUND_LEASE_RECOVERY_BOUND_MS);
```

(was `advanceTimersByTimeAsync(1)`, `:267`; the `retryAt - 1` check before it still shows no early resend), and
after the `write` spy in the control-conflict case (`:628`):

```ts
// The retained row's own batch must not claim it before the read below sees it.
holdOutboundClaims(stores);
```

`outbound-control-handoff.test.ts`: import `holdOutboundClaims`; in `converges two runtime handoffs …` after the two
runtimes:

```ts
// The commits' own batches claim nothing, so the counts below are the hand-off's alone.
const heldClaims = [holdOutboundClaims(firstStores), holdOutboundClaims(secondStores)];
```

and after `expect(browserLocks.requestCount()).toBe(0);`:

```ts
await Promise.all(heldClaims.map((held) => held.release()));
```

in the `it.each` case after `const runtime = createControlRuntime(stores);`:

```ts
// The pending row's own batch must not race the claim this case makes in its place.
const heldClaims = holdOutboundClaims(stores);
```

and after `expect((await runtime.enqueueIfAbsent(message)).verdict.kind).toBe('pending');`:

```ts
await heldClaims.release();
```

`al-outbound-control-handoff-two-tabs.test.ts`: import `OUTBOUND_LEASE_RECOVERY_BOUND_MS`, and

```ts
session.advanceMs(AL_OUTBOUND_WORK_LEASE_MS + OUTBOUND_LEASE_RECOVERY_BOUND_MS);
```

(was `AL_OUTBOUND_WORK_LEASE_MS + 1`).

```sh
npx vitest run packages/tests/shared/al-outbound-durable-effects.test.ts packages/tests/shared/alm/outbound-control-handoff.test.ts packages/tests/shared/alm/outbound/al-outbound-control-handoff-two-tabs.test.ts
```

Expected: all pass (measured green 5 runs in a row with the lane and ledger files: `Tests 38 passed (38)` each).

- [ ] **Step 10: Lower the ledger pins on a lane-controlled clock (red, then green).** In
      `packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts` give the fixture a standing lane clock — this
      is how the ledger drives the limiter deterministically: `readWarmOutboundSendLedger` reads `Date.now()` once before
      it builds the runtime and passes `nowMs: () => laneNowMs` (the fixture's `nowMs` option, which becomes the lane
      clock `runtime.clock`). The lane builds its pair at that instant, the bootstrap batch spends both allowances at
      it, and every later batch reads the same instant, so both windows stay closed for the run however long it takes
      (a `Date.now` clock is deterministic only while the run stays under 12.5 s). The stores keep `Date.now`, so queue
      deadlines and lease stamps are unchanged.

```ts
// The lane clock stands still: the sweep windows the bootstrap batch spent stay closed however long the run takes.
const laneNowMs = Date.now();
const runtime = createDefaultOutboundTestRuntime({
    stores: createIndexedDbOutboundTestStores({ observer: recorded.observer, namespace: OUTBOUND_NAMESPACE }),
    nowMs: () => laneNowMs,
```

Run red with the old pins:

```sh
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
```

Expected: `Tests 2 failed | 2 passed (4)`; `expected 6 to be 8` (chain) and
`expected { instant: 2, plainTime: 1, … } to deeply equal { instant: 5, plainTime: 2, … }` (parses). The table
shows the bootstrap's three probes (`#5` finalize, `#6` empty reserve, `#7` timeout) and no sweep in the warm-up
or the pinned send. Then add the reason and lower the pins (base result; see "Applying onto Task 3" for the
version that lands on Task 3's ledger):

```ts
const LANE_CLOCK_REASON =
    'no lease sweep: the bootstrap batch spent both sweeps\' allowances, and the lane clock ' +
    'stands still for the run, so their windows stay closed';
```

```ts
    it('reaches the carrier in 6 transactions and the idle owner in 9', async () => {
        ...
        expect(
            chain.transactions,
            'enqueue to carrier: the decision read, the fence snapshot and the commit; then the batch\'s ' +
                'claim read, claim write and guard read; ' + LANE_CLOCK_REASON + '; ' +
                SINGLE_SEND_OBSERVATION_REASON + '; ' + CANONICAL_HANDOFF_REASON + '; ' +
                SEND_GUARDS_SESSION_REASON + table
        ).toBe(6);
        expect(
            total.transactions,
            'the chain\'s 6, then the release read, the release write and the readiness probe the ' +
                'batch\'s end owes' + table
        ).toBe(9);
        expect(
            total.requests,
            'every get, getAll and put those 9 transactions issue; the guard read issues its 2 gets ' +
                'in one session' + table
        ).toBe(40);
        ...
        expect(
            total.byOwner['al-work'],
            '3 decision work reads, the reservation, the release and the readiness page; ' +
                LANE_CLOCK_REASON + '; ' + CANONICAL_HANDOFF_REASON + table
        ).toBe(6);
    });

    it('parses 4 timestamps up to the carrier and 8 up to the idle owner', async () => {
        ...
        expect(
            computeIndexedDbLedgerTotals(ledger, ['chain']).temporalParses,
            'the claim read decodes the work row (4); ' + LANE_CLOCK_REASON + '; ' + WORK_ROW_PARSES + table
        ).toEqual({ instant: 2, plainTime: 1, plainDateTime: 1 });
        expect(
            computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']).temporalParses,
            'the chain\'s 4, then the release read decodes the work row (4); the release write and ' +
                'the readiness probe parse nothing' + table
        ).toEqual({ instant: 4, plainTime: 2, plainDateTime: 2 });
    });
```

(`...` = the unchanged `ledger`/`chain`/`total`/`table` lines, the `droppedRequests` pin and the `al-admission`
pin of 10.) The inbound cases are untouched.

```sh
npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts
```

Expected: `Tests 4 passed (4)` (both inbound cases unchanged: chain 9/11, total 11/13, al-work 5/7).

- [ ] **Step 11: Set the cold pin by measurement.** In `al-indexeddb-operation-counts.test.ts`
      (`outbound default send IndexedDB volume`) the send's lane clock also stands still, then the pin falls 11 -> 9
      (measured `byKind`: `work-probe 3` — the bootstrap's finalize sweep, empty reserve and timeout sweep — `work-read 3`,
      `work-reserve 1`, `work-release 1`, `work-page 1`; base 11 = these + the send batch's two sweeps):

```ts
it('sends one durable message in 10 al-admission and 9 al-work operations', async () => {
    const observer = createCountingIndexedDbOperationObserver();
    // The lane clock stands still, so the send's batch finds the sweep windows the bootstrap spent still closed.
    const laneNowMs = Date.now();
    const runtime = createDefaultOutboundTestRuntime({
        stores: createIndexedDbOutboundTestStores({ observer, namespace: 'outbound-default-send' }),
        nowMs: () => laneNowMs,
        ...
    expect(
        counts.byOwner['al-work'],
        'one default send spends 9 al-work operations: its decision read holds the effect row ' +
            'and canonical pair its commit fences, so the commit re-reads neither, its claim ' +
            'takes the committed canonical pair in memory instead of two work reads, and only the ' +
            'bootstrap batch sweeps for exhausted rows and lapsed leases'
    ).toBe(9);
```

Red before the edit: `expected 9 to be 11`. Green after: the file passes (`Tests 20 passed` with the scan-volume
cases).

- [ ] **Step 12: README.** In `packages/shared/alm/outbound/README.md`, after the paragraph ending "a failed
      comparison returns a lost-reservation result." (base `:603-604`):

```md
Each store lane, browser and server alike, sweeps for lapsed leases and exhausted reservations on a
limiter pair of its own, the ResourceInbox dequeuer's lock-limiter design on the lane clock: at most
one timeout sweep and one finalization sweep per lease, the first on the lane's bootstrap batch, and
none on a batch whose claim filled the page. While a sweep's window is closed the readiness scan does
not advertise the reserved rows that sweep would recover, so no batch runs empty waiting for it. A
crashed lease or an exhausted row is recovered at most 19.1 s after its lease ends: the window reopens
within 1.25 leases of the last sweep, then the remembered readiness ages and the idle engine passes
once. The inbound owner sweeps on every batch.
```

- [ ] **Step 13: Constraint checks** (all run in `scratch-3` on `09bfa3448`; sandboxed unless stated).

```sh
npx dprint fmt <the 17 touched files>          # then: npx dprint check <same list>  -> exit 0
npx tsc -p packages/shared/tsconfig.json --noEmit                       # exit 0
npx tsc -p packages/shared-server/tsconfig.json --noEmit                # exit 0
(cd packages/shared-test && npm run check:ts)                           # exit 0
npx tsc -p packages/shared-web/tsconfig.json --noEmit                   # exit 0
(cd apps/api-v1 && deno task check)                                     # exit 0
node scripts/check-tests-typecheck.mjs
npm run check:repo-style:changed -- origin/main HEAD    # PASS: no new repository style findings
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD   # PASS (3 classified candidates)
node scripts/check-test-reachability.mjs                # 1706 test files, 1700 reached by CI, 6 manual
npx vitest run packages/tests/shared/alm packages/tests/shared/al-outbound-durable-effects.test.ts
                                                        # Test Files 92 passed, Tests 1168 passed
npm run test:unit:main                                  # sandbox off; see figures below
npm run test:api-v1:black-box:memory                    # sandbox off; Matrix profile api-v1-black-box: passed=60 failed=0 skipped=0 (~13 min)
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles   # Bundle budget check passed
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts   # passes on the base
```

`check-tests-typecheck` reports one error, `apps/rallar-black-box/vite.config.ts(1,19): Cannot find module
  '@vitejs/plugin-react'`: the scratch tree lacks that app's nested dependency (environmental; no error in a touched
file). `test:unit:main` (sandbox off): `Test Files 2 failed | 1322 passed | 4 skipped (1328)`,
`Tests 1 failed | 12317 passed | 12 skipped`; both failures are `packages/tests/rallar-black-box/control-bootstrap.test.ts`
and `recipe-console-build-boundary.test.ts` failing on the same missing `@vitejs/plugin-react` (environmental).
Bundles (brotli KiB): `rallar.ts` 229.026 -> 229.493 (budget 230); headless 292.497 -> 292.946 (budget 293) on the
base — no budget crossed on the base. On Task 3's result: `rallar.ts` 229.744, headless **293.301** — crosses 293,
so the combined task raises `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` to 294 (see
below).

- [ ] **Step 14: Commit.**

```sh
git add packages/shared/alm/work/al-work-lease-recovery.ts packages/shared/alm/work/al-work-queue-port.ts \
  packages/shared/alm/outbound/al-outbound-work-entry.ts packages/shared/alm/outbound/lane/al-outbound-store-lane.ts \
  packages/shared/alm/inbound/lane/al-inbound-store-lane.ts packages/shared/alm/outbound/README.md \
  packages/shared-test/shared/create-test-al-outbound-work-port.ts packages/shared-test/shared/create-test-al-inbound-work-port.ts \
  packages/tests/shared/alm/work/al-work-lease-recovery.test.ts packages/tests/shared/alm/work/al-work-queue-port.test.ts \
  packages/tests/shared/alm/work/al-work-handler.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts \
  packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/outbound-runtime-test-fixture.ts \
  packages/tests/shared/al-outbound-durable-effects.test.ts packages/tests/shared/alm/outbound-control-handoff.test.ts \
  packages/tests/shared/alm/outbound/al-outbound-control-handoff-two-tabs.test.ts \
  packages/tests/rallar-black-box-headless/headless-bundle-budget.json
git commit -F - <<'EOF'
Sweep lapsed leases once per lease on each outbound lane's clock

Each outbound store lane gives its work port a limiter pair of its own,
the ResourceInbox dequeuer's lock-limiter design on RateLimiter's public
clock API: at most one lease-timeout sweep and one exhaustion sweep per
lease, the first on the bootstrap batch, spent only when the sweep would
read. The readiness scan does not advertise the reserved rows a closed
sweep would recover, so no batch runs empty waiting for the window.
A crashed lease or an exhausted row is recovered at most 19.1 s after
its lease ends. The inbound owner sweeps on every batch.

A warm durable send falls from 8 to 6 chain transactions and from 10
to 8 in all (7 to 5 al-work); one cold send from 11 to 9 al-work. The
headless agent measures 293.301 KiB brotli, so its budget rises to 294.
EOF
```

(The scratch commit `09bfa3448`, on the base, says "from 11 to 9 in all (8 to 6 al-work)" and has no budget line;
the message above is the one for Task 3's result. Drop the budget file from `git add` if the measured headless
figure stays under 293.)

---

#### Applying onto Task 3 (`bd477f3f4`)

Verified by `git cherry-pick --no-commit bd477f3f4` onto `09bfa3448`: every production hunk and every test hunk
except the ledger merge cleanly; `al-outbound-store-lane.ts` and `al-inbound-store-lane.ts` auto-merge (Task 3's
`committed(writtenDueByMs)` calls and Task 4's port/deferral hunks touch different lines). With the two hunks below
the combined tree passes `npx vitest run packages/tests/shared/alm packages/tests/shared/al-outbound-durable-effects.test.ts
packages/tests/shared-web packages/tests/api-v1` (`Test Files 254 passed`, `Tests 2516 passed`) and
`npx tsc -p packages/shared/tsconfig.json --noEmit`.

1. **Task 3's new port site.** `al-work-handler.test.ts`, Task 3's case `finds a row another tab wrote, unannounced,
   once the restored answer reaches its age bound` builds `createALWorkQueuePort({ … random: () => 0.5 })`; add
   `leaseRecovery: { kind: 'every-batch' }` (without it the batch throws on `recovery.kind` and the case fails
   `expected [] to deeply equal [ 'own-row' ]`). That makes 15 port call sites in tests.
2. **The ledger on Task 3's version** (Task 3 already replaced `sendUntilOwnerIdle` with the named-input wait on
   the release, the durable `effect-drain` and `liveCount() === 0`, and added `diagnostics`). Keep Task 3's
   `READINESS_RESTORE_REASON` and add `LANE_CLOCK_REASON`; the runtime input takes both lines:

```ts
// The lane clock stands still: the sweep windows the bootstrap batch spent stay closed however long the run takes.
const laneNowMs = Date.now();
const runtime = createDefaultOutboundTestRuntime({
    stores: createIndexedDbOutboundTestStores({ observer: recorded.observer, namespace: OUTBOUND_NAMESPACE }),
    nowMs: () => laneNowMs,
    diagnostics: (event) => diagnostics.push(event),
```

and the pins (measured on the combined tree, all 4 ledger tests green):

```ts
    it('reaches the carrier in 6 transactions and the idle owner in 8', async () => {
        ...chain pin as in Step 10: toBe(6)...
        expect(
            total.transactions,
            'the chain\'s 6, then the release read and the release write; ' + READINESS_RESTORE_REASON + table
        ).toBe(8);
        expect(
            total.requests,
            'every get, getAll and put those 8 transactions issue; the guard read issues its 2 gets ' +
                'in one session' + table
        ).toBe(37);
        ...al-admission toBe(10) unchanged...
        expect(
            total.byOwner['al-work'],
            '3 decision work reads, the reservation and the release; ' + LANE_CLOCK_REASON + '; ' +
                CANONICAL_HANDOFF_REASON + '; ' + READINESS_RESTORE_REASON + table
        ).toBe(5);
    });

    it('parses 4 timestamps up to the carrier and 8 up to the idle owner', async () => {
        ...chain parses as in Step 10: { instant: 2, plainTime: 1, plainDateTime: 1 }...
        expect(
            computeIndexedDbLedgerTotals(ledger, ['chain', 'after-send']).temporalParses,
            'the chain\'s 4, then the release read decodes the work row (4); the release write parses ' +
                'nothing' + table
        ).toEqual({ instant: 4, plainTime: 2, plainDateTime: 2 });
    });
```

The frozen lane clock does not disturb Task 3's restore: the restored answer is `none` (undefined) and the
commit's `writtenDueByMs` equals the batch start, both of which the restore's guards admit.
3. **Bundle budget.** Raise `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` to
`"brotliBudgetKiB": 294` (measured 293.301 KiB on the combined tree); `rallar.ts` stays under 230 (229.744).
4. **Cold pin** stays at 10 + 9 on the combined tree (the counts test passes there unchanged): Task 3 leaves the cold
send's post-batch `work-page` in place.

No hunk of Task 4 lands in `al-work-handler.ts`, in `al-work-readiness-memory.ts` or in a lane's `committed()` call.

#### Measured figures

| Ledger (warm durable send)         | chain | total | requests | al-admission | al-work | parses chain / total | cold al-work |
| ---------------------------------- | ----: | ----: | -------: | -----------: | ------: | -------------------: | -----------: |
| base (P1a)                         |     8 |    11 |       42 |           10 |       8 |               9 / 13 |           11 |
| base + Task 4 (`09bfa3448`)        |     6 |     9 |       40 |           10 |       6 |                4 / 8 |            9 |
| Task 3 (`bd477f3f4`, W2's figures) |     8 |    10 |       39 |           10 |       7 |               9 / 13 |           11 |
| Task 3 + Task 4 (cherry-pick)      |     6 |     8 |       37 |           10 |       5 |                4 / 8 |            9 |

Inbound pins unchanged on both trees (chain 9/11, total 11/13, al-work 5/7, al-admission 8). Recovery: 14.42 s
after the lease end in the worst-case fake-clock scenario (bound 19.1 s); 12,400 empty batches without the clamp,
0 with it. Bundles: see Step 13.

---

### Task 5: The receipted command-shaped harness configuration and its reading (D115)

Prototyped in `scratch-4` on the base (`9e8b9fc07` → `c8536e6cd`, the commit the three measured invocations ran)
and re-applied on Task 3's head (`scratch-4b`: `bd477f3f4` → `93f67ce6c`, conflicts resolved, one verification
run). **The code below is the post-Task-3 version (`93f67ce6c`)**: Task 5 executes after Task 3, so its harness hunks
apply onto Task 3's harness changes in `durable-send-observation.ts`, `durable-send-harness-contract.ts`,
`durable-send-plain-page.spec.ts`, `durable-send-report.ts` and `create-durable-send-harness.ts` (Task 3 renamed
`ownProbe`/`probeEnd`/`probeCauses` to `batchDrain`/`batchEnd`/`batchEnds`, removed
`DURABLE_SEND_OWN_PROBE_CAUSES`, and asserts `observedProbeCauses` `{}`). The diffs below are against `bd477f3f4`.

**Files**

- Create `packages/shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts` (1-93): the WS
  client's dispatch plan as an exported pure function, moved out of the class verbatim.
- Modify `packages/shared/services/ws-queue-box-client-service.ts`: imports (9-66), `planOutgoingMessage` (256-263
  delegates), the two private `toRetryTrackingPlan`/`toSupersedenceTrackingPlan` methods removed (were 621-648).
- Test `packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts` (1-59, new).
- Modify `tests/playwright/alm/harness/durable-send-harness-contract.ts` (plan type and list, the page parameter,
  `readiness-probe` batch end, `receiptEnd`).
- Modify `tests/playwright/alm/harness/durable-send-observation.ts` (per-plan batch end, settlement and receipt waits).
- Modify `tests/playwright/alm/harness/create-durable-send-harness.ts` (the plan shape; the receipted command; the
  server ACK through the client's control path).
- Modify `tests/playwright/alm/harness/durable-send-harness-page.ts` (reads the plan from `?plan=`).
- Modify `tests/playwright/alm/run-durable-send-configuration.ts` (`DurableSendPageRunInput` with `plan`; the page
  URL names it; the profile page too).
- Modify `tests/playwright/alm/durable-send-report.ts` (`plan` per run and per configuration, `receiptEnds`, one table
  row per configuration and plan, profile line names the minimal plan).
- Modify `tests/playwright/alm/durable-send-plain-page.spec.ts` (both plans per configuration, per-plan expectations).
- Modify `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` (293 → 294: the headless agent measures
  293.120 KiB on Task 3's head once the planner is its own module; standing ruling, next whole KiB; `browser/rallar.ts`
  measures 229.6 KiB against 230, unchanged).
- `tests/manual-suites.json`, `package.json`, `playwright.config.ts`: unchanged (no path changes).

**Interfaces**

- Produces `toWsQueueBoxClientDispatchPlan(msg: ALMessage, context: WsQueueBoxClientDispatchContext):
  ALOutboundDispatchPlan<ALOutboundTransportMessage>` with `WsQueueBoxClientDispatchContext { sessionId: string;
  serverPeerId: string | undefined; socketOpen: boolean; qosProvider: ALQosInputProvider }`. `WsQueueBoxClientService`
  calls it for `planOutgoingMessage` and `planDequeuedMessage`; behaviour unchanged.
- Consumes (unchanged): `createBrowserUnicastMessage` (`packages/shared-web/browser/messages/create-browser-unicast-message.ts:45`),
  `toALCarrierQosInputProvider` + `AL_WS_CLIENT_CAPABILITIES`, `newALAckControlMessage`,
  `acceptWsQueueBoxClientControlMessage` (`ws-queue-box-client-receipt-tracking.ts:69`), `AL_CHANNEL_SEND_DEFAULTS`.
- Harness: `DurableSendPlan = 'minimal' | 'receipted-command'`, `DURABLE_SEND_PLANS`, `DURABLE_SEND_PLAN_PARAMETER`,
  `DurableSendBatchEnd = 'effect-drain' | 'readiness-probe' | 'timeout'`,
  `DurableSendReceiptEnd = 'none' | 'acknowledged' | 'unacknowledged' | 'undrained'`,
  `createDurableSendHarness(sessionId, plan)`, `runDurableSendConfiguration(context, configuration,
  input: DurableSendPageRunInput)`, `toConfigurationFigures(configuration, plan, runs)`. Artifact:
  `configurations[i].plan`, `runs[j].plan`, `runs[j].receiptEnds`; Task 3's `batchEnds` now reads
  `{"effect-drain": 90}` for the minimal plan and `{"readiness-probe": 90}` for the receipted one.

**D8 reuse inspection.** Reused: the WS client's own planner (moved, not copied, so the harness and the client share
one plan literal), the browser's typed-channel unicast builder with the `command` purpose (`ack: 'receiver'`,
`ttlMs` 30 000, at-least-once; durability `local-outbox` declared on the channel), the client's carrier QoS wrapper,
the control builder `newALAckControlMessage` and the client's control path `acceptWsQueueBoxClientControlMessage`, and
every existing harness piece (page, route, frame load, observation, report, profile). `packages/shared/cache` and
`packages/shared/resilience` offer nothing a test page's waiters need (the waiters are one-shot promises with a bound,
as P1a's are); no new runtime, no new dependency, no worker. The only production change is the move of the planner.

**Design decisions taken (each also listed under open decisions where the spec is silent)**

- _The send._ A Relic-shaped command: `messages.room({ purpose: 'command' }).sendWs(..., { peerId: serverPeerId })`
  with `durability: 'local-outbox'` — a unicast to the server's peer id that names its room. The WS client plans it
  `persist: true`, `ackTracking { mode: 'receiver', expectedPeerIds: ['server'], timeoutMs: 2000, maxAttempts: 3 }`,
  `retryTracking { maxAttempts: 3 }` (pinned by the new unit test).
- _The receipt._ After the send's batch is idle, the page hands the server's own ACK (`status: 'delivered'`,
  `fromPeerId = logicalRecipientPeerId = server`, as the server's inbound commit bundle builds it) to
  `acceptWsQueueBoxClientControlMessage`. In the real client an origin ACK skips inbound lane admission
  (`al-inbound-message-runtime.ts:271-273`, `isALOriginAcknowledgement` → `not-handled`) and goes straight to this
  function, so nothing of the client's path is skipped. The send then waits for the complete `acknowledgement`
  settlement and the `effect-drain` of the batch the ACK's commit wakes, so the next send starts on an idle owner with
  no receipt open (without that drain wait the empty batch overlapped the next send: idle receipted p50 7.4 ms in a
  trial, 5.2 ms with it).
- _Measured window._ Unchanged: `enqueueIfAbsent` → the carrier's `sendPreparedMessage`.
- _The profile_ stays on the minimal plan only, so its polyfill/JSBI/codec attribution compares with P1a's nine
  profiles; the receipted plan's extra cost is a chain question the per-plan latency answers.
- _The minimal plan_ keeps its exact message, plan literal and no settlement sink (the sink is attached only to the
  receipted plan), so the ledger's plan and its P1a comparability are unchanged.
- _Order._ Each configuration runs minimal then receipted (3 runs each, a fresh page per run), so drift hits both.

**Ruled:** the stall below is fixed in P1b as Task 6 (`task-6.md`); the decisions 2-5 were accepted as recommended.

**Finding (blocks a clean reading; needs a ruling): a full page of not-yet-due rows hides a due send.** Every
acknowledged receipted send leaves its ACK-timeout work row, due 2 000 ms after the send; the ACK completes the
receipt but not that row, which later runs as a no-op batch (`claimedCount 1`, no dispatch). Both the readiness scan
(`readALOutboundWorkReadyAt`, `packages/shared/alm/outbound/al-outbound-work-entry.ts:131-156`, 16 rows per status)
and the claim (`createALWorkQueuePort.claim` → `reserveEntries`, `packages/shared/alm/work/al-work-queue-port.ts:105-121`;
`packages/shared/queuebox/indexed-db-queue-box.ts:399-400`: "The index pages a claim in keyString order, not in
readiness order") read pages in key order. Once 16 such rows are pending, a new send's due row sorts past the page:
the claim returns 0 rows and the probe answers the earliest hidden-page timer. Debug trace (idle, 20 sends): the 16th
send commits at 137.4 ms, the batch after it claims 0, the probe answers the first ACK-timeout instant, and the send
dispatches at 2 010.6 ms when that row falls due; the next send waits ~120-200 ms behind the batch that then claims 14
due rows. In every run this is exactly 6 of 90 measured sends (period 16) at idle, cpu-4x and frame-load, and it is
the whole of those configurations' p95. It holds after Task 3 (verification run: 6 per run). Any app that sends 16 or
more receipted durable messages within the 2 s ACK timeout stalls one send up to ~2 s; unacknowledged sends pile up
the same way. Task 4 owns the scan clamp in `al-outbound-work-entry.ts`; neither Task 3 nor Task 4 as framed fixes it.

- [ ] **Step 1: Write the failing test for the shared planner.** Create
      `packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const CONTEXT = {
    sessionId: 'self',
    serverPeerId: 'server',
    socketOpen: true,
    qosProvider: toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined)
};

function commandToServer(): ALMessage {
    return newALUnicastMessage(
        'self',
        { topicId: 'room.command', resourceId: 'command-1', contextId: ROOM.groupId },
        'server',
        'command.v1',
        {},
        {
            groupRef: ROOM,
            ttlMs: 30_000,
            reliability: 'at-least-once',
            ack: 'receiver',
            qos: { durability: { algo: 'local-outbox' } }
        }
    );
}

describe('the WS client dispatch plan', () => {
    it('persists a durable command to the server and tracks the server itself as its receiver', () => {
        const plan = toWsQueueBoxClientDispatchPlan(commandToServer(), CONTEXT);

        expect(plan).toMatchObject({
            persist: true,
            ackTracking: {
                enabled: true,
                mode: 'receiver',
                timeoutMs: 2_000,
                maxAttempts: 3,
                expectedPeerIds: ['server'],
                nextHopPeerIds: ['server']
            },
            retryTracking: { enabled: true, maxAttempts: 3 },
            repairTracking: { enabled: false }
        });
        expect(plan.msg.qos?.durability).toEqual({ algo: 'local-outbox' });
        expect(plan.preparedMessages).toHaveLength(1);
    });

    it('tracks no server hop while the server names no peer id', () => {
        const plan = toWsQueueBoxClientDispatchPlan(commandToServer(), {
            ...CONTEXT,
            serverPeerId: undefined
        });

        // With no server id, a receiver unicast expects its addressee's ACK through the server's admitted receipt.
        expect(plan.ackTracking).toMatchObject({
            mode: 'receiver',
            expectedPeerIds: [],
            nextHopPeerIds: []
        });
    });
});
```

- [ ] **Step 2: Run it and see it fail.**
      `npx vitest run packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts`
      Expected: `FAIL ... Error: Cannot find package '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts'`,
      `Test Files  1 failed (1)`, `Tests  no tests`.

- [ ] **Step 3: Move the WS client's planner into the function.** Create
      `packages/shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts`:

```ts
import type { ALMessage } from '../../al-contracts/al-contract.ts';
import {
    normalizeALQosPolicy,
    resolveALQosNormalizationInput,
    resolveSupersedenceKey,
    shouldPersistOutbox,
    type ALQosEffectivePolicy,
    type ALQosInputProvider
} from '../../al-contracts/al-policy.ts';
import { computeALOutboundAckRefusal } from '../../alm/outbound/admission/compute-al-outbound-ack-refusal.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundRetryTrackingPlan,
    ALOutboundSupersedenceTrackingPlan
} from '../../alm/outbound/al-outbound-message-runtime.ts';
import {
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '../../alm/outbound/al-outbound-transport-message.ts';
import { toALOutboundMessage } from '../../alm/outbound/to-al-outbound-message.ts';
import { toWsQueueBoxClientAckTrackingPlan } from './ws-queue-box-client-receipt-tracking.ts';

export interface WsQueueBoxClientDispatchContext {
    readonly sessionId: string;
    /** The peer id the WS server answers as; undefined when the server names none. */
    readonly serverPeerId: string | undefined;
    readonly socketOpen: boolean;
    readonly qosProvider: ALQosInputProvider;
}

/** How the WS client sends one message: its normalized policy, the receipt it tracks, and its retry and supersedence. */
export function toWsQueueBoxClientDispatchPlan(
    msg: ALMessage,
    context: WsQueueBoxClientDispatchContext
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    const normalizationInput = resolveALQosNormalizationInput(
        msg,
        {
            direction: 'outbound',
            selfPeerId: context.sessionId,
            connectedPeerIds: context.socketOpen ? [context.sessionId] : []
        },
        context.qosProvider
    );
    const normalized = normalizeALQosPolicy(msg, normalizationInput);
    const message = toALOutboundMessage(msg, normalized.effective);
    const refusal = computeALOutboundAckRefusal<ALOutboundTransportMessage>({
        msg: message,
        carrier: 'ws',
        policy: normalized
    });
    return refusal.fold<ALOutboundDispatchPlan<ALOutboundTransportMessage>>(
        (refused) => refused,
        () => ({
            msg: message,
            dropReasonCode: undefined,
            persist: shouldPersistOutbox(normalized.effective),
            preparedMessages: [toALOutboundTransportMessage(message)],
            ackTracking: toWsQueueBoxClientAckTrackingPlan(
                normalized.effective,
                msg,
                context.serverPeerId
            ),
            retryTracking: toRetryTrackingPlan(normalized.effective),
            repairTracking: {
                enabled: normalized.effective.repair.algo !== 'none',
                algo: normalized.effective.repair.algo,
                maxAttempts: normalized.effective.repair.opts.maxRepairs
            },
            supersedenceTracking: toSupersedenceTrackingPlan(normalized.effective, msg)
        })
    );
}

function toRetryTrackingPlan(
    effective: ALQosEffectivePolicy
): ALOutboundRetryTrackingPlan | undefined {
    if (effective.retry.algo === 'none') {
        return undefined;
    }

    return {
        enabled: true,
        maxAttempts: effective.retry.opts.maxAttempts
    };
}

function toSupersedenceTrackingPlan(
    effective: ALQosEffectivePolicy,
    msg: ALMessage
): ALOutboundSupersedenceTrackingPlan | undefined {
    if (effective.supersedence.algo === 'none') {
        return undefined;
    }

    return {
        enabled: true,
        algo: effective.supersedence.algo,
        key: resolveSupersedenceKey(msg, effective),
        replacesMsgId: effective.supersedence.opts.replacesMsgId
    };
}
```

and make the client delegate (the body moved verbatim; `this.*` became `context.*`):

```diff
diff --git a/packages/shared/services/ws-queue-box-client-service.ts b/packages/shared/services/ws-queue-box-client-service.ts
index 486985516..7212df328 100644
--- a/packages/shared/services/ws-queue-box-client-service.ts
+++ b/packages/shared/services/ws-queue-box-client-service.ts
@@ -7,14 +7,10 @@ import {
 } from '../al-contracts/al-message-persistence-validation.ts';
 import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';
 import {
-    normalizeALQosPolicy,
     planALMessageHandling,
     resolveALQosNormalizationInput,
-    resolveSupersedenceKey,
-    shouldPersistOutbox,
     type ALMessageHandlingPlan,
     type ALMessagePlanningObservations,
-    type ALQosEffectivePolicy,
     type ALQosInputProvider
 } from '../al-contracts/al-policy.ts';
 import type {
@@ -28,7 +24,6 @@ import type {
 import { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
 import type { ALInboundRuntimeDiagnosticsSink } from '../alm/inbound/al-inbound-runtime-diagnostics.ts';
 import { createDefaultALInboundRuntimeResources } from '../alm/inbound/create-default-al-inbound-message-runtime.ts';
-import { computeALOutboundAckRefusal } from '../alm/outbound/admission/compute-al-outbound-ack-refusal.ts';
 import type { ALOutboundCancelOutcome } from '../alm/outbound/al-outbound-message-runtime.ts';
 import type {
     ALOutboundRuntimeDiagnosticsSink,
@@ -39,21 +34,17 @@ import {
     ALOutboundMessageRuntime,
     type ALOutboundDispatchPlan,
     type ALOutboundEnqueueResult,
-    type ALOutboundRetryTrackingPlan,
-    type ALOutboundSettledSendResult,
-    type ALOutboundSupersedenceTrackingPlan
+    type ALOutboundSettledSendResult
 } from '../alm/outbound/al-outbound-message-runtime.ts';
 import {
     decodeALOutboundTransportMessage,
     reconstructALOutboundTransportMessage,
-    toALOutboundTransportMessage,
     type ALOutboundTransportMessage
 } from '../alm/outbound/al-outbound-transport-message.ts';
 import {
     createDefaultALOutboundDequeueResilience,
     createDefaultALOutboundRuntimeResources
 } from '../alm/outbound/create-default-al-outbound-message-runtime.ts';
-import { toALOutboundMessage } from '../alm/outbound/to-al-outbound-message.ts';
 import { EnqueuedType } from '../api/api-config.ts';
 import type { QueueBoxResourceEntryRepository } from '../queuebox/queue-box-types.ts';
 import { NonRetryableException } from '../queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
@@ -72,10 +63,8 @@ import type {
     OnInboxMessageCallback,
     OnOutboxWebSocketMessageCallback
 } from './queue-message-callbacks.ts';
-import {
-    acceptWsQueueBoxClientControlMessage,
-    toWsQueueBoxClientAckTrackingPlan
-} from './ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';
+import { toWsQueueBoxClientDispatchPlan } from './ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';
+import { acceptWsQueueBoxClientControlMessage } from './ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';
 
 export const DEFAULT_WS_QUEUE_BOX_CLIENT_RECONNECT_OPTIONS: WsQueueBoxClientService.ReconnectOptions = {
     maxAttempts: 12,
@@ -265,37 +254,12 @@ export class WsQueueBoxClientService {
     }
 
     private planOutgoingMessage(msg: ALMessage): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
-        const socketOpen = this.isSocketOpen();
-        const normalizationInput = resolveALQosNormalizationInput(
-            msg,
-            {
-                direction: 'outbound',
-                selfPeerId: this.sessionId,
-                connectedPeerIds: socketOpen ? [this.sessionId] : []
-            },
-            this.dependencies.qosProvider
-        );
-        const normalized = normalizeALQosPolicy(msg, normalizationInput);
-        const message = toALOutboundMessage(msg, normalized.effective);
-        const refusal = computeALOutboundAckRefusal<ALOutboundTransportMessage>({
-            msg: message,
-            carrier: 'ws',
-            policy: normalized
+        return toWsQueueBoxClientDispatchPlan(msg, {
+            sessionId: this.sessionId,
+            serverPeerId: this.serverPeerId,
+            socketOpen: this.isSocketOpen(),
+            qosProvider: this.dependencies.qosProvider
         });
-        return refusal.fold<ALOutboundDispatchPlan<ALOutboundTransportMessage>>((refused) => refused, () => ({
-            msg: message,
-            dropReasonCode: undefined,
-            persist: shouldPersistOutbox(normalized.effective),
-            preparedMessages: [toALOutboundTransportMessage(message)],
-            ackTracking: toWsQueueBoxClientAckTrackingPlan(normalized.effective, msg, this.serverPeerId),
-            retryTracking: this.toRetryTrackingPlan(normalized.effective),
-            repairTracking: {
-                enabled: normalized.effective.repair.algo !== 'none',
-                algo: normalized.effective.repair.algo,
-                maxAttempts: normalized.effective.repair.opts.maxRepairs
-            },
-            supersedenceTracking: this.toSupersedenceTrackingPlan(normalized.effective, msg)
-        }));
     }
 
     private planIncomingMessage(
@@ -617,35 +581,6 @@ export class WsQueueBoxClientService {
     private isSocketOpen(): boolean {
         return this.socket.ws?.readyState === 1;
     }
-
-    private toRetryTrackingPlan(
-        effective: ALQosEffectivePolicy
-    ): ALOutboundRetryTrackingPlan | undefined {
-        if (effective.retry.algo === 'none') {
-            return undefined;
-        }
-
-        return {
-            enabled: true,
-            maxAttempts: effective.retry.opts.maxAttempts
-        };
-    }
-
-    private toSupersedenceTrackingPlan(
-        effective: ALQosEffectivePolicy,
-        msg: ALMessage
-    ): ALOutboundSupersedenceTrackingPlan | undefined {
-        if (effective.supersedence.algo === 'none') {
-            return undefined;
-        }
-
-        return {
-            enabled: true,
-            algo: effective.supersedence.algo,
-            key: resolveSupersedenceKey(msg, effective),
-            replacesMsgId: effective.supersedence.opts.replacesMsgId
-        };
-    }
 }
 
 export function createDefaultWsQueueBoxClientService(input: WsQueueBoxClientService.Input): WsQueueBoxClientService {
```

- [ ] **Step 4: Run the test and the client's suites.**
      `npx vitest run packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts` → `Tests  2 passed (2)`.
      `npx vitest run packages/tests/shared/services/ packages/tests/shared/ws-qos-policy.test.ts packages/tests/shared/browser-outbound-cancellation.test.ts`
      → `Test Files  27 passed (27)`, `Tests  240 passed (240)` (26/238 before the new file).
      `npx tsc -p packages/shared/tsconfig.json --noEmit` → exit 0.

- [ ] **Step 5: The harness contract: the plan, the page parameter, the receipted batch end, the receipt end.**

```diff
diff --git a/tests/playwright/alm/harness/durable-send-harness-contract.ts b/tests/playwright/alm/harness/durable-send-harness-contract.ts
index 759b24836..beb9c5889 100644
--- a/tests/playwright/alm/harness/durable-send-harness-contract.ts
+++ b/tests/playwright/alm/harness/durable-send-harness-contract.ts
@@ -1,5 +1,16 @@
 import type { ALWorkReadinessProbeCause } from '@shared/alm/work/al-work-handler.ts';
 
+/**
+ * What a page sends: the ledger's minimal durable plan, or a receipted command, a durable WS unicast to the
+ * server on the `command` channel, planned as the WS client plans it and acknowledged as the server does.
+ */
+export type DurableSendPlan = 'minimal' | 'receipted-command';
+
+export const DURABLE_SEND_PLANS: readonly DurableSendPlan[] = ['minimal', 'receipted-command'];
+
+/** The page URL's query parameter that names its plan, so each page composes one runtime for one plan. */
+export const DURABLE_SEND_PLAN_PARAMETER = 'plan';
+
 export interface DurableSendRunInput {
     readonly runId: string;
     readonly warmupCount: number;
@@ -19,8 +30,12 @@ export interface FrameLoadObservation {
     readonly frameLatenessMs: readonly number[];
 }
 
-/** How a send's wait for its own batch ended: on that batch's durable `effect-drain`, or at the bound. */
-export type DurableSendBatchEnd = 'effect-drain' | 'timeout';
+/**
+ * How a send's wait for its own batch ended: on that batch's durable `effect-drain`, on the readiness probe that
+ * follows the drain, or at the bound. A receipted send ends on the probe: its commit also wrote the ACK-timeout row
+ * due later, so the owner reads storage again after the batch instead of restoring its answer.
+ */
+export type DurableSendBatchEnd = 'effect-drain' | 'readiness-probe' | 'timeout';
 
 export interface DurableSendSample {
     /** `enqueueIfAbsent` call to the carrier's `sendPreparedMessage`. */
@@ -33,8 +48,16 @@ export interface DurableSendSample {
     readonly batchEnd: DurableSendBatchEnd;
     /** Every durable probe seen from the dispatch to the end of that wait. */
     readonly observedProbeCauses: readonly ALWorkReadinessProbeCause[];
+    /** How the server's receipt, handed over once the batch went idle, ended. */
+    readonly receiptEnd: DurableSendReceiptEnd;
 }
 
+/**
+ * `acknowledged`: the receipt settled complete and the batch its commit woke drained, so the next send starts
+ * on an idle owner with no receipt open. `none` for a plan that tracks no receipt.
+ */
+export type DurableSendReceiptEnd = 'none' | 'acknowledged' | 'unacknowledged' | 'undrained';
+
 export interface DurableSendRun {
     readonly samples: readonly DurableSendSample[];
     readonly frameLoad: FrameLoadObservation | undefined;
```

- [ ] **Step 6: The observation: a per-plan batch end, the acknowledgement and the ACK batch's drain.** Full file:

```ts
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALWorkReadinessProbeCause } from '@shared/alm/work/al-work-handler.ts';

import type {
    DurableSendBatchEnd,
    DurableSendReceiptEnd
} from './durable-send-harness-contract.ts';
import type { PacedFrameLoad } from './paced-frame-load.ts';

const SETTLE_BOUND_MS = 2_000;

export class DurableSendDispatchTimeoutError extends Error {
    constructor(sendIndex: number) {
        super(
            `Send ${sendIndex} did not reach its first dispatch within ${SETTLE_BOUND_MS} ms of its start`
        );
        this.name = 'DurableSendDispatchTimeoutError';
    }
}

export interface DurableSendBatchDrain {
    readonly endedOn: DurableSendBatchEnd;
    readonly observedProbeCauses: readonly ALWorkReadinessProbeCause[];
}

export interface DurableSendDispatch {
    readonly atMs: number;
    readonly framesStarted: number;
    /** Armed at the dispatch, so it ends on the drain of the batch that dispatched it, or the probe after it. */
    readonly batchDrain: Promise<DurableSendBatchDrain>;
}

interface BatchDrainWaiter {
    readonly observedProbeCauses: ALWorkReadinessProbeCause[];
    drained: boolean;
    readonly end: (endedOn: DurableSendBatchEnd) => void;
}

namespace DurableSendObservation {
    export interface Input {
        readonly frameLoad: PacedFrameLoad;
        /** Where a send's batch goes idle for this plan: its drain, or the readiness probe that follows the drain. */
        readonly batchEnd: Exclude<DurableSendBatchEnd, 'timeout'>;
    }
}

/** The carrier's send calls, the durable lane's drains and readiness probes, and its settlements, as the page observes them. */
export class DurableSendObservation {
    private readonly frameLoad: PacedFrameLoad;
    private readonly batchEnd: Exclude<DurableSendBatchEnd, 'timeout'>;
    private readonly dispatchWaiters = new Map<string, (dispatch: DurableSendDispatch) => void>();
    private batchDrainWaiters: BatchDrainWaiter[] = [];
    private readonly acknowledgementWaiters = new Map<string, () => void>();
    private drainWaiters: (() => void)[] = [];

    constructor(input: DurableSendObservation.Input) {
        this.frameLoad = input.frameLoad;
        this.batchEnd = input.batchEnd;
    }

    observeDispatch(msgId: string): void {
        const atMs = performance.now();
        const resolveDispatch = this.dispatchWaiters.get(msgId);
        if (resolveDispatch === undefined) {
            return;
        }
        this.dispatchWaiters.delete(msgId);
        resolveDispatch({
            atMs,
            framesStarted: this.frameLoad.getFramesStarted(),
            batchDrain: this.startBatchDrainWait()
        });
    }

    observeDiagnostics(event: ALOutboundRuntimeDiagnosticsEvent): void {
        if (event.kind === 'readiness-probe' && event.lane === 'durable') {
            this.observeProbe(event.cause);
        }
        else if (event.kind === 'effect-drain' && event.lane === 'durable') {
            this.observeDrain();
        }
    }

    /** A complete acknowledgement settles the send's receipt; an incomplete one or none leaves it open. */
    observeSettlement(settlement: ALDeliverySettlement): void {
        if (settlement.kind === 'acknowledgement' && settlement.complete) {
            this.acknowledgementWaiters.get(settlement.msgId)?.();
        }
    }

    waitForDispatch(msgId: string, sendIndex: number): Promise<DurableSendDispatch> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.dispatchWaiters.delete(msgId);
                reject(new DurableSendDispatchTimeoutError(sendIndex));
            }, SETTLE_BOUND_MS);
            this.dispatchWaiters.set(msgId, (dispatch) => {
                clearTimeout(timer);
                resolve(dispatch);
            });
        });
    }

    /** Armed before the receipt is handed over: the acknowledgement it settles and the batch its commit wakes. */
    async waitForReceiptEnd(msgId: string): Promise<DurableSendReceiptEnd> {
        const [acknowledged, drained] = await Promise.all([
            this.waitForAcknowledgement(msgId),
            this.waitForEffectDrain()
        ]);
        if (!acknowledged) {
            return 'unacknowledged';
        }
        return drained ? 'acknowledged' : 'undrained';
    }

    private observeProbe(cause: ALWorkReadinessProbeCause): void {
        for (const waiter of [...this.batchDrainWaiters]) {
            waiter.observedProbeCauses.push(cause);
            if (waiter.drained) {
                waiter.end('readiness-probe');
            }
        }
    }

    private observeDrain(): void {
        for (const waiter of [...this.batchDrainWaiters]) {
            if (this.batchEnd === 'effect-drain') {
                waiter.end('effect-drain');
            }
            else {
                waiter.drained = true;
            }
        }
        for (const end of [...this.drainWaiters]) {
            end();
        }
    }

    private startBatchDrainWait(): Promise<DurableSendBatchDrain> {
        return new Promise((resolve) => {
            const observedProbeCauses: ALWorkReadinessProbeCause[] = [];
            const end = (endedOn: DurableSendBatchEnd) => {
                clearTimeout(timer);
                this.batchDrainWaiters = this.batchDrainWaiters.filter((waiter) =>
                    waiter.end !== end
                );
                resolve({ endedOn, observedProbeCauses });
            };
            const timer = setTimeout(() => end('timeout'), SETTLE_BOUND_MS);
            this.batchDrainWaiters.push({ observedProbeCauses, drained: false, end });
        });
    }

    private waitForAcknowledgement(msgId: string): Promise<boolean> {
        return new Promise((resolve) => {
            const end = (acknowledged: boolean) => {
                clearTimeout(timer);
                this.acknowledgementWaiters.delete(msgId);
                resolve(acknowledged);
            };
            const timer = setTimeout(() => end(false), SETTLE_BOUND_MS);
            this.acknowledgementWaiters.set(msgId, () => end(true));
        });
    }

    private waitForEffectDrain(): Promise<boolean> {
        return new Promise((resolve) => {
            const end = (drained: boolean) => {
                clearTimeout(timer);
                this.drainWaiters = this.drainWaiters.filter((waiter) => waiter !== onDrain);
                resolve(drained);
            };
            const onDrain = () => end(true);
            const timer = setTimeout(() => end(false), SETTLE_BOUND_MS);
            this.drainWaiters.push(onDrain);
        });
    }
}
```

- [ ] **Step 7: The page composes one plan.** `create-durable-send-harness.ts`, full file:

```ts
import { toBrowserWsClientALRuntimeStoreId } from '@shared-web/browser/al-runtime/browser-al-runtime-identity.ts';
import { createBrowserALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { createBrowserUnicastMessage } from '@shared-web/browser/messages/create-browser-unicast-message.ts';
import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import type {
    ALOutboundDispatchPlan,
    ALOutboundEnqueueResult,
    ALOutboundMessageRuntime
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    toALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { createDefaultALOutboundMessageRuntime } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';
import { acceptWsQueueBoxClientControlMessage } from '@shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';

import type {
    DurableSendBatchEnd,
    DurableSendHarness,
    DurableSendPlan,
    DurableSendReceiptEnd,
    DurableSendRun,
    DurableSendRunInput,
    DurableSendSample,
    FrameLoadInput
} from './durable-send-harness-contract.ts';
import { DurableSendObservation, type DurableSendDispatch } from './durable-send-observation.ts';
import { PacedFrameLoad, type FramePhase } from './paced-frame-load.ts';

/** 7 is coprime with a 16 ms frame, so consecutive sends visit every phase before repeating one. */
const PHASE_STRIDE_MS = 7;
const HARNESS_SERVER_PEER_ID = 'harness-server';
const HARNESS_ROOM = {
    applicationId: 'alm-harness',
    workspaceId: 'alm-harness',
    groupId: 'durable-send'
};

interface DurableSendStart {
    readonly startedAtMs: number;
    readonly phase: FramePhase;
    readonly admission: Promise<ALOutboundEnqueueResult>;
    readonly dispatch: Promise<DurableSendDispatch>;
}

/** How one plan builds its message, plans its send, and what the server answers once it admits it. */
interface DurableSendPlanShape {
    readonly batchEnd: Exclude<DurableSendBatchEnd, 'timeout'>;
    readonly toMessage: (resourceId: string) => ALMessage;
    readonly planOutgoingMessage: (
        msg: ALMessage
    ) => ALOutboundDispatchPlan<ALOutboundTransportMessage>;
    /** Undefined for a plan that tracks no receipt. */
    readonly toServerReceipt: ((msg: ALMessage) => ALMessage) | undefined;
}

namespace PlainPageDurableSendHarness {
    export interface Input {
        readonly shape: DurableSendPlanShape;
        readonly runtime: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
        readonly observation: DurableSendObservation;
        readonly frameLoad: PacedFrameLoad;
    }
}

class PlainPageDurableSendHarness implements DurableSendHarness {
    private readonly shape: DurableSendPlanShape;
    private readonly runtime: ALOutboundMessageRuntime<ALOutboundTransportMessage>;
    private readonly observation: DurableSendObservation;
    private readonly frameLoad: PacedFrameLoad;

    constructor(input: PlainPageDurableSendHarness.Input) {
        this.shape = input.shape;
        this.runtime = input.runtime;
        this.observation = input.observation;
        this.frameLoad = input.frameLoad;
    }

    async runSends(input: DurableSendRunInput): Promise<DurableSendRun> {
        if (input.frameLoad !== undefined) {
            this.frameLoad.start(input.frameLoad);
        }
        try {
            const samples = await this.sendAll(input);
            return { samples, frameLoad: this.frameLoad.stop() };
        }
        finally {
            this.frameLoad.stop();
        }
    }

    private async sendAll(input: DurableSendRunInput): Promise<DurableSendSample[]> {
        const samples: DurableSendSample[] = [];
        for (let index = 0; index < input.warmupCount + input.measuredCount; index += 1) {
            const sample = await this.sendOnce(input, index);
            if (index >= input.warmupCount) {
                samples.push(sample);
            }
        }
        return samples;
    }

    /**
     * One durable send, the wait for its own batch to go idle, then the server's receipt, so the next send starts
     * on an idle owner with no receipt open.
     */
    private async sendOnce(input: DurableSendRunInput, index: number): Promise<DurableSendSample> {
        const msg = this.shape.toMessage(`${input.runId}-${index}`);
        const start = await new Promise<DurableSendStart>((resolve) =>
            this.frameLoad.runAtFrameOffset(
                toPhaseOffsetMs(input.frameLoad, index),
                () => resolve(this.startSend(msg, index))
            )
        );
        const [admission, dispatch] = await Promise.all([start.admission, start.dispatch]);
        assertDurableAdmission(admission);
        const batchDrain = await dispatch.batchDrain;
        return {
            sendToDispatchMs: dispatch.atMs - start.startedAtMs,
            phaseOffsetMs: start.phase.offsetMs,
            framesStraddled: dispatch.framesStarted - start.phase.framesStarted,
            batchEnd: batchDrain.endedOn,
            observedProbeCauses: batchDrain.observedProbeCauses,
            receiptEnd: await this.answerServerReceipt(msg)
        };
    }

    private startSend(msg: ALMessage, index: number): DurableSendStart {
        const dispatch = this.observation.waitForDispatch(msg.id.msgId, index);
        const startedAtMs = performance.now();
        const admission = this.runtime.enqueueIfAbsent(msg);
        return {
            startedAtMs,
            phase: this.frameLoad.getFramePhase(startedAtMs),
            admission,
            dispatch
        };
    }

    /** The receipt reaches the client's own control path, as the WS client hands a control from its server. */
    private async answerServerReceipt(msg: ALMessage): Promise<DurableSendReceiptEnd> {
        if (this.shape.toServerReceipt === undefined) {
            return 'none';
        }
        const receiptEnd = this.observation.waitForReceiptEnd(msg.id.msgId);
        await acceptWsQueueBoxClientControlMessage(this.runtime, this.shape.toServerReceipt(msg));
        return await receiptEnd;
    }
}

function toPhaseOffsetMs(frameLoad: FrameLoadInput | undefined, index: number): number {
    return frameLoad === undefined ? 0 : (index * PHASE_STRIDE_MS) % frameLoad.frameIntervalMs;
}

function assertDurableAdmission(result: ALOutboundEnqueueResult): void {
    if (result.verdict.kind !== 'admitted' || !result.verdict.durable) {
        throw new Error(`Expected a durable admission, received ${JSON.stringify(result.verdict)}`);
    }
}

function toHarnessMessage(sessionId: string, resourceId: string): ALMessage {
    return newALUnicastMessage(
        sessionId,
        { topicId: 'alm-harness', resourceId, contextId: 'durable-send' },
        'harness-peer',
        'alm-harness.durable-send.v1',
        { resourceId },
        { ttlMs: 60_000 }
    );
}

function toDurablePlan(msg: ALMessage): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    return {
        msg,
        dropReasonCode: undefined,
        persist: true,
        preparedMessages: [toALOutboundTransportMessage(msg)]
    };
}

/** The ledger's minimal durable plan: no receipt, no retry, no supersedence. */
function toMinimalPlanShape(sessionId: string): DurableSendPlanShape {
    return {
        batchEnd: 'effect-drain',
        toMessage: (resourceId) => toHarnessMessage(sessionId, resourceId),
        planOutgoingMessage: toDurablePlan,
        toServerReceipt: undefined
    };
}

/** A durable command to the server in a room, as `messages.room({ purpose: 'command' }).sendWs` builds it. */
function toReceiptedCommandPlanShape(sessionId: string): DurableSendPlanShape {
    const qosProvider = toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined);
    return {
        batchEnd: 'readiness-probe',
        toMessage: (resourceId) =>
            createBrowserUnicastMessage({
                creation: { createUnicast: newALUnicastMessage, newResourceId: () => resourceId },
                resolved: {
                    input: {
                        typeId: 'alm-harness.command.v1',
                        topicId: 'alm-harness',
                        payload: { resourceId }
                    },
                    scope: 'room',
                    roomId: HARNESS_ROOM.groupId,
                    roomRef: HARNESS_ROOM
                },
                peerId: HARNESS_SERVER_PEER_ID,
                payload: { resourceId },
                senderId: sessionId,
                channel: { purpose: 'command', durability: 'local-outbox' },
                laneTtlMs: AL_CHANNEL_SEND_DEFAULTS.command.ttlMs
            }),
        planOutgoingMessage: (msg) =>
            toWsQueueBoxClientDispatchPlan(msg, {
                sessionId,
                serverPeerId: HARNESS_SERVER_PEER_ID,
                socketOpen: true,
                qosProvider
            }),
        toServerReceipt: (msg) => toServerAcknowledgement(sessionId, msg)
    };
}

/** The server's own ACK for a command addressed to it: it speaks for itself as the recipient. */
function toServerAcknowledgement(sessionId: string, msg: ALMessage): ALMessage {
    const observedAtEpochMs = Date.now();
    return newALAckControlMessage(
        {
            v: 2,
            msgId: `${HARNESS_SERVER_PEER_ID}-ack:${msg.id.msgId}`,
            senderId: HARNESS_SERVER_PEER_ID,
            ts: observedAtEpochMs
        },
        {
            ackedMsgId: msg.id.msgId,
            fromPeerId: HARNESS_SERVER_PEER_ID,
            toPeerId: sessionId,
            originPeerId: sessionId,
            logicalRecipientPeerId: HARNESS_SERVER_PEER_ID,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs
        }
    );
}

function toDurableSendPlanShape(plan: DurableSendPlan, sessionId: string): DurableSendPlanShape {
    return plan === 'minimal'
        ? toMinimalPlanShape(sessionId)
        : toReceiptedCommandPlanShape(sessionId);
}

/**
 * The browser WS client's durable outbound owner over the browser's IndexedDB store pair, on a
 * private engine with no inbound owner and no volatile pair, and a carrier that records when it is called.
 */
export async function createDurableSendHarness(
    sessionId: string,
    plan: DurableSendPlan
): Promise<DurableSendHarness> {
    const frameLoad = new PacedFrameLoad();
    const shape = toDurableSendPlanShape(plan, sessionId);
    const observation = new DurableSendObservation({ frameLoad, batchEnd: shape.batchEnd });
    const stores = createBrowserALOutboundRuntimeStores(
        toBrowserWsClientALRuntimeStoreId(sessionId),
        { canonicalScope: `browser-session:${sessionId}` }
    );
    const runtime = createDefaultALOutboundMessageRuntime<ALOutboundTransportMessage>({
        stores,
        outbox: stores.workQueue,
        carrier: 'ws',
        decodePreparedMessage: decodeALOutboundTransportMessage,
        toOutboxEntry: (msg) =>
            QueueBoxUtilities.toResourceEntryFromMsg(msg, EnqueuedType.WS_OUTBOX),
        readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
        planOutgoingMessage: shape.planOutgoingMessage,
        diagnostics: (event) => observation.observeDiagnostics(event),
        // The minimal plan keeps no settlement sink, so its chain stays the one earlier heads measured.
        settlements: shape.toServerReceipt === undefined
            ? undefined
            : (settlement) => observation.observeSettlement(settlement),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            observation.observeDispatch(lifecycle.canonicalMessage.id.msgId);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    await runtime.ready();
    return new PlainPageDurableSendHarness({ shape, runtime, observation, frameLoad });
}
```

`durable-send-harness-page.ts`, full file:

```ts
import { createDurableSendHarness } from './create-durable-send-harness.ts';
import {
    DURABLE_SEND_HARNESS_GLOBAL,
    DURABLE_SEND_PLAN_PARAMETER,
    DURABLE_SEND_PLANS
} from './durable-send-harness-contract.ts';

const plan = DURABLE_SEND_PLANS.find((candidate) =>
    candidate === new URLSearchParams(location.search).get(DURABLE_SEND_PLAN_PARAMETER)
);
if (plan === undefined) {
    throw new Error(
        `The harness page names no plan in its "${DURABLE_SEND_PLAN_PARAMETER}" parameter`
    );
}

Reflect.set(
    globalThis,
    DURABLE_SEND_HARNESS_GLOBAL,
    await createDurableSendHarness(crypto.randomUUID(), plan)
);
```

- [ ] **Step 8: The runner names the plan in the page URL.**

```diff
diff --git a/tests/playwright/alm/run-durable-send-configuration.ts b/tests/playwright/alm/run-durable-send-configuration.ts
index 570e7fc0e..21fc77faf 100644
--- a/tests/playwright/alm/run-durable-send-configuration.ts
+++ b/tests/playwright/alm/run-durable-send-configuration.ts
@@ -3,7 +3,9 @@ import type { BrowserContext, CDPSession, Page } from '@playwright/test';
 import type { CpuProfile } from './compute-cpu-profile-shares.ts';
 import {
     DURABLE_SEND_HARNESS_GLOBAL,
+    DURABLE_SEND_PLAN_PARAMETER,
     type DurableSendHarness,
+    type DurableSendPlan,
     type DurableSendRun,
     type DurableSendRunInput,
     type FrameLoadInput
@@ -22,6 +24,11 @@ export interface DurableSendConfiguration {
     readonly frameLoad: FrameLoadInput | undefined;
 }
 
+/** A run on a fresh page that composes one runtime for the plan it names. */
+export interface DurableSendPageRunInput extends Omit<DurableSendRunInput, 'frameLoad'> {
+    readonly plan: DurableSendPlan;
+}
+
 interface HarnessPage {
     readonly page: Page;
     readonly cdp: CDPSession;
@@ -42,7 +49,7 @@ export async function routeDurableSendHarness(
 }
 
 export async function readBrowserVersion(context: BrowserContext): Promise<string> {
-    const { page, cdp } = await openHarnessPage(context);
+    const { page, cdp } = await openHarnessPage(context, 'minimal');
     try {
         return (await cdp.send('Browser.getVersion')).product;
     }
@@ -54,15 +61,16 @@ export async function readBrowserVersion(context: BrowserContext): Promise<strin
 export async function runDurableSendConfiguration(
     context: BrowserContext,
     configuration: DurableSendConfiguration,
-    input: Omit<DurableSendRunInput, 'frameLoad'>
+    input: DurableSendPageRunInput
 ): Promise<DurableSendRun> {
-    const harnessPage = await openHarnessPage(context);
+    const { plan, ...runInput } = input;
+    const harnessPage = await openHarnessPage(context, plan);
     try {
         await harnessPage.cdp.send('Emulation.setCPUThrottlingRate', {
             rate: configuration.cpuThrottlingRate
         });
         return await runSendsInPage(harnessPage.page, {
-            ...input,
+            ...runInput,
             frameLoad: configuration.frameLoad
         });
     }
@@ -73,10 +81,11 @@ export async function runDurableSendConfiguration(
 
 export async function profileDurableSends(
     context: BrowserContext,
-    input: Omit<DurableSendRunInput, 'frameLoad'>
+    input: DurableSendPageRunInput
 ): Promise<CpuProfile> {
-    const harnessPage = await openHarnessPage(context);
-    const idle = { ...input, frameLoad: undefined };
+    const { plan, ...runInput } = input;
+    const harnessPage = await openHarnessPage(context, plan);
+    const idle = { ...runInput, frameLoad: undefined };
     try {
         await runSendsInPage(harnessPage.page, { ...idle, measuredCount: 0 });
         await harnessPage.cdp.send('Profiler.enable');
@@ -96,10 +105,10 @@ export async function profileDurableSends(
     }
 }
 
-async function openHarnessPage(context: BrowserContext): Promise<HarnessPage> {
+async function openHarnessPage(context: BrowserContext, plan: DurableSendPlan): Promise<HarnessPage> {
     const page = await context.newPage();
     const cdp = await context.newCDPSession(page);
-    await page.goto(HARNESS_PAGE_URL);
+    await page.goto(`${HARNESS_PAGE_URL}?${new URLSearchParams({ [DURABLE_SEND_PLAN_PARAMETER]: plan })}`);
     await page.waitForFunction(
         (name) => Reflect.has(globalThis, name),
         DURABLE_SEND_HARNESS_GLOBAL
```

- [ ] **Step 9: The report carries the plan and prints one row per configuration and plan.**

```diff
diff --git a/tests/playwright/alm/durable-send-report.ts b/tests/playwright/alm/durable-send-report.ts
index 293138183..853dd4920 100644
--- a/tests/playwright/alm/durable-send-report.ts
+++ b/tests/playwright/alm/durable-send-report.ts
@@ -8,7 +8,7 @@ import {
     computePercentile,
     computeSendToDispatchPercentiles
 } from './compute-send-to-dispatch-percentiles.ts';
-import type { DurableSendRun } from './harness/durable-send-harness-contract.ts';
+import type { DurableSendPlan, DurableSendRun } from './harness/durable-send-harness-contract.ts';
 import type { DurableSendConfiguration } from './run-durable-send-configuration.ts';
 
 const REPORT_DIRECTORY = resolve(
@@ -17,6 +17,7 @@ const REPORT_DIRECTORY = resolve(
 );
 
 export interface DurableSendRunFigures {
+    readonly plan: DurableSendPlan;
     readonly p50Ms: number;
     readonly p95Ms: number;
     readonly unsettledCount: number;
@@ -24,6 +25,8 @@ export interface DurableSendRunFigures {
     readonly batchEnds: Readonly<Record<string, number>>;
     /** Every durable probe seen during those waits, counted by cause. */
     readonly observedProbeCauses: Readonly<Record<string, number>>;
+    /** How each send's server receipt ended, counted; `none` for a plan that tracks no receipt. */
+    readonly receiptEnds: Readonly<Record<string, number>>;
     /** Share of sends faster than one frame interval; null on an idle page. */
     readonly fastModeShare: number | null;
     readonly frameLoadBusyShare: number | null;
@@ -34,6 +37,7 @@ export interface DurableSendRunFigures {
 }
 
 export interface DurableSendConfigurationFigures extends DurableSendConfiguration {
+    readonly plan: DurableSendPlan;
     readonly runs: readonly DurableSendRunFigures[];
     readonly medianP50Ms: number;
     readonly medianP95Ms: number;
@@ -62,12 +66,14 @@ export interface DurableSendMethod {
 
 export function toConfigurationFigures(
     configuration: DurableSendConfiguration,
+    plan: DurableSendPlan,
     runs: readonly DurableSendRun[]
 ): DurableSendConfigurationFigures {
-    const figures = runs.map((run) => toRunFigures(configuration, run));
+    const figures = runs.map((run) => toRunFigures(configuration, plan, run));
     const fastModeShares = figures.map((run) => run.fastModeShare);
     return {
         ...configuration,
+        plan,
         runs: figures,
         medianP50Ms: computeMedian(figures.map((run) => run.p50Ms), 10),
         medianP95Ms: computeMedian(figures.map((run) => run.p95Ms), 10),
@@ -79,15 +85,18 @@ export function toConfigurationFigures(
 
 function toRunFigures(
     configuration: DurableSendConfiguration,
+    plan: DurableSendPlan,
     run: DurableSendRun
 ): DurableSendRunFigures {
     const sendToDispatchMs = run.samples.map((sample) => sample.sendToDispatchMs);
     const frameIntervalMs = configuration.frameLoad?.frameIntervalMs;
     return {
+        plan,
         ...computeSendToDispatchPercentiles(sendToDispatchMs),
         unsettledCount: run.samples.filter((sample) => sample.batchEnd === 'timeout').length,
         batchEnds: computeCountByKey(run.samples.map((sample) => sample.batchEnd)),
         observedProbeCauses: computeCountByKey(run.samples.flatMap((sample) => sample.observedProbeCauses)),
+        receiptEnds: computeCountByKey(run.samples.map((sample) => sample.receiptEnd)),
         fastModeShare: frameIntervalMs === undefined
             ? null
             : toFastModeShare(sendToDispatchMs, frameIntervalMs),
@@ -123,11 +132,12 @@ export async function writeDurableSendReport(report: DurableSendReport): Promise
     return path;
 }
 
-/** One line per configuration, each naming its figures, so a `grep p50` of the log keeps every row. */
+/** One line per configuration and plan, each naming its figures, so a `grep p50` of the log keeps every row. */
 export function toDurableSendTable(report: DurableSendReport): string {
     const rows = report.configurations.map((configuration) => {
         const runs = configuration.runs.map(toRunCell).join('  ');
-        return `${configuration.name.padEnd(18)} p50 ${String(configuration.medianP50Ms).padStart(5)} ms  ` +
+        const label = `${configuration.name.padEnd(18)} ${configuration.plan.padEnd(17)}`;
+        return `${label} p50 ${String(configuration.medianP50Ms).padStart(5)} ms  ` +
             `p95 ${String(configuration.medianP95Ms).padStart(5)} ms  ` +
             `fast ${configuration.medianFastModeShare ?? '-'}  runs p50/p95: ${runs}`;
     });
@@ -137,7 +147,7 @@ export function toDurableSendTable(report: DurableSendReport): string {
         `send-to-dispatch, median of ${report.method.runCount} runs of ${report.method.measuredCount} sends, ` +
         `${report.browser}, ${report.commit.slice(0, 9)}${tree}`,
         ...rows,
-        `idle CPU profile over ${report.method.profiledCount} sends: busy ${profile.busyMs} ms; ` +
+        `idle CPU profile of the minimal plan over ${report.method.profiledCount} sends: busy ${profile.busyMs} ms; ` +
         `polyfill ${profile.temporalPolyfillPercent} % + JSBI ${profile.jsbiPercent} % = ${profile.temporalPercent} %; ` +
         `codec self ${profile.codecSelfPercent} %, inclusive ${profile.codecInclusivePercent} %; ` +
         `polyfill + JSBI under the codec ${profile.temporalUnderCodecPercent} %`,
```

- [ ] **Step 10: The spec runs both plans and asserts per plan** (90 figures and `unsettledCount` 0 per run for both;
      the minimal plan's waits end on `effect-drain` and see no probe, the receipted plan's end on the probe after the
      drain and see only that probe; receipts `none` / `acknowledged` ×90; the profile assertions unchanged).

```diff
diff --git a/tests/playwright/alm/durable-send-plain-page.spec.ts b/tests/playwright/alm/durable-send-plain-page.spec.ts
index 402beff0d..54e7aa106 100644
--- a/tests/playwright/alm/durable-send-plain-page.spec.ts
+++ b/tests/playwright/alm/durable-send-plain-page.spec.ts
@@ -23,6 +23,12 @@ import {
     type DurableSendConfigurationFigures,
     type DurableSendMethod
 } from './durable-send-report.ts';
+import {
+    DURABLE_SEND_PLANS,
+    type DurableSendBatchEnd,
+    type DurableSendPlan,
+    type DurableSendReceiptEnd
+} from './harness/durable-send-harness-contract.ts';
 import {
     DURABLE_SEND_HARNESS_SCRIPT_URL,
     profileDurableSends,
@@ -54,28 +60,44 @@ const CONFIGURATIONS: readonly DurableSendConfiguration[] = [
     }
 ];
 
+/** Where each plan's batch goes idle and how its receipt ends; a receipted send's batch is followed by a probe. */
+const PLAN_EXPECTATIONS: Readonly<
+    Record<DurableSendPlan, { readonly batchEnd: DurableSendBatchEnd; readonly receiptEnd: DurableSendReceiptEnd; }>
+> = {
+    minimal: { batchEnd: 'effect-drain', receiptEnd: 'none' },
+    'receipted-command': { batchEnd: 'readiness-probe', receiptEnd: 'acknowledged' }
+};
+
+function computeCountSum(counts: Readonly<Record<string, number>>): number {
+    return Object.values(counts).reduce((sum, count) => sum + count, 0);
+}
+
 async function measureConfiguration(
     context: BrowserContext,
-    configuration: DurableSendConfiguration
+    configuration: DurableSendConfiguration,
+    plan: DurableSendPlan
 ): Promise<DurableSendConfigurationFigures> {
     const runs = [];
     for (let run = 0; run < METHOD.runCount; run += 1) {
         runs.push(
             await runDurableSendConfiguration(context, configuration, {
-                runId: `${configuration.name}-${run}`,
+                plan,
+                runId: `${configuration.name}-${plan}-${run}`,
                 warmupCount: METHOD.warmupCount,
                 measuredCount: METHOD.measuredCount
             })
         );
     }
-    return toConfigurationFigures(configuration, runs);
+    return toConfigurationFigures(configuration, plan, runs);
 }
 
 async function measureProfileShares(
     context: BrowserContext,
     bundle: DurableSendHarnessBundle
 ): Promise<CpuProfileShares> {
+    // The minimal plan only, so the attribution compares with the profiles of earlier heads.
     const profile = await profileDurableSends(context, {
+        plan: 'minimal',
         runId: 'profile',
         warmupCount: METHOD.warmupCount,
         measuredCount: METHOD.profiledCount
@@ -119,19 +141,25 @@ function expectRunsSettled(configurations: readonly DurableSendConfigurationFigu
     // a durable probe ran inside a send's batch, or the profile could not attribute its samples;
     // never on a latency value.
     for (const configuration of configurations) {
+        const label = `${configuration.name} ${configuration.plan}`;
         expect(
             configuration.runs.map((run) => [run.sendToDispatchMs.length, run.unsettledCount]),
-            `${configuration.name}: every measured send was dispatched and its batch went idle`
+            `${label}: every measured send was dispatched and its batch went idle`
         )
             .toEqual(Array(METHOD.runCount).fill([METHOD.measuredCount, 0]));
+        const expected = PLAN_EXPECTATIONS[configuration.plan];
         expect(
             configuration.runs.map((run) => run.batchEnds),
-            `${configuration.name}: every wait ended on its own batch's drain`
-        ).toEqual(Array(METHOD.runCount).fill({ 'effect-drain': METHOD.measuredCount }));
+            `${label}: every wait ended where its plan's batch goes idle`
+        ).toEqual(Array(METHOD.runCount).fill({ [expected.batchEnd]: METHOD.measuredCount }));
+        expect(
+            configuration.runs.map((run) => computeCountSum(run.observedProbeCauses)),
+            `${label}: a wait saw only the probe it ended on`
+        ).toEqual(Array(METHOD.runCount).fill(expected.batchEnd === 'readiness-probe' ? METHOD.measuredCount : 0));
         expect(
-            configuration.runs.map((run) => run.observedProbeCauses),
-            `${configuration.name}: no send's wait saw a durable probe`
-        ).toEqual(Array(METHOD.runCount).fill({}));
+            configuration.runs.map((run) => run.receiptEnds),
+            `${label}: every receipt ended as its plan expects`
+        ).toEqual(Array(METHOD.runCount).fill({ [expected.receiptEnd]: METHOD.measuredCount }));
     }
 }
 
@@ -144,7 +172,9 @@ test('a durable send on a plain page with an on-disk profile reports send-to-dis
         await routeDurableSendHarness(context, bundle.script);
         const configurations = [];
         for (const configuration of CONFIGURATIONS) {
-            configurations.push(await measureConfiguration(context, configuration));
+            for (const plan of DURABLE_SEND_PLANS) {
+                configurations.push(await measureConfiguration(context, configuration, plan));
+            }
         }
         const report = {
             createdAt: new Date().toISOString(),
```

- [ ] **Step 11: Typecheck the harness (no gate typechecks `tests/playwright/**`, R-P1a-16).** Throwaway config at
      `<scratchpad>/t5-tsc/tsconfig.json` (absolute `<root>` = the worktree):

```json
{
  "compilerOptions": {
    "erasableSyntaxOnly": true,
    "noEmit": true,
    "target": "ES2023",
    "module": "ESNext",
    "strict": true,
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "types": ["node"],
    "typeRoots": ["<root>/node_modules/@types"],
    "lib": ["ES2023", "DOM"],
    "paths": {
      "@shared-web/*": ["<root>/packages/shared-web/*"],
      "@shared-server/*": ["<root>/packages/shared-server/*"],
      "@shared-graph/*": ["<root>/packages/shared-graph/*"],
      "@shared-test/*": ["<root>/packages/shared-test/*"],
      "@shared/*": ["<root>/packages/shared/*"],
      "@relic-hunters/*": ["<root>/packages/relic-hunters/*"]
    }
  },
  "include": ["<root>/tests/playwright/alm/**/*.ts"]
}
```

`npx tsc -p <scratchpad>/t5-tsc/tsconfig.json` → exit 0 (397 files listed at the base).

- [ ] **Step 12: Run the harness** (sandbox off, foreground, 10-minute timeout, 1-min load average < 5, nothing
      listening on 18080-18082/5177/5178/5180: `lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(18080|18081|18082|5177|5178|5180) '`
      empty). `npm run -s perf:alm:durable-send` → eight `p50` rows (four configurations × two plans), `2 passed (3.2m)`.
      Expected shape: receipted p95 in the hundreds of ms to ~1.8 s at idle/cpu-4x/frame-load while the head-of-line
      stall above stands; the spec passes regardless (evidence, not a gate).

- [ ] **Step 13: Constraint checks.**
  - `npx dprint check <the ten files>` → clean (format only touched files).
  - `node scripts/check-tests-typecheck.mjs` → `PASS: no new type errors in the maintained test project` (1404 test
    files). In a worktree without `apps/rallar-black-box/node_modules` it fails on `vite.config.ts` (`@vitejs/plugin-react`
    not found) — environmental, identical without this change.
  - `npm run check:test-reachability` → `Test reachability: 1705 test files, 1700 reached by CI, 6 manual.`
  - `npm --workspace @ar-eye-hunter/shared-web run typecheck`, `npm --workspace @ar-eye-hunter/shared-server run typecheck`,
    `cd apps/api-v1 && deno task check` → exit 0.
  - `npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` → red at 293
    ("measures 293.120 KiB against 293"), green after the budget file reads 294; `npm --workspace
    @ar-eye-hunter/shared-web run check:browser-bundles` → `browser/rallar.ts` 229.6 KiB < 230 ok. (On the base
    `9e8b9fc07` without Task 3 the headless agent stayed under 293.)
  - `npm run test:unit:main` (sandbox off) → all pass except, in a worktree without app-nested deps, the two
    `@vitejs/plugin-react` failures (`control-bootstrap.test.ts`, `recipe-console-build-boundary.test.ts`), which pass
    with the deps present (`Test Files 2 passed`, `Tests 14 passed`).
  - After the commit: `npm run check:repo-style:changed -- origin/main HEAD` → `PASS: no new repository style findings`;
    `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` → `PASS` ×3.
    Note: an apostrophe inside a template literal in the spec (`each send's ...`) toggles the style walker's string
    state and surfaces the pre-existing `'unknown cpu'` as a new `boundary.unknown`; keep assertion messages
    apostrophe-free.

- [ ] **Step 14: Commit.**
      `git add packages/tests/rallar-black-box-headless/headless-bundle-budget.json packages/shared/services/ws-queue-box-client-service.ts packages/shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts packages/tests/shared/services/to-ws-queue-box-client-dispatch-plan.test.ts tests/playwright/alm/durable-send-plain-page.spec.ts tests/playwright/alm/durable-send-report.ts tests/playwright/alm/run-durable-send-configuration.ts tests/playwright/alm/harness/create-durable-send-harness.ts tests/playwright/alm/harness/durable-send-harness-contract.ts tests/playwright/alm/harness/durable-send-harness-page.ts tests/playwright/alm/harness/durable-send-observation.ts`
      `git commit -m "Measure a receipted command beside the minimal plan in the durable-send harness" -m "The WS client's dispatch plan moves to an exported function the client and the harness share. The harness page composes either the ledger's minimal plan or a durable command to the server on the command channel, planned as the WS client plans it and acknowledged with the server's own ACK through the client's control path; every configuration runs both plans and the report prints one row each." -m "The headless agent measures 293.120 KiB against its 293 KiB budget once the planner is its own module; the budget rises to 294 KiB."`

- [ ] **Step 15 (close task, evidence):** the reading goes to `evidence/harness-p1b.md` at execution: three
      invocations at the final head, both plans, machine and browser stated, the note that it is a desktop without vsync,
      not a phone; the receipted cpu-4x-frame-load p95 is the I2b evidence figure (D115: evidence, not a gate).

#### Measured (prototype on the base, `c8536e6cd`, `dirty: false`)

Machine darwin arm64 Apple M2 Max, HeadlessChrome/149.0.7827.55. Five invocations ran on 2026-10-01; three met every
condition and are the reading: 10:06-10:09 UTC (load 4.90 → 4.29), 10:13-10:16 (3.95 → 5.57), 10:17-10:20
(4.86 → 4.38), nothing listening on the six ports, no other Playwright run. Excluded: 09:56 (started at load 5.12)
and 10:09-10:12 (an idle `deno` held 18080); their figures fall inside the same ranges. Every invocation passed:
90 figures and `unsettledCount` 0 in every run of both plans, receipts `acknowledged` ×90 in every receipted run.
Artifacts: `scratch-4/tmp/perf/alm-durable-send/2026-10-01T10-09-35-067Z.json`, `...T10-16-34-126Z.json`,
`...T10-20-04-865Z.json`; logs `t5-tsc/run-{2,4,5}.log`.

Invocation medians (p50 / p95 ms; frame-load rows add the fast share):

| configuration     | minimal 1 / 2 / 3                                 | receipted-command 1 / 2 / 3                          |
| ----------------- | ------------------------------------------------- | ---------------------------------------------------- |
| idle              | 3.2/3.8; 3.0/3.6; 3.0/3.5                         | 5.2/1651.8; 5.1/1718.3; 5.1/1621.4                   |
| cpu-4x            | 10.6/13.6; 10.8/13.1; 10.4/11.9                   | 16.6/1272.1; 18.9/1185.6; 16.2/1247.3                |
| frame-load        | 13.3/23.7, 0.72; 10.3/22.5, 0.72; 11.4/23.7, 0.69 | 20.3/937.3, 0.38; 23.8/961.5, 0.26; 20.6/910.9, 0.37 |
| cpu-4x-frame-load | 30.6/51.6, 0.07; 32.8/50.9, 0.04; 34.7/57.2, 0.03 | 57.1/220.1, 0; 56.5/224.9, 0; 59.3/213.1, 0          |

Run-level ranges over the nine runs per row, the stalled sends, and (diagnostic only, not the reading) the pooled
percentiles of the sends at or under 500 ms:

| configuration     | plan              | run p50   | run p95       | sends > 500 ms | pooled p50/p95 of sends ≤ 500 ms |
| ----------------- | ----------------- | --------- | ------------- | -------------- | -------------------------------- |
| idle              | minimal           | 2.9–3.4   | 3.3–4.0       | 0 of 810       | 3.0/3.6                          |
| idle              | receipted-command | 4.8–5.5   | 1548.9–1841.5 | 54 of 810      | 5.0/109.5                        |
| cpu-4x            | minimal           | 10.2–11.7 | 11.7–14.1     | 0 of 810       | 10.7/12.8                        |
| cpu-4x            | receipted-command | 15.9–21.8 | 1005.7–1326.1 | 54 of 810      | 16.9/147.6                       |
| frame-load        | minimal           | 8.9–13.3  | 21.9–26.1     | 0 of 810       | 11.4/23.7                        |
| frame-load        | receipted-command | 18.3–25.4 | 831.5–1144.0  | 54 of 810      | 19.9/160.0                       |
| cpu-4x-frame-load | minimal           | 30.3–37.2 | 47.6–62.3     | 0 of 810       | 33.1/53.2                        |
| cpu-4x-frame-load | receipted-command | 51.0–62.8 | 200.5–228.7   | 5 of 810       | 56.8/216.0                       |

Reading:

- **The D115 figure.** A receipted, durable `command` send to the server at 4x CPU under the 10-in-16 ms frame load:
  p95 200.5–228.7 ms run level (invocation medians 220.1, 224.9, 213.1), p50 51.0–62.8 ms, on an Apple M2 Max with
  HeadlessChrome 149, a desktop without vsync, not a phone. The minimal plan beside it: p95 47.6–62.3, p50 30.3–37.2.
- **The receipt's own cost** shows in the p50 (invocation medians): +2 ms idle (3.0-3.2 → 5.1-5.2), +6-8 ms at cpu-4x,
  +7-13 ms under the frame load, +22-27 ms at cpu-4x-frame-load. Not attributed further here; the plan writes a
  receipt row and an ACK-timeout work row in the send's commit, which the minimal plan does not.
- **The p95 at idle, cpu-4x and frame-load is the head-of-line stall**, not chain cost: exactly 6 of 90 sends per run
  wait for the earliest hidden ACK-timeout row (0.7-1.9 s), and the send after each waits ~110-200 ms behind the batch
  that drains the due rows; 6/90 is above 5 %, so p95 lands on a stall.
- **At cpu-4x-frame-load** a send cycle is ~150 ms, so fewer than 16 rows are pending and stalls are rare (5 of 810),
  but the run outlives the 2 s timeout and the earlier sends' no-op ACK-timeout batches run between later sends; the
  `batch` probe counts (13-24 per run) are those batches. That interleaving, not the stall, carries this p95.
- **The trial runs before the final wait** (no wait for the ACK batch's drain) read idle receipted p50 6.8-7.4 ms;
  waiting for that drain moved it to 4.8-5.5 ms, so the overlap was the empty batch the ACK's commit wakes.
- **After Task 3** (verification on `93f67ce6c`, one invocation, load 4.27 → 11.81 at the end): minimal waits end on
  `effect-drain` with no probe (`{"effect-drain":90}`, `{}`), receipted waits on the probe after the drain
  (`{"readiness-probe":90}`, own-commit 66-90 + batch 0-24 per run), receipts `acknowledged` ×90, 6 stalls per run at
  idle/cpu-4x/frame-load, 0 at cpu-4x-frame-load; receipted p50/p95 medians 5.4/1731.1, 17.4/1245.8, 19.1/868.3,
  75.1/136.7 (the last row under a load that rose to 11.8 during the profile; not a reading).

#### Prototype on the base (what the measured commit differs in)

On `9e8b9fc07` the per-send end is still P1a's own-probe wait (`ownProbe`, `probeEnd`, `DURABLE_SEND_OWN_PROBE_CAUSES`),
so `c8536e6cd`'s observation keeps that wait for both plans (the receipted plan's own probe is the `own-commit` or
`batch` probe after its batch, the same probe Task 3's version ends on after the drain) and adds the same settlement
and drain waiters; the spec asserts P1a's three probe checks per plan plus the receipt end. Everything else
(planner move, plan shape, ACK, page parameter, runner, report) is identical to the code above.

---

### Task 6: An ACK that completes a receipt also completes the send's ACK-timeout work row

Prototyped in `scratch-4b` on top of Task 3 (`bd477f3f4`) and Task 5 (`93f67ce6c`): commit `dd00b4cd3`. Diffs
below are against `93f67ce6c`.

**Files**

- Modify `packages/shared/alm/outbound/to-al-outbound-effect-id.ts` (1-14): add `toALOutboundAckTimeoutEffectId`, the
  one name of a receipt's timeout check (the literal was written twice before: `compute-al-outbound-dispatch.ts:403-408`
  and `al-outbound-repair-admission.ts:363-368`; a third copy would have been needed here).
- Modify `packages/shared/alm/outbound/compute-al-outbound-dispatch.ts:24, 403` and
  `packages/shared/alm/outbound/al-outbound-repair-admission.ts:33, 363`: use it.
- Modify `packages/shared/alm/outbound/compute-al-outbound-control-admission.ts:21, 75-76, 91-100`: the candidate
  gains `endedAckTimeoutEffectId`, set when the control ended the receipt (the existing `removeRepairAttempt`
  condition: a completing ACK, a removed receipt, or a terminal NACK) and a receipt row was read.
- Create `packages/shared/alm/outbound/control/write-al-outbound-ack-timeout-completion.ts` (1-19).
- Modify `packages/shared/alm/outbound/control/al-outbound-control-admission.ts:58, 405-407`: `applyControlAdmission`
  calls it inside the control's own write transaction.
- Test `packages/tests/shared/alm/outbound/al-outbound-acknowledged-receipt-timeout.test.ts` (1-158, new).

**Interfaces**

- Produces `toALOutboundAckTimeoutEffectId(pending: Pick<ALOutboundPendingAckSnapshot, 'msgId' | 'attempts' |
  'deadlineAtMs'>): string` and `writeALOutboundAckTimeoutCompletion(tx: ALAdmissionWorkWriteContext, namespace:
  string, effectId: string): Promise<void>`; `ALControlAdmissionCandidate.endedAckTimeoutEffectId: string | undefined`.
- Consumes `ALAdmissionWorkWriteContext.readWork`/`writeWork` (`al-admission-work-backend.ts:20-27`: one write after
  the slot was read, guarded in the same conditional commit), `toALOutboundWorkKey`, `EntityStatus`.

**Survey (where the receipt's commit is, and what the hand-over really does).**

- The ACK reaches `ALOutboundControlAdmission.admit` (`control/al-outbound-control-admission.ts:119-147`): the read
  surface (`readControlAdmission`, :295-) includes the receipt row (`pending`), the pure
  `computeALOutboundControlAdmission` (`compute-al-outbound-control-admission.ts:83-108`) decides, and
  `writeControlAdmission` (:150-171) commits history, the receipt row, the repair-attempt removal and the version in
  one `backend.write` (`applyControlAdmission`, :369-410). A conflict writes nothing and retains the control for replay.
- The send's commit schedules the timeout check as a durable effect named by the receipt row
  (`compute-al-outbound-dispatch.ts:394-411`); a retry reschedules it under the next attempt
  (`al-outbound-repair-admission.ts:356-375`). The stored receipt row is always the snapshot that named the live row.
- Today nothing completes that row when the receipt ends: it runs at its deadline, reads the ended receipt and
  completes (`claimedCount 1`, no dispatch). **The hand-over does not delete it either** (correcting the brief):
  `handOver` (`al-outbound-message-runtime.ts:480-494`) deletes only the pending-ACK and repair-attempt _state_ rows in
  one commit (`toEndReceiptBundle`, `al-outbound-repair-admission.ts:379-394`), and its later work rows complete
  silently when they run (`al-outbound-send-controls.ts:46-58`). So there is no one-commit effect deletion to reuse.
  The reuse is the precedent of writing a completed work row inside an admission transaction:
  `al-outbound-pending-admission.ts:124` and `compute-al-outbound-dispatch.ts:80` (canonical entries written
  `COMPLETED`), through the same `readWork`/`writeWork` pair `al-outbound-canonical-storage.ts:160-187` uses.
- Why it stalled: the claim (`al-work-queue-port.ts:105-121` → `indexed-db-queue-box.ts:399-400`, "pages a claim in
  keyString order, not in readiness order") and the readiness scan (`al-outbound-work-entry.ts:131-156`) read 16 rows
  per status; with 16 pending timeout checks the next send's row is past the page. The key-order paging stays (a
  recorded limit: 16 _unacknowledged_ receipted sends within one ACK timeout still hide the next send; see open
  decision 1).

**D8 reuse inspection.** Reused: the control admission's existing write transaction and conditional commit (no new
transaction), the `readWork`/`writeWork` slot discipline and the precedent of writing a `COMPLETED` work entry inside
an admission commit, the existing receipt-ended condition (`removeRepairAttempt`), and the effect id the dispatch and
repair paths already wrote (now one function, removing a duplicated literal). `packages/shared/cache` has nothing for
a queue row; `packages/shared/resilience` (`Either`, `RateLimiter`) does not apply to a one-row completion. Not reused
because it does not exist: a hand-over effect deletion (see the survey). No new scan order, schema or dependency.

**Guarantees.** Settlements are unchanged: the commit states the same `acknowledgement` (complete) as before; a
partial ACK leaves the row (pinned); a timeout check that a batch already leased is left to that batch, which reads
the ended receipt and completes as today; a timeout that fires before the ACK is unchanged (the receipt is still
open, so no control ended it; `al-outbound-repair-policy.test.ts`, `al-outbound-receipt-exhaustion.test.ts` green). A
terminal NACK that ends a receipt completes the check too, which before ran as a no-op.

- [ ] **Step 1: Write the failing tests.** Create
      `packages/tests/shared/alm/outbound/al-outbound-acknowledged-receipt-timeout.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { toALOutboundEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { EntityStatus, type ALMessage } from '@shared/mod.ts';
import { acceptWsQueueBoxClientControlMessage } from '@shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';

import {
    createDefaultOutboundTestRuntime,
    createIndexedDbOutboundTestStores,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';
import { recordIndexedDbTransactionLedger } from '../record-indexed-db-transaction-ledger.ts';

const NAMESPACE = 'outbound-acknowledged-receipt';
const ACK_TIMEOUT_MS = 2_000;
/** One more than the work page of 16, which reads its rows in key order, not in readiness order. */
const SEND_COUNT = 17;

interface ReceiptedSendFixture {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly dispatchedAtMs: Map<string, number>;
    readonly settlements: ALDeliverySettlement[];
}

describe('an acknowledged receipt and its ACK-timeout work row', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('dispatches every one of 17 acknowledged receipted sends without waiting for an ACK timeout', async () => {
        const fixture = await createReceiptedSendFixture(['server']);
        const sendToDispatchMs: number[] = [];

        for (let index = 0; index < SEND_COUNT; index += 1) {
            const msg = createOutboundMessage(`receipted-${index}`);
            const startedAtMs = performance.now();
            expect((await fixture.runtime.enqueueIfAbsent(msg)).verdict).toMatchObject({
                kind: 'admitted'
            });
            await vi.waitFor(() => expect(fixture.dispatchedAtMs.has(msg.id.msgId)).toBe(true), {
                timeout: ACK_TIMEOUT_MS + 1_000,
                interval: 5
            });
            sendToDispatchMs.push(fixture.dispatchedAtMs.get(msg.id.msgId)! - startedAtMs);
            await acknowledge(fixture, msg, 'server');
        }

        // Left pending, the acknowledged sends' timeout rows filled the claim's page and the 16th send waited for the
        // first of them to fall due.
        expect(
            sendToDispatchMs.filter((ms) => ms >= ACK_TIMEOUT_MS / 2),
            JSON.stringify(sendToDispatchMs)
        )
            .toEqual([]);
    });

    it('completes the ACK-timeout row in the commit that completes the receipt', async () => {
        const fixture = await createReceiptedSendFixture(['server']);
        const msg = await sendUntilDispatched(fixture, 'complete-receipt');
        const timeoutKey = await readAckTimeoutKey(fixture, msg);
        expect((await fixture.stores.workQueue.getItem(timeoutKey))?.status).toBe(EntityStatus.NEW);

        await acknowledge(fixture, msg, 'server');

        expect((await fixture.stores.workQueue.getItem(timeoutKey))?.status).toBe(
            EntityStatus.COMPLETED
        );
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement'))
            .toEqual([expect.objectContaining({ msgId: msg.id.msgId, complete: true })]);
    });

    it('keeps the ACK-timeout row while the receipt still waits for another recipient', async () => {
        const fixture = await createReceiptedSendFixture(['server', 'peer-2']);
        const msg = await sendUntilDispatched(fixture, 'partial-receipt');
        const timeoutKey = await readAckTimeoutKey(fixture, msg);

        await acknowledge(fixture, msg, 'server');

        expect((await fixture.stores.workQueue.getItem(timeoutKey))?.status).toBe(EntityStatus.NEW);
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement'))
            .toEqual([expect.objectContaining({ msgId: msg.id.msgId, complete: false })]);
    });
});

async function createReceiptedSendFixture(
    expectedPeerIds: readonly string[]
): Promise<ReceiptedSendFixture> {
    const stores = createIndexedDbOutboundTestStores({
        observer: recordIndexedDbTransactionLedger().observer,
        namespace: NAMESPACE
    });
    const dispatchedAtMs = new Map<string, number>();
    const settlements: ALDeliverySettlement[] = [];
    const ackTracking: ALOutboundAckTrackingPlan = {
        enabled: true,
        timeoutMs: ACK_TIMEOUT_MS,
        maxAttempts: 3,
        expectedPeerIds,
        nextHopPeerIds: expectedPeerIds,
        mode: 'receiver'
    };
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [{ kind: 'send' }],
            ackTracking,
            retryTracking: { enabled: true, maxAttempts: 3 }
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            dispatchedAtMs.set(lifecycle.canonicalMessage.id.msgId, performance.now());
            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
    await runtime.ready();
    return { runtime, stores, dispatchedAtMs, settlements };
}

async function sendUntilDispatched(
    fixture: ReceiptedSendFixture,
    resourceId: string
): Promise<ALMessage> {
    const msg = createOutboundMessage(resourceId);
    await fixture.runtime.enqueueIfAbsent(msg);
    await vi.waitFor(() => expect(fixture.dispatchedAtMs.has(msg.id.msgId)).toBe(true));
    return msg;
}

/** The row the send's commit scheduled for its receipt's first timeout, named from the receipt it tracks. */
async function readAckTimeoutKey(fixture: ReceiptedSendFixture, msg: ALMessage) {
    const pending = await fixture.stores.admissionStore.readReceiptState({
        originPeerId: 'self',
        msgId: msg.id.msgId
    });
    expect(pending).toBeDefined();
    return toALOutboundWorkKey(
        NAMESPACE,
        toALOutboundEffectId([
            'ack-timeout',
            msg.id.msgId,
            pending!.attempts + 1,
            pending!.deadlineAtMs
        ])
    );
}

/** The recipient's own ACK, as the WS server answers a command addressed to it, through the client's control path. */
async function acknowledge(
    fixture: ReceiptedSendFixture,
    msg: ALMessage,
    recipientPeerId: string
): Promise<void> {
    const observedAtEpochMs = Date.now();
    const ack = newALAckControlMessage(
        {
            v: 2,
            msgId: `${recipientPeerId}-ack:${msg.id.msgId}`,
            senderId: recipientPeerId,
            ts: observedAtEpochMs
        },
        {
            ackedMsgId: msg.id.msgId,
            fromPeerId: recipientPeerId,
            toPeerId: 'self',
            originPeerId: 'self',
            logicalRecipientPeerId: recipientPeerId,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs
        }
    );
    expect(await acceptWsQueueBoxClientControlMessage(fixture.runtime, ack)).toEqual({
        kind: 'committed'
    });
}
```

- [ ] **Step 2: Run them and see the stall.**
      `npx vitest run packages/tests/shared/alm/outbound/al-outbound-acknowledged-receipt-timeout.test.ts`
      Expected: `Tests  2 failed | 1 passed (3)`:
  - the counter-case fails with the 16th send waiting for the first timeout row:
    `AssertionError: [16.66,4.48,4.17,3.72,4.09,3.73,5.22,3.13,3.64,4.13,3.81,3.76,3.73,4.07,3.47,1864.60,129.43]: expected [ 1864.6029580000002 ] to deeply equal []`
    (send-to-dispatch ms per send; the 17th waits 129 ms behind the batch that drains the 15 due rows);
  - the pin fails `expected 'NEW' to be 'COMPLETED'`;
  - the partial-receipt guard passes already (it pins that the fix must not touch an open receipt).

- [ ] **Step 3: Name the timeout check once.** `to-al-outbound-effect-id.ts`:

```diff
diff --git a/packages/shared/alm/outbound/to-al-outbound-effect-id.ts b/packages/shared/alm/outbound/to-al-outbound-effect-id.ts
index 179a0a530..77d80150b 100644
--- a/packages/shared/alm/outbound/to-al-outbound-effect-id.ts
+++ b/packages/shared/alm/outbound/to-al-outbound-effect-id.ts
@@ -1,5 +1,14 @@
+import type { ALOutboundPendingAckSnapshot } from '../al-runtime-state-stores.ts';
+
 export function toALOutboundEffectId(
     parts: readonly (number | string)[]
 ): string {
     return parts.map((part) => encodeURIComponent(String(part))).join(':');
 }
+
+/** The timeout check a receipt row schedules for its next attempt; the row's attempt and deadline name it. */
+export function toALOutboundAckTimeoutEffectId(
+    pending: Pick<ALOutboundPendingAckSnapshot, 'msgId' | 'attempts' | 'deadlineAtMs'>
+): string {
+    return toALOutboundEffectId(['ack-timeout', pending.msgId, pending.attempts + 1, pending.deadlineAtMs]);
+}
```

```diff
diff --git a/packages/shared/alm/outbound/compute-al-outbound-dispatch.ts b/packages/shared/alm/outbound/compute-al-outbound-dispatch.ts
index 1ec4a1f26..62a134f2b 100644
--- a/packages/shared/alm/outbound/compute-al-outbound-dispatch.ts
+++ b/packages/shared/alm/outbound/compute-al-outbound-dispatch.ts
@@ -21,7 +21,7 @@ import {
     toALOutboundDispatchCompletionReceipt,
     type ALOutboundDispatchCompletionRead
 } from './control/to-al-outbound-dispatch-completion-receipt.ts';
-import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
+import { toALOutboundAckTimeoutEffectId, toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
 import { toALOutboundPreparedFingerprint } from './to-al-outbound-prepared-fingerprint.ts';
 import {
     isALOutboundAckTrackingWritable,
@@ -400,12 +400,7 @@ function computeAckTrackingWrites<TPrepared>(
             expireAtTimestamp: messageExpiresAtMs
         }],
         durableEffects: [{
-            effectId: toALOutboundEffectId([
-                'ack-timeout',
-                pending.msgId,
-                pending.attempts + 1,
-                pending.deadlineAtMs
-            ]),
+            effectId: toALOutboundAckTimeoutEffectId(pending),
             retryAtMs: pending.deadlineAtMs,
             expireAtTimestamp: toALOutboundAckRetryScheduleEndTimestamp(pending, messageExpiresAtMs),
             payload: { kind: 'ack-timeout', msgId: pending.msgId }
```

```diff
diff --git a/packages/shared/alm/outbound/al-outbound-repair-admission.ts b/packages/shared/alm/outbound/al-outbound-repair-admission.ts
index d72a88fe5..e730fd144 100644
--- a/packages/shared/alm/outbound/al-outbound-repair-admission.ts
+++ b/packages/shared/alm/outbound/al-outbound-repair-admission.ts
@@ -30,7 +30,7 @@ import type {
 } from './control/al-outbound-control-admission.ts';
 import { toALOutboundReceiptExhaustedFact } from './control/to-al-outbound-receipt-exhausted-fact.ts';
 import { writeALOutboundControlAdmissionDiagnostic } from './control/write-al-outbound-control-admission-diagnostic.ts';
-import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
+import { toALOutboundAckTimeoutEffectId, toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
 import {
     isALOutboundReceiptComplete,
     toALOutboundAckRetryScheduleEndTimestamp
@@ -360,12 +360,7 @@ export class ALOutboundRepairAdmission<TPrepared> {
         messageExpiresAtMs: number
     ): ALOutboundDurableEffectWrite<TPrepared> {
         return {
-            effectId: toALOutboundEffectId([
-                'ack-timeout',
-                pending.msgId,
-                pending.attempts + 1,
-                pending.deadlineAtMs
-            ]),
+            effectId: toALOutboundAckTimeoutEffectId(pending),
             retryAtMs: pending.deadlineAtMs,
             expireAtTimestamp: toALOutboundAckRetryScheduleEndTimestamp(pending, messageExpiresAtMs),
             payload: {
```

- [ ] **Step 4: The decision: which check the control's commit completes.**

```diff
diff --git a/packages/shared/alm/outbound/compute-al-outbound-control-admission.ts b/packages/shared/alm/outbound/compute-al-outbound-control-admission.ts
index e0086620d..b1dffb452 100644
--- a/packages/shared/alm/outbound/compute-al-outbound-control-admission.ts
+++ b/packages/shared/alm/outbound/compute-al-outbound-control-admission.ts
@@ -18,7 +18,7 @@ import type {
 import type { ALStoredOutboundMessage } from './admission/al-outbound-admission-validation.ts';
 import type { ALOutboundSettlementFact } from './al-outbound-message-runtime.ts';
 import { toALOutboundReceiptExhaustedFact } from './control/to-al-outbound-receipt-exhausted-fact.ts';
-import { toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
+import { toALOutboundAckTimeoutEffectId, toALOutboundEffectId } from './to-al-outbound-effect-id.ts';
 import {
     acceptALOutboundPendingAckSnapshot,
     isALOutboundReceiptComplete,
@@ -72,6 +72,8 @@ export interface ALControlAdmissionCandidate {
     readonly history: ALControlHistory;
     readonly pending: ALPendingAckWrite;
     readonly removeRepairAttempt: boolean;
+    /** The timeout check of a receipt this control ended, which the same commit completes; undefined otherwise. */
+    readonly endedAckTimeoutEffectId: string | undefined;
     readonly receiptExpireAtTimestamp: number;
     readonly repairEffect?: ALRepairHintEffectWrite;
     readonly controlExpireAtTimestamp: number;
@@ -86,12 +88,16 @@ export function computeALOutboundControlAdmission(
     const history = appendControlHistory(read);
     const pending = computePendingAckWrite(read, history);
     const terminal = read.parsed.type === 'nack' && isTerminalNack(read.parsed.payload);
+    const receiptEnded = terminal || pending.kind === 'remove' ||
+        (pending.kind === 'set' && isALOutboundReceiptComplete(pending.value));
     return {
         read,
         history,
         pending,
-        removeRepairAttempt: terminal || pending.kind === 'remove' ||
-            (pending.kind === 'set' && isALOutboundReceiptComplete(pending.value)),
+        removeRepairAttempt: receiptEnded,
+        endedAckTimeoutEffectId: receiptEnded && read.pending !== undefined
+            ? toALOutboundAckTimeoutEffectId(read.pending)
+            : undefined,
         receiptExpireAtTimestamp: pending.kind === 'set' && !isALOutboundReceiptComplete(pending.value)
             ? read.sent?.reference.expiresAtMs ?? read.nowMs
             : Math.max(
```

- [ ] **Step 5: The write, in the control's own transaction.** Create
      `packages/shared/alm/outbound/control/write-al-outbound-ack-timeout-completion.ts`:

```ts
import { EntityStatus } from '../../../queuebox/ResourceEntry.ts';
import type { ALAdmissionWorkWriteContext } from '../../al-admission-work-backend.ts';
import { toALOutboundWorkKey } from '../al-outbound-work-entry.ts';

/**
 * Completes the waiting timeout check of a receipt this commit ends: left pending, it would only find nothing to
 * retry at its deadline, and until then it holds a slot of the key-ordered claim page. A check a batch already
 * leased is left to that batch.
 */
export async function writeALOutboundAckTimeoutCompletion(
    tx: ALAdmissionWorkWriteContext,
    namespace: string,
    effectId: string
): Promise<void> {
    const entry = await tx.readWork(toALOutboundWorkKey(namespace, effectId));
    if (entry?.status === EntityStatus.NEW || entry?.status === EntityStatus.RETRY) {
        tx.writeWork({ ...entry, status: EntityStatus.COMPLETED });
    }
}
```

```diff
diff --git a/packages/shared/alm/outbound/control/al-outbound-control-admission.ts b/packages/shared/alm/outbound/control/al-outbound-control-admission.ts
index c02922df7..c1a793048 100644
--- a/packages/shared/alm/outbound/control/al-outbound-control-admission.ts
+++ b/packages/shared/alm/outbound/control/al-outbound-control-admission.ts
@@ -55,6 +55,7 @@ import {
 } from '../compute-al-outbound-control-admission.ts';
 import { toALOutboundEffectId } from '../to-al-outbound-effect-id.ts';
 import { validateALOutboundControlAdmission } from '../validate-al-outbound-control-admission.ts';
+import { writeALOutboundAckTimeoutCompletion } from './write-al-outbound-ack-timeout-completion.ts';
 
 export type ALOutboundControlAdmissionResult =
     | Readonly<{ kind: 'not-handled'; }>
@@ -401,6 +402,9 @@ export class ALOutboundControlAdmission<TPrepared> {
         if (candidate.removeRepairAttempt) {
             await tx.remove(toALOutboundRepairAttemptKey(this.namespace, read.targetMsgId));
         }
+        if (candidate.endedAckTimeoutEffectId !== undefined) {
+            await writeALOutboundAckTimeoutCompletion(tx, this.namespace, candidate.endedAckTimeoutEffectId);
+        }
         await tx.set(
             toALOutboundVersionKey(this.namespace, read.owner!),
             candidate.nextVersion!,
```

(Kept out of `al-outbound-control-admission.ts` on purpose: inlined as a private method it raised that file's
cognitive load to 51, over the warn tier, and `check:repo-style:changed` failed.)

- [ ] **Step 6: Run the tests.** Same command → `Tests  3 passed (3)`. Counter-case send-to-dispatch after the fix,
      three runs (ms, sends 1-17): `[16,4.2,3.6,3.5,3.6,3.5,3.1,3.2,2.9,3.3,3.3,3.3,3.1,3.2,2.6,3.4,7.8]`,
      `[15.5,4.5,3.7,3.8,3.8,3.4,3,3.3,3.4,3.3,3.4,3.2,3.1,3.2,3,3.2,2.9]`,
      `[16.5,4.5,3.7,3.7,3.7,3.5,3.1,2.9,3.1,3.1,3,3.4,3.2,3.1,3,3.1,2.9]` (16th: 3.2-3.4 ms, was 1 864.6 ms).

- [ ] **Step 6b: The NACK case and the README sentence.** Add one case to
      `packages/tests/shared/alm/outbound/al-outbound-acknowledged-receipt-timeout.test.ts`: a terminal NACK that ends a
      receipt (the control the receiver sends when it refuses the message for good; build it with the same control
      constructor the ACK case uses, `status` set to the terminal refusal the existing NACK tests use, see
      `outbound-ack-conflict-replay.test.ts` for a sample) also leaves the send's `ack-timeout` row `COMPLETED` in the
      same commit, while the receipt settles as it does today (read the settlement back; assert it is unchanged against
      a run without the fix). Run the file: expected 4 passed. Then add one sentence to
      `packages/shared/alm/outbound/README.md` under "Receipt ends and the hand-over": a receipt that ends (a complete
      ACK or a terminal NACK) completes the send's ACK-timeout work row in the commit that ends it, so no no-op timeout
      batch follows; a row a batch already leased is left to that batch. Add both files to Step 9's `git add` list.

- [ ] **Step 7: The ledger and the suites.**
  - `npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
    → `Tests  24 passed (24)`: the minimal plan's pins do not move (no receipt, no control).
  - `npx vitest run packages/tests/shared/alm packages/tests/shared/services packages/tests/shared/ws-qos-policy.test.ts packages/tests/rallar-black-box-headless`
    → `Test Files  119 passed (119)`, `Tests  1407 passed (1407)`.
  - Receipted ledger (measured with a throwaway test, not committed; one warm receipted send then the pinned one,
    `ackTracking` receiver/server, timeout 2 000 ms, on Task 3's head): chain 8 transactions / 43 requests, chain +
    after-send 11 / 49 (`al-admission` 10, `al-work` 9), **identical with and without the fix**. The server ACK: 7
    transactions both ways (its commit and the batch it wakes), requests 26 → 29 (the commit's `readWork` of the
    timeout row and its `put`). In the 2.3 s after the ACKs of the warm and pinned sends: **16 transactions without
    the fix (the two no-op timeout batches), 0 with it**. Recommendation in open decision 2.

- [ ] **Step 8: Constraint checks.**
  - `npx tsc -p packages/shared/tsconfig.json --noEmit`, `npm --workspace @ar-eye-hunter/shared-web run typecheck`,
    `npm --workspace @ar-eye-hunter/shared-server run typecheck` → exit 0; `cd apps/api-v1 && deno task check` → exit 0.
  - `node scripts/check-tests-typecheck.mjs` (with `apps/rallar-black-box/node_modules` present) → `PASS` (1405 files).
  - `npm run check:test-reachability` → `Test reachability: 1707 test files, 1701 reached by CI, 6 manual.`
  - Bundles: headless agent 293.238 KiB < 294 (the budget Task 5 raised); `browser/rallar.ts` 229.6 KiB < 230.
  - `npm run test:unit:main` (sandbox off, app deps present) → `Test Files  1325 passed | 4 skipped (1329)`,
    `Tests  12344 passed | 12 skipped (12356)`.
  - dprint on the seven files → clean. After the commit: `npm run check:repo-style:changed -- origin/main HEAD` → `PASS`;
    `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` → `PASS` ×3.

- [ ] **Step 9: Commit.**
      `git add packages/shared/alm/outbound/to-al-outbound-effect-id.ts packages/shared/alm/outbound/compute-al-outbound-dispatch.ts packages/shared/alm/outbound/al-outbound-repair-admission.ts packages/shared/alm/outbound/compute-al-outbound-control-admission.ts packages/shared/alm/outbound/control/al-outbound-control-admission.ts packages/shared/alm/outbound/control/write-al-outbound-ack-timeout-completion.ts packages/tests/shared/alm/outbound/al-outbound-acknowledged-receipt-timeout.test.ts`
      `git commit -m "Complete an ended receipt's ACK-timeout check in the commit that ends it" -m "An acknowledgement that completes a receipt, or a NACK that ends it, now marks the receipt's pending ACK-timeout work row completed in the same commit. Left pending, the row only found nothing to retry at its deadline, and sixteen such rows filled the key-ordered claim page so the next send waited for the first of them to fall due. A row a batch has already leased is left to that batch."`

#### Harness: the receipted reading before and after (three invocations each)

Before = `c8536e6cd` (Task 5 on the base, `task-5.md`), after = `dd00b4cd3` (Task 3 + Task 5 + Task 6), both
`dirty: false`, Apple M2 Max, HeadlessChrome/149.0.7827.55, a desktop without vsync, not a phone. After-invocations
2026-10-01 11:06-11:10 UTC, load 4.66 → 4.08, 4.45 → 3.59, 3.59 → 3.99, nothing on the six ports; every run passed
(90 figures, `unsettledCount` 0, receipted waits `{"readiness-probe":90}` with `{"own-commit":90}`, receipts
`acknowledged` ×90); the suite took 1.3 min instead of 3.2. Artifacts `scratch-4b/tmp/perf/alm-durable-send/`
(`t5-tsc/t6-artifacts.txt`).

Invocation medians, p50/p95 ms:

| configuration     | minimal after                   | receipted before (c8536e6cd)          | receipted after (dd00b4cd3)     |
| ----------------- | ------------------------------- | ------------------------------------- | ------------------------------- |
| idle              | 3.0/3.5; 2.9/3.4; 3.0/3.4       | 5.2/1651.8; 5.1/1718.3; 5.1/1621.4    | 3.6/4.5; 3.6/4.4; 3.6/4.3       |
| cpu-4x            | 10.3/12.0; 10.3/11.8; 10.5/12.1 | 16.6/1272.1; 18.9/1185.6; 16.2/1247.3 | 11.9/14.0; 12.0/13.7; 11.8/13.6 |
| frame-load        | 10.1/23.3; 11.1/22.9; 12.9/23.3 | 20.3/937.3; 23.8/961.5; 20.6/910.9    | 12.6/23.7; 10.7/24.1; 13.3/25.2 |
| cpu-4x-frame-load | 30.3/51.6; 31.3/50.4; 31.5/51.4 | 57.1/220.1; 56.5/224.9; 59.3/213.1    | 33.5/55.0; 34.2/56.3; 32.9/54.7 |

Run-level ranges (nine runs per row):

| configuration     | plan                     | run p50               | run p95                   | sends > 500 ms |
| ----------------- | ------------------------ | --------------------- | ------------------------- | -------------- |
| idle              | minimal                  | 2.8–3.0               | 3.1–3.5                   | 0 of 810       |
| idle              | receipted before → after | 4.8–5.5 → 3.5–3.8     | 1548.9–1841.5 → 4.3–4.6   | 54 → 0 of 810  |
| cpu-4x            | minimal                  | 10.2–10.5             | 11.3–12.4                 | 0 of 810       |
| cpu-4x            | receipted before → after | 15.9–21.8 → 11.7–12.0 | 1005.7–1326.1 → 13.4–14.6 | 54 → 0 of 810  |
| frame-load        | minimal                  | 8.8–12.9              | 22.2–26.4                 | 0 of 810       |
| frame-load        | receipted before → after | 18.3–25.4 → 10.5–13.9 | 831.5–1144.0 → 21.9–26.5  | 54 → 0 of 810  |
| cpu-4x-frame-load | minimal                  | 30.2–31.7             | 48.8–53.8                 | 0 of 810       |
| cpu-4x-frame-load | receipted before → after | 51.0–62.8 → 32.6–35.1 | 200.5–228.7 → 53.5–60.2   | 5 → 0 of 810   |

Reading:

- **The D115 figure after Task 6:** a receipted durable `command` send at 4x CPU under the frame load reads p95
  53.5–60.2 ms (invocation medians 55.0, 56.3, 54.7), p50 32.6–35.1 ms, beside the minimal plan's 48.8–53.8 / 30.2–31.7.
- The stall is gone (0 sends over 500 ms in 3 240), and so are the no-op timeout batches that ran between later sends
  at cpu-4x-frame-load (receipted waits now see only `own-commit` probes; before, 13-26 `batch` probes per run).
- What remains is the receipt's own cost: +0.6 ms p50 idle (2.9-3.0 → 3.6), +1.5 ms at cpu-4x, +1-3 ms under the frame
  load, +2-3 ms at cpu-4x-frame-load; p95 +1 ms idle, +2 ms cpu-4x, +4-5 ms at cpu-4x-frame-load.
- The before column is Task 5 on the base (without Task 3); Task 3 alone left the stall in place (verification run on
  `7375465eb`: 6 per run, receipted p95 868-1731 ms at idle/cpu-4x/frame-load), so the change is Task 6's.

---

### Task 7: Close: final figures, gates, hosted proofs, the PR body and the plan file

Runs after tasks 1–6 are committed, reviewed and pushed. It records the final pins and figures, runs the local
merge bar, runs one final whole-branch review with one fix wave, takes the branch through the Branch Release Gate,
the hosted ALM manifests and the ALM observation, publishes the PR title and body, and deletes this plan file in its
last commit. It never merges and never takes the PR out of draft on its own.

**Files**

- Modify: `playground/alm/alm-qos-product-plan.md` §7.1 (the measured figures after P1a, with the commit they were
  measured on), `packages/shared-web/bundle-budgets.json` and
  `packages/tests/rallar-black-box-headless/headless-bundle-budget.json` only if a budget is crossed.
- Modify (fix wave only): the files the final review's Critical and Important findings name.
- Delete (last commit): `plans/active/alm-p1b-probes-on-the-engines-cadence-implementation-plan.md`.
- Create (never committed): `tmp/p1b-task7/**` (logs, artifacts, `pr-body.md`, `hosted.md`).
- Test: the local merge bar (steps 3–7); no new test file.

**Interfaces**

- Consumes: task 4's ledger test at its final figures (chain ≤ 6, total ≤ 8, `al-admission` 10, `al-work` ≤ 5;
  inbound 9/11 chain, 11/13 total, 5/7 `al-work` unchanged); task 5's harness (`npm run perf:alm:durable-send`, both plans); P1a's after-figures as the before-figures
  (`.claude/worktrees/alm-p1/.superpowers/sdd/alm-p1a-codec-and-send-chain-implementation-plan/evidence/harness-after.md`,
  copied to this plan's `evidence/harness-before.md` in step 1); tasks 1–6 pushed.
- Produces: code head `H1` (reviewed and gated), final head `H2` (H1 plus the last commit), the PR title and body.

Throughout: `WT=/Users/knuthelge/ProjectLocker/github/ar-eye-hunter/.claude/worktrees/alm-p1b`,
`R=intact-software-systems/ar-eye-hunter`, `B=claude/alm-p1b-probe-cadence`, `T=$WT/tmp/p1b-task7`,
`E=$WT/.superpowers/sdd/alm-p1b-probes-on-the-engines-cadence-implementation-plan/evidence`. Every `gh`, `git fetch`,
`git push`, `docker` command, every lane, Playwright run and black-box runner, and `npm run test:unit` need the
sandbox disabled. Use `gh run list` and `gh run view`, never `gh pr checks`.

**Lane rule.** One lane at a time on this machine: the ALM lane, `test:e2e`, `test:full-stack:memory`, the harness
and the black-box runners share ports 18080–18082, 5177, 5178 and 5180, and Playwright attaches to whatever already
listens there. Before every lane:

```sh
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(18080|18081|18082|5177|5178|5180) ' ; ps aux | grep -E 'black-box-run.mts|playwright test' | grep -v grep
```

Expected: no output. Nothing in the worktree is edited while a lane runs. A lane's verdict is its summary line,
never its exit code.

- [ ] **Step 1: Preconditions**

```sh
mkdir -p $T
git -C $WT status --short
git -C $WT fetch origin
git -C $WT rev-parse HEAD origin/$B
git -C $WT log --oneline HEAD..origin/main | wc -l
gh variable list -R $R | grep -c RALLAR_BLACK_BOX_ALM_SCOPE
test -f $E/harness-before.md && echo HARNESS-BEFORE
gh pr view 628 -R $R --json mergeable,mergeStateStatus --jq '[.mergeable, .mergeStateStatus] | @tsv'
```

Expected: no status output; the two hashes equal; `0` variables; `HARNESS-BEFORE`; `MERGEABLE`. If main moved
(the `wc -l` is not `0`) or the PR reads `CONFLICTING`, merge main first: `git -C $WT merge --no-ff origin/main -m
"Merge origin/main into $B"`, resolve keeping both sides' behaviour and tests, `npm ci` if `package-lock.json`
changed, then `npm run typecheck 2>&1 | tail -3` and `node scripts/check-test-reachability.mjs` before step 2.

- [ ] **Step 2: Final ledger, cold pin and bundle figures**

```sh
cd $WT && npx vitest run packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts 2>&1 | grep -E "✓|✗|Tests  "
grep -n -E "toHaveLength\(|toBe\([0-9]+" packages/tests/shared/alm/al-indexeddb-transaction-ledger.test.ts | head -20
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles | grep -E "browser/rallar(-core|-realtime|-data|-crdt)?\.ts "
npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts 2>&1 | grep -E "KiB|Tests  "
```

Expected: both pin files pass; the ledger pins read chain `6`, total `8`, `al-admission` `10`, `al-work` `5` (or lower, with the reason
strings tasks 3–4 and 6 wrote), the inbound pins unchanged; the cold pin reads `10` and the `al-work` figure task 4
measured. Record the five bundle lines and the headless figure in
`$T/figures.md`. If `browser/rallar.ts` or the headless bundle exceeds its budget, set the budget to the next whole
KiB above the measured figure in the data file (never higher), and commit `chore(bundles): raise the <entry> budget
to <N> KiB (measured <x.xx> KiB at <sha>)`; the figure and the reason go into the PR body.

- [ ] **Step 3: Harness after-figures**

Two heads, both plans (minimal and receipted-command), three invocations each, sandbox disabled, no other lane
running, in one quiet session: the before head is the design commit 9e8b9fc07 (the harness there has only the
minimal plan; its minimal figures are the comparator) and the after head is H1. Use a temporary worktree for the
before head (`git -C $WT worktree add $T/at-9e8b9fc07 9e8b9fc07`, `node_modules` symlinked to `$WT/node_modules`,
`npm run -s perf:alm:durable-send` there, then `git worktree remove --force $T/at-9e8b9fc07`):

```sh
cd $WT && for k in 1 2 3; do npm run -s perf:alm:durable-send 2>&1 | tee $T/harness-after-$k.log | grep -E "p50|p95|polyfill|codec|artifact"; done
ls -t tmp/perf/alm-durable-send/*.json | head -3
```

Expected: three artifacts per head; each of the four configurations (idle, 4× CPU, 1× with the frame load, 4× CPU
with the frame load) reports send-to-dispatch p50 and p95 per plan, and the profile line reports the CPU shares.
Noise rule: per comparator (idle p50/p95, cpu-4x p50/p95, frame-load p95 and fastModeShare, cpu-4x-frame-load
p50/p95) take the RANGE of the nine run-level values at each head and report a change only when the two ranges do
not overlap; otherwise "within noise"; report `frameLatenessP95Ms` beside the frame-load rows. The receipted
plan's figures at H1 are the I2b evidence D115 names: record them with the machine, the browser and "not a phone";
they gate nothing. The machine must be quiet (load average below about 5: `uptime`); if the load average differs from
the one recorded in `$E/harness-before.md`, first re-run the three before-runs at the Task 2 commit
(`git -C $WT worktree add $T/before <task-2 sha>` with `node_modules` symlinked, `npm run -s perf:alm:durable-send`
there three times, then `git worktree remove --force $T/before`) back to back with the after-runs, so both sides
share one session's noise. Write `$E/harness-after.md` with the three runs beside the before-figures
from `$E/harness-before.md`, the machine, the Chromium version, and the commit each was measured on. The after-p95
under the frame load at 4× CPU is the figure D89 reads after P1b; here it is recorded, not judged. A run whose
before-and-after differ by less than the machine's run-to-run spread (the three before-runs' spread) is reported as
"within noise", never as a gain.

- [ ] **Step 4: Local merge bar, static checks**

```sh
cd $WT
npm run typecheck 2>&1 | tail -3
npm run build 2>&1 | tail -15
npm run check:repo-style:changed -- origin/main HEAD
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
npm run check:test-reachability
(cd apps/api-v1 && deno task check) && (cd apps/rallar-black-box-control-server && deno task check) && (cd apps/relic-hunter-server-v1 && deno task check)
npx dprint check $(git diff --name-only origin/main HEAD | tr '\n' ' ')
```

Expected: `check-tests-typecheck: N test files enforced, 0 files carrying known debt (0 errors)`; build exits 0
with no `error` line; `PASS: no new repository style findings`; the coupling check prints `PASS:`;
`check:test-reachability` exits 0 (the harness spec is owned by `tests/manual-suites.json`); the three Deno checks
exit 0; dprint check exits 0.

- [ ] **Step 5: Local merge bar, `test:ci`**

Sandbox disabled, lane rule applies:

```sh
cd $WT && npm run test:ci 2>&1 | tee $T/test-ci.log | grep -E "Test Files|Tests  |ok \||passed|failed|flaky"
```

Expected, in order: Vitest `Test Files  N passed | K skipped (N)` and `Tests  N passed | K skipped (N)` with 0
failed; four Deno blocks each `ok | N passed | 0 failed`; Playwright `test:rallar` and the recipe console `N
passed`; the in-memory full stack `N passed`. Known intermittent reds that pass alone: `repo-style-changed-check.test.ts`
and `state-write-malformed-evidence.test.ts` (timeouts under load), the memory-QueueBox work-page test, and
`full-stack-quick-test-ws`. Rerun such a file alone, record both results, then rerun `npm run test:ci`; a red that
repeats alone is a defect.

- [ ] **Step 6: Local merge bar, API black-box on Postgres**

```sh
docker ps --filter name=ar-eye-hunter-postgres --format '{{.Status}}'
cd $WT && npm run test:api-v1:black-box:memory 2>&1 | tee $T/bb-memory.log | grep "Matrix profile\|FAILED"
npm run test:api-v1:black-box:postgres 2>&1 | tee $T/bb-postgres.log | grep "Matrix profile\|FAILED"
```

Expected: the container `Up ...` (if stopped: `docker start ar-eye-hunter-postgres`; never `db:test:up`, never
`db:down`); every `Matrix profile <name>: passed=N failed=0 skipped=K` line with `failed=0`. P1b changes the
work port every outbound lane uses, api-v1's Postgres ALM lane included (D113), so the cluster profile and the
medium-scale gate ARE required: `npm run test:api-v1:black-box:postgres:medium-scale 2>&1 | tee $T/bb-medium.log |
grep "Matrix profile\|FAILED"` must read `failed=0`, and the local `test:api-v1:black-box:postgres` run above
already includes the cluster profile (its summary prints a second `Matrix profile … cluster` line; P1a's close
read `passed=12 failed=0` there) — both `Matrix profile` lines of that run must read `failed=0`. The medium-scale gate's
constants, operation matrix and assertions are unchanged.

- [ ] **Step 7: Local merge bar, the full ALM lane**

```sh
cd $WT && rm -rf apps/rallar-black-box/test-results
RALLAR_BLACK_BOX_ALM_SCOPE=full npm run -s test:rallar:full-stack:memory:alm 2>&1 | tee $T/alm-full.log | grep -E "family over|passed|failed|flaky|skipped"
for F in apps/rallar-black-box/test-results/alm-observation/*-full*.json; do case $F in *-snapshot.json|*-page-diagnostics.json) ;; *) printf '%s ' $F; jq -r '.cellOutcome + " " + .regime' $F;; esac; done
```

Expected: every `baseline`, `addressed` and `three-agent` family over `ws`, `rtc` and `rtc-with-ws-fallback` in
`(full)` passes, `durable-opt-in` and `delivery-baseline` included; the summary shows `N passed` and no `failed` or
`flaky`; every cell file reads `passed`. Harness budgets unchanged (`git diff origin/main --
packages/shared-test/rallar-bb-test/conformance` touches no timeout constant).

- [ ] **Step 8: Final whole-branch review, three seats, and one fix wave**

Per the subagent-driven-development skill's final review: dispatch the reviewer on the most capable model with the
whole-branch diff (`git diff origin/main...HEAD`, packaged to a file), the spec (`playground/alm/alm-p1-design-proposal.md`
§2.1, §5) and the Global Constraints, in three seats: product (guarantees unchanged: fence, supersedence,
settlement, expiry, group commit, volatile lane), harness (the ledger and the harness measure what they claim), and
code quality (repo style, sizes, names, READMEs true). ONE fix dispatch for every Critical and Important finding,
one scoped re-review, residual minors adjudicated in the ledger. Each fix is a TDD commit. Then repeat steps 2, 4
and the focused tests the fixes touched; steps 5–7 are repeated only if a fix touched product code.

- [ ] **Step 9: Push the code head and read the gate**

```sh
cd $WT && git push origin HEAD:$B && git rev-parse HEAD > $T/H1
gh run list -R $R --branch $B --limit 6 --json name,status,conclusion,databaseId,headSha --jq '.[] | "\(.databaseId) \(.name) \(.status) \(.conclusion) \(.headSha[0:9])"'
```

Poll `gh run view <RUN> -R $R --json status,conclusion` every few minutes (foreground `gh`, sandbox disabled).
Expected: `Branch Release Gate` `success` on H1; read every failed job from its log and artifacts
(`gh run view <RUN> --log-failed`, `gh run download`), never from a theory; a fix is a TDD commit with a
counter-case, pushed, and the gate is read again on the new head.

- [ ] **Step 10: Hosted manifests 18 and 22 from the branch**

```sh
for M in 18-alm-conformance-2-agent 22-alm-conformance-3-agent; do
  gh workflow run hetzner-distributed-recipe.yml -R $R --ref $B -f ref=$B -f register_before_login=true \
    -f manifest_path=apps/rallar-black-box/manifests/hetzner/$M.json
  echo "dispatched $M"
  gh run list -R $R --workflow "Run Hetzner Distributed Recipe" --branch $B --limit 1 --json databaseId,createdAt
done
```

After each dispatch, repeat the `gh run list` until a newer run appears, record `manifest -> run id` in
`$T/hosted.md`, and read each finished run:

```sh
gh run view <RUN> -R $R --json conclusion,createdAt,updatedAt --jq '[.conclusion, .createdAt, .updatedAt] | @tsv'
gh run download <RUN> -R $R -D $T/hosted-<RUN>
find $T/hosted-<RUN> -name fleet-report-summary.md -o -name failures.json | head
```

Expected: both runs `success`, each taking minutes (a green run of about 40 s ran nothing: read its log before
counting it). A red is diagnosed from `failures.json` and `fleet-report-summary.md`, fixed on the branch with a TDD
commit, and re-dispatched from the branch; main is never the test bed.

- [ ] **Step 11: ALM observation, smoke on three consecutive runs and at most two full reads**

The gate on H1 started `alm-conformance-observation.yml` beside it (smoke). Add two smoke re-runs of that job
with no push in between, then at most two full reads:

```sh
gh variable list -R $R | grep -c RALLAR_BLACK_BOX_ALM_SCOPE
gh run list -R $R --workflow alm-conformance-observation.yml --branch $B --limit 3 --json databaseId,status,conclusion,headSha
gh run rerun <OBS_RUN> -R $R
gh run view <OBS_RUN> -R $R --log 2>/dev/null | grep -E "family over|passed|failed|regime=" | tail -20
```

Expected: `0` variables; three attempts each `success`, each log showing every `(smoke)` family `passed`. Then,
for each full read (the second only if the first ran fewer cells than the lane has, or a fix went in after it):

```sh
gh variable set RALLAR_BLACK_BOX_ALM_SCOPE -R $R --body full
gh run rerun <OBS_RUN> -R $R
gh run view <OBS_RUN> -R $R --json status,conclusion
```

Poll until `completed` (at most 30 minutes), then at once:

```sh
gh variable delete RALLAR_BLACK_BOX_ALM_SCOPE -R $R
gh variable list -R $R | grep -c RALLAR_BLACK_BOX_ALM_SCOPE
gh run view <OBS_RUN> -R $R --log > $T/alm-full-read-<k>.log; grep -E "family over .*\(full\)|passed|failed|regime=" $T/alm-full-read-<k>.log
```

Expected: the delete succeeds and the count is `0` (if the session may end before the job completes, write in
`$T/hosted.md`: "delete RALLAR_BLACK_BOX_ALM_SCOPE once run <id> completes"). Acceptance, cell by cell, against
#566's accepted read: every `ws` cell passed; `addressed` and `three-agent` over `rtc` passed; `baseline` over `rtc`
passed or failed only at `not-yet-in-sync-delivered-after-refresh` `received-1`; `rtc-with-ws-fallback` cells any
outcome, recorded (the 30-minute job timeout cuts them). Any WS red, or an RTC red at another step, is not accepted:
download the artifact and diagnose before a second read.

- [ ] **Step 12: The last commit: the figures and the plan file**

Two document corrections ride in this commit: in `playground/alm/alm-p1-design-proposal.md` §11.C, the sentence
on what a missing clamp causes reads "a zero-delay loop: a past lease end re-arms the engine at delay 0" instead of
"an empty batch every ~100 ms"; and the recovery bound in §11.C and in `packages/shared/alm/outbound/README.md`
carries the caveat that it assumes the readiness scan (16 rows per type) or a sweep (64 rows) sees the row, so a
crashed row hidden behind 16 live leases is recovered at the first batch that sweeps with its window open. Then, in
`playground/alm/alm-qos-product-plan.md` §7.1, add the measured after-figures (the ledger counts and the
harness p50/p95 per configuration) with the commit they were measured on, as a "measured (P1a, <sha>)" label, and
delete this plan file:

```sh
cd $WT && git rm plans/active/alm-p1b-probes-on-the-engines-cadence-implementation-plan.md
npx dprint fmt playground/alm/alm-qos-product-plan.md
git add playground/alm/alm-qos-product-plan.md
git commit -m "Record P1b's measured figures and close its plan"
git push origin HEAD:$B && git rev-parse HEAD > $T/H2
```

Expected: the commit contains only the two paths; the Branch Release Gate runs again on H2 and is read as in step
9 (docs-only, so the earlier hosted and observation reads on H1 stand; the PR body names both heads).

- [ ] **Step 13: The PR title and body**

Title: `ALM Release 4, P1b: probes on the engine's cadence (D112–D118)`. Body sections in this order: Goal, Changes
(one bullet per task, the pin each moved), Acceptance (the ledger figures before and after; the harness table from
`$E/harness-after.md`; the bundle figures and any budget raise; the ALM lane full read and manifests 18 and 22, run
ids), Validation (steps 4–7 and 9–11 with counts and run ids, measured on H1; the H2 gate), Rulings (every `Ruling:`
line from the SDD ledger, with what it costs if wrong), Risk and rollback (revert the merge commit; no schema change,
so no reset), Follow-up (I2a next; the fence-snapshot fold; bundle removal; the native alias; the generic bounded FIFO decided with I2b's plan; the D85 narrowing at I2b),
and the attribution line. Publish with `gh pr edit 628 -R $R --title "..." --body-file $T/pr-body.md`. Leave the PR
in draft; the maintainer reviews and merges. Then write `Task 7: complete` and `PLAN COMPLETE <date>: PR #628 at

<H2>` in the ledger.

- [ ] **Step 14: After the maintainer merges**

Watch main's `Push on main`, `Deploy Web + API` and `Run Hetzner Supported Distributed Manifests` on the merge
commit (`gh run list -R $R --branch main --limit 4`), report them, and record P1b as delivered in memory. I2a's plan is written next.

---
