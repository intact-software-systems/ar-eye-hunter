# ALM F2 One Work Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give durable ALM work one owner per side, make the admission stores readable without
checker pins, return every control-admission conflict as a value, replace every whole-store
IndexedDB read with an indexed one, and add the schema-identity reset that every later cutover uses.

**Architecture:** A new `packages/shared/alm/work/` feature owns the QueueBox port (`ALWorkQueuePort`)
and one generic work handler (`ALWorkHandler`) that both directions compose. The outbound runtime's
legacy `dequeue()` path is deleted; foreign outbox rows (`WS_OUTBOX`, `APP_OUTBOX`, RTC) become
`dequeue-message` work claimed by the same handler. Control admission moves out of both persistence
owners into `inbound/control/` and `outbound/control/` with the same read → compute → validate →
commit shape as data admission, conflicts as `'conflict'`, and retained `admit-control` work on
conflict. Inbound messages get one canonical owner row that effects and buffered snapshots reference.
The IndexedDB queue box gets `expiryEpochMs` and `endEpochMs` fields with indexes so cleanup,
reservation, and readiness probes read bounded ranges. AL-owned rows are keyed `topic/<owner>/<id>`
so browser cleanup is a key-range delete. The ALM database carries a schema id; a mismatch deletes
and recreates it and reports `alm.storage.reset`.

**Tech Stack:** TypeScript across Node, Deno, and browser; Vitest with `fake-indexeddb`; PGlite and
PostgreSQL for the server backend; dprint.

**Spec:** [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md),
section "Release 2, F2: one work owner and split stores", plus "Storage, cutover, reset, and
rollback" and "Governance and delivery rules". F1 (`plans/alm-f1-conformance-lane-implementation-plan.md`)
must be merged first: F2's acceptance runs the baseline conformance family and the storage
counters.

## Global Constraints

- Decision D8: search `packages/**` before writing anything; ask before an internal library; no new
  third-party dependency.
- Decision D3: browser ALM storage resets on schema mismatch; no data migration; the PR body lists
  what pending work is discarded (every queued unsent message, pending-ACK record, and ordering track
  from the previous schema id).
- No retained legacy: every deleted path is removed in the commit that replaces it, including its
  tests; obsolete coupled tests are rewritten in the same commit.
- Canonical verbs; `handle`, `process`, `execute` are removed from the touched files
  (`handlePendingAckTimeout` → `retryPendingAck`, `executeRepairFromHint` → `retransmitFromRepairHint`,
  `processBatch`/`processPage` disappear with the old handlers, `handleIncomingMessage` →
  `admitIncomingMessage`, `handleControlMessage` → `admitControlMessage`).
- Required fields by default: `nowMs`, `canonicalScope`, `newControlId`, and `decodePrepared` become
  required constructor inputs; `createDefault…` composition roots supply them.
- Expected failure is an `Either` value; `assertXxx` is reserved for programmer invariants
  (`assertObservations` → `validateObservedWork` returning issues; the conflict is a typed value).
- After this PR no `file.cognitive-load` finding at or above the warn tier remains under
  `packages/shared/alm`, and the disposition files carry no entry for an ALM file.
- Every commit keeps focused Vitest, `npx dprint check <files>`, and the package typecheck green;
  before pushing: `npm run test:unit`, the three Deno checks, `npx dprint check`,
  `npm run check:repo-style:changed -- origin/main HEAD`, `npm run test:rallar:full-stack:memory:alm`.
- This is an incompatible cutover (decision D6 allows the large PR): browser schema id, inbound work
  key layout, and effect payload shapes change together.

## Execution adjustments (2026-09-09, pre-flight rulings)

- R1/R2: the admission stores stop exposing `workQueue`, but the composition still needs the
  queue to build the port. `ALInboundRuntimeStores`/`ALInboundMessageRuntime.Resources` (Task 4)
  and `ALOutboundRuntimeStores`/`ALOutboundMessageRuntime.Resources` (Task 6) carry
  `readonly workQueue: QueueBoxResourceEntryRepository`; each runtime constructor builds its own
  `ALWorkQueuePort` from it (inbound `workTypes = {toALInboundWorkType(namespace)}`, outbound
  `{toALOutboundWorkType(namespace), ...dequeue.types}`) before constructing the control admission
  and the handler. The outbound type set depends on consumer-specific dequeue types the store
  factories do not know, so the port is not a resource.
- R3/R4: Task 6 passes `dequeue` and receives `workQueue` at the three production constructions
  so every commit typechecks; Task 7 deletes the legacy methods and registrations. The overlay
  manager's `this.outbox` becomes the stores bundle's `workQueue`.
- R18: `peekNextReadyAt` reads one fixed 16-entry RETRY page per type (the existing handler's
  bound); the engine's idle schedule covers an under-report; polling bounds are measured in V1.
- R22/R24 (Task 3): the owner row carries `retainUntilMs`; every buffered-slot re-extension is
  clamped to it; every consumer of a buffered slot resolves its owner row.
- R27 (Task 4/5): a replayed `admit-control` that commits surfaces its acceptance through
  `onControlMessage`; `replay` returns `{ outcome, acceptance }`.
- R30/R31 (Task 5): the port's `peekNextReadyAt` advertises NEW work as ready now (one NEW row per
  type) merged with RETRY readiness; readiness is a handler dependency
  (`ALWorkHandlerDependencies.readNextReadyAtMs`) — the inbound runtime passes its eligibility-aware
  selector probe, the outbound runtime passes its own probe (Task 6).
- R32 (Task 6): the port's peek skips expired rows (`readWorkPage` applies no expiry filter, so an
  expired NEW row would otherwise read as ready forever); the outbound probe keeps today's
  semantics (unleased RESERVED rows are ready now, expired rows are skipped).
- R29 (Task 6/11): warn-tier-or-worse ALM files after Task 4 were compute-al-inbound-admission (64),
  validate-al-inbound-commit-bundle (58), al-outbound-admission-effect-store (68),
  al-outbound-message-runtime (55), al-outbound-repair-admission (60), al-outbound-admission-store
  (124); Task 6 lands the four outbound files under the warn tier, Task 11 splits the rest along
  real boundaries and makes `validateALInboundControlAdmission` return every issue.
- H5 (Task 6, from the runner diagnosis of the F1 lane): outbound admission of a typed send is a
  serialized chain of IndexedDB round trips with the batch awaited inline before and after the
  commit; Task 6 replaces the awaited `processCommitted()` with the non-blocking
  `ALWorkHandler.committed()`, wires the existing `outboundDiagnostics` sink
  (`initialise-browser-middleware.ts`, no caller today) from the black-box composition beside
  `RallarDiagnosticsPorts`, and raises the conformance `EXPIRY_TTL_MS` above the measured admission
  latency so `deadline-expiry` asserts what it claims. The lane returns to `test:ci` when Task 12
  proves it on the runner (observation job). Done in Task 6b (sink topic
  `rallar.browser.alm.outbound_diagnostics`, `EXPIRY_TTL_MS` 7 500 ms, manifest 18 regenerated).
- R39/R43 (Task 5 fix round 2): the inbound runtime announces a commit only when it wrote work,
  and an empty batch stays off the same tick (a zero-mutation duplicate admission had started a
  fire-and-forget batch that outlived a closing PGlite and spun). A batch can still outlive
  `dispose()` (uncancellable port operations; lease expiry recovers) — recorded for the final
  review; `dispose(): void` stays in F2.
- R46 (Task 7 fix round): every queue-entry writer (`toResourceEntry`, `toResourceEntryWithKey`,
  `QueueBoxUtilities.toResourceEntryFromMsg`) stamps `date`/`createdTs` from one UTC instant — the
  readers reinterpret `createdTs` as UTC wall clock, and the old `isAnyEntryToLock` path had masked
  the local-zone stamp until the handler's probe became the sole cold-discovery path.
- R40 (Task 11): the outbound admission family (`al-outbound-admission-store.ts`, `-reads.ts`,
  `-keys.ts`, `-effect-store.ts`, `-validation.ts`, plus a `-mutations.ts` split of the store's
  compute/apply half) moves into `packages/shared/alm/outbound/admission/` in one move with
  lineage entries; that takes the directory from 23 to 18 direct files (clearing the zero-tolerance
  layout metrics) and lands the store under the warn tier; `al-outbound-message-runtime.ts` (55)
  and `al-outbound-repair-admission.ts` (60) are split along a real boundary in the same task.

---

## File structure

| Responsibility                              | File                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| QueueBox port for ALM work                  | Create `packages/shared/alm/work/al-work-queue-port.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| One generic work handler                    | Create `packages/shared/alm/work/al-work-handler.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Inbound admission store (data only)         | Modify `packages/shared/alm/inbound/al-inbound-admission-store.ts` (shrinks below 700 lines)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Inbound control admission                   | Create `packages/shared/alm/inbound/control/al-inbound-control-admission.ts`, `compute-al-inbound-control-admission.ts`, `validate-al-inbound-control-admission.ts`                                                                                                                                                                                                                                                                                                                                                                                                              |
| Inbound canonical message owner             | Modify `packages/shared/alm/inbound/al-inbound-effect-intent.ts`, `prepare-al-inbound-commit-bundle.ts`, `al-inbound-admitted-delivery.ts`, `al-inbound-ordering-validation.ts`                                                                                                                                                                                                                                                                                                                                                                                                  |
| Inbound work entry keys                     | Modify `packages/shared/alm/inbound/al-inbound-work-entry.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Outbound admission store (data only)        | Modify `packages/shared/alm/outbound/al-outbound-admission-store.ts` (shrinks below 700 lines)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Outbound control admission                  | Move `packages/shared/alm/outbound/al-outbound-admission-control-store.ts` → `packages/shared/alm/outbound/control/al-outbound-control-admission.ts`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Outbound persisted keys                     | Create `packages/shared/alm/outbound/al-outbound-admission-keys.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Outbound work entry keys and dequeue effect | Modify `packages/shared/alm/outbound/al-outbound-work-entry.ts`, `al-outbound-effect-validation.ts`, `al-outbound-admission-effect-store.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Outbound runtime                            | Modify `packages/shared/alm/outbound/al-outbound-message-runtime.ts`, `al-outbound-repair-admission.ts`, `create-default-al-outbound-message-runtime.ts`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Delete the legacy dequeue path              | Modify `packages/shared/services/ws-queue-box-client-service.ts`, `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts`, `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts`, `packages/shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts`; delete `QueueBoxUtilities.defaultDequeue` if unused afterwards                                                                                                                                                                                                     |
| Indexed queue box reads                     | Modify `packages/shared/queuebox/indexed-db-queue-box-store.ts`, `indexed-db-queue-box-entry-codec.ts`, `indexed-db-queue-box-entry.ts`, `indexed-db-queue-box.ts`                                                                                                                                                                                                                                                                                                                                                                                                               |
| Canonical outbound key layout               | Modify `packages/shared/alm/outbound/al-outbound-canonical-message.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Browser cleanup by key range                | Modify `packages/shared-web/browser/al-runtime/browser-al-work-cleanup.ts`, `browser-al-runtime-cleanup.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Schema identity and reset                   | Modify `packages/shared/alm/open-indexed-db-admission-database.ts`, `packages/shared/alm/al-runtime-stores.ts`, `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts`; extend `RallarDiagnosticsPorts` (from F1) with `onStorageReset`                                                                                                                                                                                                                                                                                                                           |
| Dispositions                                | Modify `scripts/repo-style-check/reviewed-dispositions.mjs` (delete every ALM entry)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Navigation maps                             | Modify `packages/shared/alm/inbound/README.md`, `packages/shared/alm/outbound/README.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Tests                                       | Create `packages/tests/shared/alm/work/al-work-queue-port.test.ts`, `al-work-handler.test.ts`, `packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts`, `packages/tests/shared/alm/inbound/al-inbound-canonical-message.test.ts`, `packages/tests/shared/alm/outbound/al-outbound-dequeue-work.test.ts`, `packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts`, `packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts`, `packages/tests/shared/alm/al-storage-snapshot.test.ts`; rewrite the tests the deleted files owned |

---

### Task 1: The ALM work queue port

**Files:**

- Create: `packages/shared/alm/work/al-work-queue-port.ts`
- Test: `packages/tests/shared/alm/work/al-work-queue-port.test.ts`

**Interfaces:**

- Produces:

```ts
export type ALWorkOutcome =
    | Readonly<{ status: 'completed'; }>
    | Readonly<{ status: 'non-retryable'; }>
    | Readonly<{ status: 'retry'; }>
    | Readonly<{ status: 'not-ready'; readyAtMs: number; }>;

export interface ALWorkClaim {
    readonly entry: ResourceEntry;
    readonly attempts: number;
    readonly leaseUntilMs: number;
}

export interface ALWorkPage {
    readonly entries: readonly ResourceEntry[];
    readonly nextCursor: ResourceInboxWorkPage.Cursor | null;
}

export interface ReadALWorkPageInput {
    readonly status: EntityStatus;
    readonly maxToRead: number;
    readonly cursor: ResourceInboxWorkPage.Cursor | null;
}

export interface ClaimALWorkInput {
    readonly maxCount: number;
    /** Observations from a prior page read; undefined lets the queue select. */
    readonly observedEntries: readonly ResourceEntry[] | undefined;
}

export interface ALWorkQueuePort {
    readonly workTypes: ReadonlySet<string>;
    retainIfAbsent(entry: ResourceEntry): Promise<ResourceEntry>;
    readPage(input: ReadALWorkPageInput): Promise<ALWorkPage>;
    claim(input: ClaimALWorkInput): Promise<readonly ALWorkClaim[]>;
    finalizeExhausted(maxCount: number): Promise<readonly ALWorkClaim[]>;
    release(claim: ALWorkClaim, outcome: ALWorkOutcome): Promise<void>;
    peekNextReadyAt(): Promise<number | undefined>;
    readEntry(key: Key): Promise<ResourceEntry | undefined>;
}

export interface CreateALWorkQueuePortInput {
    readonly queue: QueueBoxResourceEntryRepository;
    readonly workTypes: ReadonlySet<string>;
    readonly leaseMs: number;
    readonly nowMs: () => number;
    readonly random: () => number;
}

export function createALWorkQueuePort(input: CreateALWorkQueuePortInput): ALWorkQueuePort;
```

`release` is the single owner of the retry decision:

```ts
async release(claim, outcome) {
    const disposition = toReleaseDisposition(outcome, claim, input);
    try {
        await input.queue.releaseEntries([claim.entry], disposition);
    }
    catch (error) {
        if (!(error instanceof ResourceInboxLostReservationError)) {
            throw error;
        }
    }
}

function toReleaseDisposition(outcome, claim, input): ResourceInboxReleaseDisposition {
    switch (outcome.status) {
        case 'completed':
            return { status: EntityStatus.COMPLETED, delayMs: null };
        case 'non-retryable':
            return { status: EntityStatus.NON_RETRYABLE, delayMs: null };
        case 'not-ready':
            return { status: EntityStatus.RETRY, delayMs: Math.max(1, Math.ceil(outcome.readyAtMs - input.nowMs())), reason: 'not-ready' };
        case 'retry': {
            const decision = retryAfterAttempt(DEFAULT_RESOURCE_INBOX_RETRY_POLICY, claim.attempts, input.random());
            return decision.status === 'failed'
                ? { status: EntityStatus.FAILED, delayMs: null }
                : { status: EntityStatus.RETRY, delayMs: Math.max(1, decision.delayMs ?? 1) };
        }
    }
}
```

`claim` reserves `NEW_AND_RETRY_STATUSES` first (`reserveEntries` with `observedEntries`), then
timed-out `RESERVED` rows (`reserveTimeoutEntries` with `Temporal.Duration.from({ milliseconds: leaseMs })`),
and maps each `ResourceEntry` to `{ entry, attempts: entry.dequeueAudit.attempts, leaseUntilMs: nowMs + leaseMs }`.
`finalizeExhausted` wraps `reserveRetryExhaustionFinalizations(workTypes, { processingAttempts: DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts, maxToReserve, staleAfterMs: leaseMs })`.
`peekNextReadyAt` reads one `RETRY` page and returns the earliest `dequeueAudit.nextTs`, or `undefined`.

- [x] **Step 1: Write the failing test**

Create `packages/tests/shared/alm/work/al-work-queue-port.test.ts` using `InMemoryQueueBox` (see
`packages/tests/shared/in-memory-queuebox.test.ts` for construction with an injected clock):

```ts
import { Temporal } from '@js-temporal/polyfill';
import { createALWorkQueuePort } from '@shared/alm/work/al-work-queue-port.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { newWorkEntry } from './al-work-test-entries.ts';

describe('ALWorkQueuePort', () => {
    it('claims new work, decides retry once, and refunds a not-ready release', async () => {
        let now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'w-1'));

        const [claim] = await port.claim({ maxCount: 4, observedEntries: undefined });
        expect(claim.attempts).toBe(1);
        expect(claim.leaseUntilMs).toBe(15_000);

        await port.release(claim, { status: 'not-ready', readyAtMs: now + 2_000 });
        const notReady = await port.readEntry(claim.entry.key);
        expect(notReady?.status).toBe(EntityStatus.RETRY);
        expect(notReady?.dequeueAudit.attempts).toBe(0);

        now += 2_000;
        const [second] = await port.claim({ maxCount: 4, observedEntries: undefined });
        await port.release(second, { status: 'retry' });
        const retried = await port.readEntry(second.entry.key);
        expect(retried?.status).toBe(EntityStatus.RETRY);
        expect(retried?.dequeueAudit.attempts).toBe(1);
    });

    it('completes and rejects work and tolerates a lost reservation', async () => {
        let now = 10_000;
        const queue = new InMemoryQueueBox(
            undefined,
            () => Temporal.Instant.fromEpochMilliseconds(now)
        );
        const port = createALWorkQueuePort({
            queue,
            workTypes: new Set(['AL_TEST']),
            leaseMs: 5_000,
            nowMs: () => now,
            random: () => 0.5
        });
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'w-2'));
        await port.retainIfAbsent(newWorkEntry('AL_TEST', 'w-3'));
        const claims = await port.claim({ maxCount: 4, observedEntries: undefined });

        await port.release(claims[0], { status: 'completed' });
        await port.release(claims[1], { status: 'non-retryable' });
        expect((await port.readEntry(claims[0].entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect((await port.readEntry(claims[1].entry.key))?.status).toBe(
            EntityStatus.NON_RETRYABLE
        );
        await expect(port.release(claims[0], { status: 'completed' })).resolves.toBeUndefined();
    });
});
```

Create `packages/tests/shared/alm/work/al-work-test-entries.ts` with `newWorkEntry(typeId, effectId)`
that returns a `ResourceEntry` in status `NEW` with `audit.expiryTs = NEVER_EXPIRE_TS` and key
`{ topicId: 'AL_TEST', resourceId: 'ns', contextId: effectId }` (copy the audit fields from
`QueueBoxUtilities.toResourceEntryFromMsg`).

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared/alm/work/al-work-queue-port.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Write the port**

Create `packages/shared/alm/work/al-work-queue-port.ts` with the contracts above, the `release`
shown, and:

```ts
export function createALWorkQueuePort(input: CreateALWorkQueuePortInput): ALWorkQueuePort {
    const { queue, workTypes, leaseMs, nowMs } = input;
    const maxAttempts = DEFAULT_RESOURCE_INBOX_RETRY_POLICY.maxAttempts;
    return {
        workTypes,
        retainIfAbsent: (entry) => queue.enqueueIfAbsent(entry),
        readPage: async ({ status, maxToRead, cursor }) => {
            const [typeId] = [...workTypes];
            const page = await queue.readWorkPage({ typeId, status, maxToRead, cursor });
            return { entries: page.entries, nextCursor: page.nextCursor };
        },
        claim: async ({ maxCount, observedEntries }) => {
            const pending = await queue.reserveEntries({
                typeIds: new Set(workTypes),
                statusIds: new Set(NEW_AND_RETRY_STATUSES),
                reservationInput: { maxToReserve: maxCount, maxAttempts },
                observedEntries
            });
            const recovered = await queue.reserveTimeoutEntries({
                typeIds: new Set(workTypes),
                reservationInput: {
                    maxToReserve: Math.max(0, maxCount - pending.size),
                    maxAttempts
                },
                timeSinceStartTs: Temporal.Duration.from({ milliseconds: leaseMs }),
                observedEntries
            });
            return [...pending.values(), ...recovered.values()].map((entry) =>
                toClaim(entry, nowMs() + leaseMs)
            );
        },
        finalizeExhausted: async (maxCount) => {
            const reserved = await queue.reserveRetryExhaustionFinalizations(new Set(workTypes), {
                processingAttempts: maxAttempts,
                maxToReserve: maxCount,
                staleAfterMs: leaseMs
            });
            return [...reserved.values()].map(({ entry }) => toClaim(entry, nowMs() + leaseMs));
        },
        release: (claim, outcome) =>
            releaseClaim(queue, claim, toReleaseDisposition(outcome, claim, input)),
        peekNextReadyAt: async () => {
            const [typeId] = [...workTypes];
            const page = await queue.readWorkPage({
                typeId,
                status: EntityStatus.RETRY,
                maxToRead: 16,
                cursor: null
            });
            const due = page.entries.map((entry) => entry.dequeueAudit.nextTs?.epochMilliseconds)
                .filter((value): value is number => value !== undefined);
            return due.length === 0 ? undefined : Math.min(...due);
        },
        readEntry: (key) => queue.getItem(key)
    };
}

function toClaim(entry: ResourceEntry, leaseUntilMs: number): ALWorkClaim {
    return { entry, attempts: entry.dequeueAudit.attempts, leaseUntilMs };
}
```

`workTypes` with more than one type is used by the outbound port (Task 6); `readPage` and
`peekNextReadyAt` iterate every type in that case and merge (`Math.min` for readiness; concatenated
pages capped at `maxToRead`).

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/tests/shared/alm/work/al-work-queue-port.test.ts`
Expected: PASS, 2 tests.

- [x] **Step 5: Commit**

```bash
git add packages/shared/alm/work packages/tests/shared/alm/work
git commit -m "feat(alm): add the ALM work queue port with one retry decision"
```

---

### Task 2: One generic work handler

**Files:**

- Create: `packages/shared/alm/work/al-work-handler.ts`
- Test: `packages/tests/shared/alm/work/al-work-handler.test.ts`

**Interfaces:**

- Consumes: Task 1's `ALWorkQueuePort`, `InboxOutboxEngine` (`includeTask`, `excludeTask`, `wake`, `wakeAt`, `start`, `stop`).
- Produces:

```ts
export type ALWorkAttemptResult =
    | ALWorkOutcome
    | Readonly<{ status: 'retained'; settled: Promise<ALWorkOutcome>; }>;

export interface ALWorkReadySelection {
    readonly claims: readonly ALWorkClaim[];
    readonly nextReadyAtMs: number | undefined;
}

export interface ALWorkHandlerDependencies {
    readonly workerId: string;
    readonly port: ALWorkQueuePort;
    readonly queueEngine: InboxOutboxEngine;
    readonly ownsQueueEngine: boolean;
    readonly clock: { nowMs(): number; };
    readonly pageSize: number;
    /** Reads eligible work; the port owns reservation. */
    readonly selectReady: (
        port: ALWorkQueuePort,
        pageSize: number
    ) => Promise<ALWorkReadySelection>;
    readonly runClaim: (claim: ALWorkClaim) => Promise<ALWorkAttemptResult>;
    readonly diagnostics: ((event: ALWorkBatchDiagnostics) => void) | undefined;
}

export interface ALWorkBatchDiagnostics {
    readonly kind: 'work-batch';
    readonly workerId: string;
    readonly durationMs: number;
    readonly claimedCount: number;
    readonly completedCount: number;
    readonly rescheduledCount: number;
    readonly rejectedCount: number;
}

export class ALWorkHandler {
    constructor(dependencies: ALWorkHandlerDependencies);
    ready(): Promise<void>;
    dispose(): void;
    /** After a commit: wakes the engine and runs one batch if idle; never blocks on delivery of unrelated work. */
    committed(): void;
    hasActiveBatch(): boolean;
}
```

`committed()` is synchronous and only wakes: this removes the inline drain the inbound ingress
awaited (`al-inbound-message-runtime.ts:151`). Corruption (`ALAdmissionCorruptionError`) and
`NonRetryableException` from `runClaim` release the claim as `non-retryable`; any other thrown error
releases as `retry`; a `retained` result releases when `settled` resolves.

- [x] **Step 1: Write the failing test**

Create `packages/tests/shared/alm/work/al-work-handler.test.ts` with a fake port (in-memory arrays)
and `new InboxOutboxEngine(...)` as `packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts`
constructs it:

```ts
it('runs one batch per wake, releases each claim once, and never awaits delivery on committed()', async () => {
    const released: string[] = [];
    const port = fakePort({
        claims: ['w-1', 'w-2'],
        onRelease: (claim, outcome) =>
            released.push(`${claim.entry.key.contextId}:${outcome.status}`)
    });
    const engine = createEngine();
    const handler = new ALWorkHandler({
        workerId: 'test-worker',
        port,
        queueEngine: engine,
        ownsQueueEngine: true,
        clock: { nowMs: () => 1_000 },
        pageSize: 16,
        selectReady: async (p, size) => ({
            claims: await p.claim({ maxCount: size, observedEntries: undefined }),
            nextReadyAtMs: undefined
        }),
        runClaim: async (claim) =>
            claim.entry.key.contextId === 'w-2' ? { status: 'retry' } : { status: 'completed' },
        diagnostics: undefined
    });
    await handler.ready();
    expect(released).toEqual(['w-1:completed', 'w-2:retry']);

    const before = Date.now();
    handler.committed();
    expect(Date.now() - before).toBeLessThan(5);
    handler.dispose();
});

it('classifies thrown errors: corruption rejects, other errors retry, retained results settle later', async () => {
    /* three claims, three behaviors, assert released outcomes */
});
```

Write the second test fully with a claim whose `runClaim` throws `new ALAdmissionCorruptionError('k', new TypeError('x'))`,
one that throws `new Error('transient')`, and one returning `{ status: 'retained', settled: Promise.resolve({ status: 'completed' }) }`;
await one macrotask and assert `['c-1:non-retryable', 'c-2:retry', 'c-3:completed']`.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared/alm/work/al-work-handler.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Write the handler**

Create `packages/shared/alm/work/al-work-handler.ts`:

```ts
export class ALWorkHandler {
    private readonly dependencies: ALWorkHandlerDependencies;
    private batch: Promise<void> | undefined;
    private bootstrapped = false;
    private readonly shutdown = new AbortController();

    constructor(dependencies: ALWorkHandlerDependencies) {
        this.dependencies = dependencies;
        dependencies.queueEngine.includeTask(dependencies.workerId, {
            name: dependencies.workerId,
            maxConcurrency: () => 1,
            isWork: () => this.hasReadyWork(),
            runnable: () => this.runBatch(),
            ongoingTasks: []
        });
    }

    async ready(): Promise<void> {
        if (this.bootstrapped || this.shutdown.signal.aborted) {
            return;
        }
        await this.runBatch();
        this.bootstrapped = true;
        if (!this.shutdown.signal.aborted && this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.start();
        }
    }

    dispose(): void {
        this.shutdown.abort();
        this.dependencies.queueEngine.excludeTask(this.dependencies.workerId);
        if (this.dependencies.ownsQueueEngine) {
            this.dependencies.queueEngine.stop();
        }
    }

    committed(): void {
        this.dependencies.queueEngine.wake();
        if (this.batch === undefined) {
            void this.runBatch();
        }
    }

    hasActiveBatch(): boolean {
        return this.batch !== undefined;
    }

    private async hasReadyWork(): Promise<boolean> {
        if (this.shutdown.signal.aborted || this.batch !== undefined) {
            return false;
        }
        const next = await this.dependencies.port.peekNextReadyAt();
        this.dependencies.queueEngine.wakeAt(this.dependencies.workerId, next);
        return next !== undefined && next <= this.dependencies.clock.nowMs();
    }

    private runBatch(): Promise<void> {
        if (this.shutdown.signal.aborted) {
            return Promise.resolve();
        }
        if (this.batch !== undefined) {
            return this.batch;
        }
        this.batch = this.runSelectedWork().catch((error) => {
            if (error instanceof ALAdmissionCorruptionError) {
                throw error;
            }
            console.error('ALM work batch failed', error);
        }).finally(() => {
            this.batch = undefined;
        });
        return this.batch;
    }

    private async runSelectedWork(): Promise<void> {
        const { port, pageSize, selectReady, clock, workerId } = this.dependencies;
        const startedAtMs = clock.nowMs();
        const counts = {
            claimedCount: 0,
            completedCount: 0,
            rescheduledCount: 0,
            rejectedCount: 0
        };
        for (const claim of await port.finalizeExhausted(pageSize)) {
            await port.release(claim, { status: 'non-retryable' });
            counts.rejectedCount += 1;
        }
        const selection = await selectReady(port, pageSize);
        counts.claimedCount = selection.claims.length;
        for (const claim of selection.claims) {
            if (this.shutdown.signal.aborted) {
                return;
            }
            await this.runOne(claim, counts);
        }
        this.dependencies.queueEngine.wakeAt(workerId, selection.nextReadyAtMs);
        this.dependencies.diagnostics?.({
            kind: 'work-batch',
            workerId,
            durationMs: Math.max(0, clock.nowMs() - startedAtMs),
            ...counts
        });
    }

    private async runOne(claim: ALWorkClaim, counts: ALWorkCounts): Promise<void> {
        let result: ALWorkAttemptResult;
        try {
            result = await this.dependencies.runClaim(claim);
        }
        catch (error) {
            result = error instanceof ALAdmissionCorruptionError ||
                    error instanceof NonRetryableException
                ? { status: 'non-retryable' }
                : { status: 'retry' };
        }
        if (result.status === 'retained') {
            void result.settled
                .then((outcome) => this.dependencies.port.release(claim, outcome))
                .catch((error) => console.error('Retained ALM work failed', error))
                .finally(() => this.dependencies.queueEngine.wake());
            return;
        }
        await this.dependencies.port.release(claim, result);
        if (result.status === 'completed') {
            counts.completedCount += 1;
        }
        else if (result.status === 'non-retryable') {
            counts.rejectedCount += 1;
        }
        else {
            counts.rescheduledCount += 1;
        }
    }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/tests/shared/alm/work/al-work-handler.test.ts`
Expected: PASS, 2 tests.

- [x] **Step 5: Commit**

```bash
git add packages/shared/alm/work packages/tests/shared/alm/work
git commit -m "feat(alm): add the generic ALM work handler"
```

---

### Task 3: Inbound work keys, canonical inbound message owner, and effect references

**Files:**

- Modify: `packages/shared/alm/inbound/al-inbound-work-entry.ts:65-75`
- Modify: `packages/shared/alm/inbound/al-inbound-effect-intent.ts:11-42`, `prepare-al-inbound-commit-bundle.ts:127-175`
- Modify: `packages/shared/alm/inbound/al-inbound-admission-store.ts` (new mutation kind and reader)
- Modify: `packages/shared/alm/inbound/al-inbound-admitted-delivery.ts:55-140`
- Modify: `packages/shared/alm/inbound/al-inbound-ordering-validation.ts` (buffered snapshot references the owner)
- Test: `packages/tests/shared/alm/inbound/al-inbound-canonical-message.test.ts`; rewrite affected assertions in `packages/tests/shared/al-inbound-message-runtime.test.ts` and `packages/tests/shared/alm/al-inbound-admission-preparation.test.ts`

**Interfaces:**

- Produces:
  - `toALInboundWorkKey(namespace, effectId)` returns `{ topicId: 'AL_INBOUND', resourceId: encodeURIComponent(namespace), contextId: encodeURIComponent(effectId) }` so the key string is `AL_INBOUND/<namespace>/<effectId>`.
  - New admission mutation `{ kind: 'set-inbound-message'; value: ALStoredInboundMessage; expireAtTimestamp: number }` with
    `interface ALStoredInboundMessage { readonly msgId: string; readonly senderId: string; readonly msg: ALMessage; }` stored under `${namespace}:message:${senderId}:${msgId}`.
  - `ALInboundAdmissionStore.readInboundMessage(reference: ALInboundMessageReference): Promise<ALMessage | undefined>` with `interface ALInboundMessageReference { readonly senderId: string; readonly msgId: string; }`.
  - Effect payloads `dispatch-local` and `forward-message` carry `readonly message: ALInboundMessageReference` instead of `entry`/`msg`; `send-control` keeps its small control envelope; buffered snapshots store the reference plus the plan.
  - `ALInboundAdmittedDelivery.deliver` reads the message through the store and builds the dispatch entry with the runtime's existing `toInboxEntry` port; a missing owner row is `ALAdmissionCorruptionError`.

- [x] **Step 1: Write the failing test**

Create `packages/tests/shared/alm/inbound/al-inbound-canonical-message.test.ts` using
`createDefaultALInboundRuntimeResources` as `al-inbound-effect-worker-lifecycle.test.ts` does:

```ts
it('stores one inbound message owner and references it from every effect and buffered snapshot', async () => {
    const resources = createDefaultALInboundRuntimeResources({
        selfPeerId: 'receiver',
        toInboxEntry: toTestInboxEntry
    });
    const message = newALUnicastMessage('sender', route(), 'receiver', 'chat', { text: 'hello' });
    const runtime = createRuntime(resources, { forwardToPeers: ['relay'] });
    await runtime.admitIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });

    const stored = await resources.admissionStore.readInboundMessage({
        senderId: 'sender',
        msgId: message.id.msgId
    });
    expect(stored).toEqual(message);
    const rows = await readAllWorkRows(resources);
    for (const row of rows) {
        expect(row.resource).not.toContain('"text":"hello"');
        expect(row.resource).toContain(`"msgId":"${message.id.msgId}"`);
    }
});
```

Write `readAllWorkRows` against the in-memory queue's `readWorkPage` for type `toALInboundWorkType(namespace)`.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared/alm/inbound/al-inbound-canonical-message.test.ts`
Expected: FAIL, `readInboundMessage` is not a function.

- [x] **Step 3: Implement the owner row, the references, and the key layout**

In `al-inbound-admission-store.ts` add the mutation kind to `ALInboundAdmissionMutation`, the
`applyMutation` branch (`transaction.set(key, value, expireAtTimestamp)`), the decoder
`decodeALStoredInboundMessage(value, key)` beside the other decoders (validate `msgId`, `senderId`,
and `decodePersistedALMessage(value.msg)`), and:

```ts
async readInboundMessage(reference: ALInboundMessageReference): Promise<ALMessage | undefined> {
    const stored = await this.backend.read(this.toInboundMessageKey(reference), decodeALStoredInboundMessage);
    return stored?.msg;
}
```

In `prepare-al-inbound-commit-bundle.ts`, the incoming-message bundle adds the
`set-inbound-message` mutation (expiry = the admitted deadline, or the retention ceiling when the
message has none) before the effects; `prepareALInboundDurableEffect` maps `dispatch-local` to
`{ kind: 'dispatch-local', message: reference }` and passes `forward-message` through with
`{ kind: 'forward-message', message: reference, fromPeerId, plan }`. In `al-inbound-effect-intent.ts`
replace the `msg` fields of those two payloads with `message: ALInboundMessageReference`. In
`al-inbound-admitted-delivery.ts`, `readReadiness` and `deliver` resolve the message through
`this.admissionStore.readInboundMessage(payload.message)` and throw
`new ALAdmissionCorruptionError(JSON.stringify(payload.message), new TypeError('Inbound message owner row is missing'))`
when absent; `dispatchAdmittedEntry` receives the entry built by `this.dependencies.toInboxEntry(msg)`.
In `al-inbound-ordering-validation.ts` the buffered snapshot stores `message: ALInboundMessageReference`
and `plan` instead of `msg`.

Change `toALInboundWorkKey` to the layout above and run
`rg -n "AL_INBOUND/" packages` to update any literal key-string expectation.

- [x] **Step 4: Run the inbound suites**

Run: `npx vitest run packages/tests/shared/alm packages/tests/shared/al-inbound-message-runtime.test.ts packages/tests/shared/al-durable-runtime.test.ts packages/tests/shared-web/al-runtime`
Expected: PASS after rewriting assertions that read `payload.msg` or `payload.entry` to read the
reference and the owner row.

- [x] **Step 5: Commit**

```bash
git add packages/shared/alm/inbound packages/tests
git commit -m "feat(alm): one inbound message owner row referenced by effects and buffered snapshots"
```

---

### Task 4: Inbound control admission as its own owner with conflict as a value

**Files:**

- Create: `packages/shared/alm/inbound/control/al-inbound-control-admission.ts`, `compute-al-inbound-control-admission.ts`, `validate-al-inbound-control-admission.ts`
- Modify: `packages/shared/alm/inbound/al-inbound-admission-store.ts` (delete `acceptControlMessage`, `readControlAdmission`, `readCorrelatedControlAdmission`, `writeControlAdmission`, the two module-private functions at lines 1069-1150 and the interfaces at 1048-1068; keep `readControlOwnerIndex`, `readAcknowledgementState`, `readMessageOwnerRecord` public as read ports)
- Modify: `packages/shared/alm/inbound/al-inbound-message-runtime.ts:119-170` (`admitIncomingMessage`, `admitControlMessage`)
- Modify: `packages/shared/alm/inbound/al-inbound-work-entry.ts` (new payload kind `admit-control`)
- Test: `packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts`

**Interfaces:**

- Produces:

```ts
export interface ALInboundControlAdmissionDependencies {
    readonly admissionStore: ALInboundAdmissionStore;
    readonly port: ALWorkQueuePort;
    readonly clock: { nowMs(): number; };
    readonly newControlId: () => string;
    readonly retention: NormalizedALRuntimeStoreRetentionConfig;
}

export type ALInboundControlAdmissionResult =
    | Readonly<{ kind: 'not-handled'; }>
    | Readonly<{ kind: 'committed'; acceptance: ALControlAcceptance; }>
    | Readonly<{ kind: 'pending-control'; }>
    | Readonly<{ kind: 'rejected'; reason: string; }>;

export class ALInboundControlAdmission {
    constructor(dependencies: ALInboundControlAdmissionDependencies);
    /** One conditional commit; a conflict retains admit-control work for the worker. */
    admit(msg: ALMessage): Promise<ALInboundControlAdmissionResult>;
    /** Runs one retained attempt from the worker. */
    replay(payload: ALInboundPendingControl): Promise<ALWorkOutcome>;
}

export interface ALInboundPendingControl {
    readonly kind: 'admit-control';
    readonly msg: ALMessage;
    readonly expiresAtMs: number;
}
```

- `ALInboundRuntimeStores` and `ALInboundMessageRuntime.Resources` gain
  `readonly workQueue: QueueBoxResourceEntryRepository` (the backend's queue): the store factories in
  `al-runtime-stores.ts` and `browser-al-runtime-stores.ts` return their backend's queue,
  `createDefaultALInboundRuntimeResources` returns its local `InMemoryQueueBox`, and the runtime
  constructor builds `this.workPort = createALWorkQueuePort({ queue: dependencies.workQueue, workTypes: new Set([toALInboundWorkType(namespace)]), leaseMs: AL_INBOUND_WORK_LEASE_MS, nowMs: () => clock.nowMs(), random })`
  and hands it to `ALInboundControlAdmission` (rulings R1, R2). The admission store keeps
  `workQueue` until Task 5 removes its last caller (`retainPending`).

`admit` = decode (`decodeALControlMessage`) → read (`readControlAdmission` moved here) →
`computeALInboundControlAdmission` → `validateALInboundControlAdmission` (returns `Either`) →
`admissionStore.commitMutations(...)`; when the commit returns `'conflict'` it calls
`port.retainIfAbsent(computeALInboundWorkEntry({ payload: { kind: 'admit-control', msg, expiresAtMs }, ... }))`
and returns `{ kind: 'pending-control' }`. Nothing in the file throws for an expected outcome.

- [x] **Step 1: Write the failing test**

Create `packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts` with three cases:
a valid ACK for a tracked message commits and returns `committed` with `acceptance.handled === true`;
an ACK from a peer that does not own the message returns `not-handled` and writes nothing (assert the
ACK history is unchanged through `readAcknowledgementState`); a commit that conflicts (inject a
backend whose `write` throws `ALAdmissionBackendConflictError` once, as
`packages/tests/shared/alm/al-admission-backend.test.ts` does) returns `pending-control` and the work
queue holds one `admit-control` row whose `replay` then commits.

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts`
Expected: FAIL, module not found.

- [x] **Step 3: Move the code and change the runtime**

Move the three functions and the read/write methods listed above into the new files verbatim,
then replace `throw new ALAdmissionBackendConflictError(...)` inside the moved write path with a
returned `'conflict'` (the store's `commitMutations` already maps the backend's conflict to the
value). In `al-inbound-message-runtime.ts` rename `handleIncomingMessage` → `admitIncomingMessage`
and `handleControlMessage` → `admitControlMessage`, construct `new ALInboundControlAdmission({...})`
in the constructor, and map its result to the existing `Acceptance` union (`pending-control` →
`{ kind: 'pending-admission' }`). Delete the `catch (error) { if (error instanceof ALAdmissionBackendConflictError) ... }`
block at lines 160-163. Add `admit-control` to `ALInboundDurableEffect` and to
`decodeALInboundWorkEntry`. Update the three call sites of `handleIncomingMessage`
(`ws-queue-box-server-service.ts:402`, `ws-queue-box-client-service.ts:436`,
`web-rtc-rx-streamer-service.ts:145`) and every test that names it.

- [x] **Step 4: Run the inbound suites**

Run: `npx vitest run packages/tests/shared/alm packages/tests/shared/al-inbound-message-runtime.test.ts packages/tests/shared/services packages/tests/shared/webrtc packages/tests/shared/multicast`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/shared packages/tests
git commit -m "refactor(alm): lift inbound control admission into its own owner with conflict as a value"
```

---

### Task 5: Compose the inbound runtime on the port and the generic handler

**Files:**

- Modify: `packages/shared/alm/inbound/al-inbound-message-runtime.ts` (`Resources`, constructor, `ready`, `dispose`)
- Modify: `packages/shared/alm/inbound/al-inbound-message-admission.ts:100-130` (`retainPending` uses the port)
- Modify: `packages/shared/alm/inbound/al-inbound-durable-effect-store.ts` (delete `claimReadyEffects`, `completeEffect`, `rejectEffect`, `finalizeExhaustedEffects`, `rescheduleEffect`, `releaseEffect`; keep `persistEffect`, `readOrderedDelivery`)
- Modify: `packages/shared/alm/inbound/al-inbound-admission-store.ts` (delete `workQueue`, the forwarding methods, and `Claim/Finalize/RescheduleALInboundEffectInput`)
- Modify: `packages/shared/alm/inbound/read-al-inbound-work-selection.ts` (becomes the inbound `selectReady`)
- Modify: `packages/shared/alm/inbound/create-default-al-inbound-message-runtime.ts` (creates the port)
- Delete: `packages/shared/alm/inbound/al-inbound-work-handler.ts`
- Test: rewrite `packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts` against the port and handler; update `packages/tests/shared/al-inbound-message-runtime.test.ts`

**Interfaces:**

- `ALInboundMessageRuntime.Resources` already carries `readonly workQueue` (Task 4); the runtime
  constructor already builds `this.workPort` from it (ruling R2). This task removes
  `ALInboundAdmissionStore.workQueue` and the forwarding methods and moves `retainPending` onto the port.
- The inbound `selectReady(port, pageSize)` keeps the status rotation and readiness probe of the old
  handler (`readALInboundWorkSelection`) but returns `ALWorkReadySelection` and calls `port.claim({ maxCount, observedEntries: claimable })`.
- `runClaim(claim)` decodes the entry with `decodeALInboundWorkEntry`, dispatches on `payload.kind`:
  `admit-message` → `admission.replay`, `admit-control` → `controlAdmission.replay`, everything else →
  `delivery.deliver(effect)`, mapping `'completed' | 'retry'` and `{ retryAfterMs }` to `ALWorkOutcome`.

- [x] **Step 1: Rewrite the lifecycle test first**

Rewrite `al-inbound-effect-worker-lifecycle.test.ts` so each case retains work through
`resources.workQueue.enqueueIfAbsent(...)`, drives the engine, and asserts outcomes through
`resources.workQueue.getItem(key)`. Keep its four behaviors: transient claim failure retries;
corruption rejects; disposal stops further batches; a not-ready deferral keeps `attempts` at 0.
Add the crash-convergence case the spec's F2 acceptance names: a progress commit persisted, the
claim released as `retry` before the effect completed, and redelivery converging on the next batch
(ruling R17). Add a case that `committed()` returns synchronously and never awaits delivery (R16).

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts`
Expected: FAIL on the new cases (synchronous `committed()`, crash convergence) while the old handler is still composed.

- [x] **Step 3: Compose**

In the runtime constructor replace `new ALInboundWorkHandler({...})` with (the port is the one
the constructor already built from `dependencies.workQueue` in Task 4; the inbound `selectReady`
is a selector created in the constructor that owns the scan state `cursor`/`statusIndex`, ruling R8):

```ts
this.work = new ALWorkHandler({
    workerId: dependencies.effectWorkerId,
    port: this.workPort,
    queueEngine: dependencies.queueEngine,
    ownsQueueEngine: dependencies.ownsQueueEngine,
    clock: dependencies.clock,
    pageSize: 16,
    selectReady: (port, pageSize) =>
        selectReadyInboundWork({
            port,
            pageSize,
            delivery: this.delivery,
            namespace: this.admissionStore.namespace,
            nowMs: () => dependencies.clock.nowMs()
        }),
    runClaim: (claim) => this.runInboundClaim(claim),
    diagnostics: undefined
});
```

`admitIncomingMessage` ends with `this.work.committed();` (no await), and so does
`admitControlMessage` before `onControlMessage` runs (ruling R16). Delete the old handler file
and every import of it.

- [x] **Step 4: Run the suites and the typecheck**

Run: `npx vitest run packages/tests/shared/alm packages/tests/shared/al-inbound-message-runtime.test.ts packages/tests/shared/services packages/tests/shared-web/al-runtime && npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: PASS and exit 0.

- [x] **Step 5: Commit**

```bash
git add packages/shared packages/tests
git commit -m "refactor(alm): compose the inbound runtime on the work port and the generic handler"
```

---

### Task 6: Outbound keys, decoder at construction, control admission owner, and dequeue work

**Files:**

- Create: `packages/shared/alm/outbound/al-outbound-admission-keys.ts`
- Move: `packages/shared/alm/outbound/al-outbound-admission-control-store.ts` → `packages/shared/alm/outbound/control/al-outbound-control-admission.ts`
- Modify: `packages/shared/alm/outbound/al-outbound-admission-store.ts` (interface and class), `al-outbound-admission-effect-store.ts`, `al-outbound-work-entry.ts`, `al-outbound-effect-validation.ts`, `al-outbound-repair-admission.ts`, `al-outbound-message-runtime.ts`, `create-default-al-outbound-message-runtime.ts`
- Test: `packages/tests/shared/alm/outbound/al-outbound-dequeue-work.test.ts`; update `packages/tests/shared/al-outbound-message-runtime.test.ts`, `al-outbound-durable-effects.test.ts`, `packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts`, `outbound-runtime-test-fixture.ts`

**Interfaces:**

- `al-outbound-admission-keys.ts` exports the five pure key builders, each `(namespace: string, id: string) => string`:
  `toALOutboundMessageOwnerKey`, `toALOutboundVersionKey`, `toALOutboundSentMessageKey`, `toALOutboundPendingAckKey`, `toALOutboundRepairAttemptKey`. Both stores import them; the duplicated private builders are deleted.
- `CreateALOutboundAdmissionStoreInput<TPrepared>` becomes `{ nowMs; canonicalScope; namespace; backend; supersedenceTrackTtlMs; retention; decodePrepared: ALOutboundPreparedMessageDecoder<TPrepared> }` (all required); `createALOutboundAdmissionStore<TPrepared>(input)`; every method loses its `decodePrepared` parameter; `ALOutboundAdmissionStore<TPrepared>` loses `workQueue`, `claimReadyEffects`, `completeEffect`, `rejectEffect`, `rescheduleEffect`, `peekNextEffectReadyAt`, `acceptControlMessage`, `scheduleNotYetInSyncRetry`.
- `ALOutboundControlAdmission<TPrepared>` (moved store) exposes `admit(msg): Promise<ALOutboundControlAdmissionResult>` with the same result union as the inbound one (`not-handled | committed | pending-control | rejected`) and `scheduleNotYetInSyncRetry(schedule)`; `validateEffects` returns `readonly ALOutboundEffectIssue[]` (`{ code: string; effectId: string; message: string }`), and `assertObservations` becomes `validateObservedWork(...)` returning issues that the commit turns into `'conflict'`.
- New outbound work payload `{ kind: 'dequeue-message'; queueTypeId: string }` decoded from a foreign queue row (a row whose `typeId` is in `dequeueTypes`): `decodeALOutboundWorkEntry` returns `{ effectId: toKeyAsString(entry.key), payload: { kind: 'dequeue-message', queueTypeId: entry.typeId }, canonicalMessage: readMessageFromEntry(entry), ... }` for those rows.
- `ALOutboundMessageRuntime.Dependencies` gains `readonly dequeue: { readonly types: ReadonlySet<string>; readonly resilience: ResourceInboxResilience; }`; `ALOutboundRuntimeStores` and `ALOutboundMessageRuntime.Resources` gain `readonly workQueue: QueueBoxResourceEntryRepository` (the backend's queue, returned by the store factories and by `createDefaultALOutboundRuntimeResources`); the runtime constructor builds `this.workPort = createALWorkQueuePort({ queue: dependencies.workQueue, workTypes: new Set([toALOutboundWorkType(namespace), ...dequeue.types]), leaseMs, nowMs, random })` (rulings R1, R2); `dequeue()` is deleted. The three production constructions (`ws-queue-box-server-service.ts:173`, `ws-queue-box-client-service.ts:177`, `web-rtc-overlay-multicast-manager.ts:134`) pass `dequeue` and receive `workQueue` from their stores in this task so every commit typechecks; the overlay manager's `this.outbox` reads the stores' `workQueue` (rulings R3, R4). `runDurableEffect` gains:

```ts
case 'dequeue-message':
    return await this.admitDequeuedMessage(effect);
```

```ts
private async admitDequeuedMessage(effect: ALOutboundEffectSnapshot<TPrepared>): Promise<ALWorkOutcome> {
    const { resilience } = this.dependencies.dequeue;
    if (resilience.isNotAllowedThroughToDequeue()) {
        return { status: 'not-ready', readyAtMs: this.readNowMs() + resilience.toCircuitOpenBackoffMs() };
    }
    const msg = effect.canonicalMessage;
    if (!msg) {
        throw new NonRetryableException('Dequeued work has no message');
    }
    if (await this.dependencies.admissionStore.isMessageSuperseded(msg)) {
        return { status: 'completed' };
    }
    const computed = await this.commitDispatchPlan({
        msg,
        planner: this.dependencies.planDequeuedMessage,
        intent: 'dequeue',
        phase: 'dequeue',
        options: {
            observedOutboxEntry: effect.entry,
            attemptIdentity: JSON.stringify(['queue', effect.attempts, effect.entry.dequeueAudit.startTs?.toString() ?? null])
        }
    });
    if (computed.status === 'expired' || computed.status === 'superseded' || computed.status === 'skipped') {
        return { status: 'completed' };
    }
    if (computed.status === 'failed') {
        throw new NonRetryableException(computed.reason);
    }
    if (computed.status === 'no-route') {
        resilience.failure();
        return { status: 'retry' };
    }
    resilience.success();
    await this.dependencies.afterDequeueAdmission?.(msg, effect.entry);
    return { status: 'completed' };
}
```

`ResourceInboxResilience.toCircuitOpenBackoffMs()` must exist; check
`packages/shared/queuebox/resource-inbox/resource-inbox-resilience.ts` and add it as a pure read of
the circuit breaker's configured open duration if absent.

- [x] **Step 1: Write the failing dequeue-work test**

Create `packages/tests/shared/alm/outbound/al-outbound-dequeue-work.test.ts` using the fixture in
`outbound-runtime-test-fixture.ts` (extend `OutboundTestRuntimeInput` with `dequeue`):

```ts
it('claims a foreign outbox row as dequeue-message work and admits it through the planner', async () => {
    const outbox = new InMemoryQueueBox(
        undefined,
        () => Temporal.Instant.fromEpochMilliseconds(now())
    );
    const runtime = await createOutboundTestRuntime({
        outbox,
        dequeue: { types: new Set(['WS_OUTBOX']), resilience: new ResourceInboxResilience() },
        planOutgoingMessage: plan,
        sendPreparedMessage: recordSend
    });
    const message = newALUnicastMessage('server', route(), 'peer-1', 'chat', { n: 1 });
    await outbox.enqueueIfAbsent(QueueBoxUtilities.toResourceEntryFromMsg(message, 'WS_OUTBOX'));

    await runtime.ready();
    await drainEngine();
    expect(sent.map((prepared) => prepared.msgId)).toEqual([message.id.msgId]);
    expect(
        (await outbox.getItem(QueueBoxUtilities.toResourceEntryFromMsg(message, 'WS_OUTBOX').key))
            ?.status
    ).toBe(EntityStatus.COMPLETED);
});

it('keeps a no-route dequeue on the retry budget and a failed admission non-retryable', async () => {
    /* two rows, assert RETRY with attempts 1 and NON_RETRYABLE */
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared/alm/outbound/al-outbound-dequeue-work.test.ts`
Expected: FAIL, `dequeue` is not a fixture option.

- [x] **Step 3: Implement**

Create the keys module and replace both stores' private builders. Move the control store to
`outbound/control/`, rename the class `ALOutboundControlAdmission`, take `decodePrepared` from the
store input at construction, convert `throw workValidated[0]` and the two conflict throws into returned
values, and add the `pending-control` retention through the port exactly as Task 4 did inbound.
Change `CreateALOutboundAdmissionStoreInput` and the interface as listed; delete the per-call
decoder parameters. Add the `dequeue-message` payload and decoder branch. Add `workQueue` to the
resources and `dequeue` to the dependencies, build the port in the constructor, compose `ALWorkHandler` as Task 5 did with
`selectReady: (port, size) => port.claim({ maxCount: size, observedEntries: undefined }).then((claims) => ({ claims, nextReadyAtMs: undefined }))`
and `runClaim: (claim) => this.runOutboundClaim(claim)` (decode → `runDurableEffect`), and
`readNextReadyAtMs: (port) => this.readOutboundReadyAt(port)` keeping the old handler's probe
semantics (NEW and unleased RESERVED are ready now, RETRY at `nextTs`, expired rows skipped) (R31,
R32; also make the port's own `peekNextReadyAt` skip expired rows). Delete
`dequeue()`, rename `handlePendingAckTimeout` → `retryPendingAck` and `executeRepairFromHint` →
`retransmitFromRepairHint`. Delete `al-outbound-work-handler.ts`. The awaited inline
`processCommitted()` after a send is gone with it: `send`/`admit` end with the synchronous
`committed()` (H5). Wire the middleware's existing `outboundDiagnostics` sink from the black-box
page composition (beside the F1 diagnostics ports) so `sender-queue-wait`, `browser-lock-wait`,
`browser-lock-hold` and `effect-drain` durations land in the agent event log, and raise
`EXPIRY_TTL_MS` in `create-alm-conformance-recipes.ts` above the admission latency the runner
measured (1.3–5 s) while staying below the receive window. Land `al-outbound-admission-store.ts`,
`al-outbound-admission-effect-store.ts`, `al-outbound-message-runtime.ts` and
`al-outbound-repair-admission.ts` under the cognitive-load warn tier (R29). In
`create-default-al-outbound-message-runtime.ts` return the stores' `workQueue` as a resource (the
backend is the composition root's own value, so the store no longer exposes the queue).

- [x] **Step 4: Run the outbound suites and the typecheck**

Run: `npx vitest run packages/tests/shared/alm packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/al-outbound-durable-effects.test.ts packages/tests/shared/al-durable-runtime.test.ts && npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: PASS and exit 0 (the runtime tests that called `runtime.dequeue(...)` are rewritten to enqueue a foreign row and drive the engine).

- [x] **Step 5: Commit**

```bash
git add packages/shared packages/tests
git commit -m "refactor(alm): one outbound work owner, control admission as its own owner, keys and decoder at construction"
```

---

### Task 7: Delete the legacy dequeue consumers in the three services and the middleware

**Files:**

- Modify: `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:334-339` (delete `dequeueOutbox`; Task 6 already passes `dequeue: { types: WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, resilience }` and `workQueue` when constructing the outbound runtime)
- Modify: `packages/shared/services/ws-queue-box-client-service.ts:573-579` and the `includeTask` registration near lines 180-200 (delete the outbox task; the runtime's handler owns the engine task)
- Modify: `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts:355-363` and its outbox `includeTask` registration
- Modify: `packages/shared-server/rallar-system/middleware/rallar-middleware-queue-registration.ts:131-146` (delete the `WsQueueBoxServerService.OUTBOX_ENQUEUE_TYPE` task)
- Modify: `packages/shared/services/queue-box-utilities.ts` (delete `defaultDequeue` if `rg -n "defaultDequeue" packages apps` finds no remaining caller other than the RTC rx streamer's inbox, which stays)
- Test: update `packages/tests/shared/services/ws-queue-box-server-ingress.test.ts`, `ws-queue-box-client-ingress.test.ts`, `packages/tests/shared/webrtc-overlay-services.test.ts`, `packages/tests/shared-server/rallar-system/middleware/rallar-middleware-queue-completeness.test.ts`, `apps/api-v1/test/services/ws-room-live-fanout.test.ts`

- [x] **Step 1: Find every registration and caller**

Run: `rg -n "dequeueOutbox|outboundRuntime\.dequeue|OUTBOX_DEQUEUE_TYPES|includeTask\(" packages/shared/services packages/shared/multicast packages/shared-server/rallar-system/middleware apps/api-v1/src`
Expected: the sites listed above plus the RTC rx streamer's inbox task, which is out of scope.

- [x] **Step 2: Run the affected tests to see them fail after deletion**

Delete the methods and registrations, then run:
`npx vitest run packages/tests/shared/services packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared-server/rallar-system/middleware`
Expected: FAIL on tests that called `dequeueOutbox` directly.

- [x] **Step 3: Rewrite those tests to drive the engine**

Each test that called `service.dequeueOutbox(types, resilience)` now enqueues the outbox row and
awaits `engine.wake()` followed by the runtime's batch (use the same `drainEngine()` helper as
Task 6's test; put it in `packages/tests/shared/alm/outbound-runtime-test-fixture.ts`).

- [x] **Step 4: Run tests, typechecks, and the Deno check**

Run: `npx vitest run packages/tests/shared/services packages/tests/shared/webrtc-overlay-services.test.ts packages/tests/shared-server packages/tests/api-v1 && npm --workspace @ar-eye-hunter/shared-server run typecheck && cd apps/api-v1 && deno task check`
Expected: PASS and exit 0.

- [x] **Step 5: Commit**

```bash
git add packages/shared packages/shared-server packages/tests apps/api-v1
git commit -m "refactor(alm): delete the legacy outbound dequeue path; the work handler is the only consumer"
```

---

### Task 8: Indexed reads in the IndexedDB queue box

**Files:**

- Modify: `packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts:11-60` (`StoredResourceEntry` gains `expiryEpochMs: number` and `endEpochMs: number | null`; `encodeStoredResourceEntry` fills them from `audit.expiryTs` and `dequeueAudit.endTs`)
- Modify: `packages/shared/queuebox/indexed-db-queue-box-store.ts:24-40` (two new indexes `by-expiry` on `expiryEpochMs` and `by-status-end` on `['status', 'endEpochMs']`), delete `readAllStoredQueueEntries`, add `readStoredQueueEntriesByTypeStatus`, `readExpiredStoredQueueEntries`, `readCompletedStoredQueueEntriesBefore`
- Modify: `packages/shared/queuebox/indexed-db-queue-box.ts` bodies of `cleanupAsync` (156), `reserveTimeoutEntries` (288), `reserveEntries` (338), `reserveRetryExhaustionFinalizations` (432), `isAnyEntryToLock` (477), and the two helper functions at the file's tail that call `readAllStoredQueueEntries`
- Test: `packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts`; keep `packages/tests/shared/indexeddb-queuebox.test.ts` green

**Interfaces:**

- Produces in the store module:

```ts
export const INDEXED_DB_QUEUE_EXPIRY_INDEX_NAME = 'by-expiry';
export const INDEXED_DB_QUEUE_STATUS_END_INDEX_NAME = 'by-status-end';

export async function readStoredQueueEntriesByTypeStatus(
    db: IDBDatabase,
    storeName: string,
    typeId: string,
    status: EntityStatus,
    maxToRead: number
): Promise<readonly StoredResourceEntry[]>;

export async function readExpiredStoredQueueEntries(
    db: IDBDatabase,
    storeName: string,
    nowEpochMs: number,
    maxToRead: number
): Promise<readonly StoredResourceEntry[]>;

export async function readCompletedStoredQueueEntriesBefore(
    db: IDBDatabase,
    storeName: string,
    status: EntityStatus,
    endBeforeEpochMs: number,
    maxToRead: number
): Promise<readonly StoredResourceEntry[]>;
```

each built from one `IDBKeyRange` and `index.getAll(range, maxToRead)` inside `readIndexedDbTransaction`.
Every former whole-store scan becomes a loop over the requested `typeIds × statuses` with a page of
`maxToReserve` (or 64 for probes), and `cleanupAsync` deletes at most 256 expired rows and 256
retention-expired completed rows per run.

- [ ] **Step 1: Write the failing test**

Create `packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts` with `fake-indexeddb/auto`:
seed 300 entries of three types and mixed statuses, then assert (a) `reserveEntries` for one type
never returns another type and touches at most `maxToReserve` rows (spy on `getAll` calls through a
wrapped `IDBIndex.prototype.getAll` and assert the `count` argument is bounded), (b) `cleanupAsync`
removes only expired rows and completed rows past retention, (c) `isAnyEntryToLock` returns true when
one RETRY row is due and false when none is, and (d) `readAllStoredQueueEntries` no longer exists
(`expect('readAllStoredQueueEntries' in storeModule).toBe(false)`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the two fields and two indexes, write the three readers, and rewrite the five bodies. For
`reserveEntries` with `observations === undefined`:

```ts
const candidates: StoredResourceEntry[] = [];
for (const typeId of typeIds) {
    for (const status of statusIds) {
        candidates.push(
            ...await readStoredQueueEntriesByTypeStatus(
                db,
                this.#storeName,
                typeId,
                status,
                maxToReserve
            )
        );
    }
}
```

and keep the existing per-row predicate loop unchanged over `candidates`. `reserveTimeoutEntries`
reads `RESERVED` per type; `reserveRetryExhaustionFinalizations` reads `FAILED` and `RESERVED` per
type with `maxToReserve`; `isAnyEntryToLock` reads one `NEW` row per type, `RETRY` rows via the
fairness index with `fairnessDueEpochMs <= now` (`IDBKeyRange.bound([typeId, RETRY, 0], [typeId, RETRY, now])`, count 1),
and `RESERVED` rows (64 per type) for the timeout predicate; `cleanupAsync` uses the two new readers.

- [ ] **Step 4: Run the queue box suites**

Run: `npx vitest run packages/tests/shared/queuebox packages/tests/shared/indexeddb-queuebox.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/queuebox packages/tests/shared
git commit -m "perf(queuebox): indexed IndexedDB reads replace every whole-store scan"
```

---

### Task 9: AL-owned rows keyed by owner, and browser cleanup by key range

**Files:**

- Modify: `packages/shared/alm/outbound/al-outbound-canonical-message.ts:68-82` (`toALOutboundCanonicalKey` returns `{ topicId: 'AL_OUTBOUND_MESSAGE', resourceId: \`scope-${fnv1a64(scope)}\`, contextId: \`message-${fnv1a64(identity)}\` }`;`toALOutboundIdentityKey`returns`{ topicId: 'AL_OUTBOUND_IDENTITY', resourceId: key.resourceId, contextId: key.contextId }`),`al-outbound-work-entry.ts:33-39`(namespace in`resourceId`)
- Modify: `packages/shared-web/browser/al-runtime/browser-al-work-cleanup.ts` (replace the full-range cursor with one bounded range per owned prefix and topic), `browser-al-runtime-cleanup.ts`
- Test: update `packages/tests/shared-web/al-runtime/browser-al-runtime-cleanup-validation.test.ts`, `browser-outbound-cleanup.test.ts`, `browser-al-runtime-ownership.test.ts`

- [ ] **Step 1: Write the failing cleanup test**

Add to `browser-outbound-cleanup.test.ts` a case that seeds work and canonical rows for two sessions,
runs the session cleanup for one, and asserts through a spied `IDBObjectStore.prototype.openCursor`
that every range passed starts with `AL_INBOUND/<prefix>` or `AL_OUTBOUND/<prefix>` or
`AL_OUTBOUND_MESSAGE/scope-<hash>` and that the other session's rows survive.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/tests/shared-web/al-runtime/browser-outbound-cleanup.test.ts`
Expected: FAIL (the current cursor range is the whole AL topic range).

- [ ] **Step 3: Implement the key layout and the range reads**

Change the three key builders. In `readBrowserALWorkCleanupRows` replace the single
`IDBKeyRange.bound('AL_INBOUND', 'AL_OUTBOUND￿')` with one cursor per range in
`toBrowserALWorkCleanupRanges(keyPrefixes, canonicalScopes)`:

```ts
export function toBrowserALWorkCleanupRanges(input: {
    readonly namespacePrefixes: readonly string[];
    readonly canonicalScopes: readonly string[];
}): readonly IDBKeyRange[] {
    const ranges: IDBKeyRange[] = [];
    for (const prefix of input.namespacePrefixes) {
        const encoded = encodeURIComponent(prefix);
        ranges.push(IDBKeyRange.bound(`AL_INBOUND/${encoded}`, `AL_INBOUND/${encoded}￿`));
        ranges.push(IDBKeyRange.bound(`AL_OUTBOUND/${encoded}`, `AL_OUTBOUND/${encoded}￿`));
    }
    for (const scope of input.canonicalScopes) {
        const hashed = `scope-${fnv1a64(scope)}`;
        ranges.push(
            IDBKeyRange.bound(`AL_OUTBOUND_MESSAGE/${hashed}/`, `AL_OUTBOUND_MESSAGE/${hashed}/￿`)
        );
        ranges.push(
            IDBKeyRange.bound(`AL_OUTBOUND_IDENTITY/${hashed}/`, `AL_OUTBOUND_IDENTITY/${hashed}/￿`)
        );
    }
    return ranges;
}
```

The session cleanup passes `canonicalScopes: [\`browser-session:${sessionId}\`]`; the expiry cleanup
passes the global prefix and uses the queue box's`cleanupAsync`for expired rows instead of the AL
range scan. Delete`isSelectedBrowserCanonicalScope` and the identity-fact decoding that only served
scope filtering.

- [ ] **Step 4: Run the shared-web suites**

Run: `npx vitest run packages/tests/shared-web/al-runtime packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts packages/tests/shared/alm/al-admission-backend.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/shared-web packages/tests
git commit -m "perf(alm): key AL-owned rows by owner so browser cleanup is a key-range delete"
```

---

### Task 10: Schema identity and delete-on-mismatch reset

**Files:**

- Modify: `packages/shared/alm/open-indexed-db-admission-database.ts`
- Modify: `packages/shared/alm/al-runtime-stores.ts:88-120` (pass `schemaId` and `onStorageReset`)
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts` (pass `diagnosticsPorts.onStorageReset`)
- Modify: the `RallarDiagnosticsPorts` contract from F1 (add `readonly onStorageReset: (event: ALStorageResetEvent) => void`, default `() => {}`)
- Test: `packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts`

**Interfaces:**

```ts
export const AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-09-f2';
export const AL_ADMISSION_SCHEMA_KEY = '__rallar_al_schema__';

export interface ALStorageResetEvent {
    readonly dbName: string;
    readonly previousSchemaId: string | undefined;
    readonly schemaId: string;
    readonly reason: 'schema-id-mismatch' | 'store-schema-mismatch';
}

export interface OpenIndexedDbAdmissionDatabaseInput {
    readonly dbName: string;
    readonly storeName: string;
    readonly schemaId: string;
    readonly onStorageReset: (event: ALStorageResetEvent) => void;
}

export async function openIndexedDbAdmissionDatabase(
    input: OpenIndexedDbAdmissionDatabaseInput
): Promise<IDBDatabase>;
export class ALStorageResetBlockedError extends Error {}
```

Behavior: open with the two store definitions; on a thrown store-schema mismatch from
`openIndexedDbWithStores`, or when the `AL_ADMISSION_SCHEMA_KEY` record is absent or differs,
close the database, `indexedDB.deleteDatabase(dbName)` (reject with `ALStorageResetBlockedError`
if `blocked` fires and does not resolve within 5 s), call `onStorageReset`, and open once more; a
second mismatch throws. The schema record is written as an initial record `{ key: AL_ADMISSION_SCHEMA_KEY, value: schemaId, expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP }`.

- [ ] **Step 1: Write the failing test**

Create `packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts` with `fake-indexeddb/auto`:
open a database through `openIndexedDbAdmissionDatabase` with `schemaId: 'old'`, write one admission
row, close; open again with `schemaId: AL_ADMISSION_SCHEMA_ID` and a recording `onStorageReset`;
assert the event `{ previousSchemaId: 'old', schemaId: AL_ADMISSION_SCHEMA_ID, reason: 'schema-id-mismatch' }`
was emitted once, the old row is gone, and the schema record now holds the new id. Second case: a
database created with a different store set (open `indexedDB.open(dbName)` and create a single store
named `legacy`) resets with `reason: 'store-schema-mismatch'`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts`
Expected: FAIL, the function does not accept an input object.

- [ ] **Step 3: Implement**

```ts
export async function openIndexedDbAdmissionDatabase(
    input: OpenIndexedDbAdmissionDatabaseInput
): Promise<IDBDatabase> {
    const first = await openOrReset(input, undefined);
    if (first.kind === 'open') {
        return first.db;
    }
    input.onStorageReset(first.event);
    const second = await openOrReset(input, 'after-reset');
    if (second.kind === 'open') {
        return second.db;
    }
    throw new Error(`ALM storage ${input.dbName} still mismatches after reset`);
}

async function openOrReset(
    input,
    attempt
): Promise<{ kind: 'open'; db: IDBDatabase; } | { kind: 'reset'; event: ALStorageResetEvent; }> {
    let db: IDBDatabase;
    try {
        db = await openIndexedDbWithStores(
            input.dbName,
            toAdmissionStoreDefinitions(input.storeName, input.schemaId)
        );
    }
    catch (error) {
        if (attempt === 'after-reset' || !isIndexedDbSchemaMismatch(error)) {
            throw error;
        }
        await deleteIndexedDbDatabase(input.dbName);
        return {
            kind: 'reset',
            event: {
                dbName: input.dbName,
                previousSchemaId: undefined,
                schemaId: input.schemaId,
                reason: 'store-schema-mismatch'
            }
        };
    }
    const stored = await readStoredSchemaId(db, input.storeName);
    if (stored === input.schemaId) {
        return { kind: 'open', db };
    }
    db.close();
    if (attempt === 'after-reset') {
        throw new Error('ALM schema id mismatch persisted after reset');
    }
    await deleteIndexedDbDatabase(input.dbName);
    return {
        kind: 'reset',
        event: {
            dbName: input.dbName,
            previousSchemaId: stored,
            schemaId: input.schemaId,
            reason: 'schema-id-mismatch'
        }
    };
}
```

`isIndexedDbSchemaMismatch` matches the three schema errors thrown by `open-indexed-db.ts`
(`'do not match the required schema'`, `'has key path'`, `'auto-increment does not match'`); make
those a typed `IndexedDbSchemaMismatchError` in `open-indexed-db.ts` rather than string matching.
`deleteIndexedDbDatabase` wraps `indexedDB.deleteDatabase` with `onblocked` → 5 s timer →
`ALStorageResetBlockedError`. Thread `schemaId: AL_ADMISSION_SCHEMA_ID` and `onStorageReset` from
`createIndexedDbAL*RuntimeStores` (required input) and from the browser composition's
`diagnosticsPorts.onStorageReset`. The black-box page composition records the event as a diagnostic
`rallar.browser.alm.storage_reset`.

- [ ] **Step 4: Run the suites**

Run: `npx vitest run packages/tests/shared-web/al-runtime packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared/alm/al-outbound-indexeddb-replay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared packages/shared-web packages/tests
git commit -m "feat(alm): schema identity with delete-on-mismatch reset for the browser ALM database"
```

---

### Task 11: Touched-file closure, dispositions, navigation maps, and the storage snapshot

**Files:**

- Modify: `scripts/repo-style-check/reviewed-dispositions.mjs` (delete every entry whose `path` starts with `packages/shared/alm`, `packages/shared/al-contracts` is out of scope; delete the `packages/shared/alm/inbound` and `packages/shared/alm/outbound` layout entries)
- Modify: `packages/shared/alm/inbound/README.md`, `packages/shared/alm/outbound/README.md`
- Modify: every touched ALM file for banned verbs, `room` in the shared `Source` contract (rename `roomRecipientPeerIds` → `groupRecipientPeerIds` with its producer in `rallar-server-ws-router.ts`), optional persisted fields `outboxKey?`/`supersedenceKey?` in `al-runtime-state-stores.ts:86-91` (make them `| null` required), and `toAdmissionAcceptance`'s string-prefix match in `al-inbound-message-admission.ts:163` (the plan returns a typed `dropReasonCode: 'duplicate' | ...`; add the code to `ALMessageHandlingPlan` in `al-policy.ts` beside `dropReason`)
- Create: `packages/tests/shared/alm/al-storage-snapshot.test.ts`

- [ ] **Step 1: Delete the dispositions and measure**

Delete the entries, then run:
`node scripts/repo-style-check.mjs --cognitive-metrics --root packages/shared/alm | grep -c "file.cognitive-load"`
Expected: `0`. Measured after Task 6: `compute-al-inbound-admission.ts` 64,
`validate-al-inbound-commit-bundle.ts` 58, `al-outbound-admission-store.ts` 62,
`al-outbound-message-runtime.ts` 55, `al-outbound-repair-admission.ts` 60. Ruling R40: move the
outbound admission family into `packages/shared/alm/outbound/admission/` (store, reads, keys,
effect store, validation, plus `al-outbound-admission-mutations.ts` holding the store's
compute/apply half) in one move with lineage entries, which also clears the directory's
zero-tolerance layout metrics (23 → 18 direct files); split the runtime's ack-timeout/repair
dispatch and the repair admission's retry scheduling along their real boundaries; split the two
inbound files along theirs (the admission compute's dedup/ordering halves; the bundle validation's
effect/mutation halves). `validateALInboundControlAdmission` returns every issue (global
constraint), not the first.

- [ ] **Step 2: Run the changed gate**

Run: `npm run check:repo-style:changed -- origin/main HEAD`
Expected: `PASS: no new repository style findings`. A finding here is fixed in code, never by a new
disposition.

- [ ] **Step 3: Update the navigation maps**

Rewrite the "Construction and registration", "Admission and invocation paths", and "Selection,
failure, and cleanup" sections of both READMEs to name `ALWorkQueuePort`, `ALWorkHandler`, the
`control/` owners, the `dequeue-message` work, the inbound message owner row, the key layout, and
the reset. Remove the sentences that no longer hold ("wakes the existing worker after commit"
becomes true and stays; "inbound effects can still contain envelope copies" is deleted; "the scan
currently visits the AL work range before filtering by session" is deleted).

- [ ] **Step 4: Write the storage snapshot test**

Create `packages/tests/shared/alm/al-storage-snapshot.test.ts`: with `fake-indexeddb/auto`, run the
standard workload (eight superseding updates to three recipients at 128 B, 4 KiB, and 64 KiB) through
`createDefaultIndexedDbALOutboundRuntimeStores` and the outbound runtime, then write
`tmp/perf/alm-storage-snapshot.json` with `{ workload, rowsByStatus, bytesByTopic, measuredAt: commit }`
(commit from `git rev-parse HEAD` via `node:child_process`) and assert the file has the four keys. The
PR body cites its numbers next to #521's 47,465-byte readback figure.

- [ ] **Step 5: Commit**

```bash
git add scripts/repo-style-check packages/shared packages/shared-server packages/tests
git commit -m "chore(alm): retire the ALM checker pins, close touched files, and refresh the navigation maps"
```

---

### Task 12: Whole-branch validation and the PR

- [ ] **Step 1: Run the full local gates**

```bash
npm run test:unit
cd apps/api-v1 && deno task check && deno task test && cd ../..
cd apps/rallar-black-box-control-server && deno task check && cd ../..
cd apps/relic-hunter-server-v1 && deno task check && cd ../..
npx dprint check
npm run check:repo-style:changed -- origin/main HEAD
npm run check:repo-style:navigation-details -- --root packages/shared/alm
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm run test:rallar:full-stack:memory:alm
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:postgres:integration
```

Expected: every command exits 0. The medium-scale and Postgres integration lanes need
`npm run db:test:up` on a fresh database first; record "skipped" with the reason if Docker is not
available and let the Release Gate run them.

- [ ] **Step 2: Manual 5/5 navigation probe**

From `WsQueueBoxServerService`'s construction of the outbound runtime, reach with Go to Definition
and Find Usages: the concrete operation entry (`admitDequeuedMessage`), the policy
(`planDequeuedMessage`), the first conditional guard (`commitDispatchPlan` → the store's observation
compare), the exact durable result (`commitBundle` → `'committed' | 'conflict' | 'expired'`), and the
after-commit effect (`ALWorkHandler.committed`). Record the five landmarks and any search escape in
the PR body.

- [ ] **Step 3: Open the PR**

Body sections: Goal (F2 outcome), Changes (Tasks 1 to 11 in one paragraph each), Acceptance (the
spec's F2 acceptance list mapped to tests and lanes), Validation (Step 1 with the commit each figure
was measured on, the storage snapshot numbers, the probe result), Risk and rollback (incompatible
browser schema id and key layout; every pending ALM browser row from the previous schema is discarded
on first open; rollback is the revert, and a reverted build resets the database again on the old
schema id), Follow-up (S1).

---

## Self-review

- Spec coverage: F2 items 1 (Tasks 6, 7), 2 (Task 3), 3 (Tasks 8, 9), 4 (Tasks 1, 2, 5, 6), 5 (Tasks 4, 6),
  6 (Tasks 6, 11), 7 (Task 10), 8 (Task 11). Acceptance: baseline family (Task 12 lane), crash convergence
  (Task 3's owner row plus the existing ordered-delivery commit; add a crash-between-commits case to
  `al-inbound-effect-worker-lifecycle.test.ts` in Task 5 if it is not already covered by the rewritten
  suite), reset with diagnostic (Task 10), zero warn-tier findings (Task 11 Step 1), no new disposition
  (Task 11 Step 2), storage snapshot (Task 11 Step 4).
- Placeholder scan: discovery steps carry exact commands and expected results; nothing is left to fill in later.
- Type consistency: `ALWorkQueuePort`, `ALWorkClaim`, `ALWorkOutcome`, `ALWorkAttemptResult`
  (Tasks 1, 2, 5, 6); `ALInboundMessageReference` (Task 3 used by Task 4's control reads and Task 5's
  delivery); `dequeue-message` payload and `Dependencies.dequeue` (Tasks 6, 7);
  `readStoredQueueEntriesByTypeStatus` and friends (Task 8); `toBrowserALWorkCleanupRanges` (Task 9);
  `openIndexedDbAdmissionDatabase` input and `ALStorageResetEvent` (Task 10, consumed by the browser
  composition and the black-box page runtime from F1).
