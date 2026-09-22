# ALM F2c Per-Row Fence and Batched Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three admission backends conflict-equivalent and make a work batch release once.
On IndexedDB an admission commit conflicts today when a store-global scalar moved, so an unrelated
outbound send, an ACK on another message, or a second inbound admission conflicts a commit in flight
regardless of row overlap; after this slice a commit conflicts only when a row its own decision read
or wrote actually moved. A batch that runs N claims writes one release instead of N, and the batch's
`releaseDurationMs` measures that one write. The receiver's inbound pending share and release phase
become repo-owned evidence: the observation snapshot decodes the inbound diagnostics topic, so the
figures F2b read from session scripts are read from a cell file instead.

**Architecture:** `packages/shared/alm/` keeps its owners. Every stored IndexedDB admission row
carries a `revision`; `IndexedDbAdmissionWriteBuffer`
(`packages/shared/alm/indexed-db-admission-backend.ts:265-381`) records the revision it observed for
every key the write phase read or wrote and the key list of every prefix it listed, and
`writeIndexedDbAdmissionMutations` (`packages/shared/alm/write-indexed-db-admission-mutations.ts:68-150`)
re-reads exactly those inside its readwrite. `AL_ADMISSION_REVISION_KEY` and its row are deleted and
`AL_ADMISSION_SCHEMA_ID` bumps, so existing browser storage resets on mismatch (D3, D17). The
app-level fence `requireOriginalObservations`
(`packages/shared/alm/inbound/al-inbound-admission-store.ts:631-690`) keeps its shape: reads outside
the write, fence inside it. `releaseEntries` on the QueueBox contract
(`packages/shared/queuebox/queue-box-types.ts:356-359`) takes a disposition per entry, and
`ALWorkHandler.runSelectedWork` (`packages/shared/alm/work/al-work-handler.ts:315-348`) collects its
batch's release decisions and flushes them once at the end. `ALAdmissionWorkBackend`'s own contract
does not change.

**Tech Stack:** TypeScript across Node, Deno, and browser; Vitest with `fake-indexeddb`; PGlite and
PostgreSQL for the server backend; Playwright for the conformance lane; dprint.

**Spec:** [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md),
section "Release 3, F2c: the per-row fence and batched releases", with decisions D3, D8 and D17 from
the decision record and the rules under "Governance and delivery rules". The controller's binding
design rulings are `.superpowers/f2c-design-rulings.md` (R-F2c-1 to R-F2c-4); the file:line ground
truth this plan argues from is `.superpowers/f2c-survey.md`. F2b is merged on `main` as `a336ad41c`
and S1 as `f82c64e23`; F2c starts from merged `main` and merges before S1's final gate (D16).

## Global Constraints

- Decision D8: search `packages/**` before writing anything; ask before an internal library; no new
  third-party dependency.
- No retained legacy: every replaced path is removed in the commit that replaces it, including its
  tests; obsolete coupled tests are rewritten in the same commit.
- No migration and no old-format fallback (D3, D17): incompatible ALM browser storage is deleted on
  schema mismatch. There is no compatibility window, no envelope version window, and no reader that
  accepts a row without the field this slice adds.
- Touched-file standards closure: every touched human-authored file is reviewed and remediated in
  full; a support file changed by that remediation enters closure recursively; independent untouched
  code stays outside.
- No duplicated logic: a private reader that already exists is widened, never re-implemented beside
  itself. The single-disposition `releaseEntries` is replaced, not kept beside the per-entry form.
- Canonical verbs (`readXxx`, `computeXxx`, `validateXxx`, `resolveXxx`, `toXxx`); `handle`,
  `process`, `execute`, `util`, `helper`, `data` do not appear in the touched files.
- Expected failure is an `Either` value or a typed outcome; `assertXxx` is reserved for programmer
  invariants. A conflict stays a value: `'conflict'` at every admission-store caller,
  `ALAdmissionBackendConflictError` only across the backend boundary that already throws it.
- Required fields by default in every contract this slice extends; an optional field is valid only
  where absence has a distinct domain meaning (state it in the field's comment).
- At most three positional parameters; at four, one named input interface.
- `interface` for object contracts, `type` for unions, mapped, tuple and function types. One
  canonical name per type: no alias, import rename or re-export that only renames an existing type.
- No new `file.cognitive-load` pin on an ALM file and no new disposition entry — the F2 constraint
  survives this slice. `docs/repo-code-style-exceptions.md` is used only for its three real cases.
- **Never weaken a harness budget to make a run pass.** `CONNECT_READINESS_TIMEOUT_MS` 30 000, the
  receiver window derived from `CONFORMANCE_DEADLINE_MS` 18 000, `NON_EXPIRING_SEND_TIMEOUT_MS`
  10 000 and `EXPIRY_TTL_MS` 7 500 are fixed by the 2026-09-11 maintainer decision. The regime
  thresholds `ALM_OBSERVATION_NORMAL_REGIME_MAX_MS_PER_OPERATION` 30 and
  `ALM_OBSERVATION_SLOW_REGIME_MIN_MS_PER_OPERATION` 35 are constants, not knobs.
- No new timer, queue, coalescing window or registry for releases. The batch loop is the only
  boundary the flush uses; `releaseRetainedClaim` stays one claim at a time.
- Every commit keeps focused Vitest, `npx dprint check <files>`, and the package typecheck green;
  before pushing: `npm run test:unit`, the three Deno checks, `npm run test:deno`,
  `npx dprint check`, `npm run check:repo-style:changed -- origin/main HEAD`,
  `node scripts/check-tests-typecheck.mjs`,
  `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`,
  `npm run test:rallar:full-stack:memory:alm`.
- `packages/shared/alm/inbound/README.md` and `packages/shared/alm/outbound/README.md` are updated in
  the same PR and never claim behaviour the code does not have. There is no
  `packages/shared/alm/README.md` in the tree and this slice does not add one.

## The measured starting point

F2b's Task 5 outcome (`plans/alm-f2b-inbound-owner-implementation-plan.md:437-449`, head
`80d017d24`) is the baseline this slice is measured against: every cell ran in a `slow` regime and
all three were red with the baseline signature, so F2c's runner comparison is a same-regime one or it
is not a verdict. Merged `main` `f8db93762` reproduced the same slow-regime signature.

| Evidence                                                    | Figure                                                                               | Source                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Per-operation cost, slow regime                             | rtc 48.2, rtc-with-ws-fallback 54.7 ms/op; ws unclassified (4 samples)               | F2b plan, Task 5 outcome (`:437-439`)                                         |
| Inbound `effect-drain` median per batch (sender / receiver) | rtc 14.0 / 10.5 s; fallback 9.1 / 6.4 s; ws 5.3 / 8.9 s                              | same (`:440-443`)                                                             |
| Inbound phase split, rtc (sender / receiver)                | run 9.0 / 4.6 s, **release 4.0 / 2.3 s**, claim 1.6 / 1.7 s, selection 0.15 / 0.53 s | same (`:441-442`)                                                             |
| Inbound queue wait, rtc                                     | 18.3 / 24.5 s                                                                        | same (`:442`)                                                                 |
| `pending` share of inbound `admission-outcome`              | rtc 77 / 76 %, fallback 69 / 73 %, ws 45 / 43 %                                      | same (`:442-443`)                                                             |
| Outbound `effect-drain` median, same run                    | 1.3–2.4 s                                                                            | same (`:443`)                                                                 |
| Local lane, normal regime                                   | 3 of 3 cells pass at 7–13 ms/op                                                      | same (`:448-449`)                                                             |
| One committing admission attempt, IndexedDB                 | `['readonly', 'readonly', 'readwrite']`, `liveWhenOpened()` `[0, 0]`                 | survey §1; `al-inbound-admission-transactions.test.ts:62-66,300-313`          |
| Retain then replay                                          | 5 transactions: `['readonly', 'readwrite', ...COMMITTING_ADMISSION_ATTEMPT]`         | survey §1; `al-inbound-admission-transactions.test.ts:75-79`                  |
| One inbound message, admit through deliver                  | 8 `al-admission` operations (6 admission + 2 drain)                                  | survey §4; `al-indexeddb-operation-counts.test.ts:259-263`                    |
| One drained `dispatch-local` row                            | 2 `al-admission` operations                                                          | survey §4; `al-indexeddb-operation-counts.test.ts:244-249`                    |
| One default send                                            | 10 `al-admission` and 15 `al-work` operations                                        | survey §4; `al-indexeddb-operation-counts.test.ts:197-231`                    |
| One release today                                           | one `work-release` operation per claim, batched or not                               | survey §3; `indexed-db-queue-box.ts:306-337`, `al-work-queue-port.ts:150-163` |

The release phase is the second-largest inbound cost component after the claims' own work, and no
repo-owned test or cell reproduces the pending share or the phase medians today: F2b's figures came
from session scripts (`inb.mjs`, `adm2.mjs`) that its plan calls session records, not repository
files (`plans/alm-f2b-inbound-owner-implementation-plan.md:59-61`, survey §4). Task 3 is what turns
them into a cell file, and Task 0 is what turns today's two costs into RED pins.

## The fence today

The three backends are not conflict-equivalent (survey §1, §5):

| Backend             | File                                                                                                                                    | Compare-and-set granularity                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory              | `packages/shared/alm/al-admission-backend.ts:133-162` (`InMemoryAdmissionBackend.write`)                                                | No revision. Writers are fully serialized through the `writeTail` promise chain, so a fence mismatch can only be a genuinely completed intervening write.     |
| IndexedDB           | `packages/shared/alm/indexed-db-admission-backend.ts:181-238` plus `packages/shared/alm/write-indexed-db-admission-mutations.ts:68-150` | One shared scalar `AL_ADMISSION_REVISION_KEY` per physical object store, shared by the inbound and outbound backends and by all three logical browser stores. |
| PostgreSQL / PGlite | `packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts:92-136` plus `p-sql-admission-mutation-collector.ts:17-36`  | Per-row `expectedRevision` / `expected: 'absent'` compare-and-set per mutation, so only writers touching the same row conflict.                               |

IndexedDB is strictly more conflict-prone than its own Postgres sibling and than the doctrine's model
(`.agents/skills/rallar-code-writing/references/convergent-service-writing.md:48-64,144-155`:
optimistic expected-revision compare-and-set, a conflict returned to the retry owner as a value, and
no lock without explicit human approval). Task 1 closes that gap; the memory backend's serialized
writer and the PostgreSQL per-row compare-and-set are unchanged.

**What the fence read set is.** Everything `requireOriginalObservations` re-reads through
`transaction: ALAdmissionWriteContext` (survey §1): the message owner row; `pendingAck` and `acks`;
`controlOwners`; the supersedence `latest`/`replacement` pair when the plan named a key; the dedup
expiry row; the ordering track snapshot **and every buffered row under the track's key prefix**, each
with its own canonical message row; delivery progress; and, for a release, one buffered snapshot with
its canonical message. Narrowing that surface (R20 lever 1) is **not** in this slice.

---

### Task 0: Pin today's two costs RED-first

Per ruling R-F2c-4. Nothing in this task changes production code.

**Files:**

- Modify: `packages/tests/shared/alm/inbound-runtime-test-fixture.ts` (`createInboundTestStores`,
  `:63-85`; new interleave hook beside `setNextInboundCommitConflicted`, `:219-232`)
- Modify: `packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts`
  (one new `it.fails`, existing pins untouched)
- Modify: `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` (one new `describe`)
- Read only: `.superpowers/f2c-survey.md`, `.superpowers/f2c-design-rulings.md`, and the F2b plan's
  Task 5 outcome paragraph.

**Interfaces:**

- Consumes: `IndexedDbAdmissionBackend`, `ALInboundAdmissionStore.commitBundle`,
  `createCountingIndexedDbOperationObserver`, `ALWorkHandler`, `createALWorkQueuePort`,
  `toTestALWorkReadySelection`, `recordIndexedDbTransactions`.
- Produces, in `packages/tests/shared/alm/inbound-runtime-test-fixture.ts`:

  ```ts
  export interface InboundTestBackendStores {
      readonly backend: ALAdmissionWorkBackend;
      readonly stores: ALInboundRuntimeStores;
  }

  export function createInboundTestBackendStores(
      input: CreateInboundTestStoresInput
  ): InboundTestBackendStores;

  export function setNextAdmissionWritePhaseInterleaved(
      backend: ALAdmissionWorkBackend,
      interleave: () => Promise<void>
  ): void;
  ```

  `createInboundTestStores` keeps its signature and becomes
  `createInboundTestBackendStores(input).stores`, so the existing fixture is widened rather than
  duplicated and no caller changes.

- [x] **Step 1: Widen the fixture to hand back its backend.** Move today's
      `createInboundTestStores` body (`inbound-runtime-test-fixture.ts:63-85`) into
      `createInboundTestBackendStores`, returning `{ backend, stores }`, and leave
      `createInboundTestStores` as the one-line delegation above. Add the interleave hook beside
      `setNextInboundCommitConflicted`:

      ```ts
      /**
       * Lands a complete second write between the next write phase's fence snapshot and its
       * conditional write: the callback has computed its mutations and nothing has committed yet,
       * which is the exact window a store-global revision turns into a false conflict.
       */
      export function setNextAdmissionWritePhaseInterleaved(
          backend: ALAdmissionWorkBackend,
          interleave: () => Promise<void>
      ): void {
          const write = backend.write.bind(backend);
          vi.spyOn(backend, 'write').mockImplementationOnce(
              async (operation, executionExpiresAtMs) =>
                  await write(async (transaction) => {
                      const result = await operation(transaction);
                      await interleave();
                      return result;
                  }, executionExpiresAtMs)
          );
      }
      ```

      `mockImplementationOnce` leaves the original as the default, so the nested write the
      `interleave` callback performs runs unhooked.
      Command: `npx tsc -p packages/shared/tsconfig.json --noEmit` and
      `npx vitest run packages/tests/shared/alm/inbound`
      Expected: green; no behaviour changed yet.
- [x] **Step 2: The disjoint-key interleave (RED).** Add to
      `al-inbound-admission-transactions.test.ts`:

      ```ts
      it.fails('commits two disjoint admissions interleaved across one fence', async () => {
          const { backend, stores } = createInboundTestBackendStores({
              namespace: TRANSACTION_NAMESPACE,
              storage: 'indexeddb',
              observer: createPassThroughIndexedDbOperationObserver()
          });
          await stores.admissionStore.ready();
          const fenced = await readInboundTestAdmission(
              stores.admissionStore,
              createInboundTestMessage({ msgId: 'fenced-admission' })
          );
          setNextAdmissionWritePhaseInterleaved(backend, async () => {
              await admitIncomingMessage(
                  stores.admissionStore,
                  createInboundTestMessage({ msgId: 'interleaved-admission' })
              );
          });

          // Today: the interleaved commit bumps AL_ADMISSION_REVISION_KEY, which the fenced write
          // compares even though the two messages share no row. Task 1 flips this to `it`.
          expect(
              await stores.admissionStore.commitBundle(fenced),
              'a commit whose read and write sets no other writer touched must not conflict'
          ).toBe('committed');
      });
      ```

      Command:
      `npx vitest run packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts`
      Expected: the new test reports as an expected failure (`commitBundle` returns `'conflict'`);
      every other pin in the file stays green.
- [x] **Step 3: The per-claim release count (RED).** Add to `al-indexeddb-operation-counts.test.ts`,
      reusing that file's `createOutboundWorkPort` (`:403-416`) and `newOutboundWorkEntry`
      (`:419-432`):

      ```ts
      describe('work batch release volume', () => {
          it('releases four completed claims in four work-release operations today', async () => {
              expect(await readCompletedBatchReleaseOperations(4)).toBe(4);
          });

          // Task 2 flips this to `it`: one batch, one release write.
          it.fails('releases one batch of completed claims in 1 work-release operation', async () => {
              expect(await readCompletedBatchReleaseOperations(4)).toBe(1);
          });
      });

      /** One batch of `claimCount` retained rows run to completion, counted by `work-release` alone. */
      async function readCompletedBatchReleaseOperations(claimCount: number): Promise<number> {
          const observer = createCountingIndexedDbOperationObserver();
          const port = createOutboundWorkPort(observer);
          const engine = new InboxOutboxEngine();
          const handler = new ALWorkHandler({
              workerId: 'al-outbound:batched-release',
              port,
              queueEngine: engine,
              ownsQueueEngine: false,
              clock: { nowMs: () => NOW_MS },
              pageSize: AL_OUTBOUND_WORK_PAGE_SIZE,
              readinessMemoryMs: AL_WORK_READINESS_MEMORY_MS,
              readNextReadyAtMs: (probed) => readALOutboundWorkReadyAt(probed, NOW_MS, NO_DEFERRAL),
              selectReady: async (claimable, size) =>
                  toTestALWorkReadySelection(
                      await claimable.claim({ maxCount: size, observedEntries: undefined })
                  ),
              runClaim: async () => ({ status: 'completed' }),
              diagnostics: undefined
          });
          await handler.ready();
          for (let index = 0; index < claimCount; index += 1) {
              await port.retainIfAbsent(newOutboundWorkEntry(WORK_TYPES[0], `batched-${index}`));
          }
          // The rows reach the queue behind the handler's back, so only this wake announces them.
          engine.wakeAfterExternalWrite();
          const before = observer.getCounts().byKind['work-release'] ?? 0;
          await engine.executeOnce();
          const released = (observer.getCounts().byKind['work-release'] ?? 0) - before;
          handler.dispose();
          return released;
      }
      ```

      Command: `npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
      Expected: the first test passes at 4; the second reports as an expected failure. If the
      measured figure is not 4, record the real one in both tests and in the commit message rather
      than adjusting the batch.
- [x] **Step 4: Re-state the pins that must survive, without weakening them.** Confirm by running
      them, and name them in the commit message as the slice's regression set:
      `al-inbound-admission-transactions.test.ts` — `COMMITTING_CONTROL_ADMISSION` and
      `COMMITTING_ADMISSION_ATTEMPT` both `['readonly', 'readonly', 'readwrite']` (`:55-66`),
      `RETAIN_THEN_REPLAY` (`:75-79`), `ONE_DECISION_SURFACE` `['readonly']` (`:47`),
      `ONE_DISPATCHED_MESSAGE` and `DISPATCH_WITHOUT_ITS_OBSERVATION` (`:88-96`), and
      `liveWhenOpened()` `[0, 0]` on a committing bundle (`:300-313`);
      `al-outbound-admission-transactions.test.ts` — `COMMITTING_ADMISSION_TRANSACTIONS` (`:60`),
      `liveWhenOpened()` `[0, 0, 0]` (`:160-171`), and `liveCount()` `0` for a commit that conflicts
      inside its own write phase (`:173-185`);
      `al-indexeddb-operation-counts.test.ts` — 10 `al-admission` / 15 `al-work` for one default
      send (`:197-231`), 2 admission operations for one drained `dispatch-local` row (`:244-249`),
      and 8 for one message admitted and delivered (`:259-263`).
      **Why the operation counts can stay unchanged while the readwrite reads more rows:** the
      counting observer is called only from the backend's own `read`/`list`/`write`
      (`indexed-db-admission-backend.ts:119,148,185`) and the read session's `read`/`list`/`readWork`
      (`indexed-db-admission-read-session.ts:81,95,110`). The fence's re-reads run inside the
      already-counted write, and the write buffer's `readRow`/`readRows` are unobserved today, so
      Task 1 adds requests but no counted operation and no transaction.
      Commands:
      `npx vitest run packages/tests/shared/alm/inbound packages/tests/shared/alm/outbound packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
- [x] **Step 5: Commit the pins.** One commit, message naming the two measured figures (a disjoint
      interleave conflicts today; four completed claims cost four `work-release` operations) and the
      regression set from Step 4. The two new tests are `it.fails` at this commit so
      `npm run test:unit` stays green, and Tasks 1 and 2 flip each to `it` in the commit that earns
      it.
      Commands: `npx dprint check packages/tests/shared/alm/inbound-runtime-test-fixture.ts packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
      `git commit -am 'test(alm): pin the store-global admission fence and the per-claim release'`

### Task 1: Per-row revisions on the IndexedDB admission backend

Per ruling R-F2c-1. Every stored admission row carries a revision; the write phase records what it
observed for every key it read or wrote and for every prefix it listed; the readwrite re-reads
exactly those and aborts as a typed conflict when one moved. The store-global revision key, its
initial row, and every symbol that served it are deleted in this commit.

**Files:**

- Create: `packages/shared/alm/indexed-db-admission-fence.ts`
- Modify: `packages/shared/alm/indexed-db-admission-row.ts:11-39` (the row shape and its decoder),
  `packages/shared/alm/open-indexed-db-admission-database.ts:14-26,81-91,151-167` (delete the
  revision key, its initial row and its decoder; bump the schema id; one initial record),
  `packages/shared/alm/write-indexed-db-admission-mutations.ts:16-66,93-150,216-226` (fence instead
  of scalar), `packages/shared/alm/indexed-db-admission-backend.ts:130-143,150-177,181-238,265-381,383-404`
  (write buffer records the fence; `write` passes it; expiry eviction and `read`/`list` stop
  carrying a revision), `packages/shared/alm/indexed-db-admission-read-session.ts:25-28,44-48,66,137-141,143-153,178-186`
  (delete `readRevision` and the expired-row revision),
  `packages/shared/alm/read-indexed-db-admission-snapshot.ts:11-44,63-70,152-155` (rows only; drop
  the `'revision'` selection arm and the revision bookkeeping key),
  `packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts:47-56,270-282,289-305,394-411`
  (cleanup writes no revision row and validates none)
- Test: `packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts`,
  `packages/tests/shared/alm/al-admission-backend.test.ts:472-535`,
  `packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts:324`,
  `packages/tests/shared/alm/al-outbound-retention-commit.test.ts:12,92`,
  `packages/tests/shared/alm/al-inbound-indexeddb-commit-deadline.test.ts:18,128`,
  `packages/tests/shared/alm/outbound/al-outbound-admission-fences.test.ts:26,277`,
  `packages/tests/shared-web/al-runtime/browser-al-runtime-cleanup-validation.test.ts:2-3,38-54,119-133`,
  `packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts:16-49`,
  `packages/tests/shared-server/al-runtime/postgres/p-sql-admission-work-transactions.test.ts`,
  `tests/playwright/rallar-black-box/browser-indexeddb-transaction-writes-fixture.ts:12,234`

**Interfaces:**

- Produces, `packages/shared/alm/indexed-db-admission-fence.ts`:

  ```ts
  /** A row's first stored revision; every replace commits at the revision it observed plus one. */
  export const INDEXED_DB_ADMISSION_FIRST_REVISION = 1;

  /** What one key looked like when the write phase observed it: its stored revision, or absent. */
  export type IndexedDbAdmissionObservedRevision = number | 'absent';

  /**
   * The keys one write phase's decision depends on. `rows` holds every key it read or wrote with the
   * revision it observed; `prefixes` holds every prefix it listed with the keys that list returned,
   * so a row added to or removed from a listed range conflicts even though no read key moved.
   */
  export interface IndexedDbAdmissionFence {
      readonly rows: ReadonlyMap<string, IndexedDbAdmissionObservedRevision>;
      readonly prefixes: ReadonlyMap<string, readonly string[]>;
  }

  export function computeIndexedDbAdmissionWriteRevision(
      observed: IndexedDbAdmissionObservedRevision
  ): number;

  export function toIndexedDbAdmissionObservedRevision(
      stored: IndexedDbAdmissionStoredRow | undefined
  ): IndexedDbAdmissionObservedRevision;
  ```

- Produces, `packages/shared/alm/indexed-db-admission-row.ts`:

  ```ts
  export interface IndexedDbAdmissionStoredRow {
      readonly key: string;
      readonly value: ALAdmissionStoredValue['value'];
      readonly expireAtTimestamp: number;
      readonly writeToken: string;
      /** 1 on insert, +1 per replace: the per-row compare-and-set every commit fences on. */
      readonly revision: number;
  }
  ```

  `decodeIndexedDbAdmissionStoredRow` requires `revision` through `decodeALAdmissionNumber`; a row
  without it is `ALAdmissionCorruptionError`, which is why the schema id moves in the same commit.
- Produces, `packages/shared/alm/write-indexed-db-admission-mutations.ts`:

  ```ts
  export interface WriteIndexedDbAdmissionMutationsInput {
      readonly deadline?: PersistenceWriteDeadline;
      readonly db: IDBDatabase;
      readonly fence: IndexedDbAdmissionFence;
      readonly mutations: readonly IndexedDbAdmissionMutation[];
      readonly queueMutations: readonly ComputedIndexedDbQueueMutation[];
      readonly storeName: string;
  }
  ```

  `expectedRevision` and `revisionWrite` are gone. `IndexedDbAdmissionMutation` keeps its three arms
  unchanged.
- Produces, `packages/shared/alm/indexed-db-admission-backend.ts`: `IndexedDbAdmissionWriteBuffer`
  gains `fence(): IndexedDbAdmissionFence`; `IndexedDbAdmissionFencedWrite` loses
  `expectedRevision`.
- Produces, `packages/shared/alm/indexed-db-admission-read-session.ts`:
  `ExpiredIndexedDbAdmissionRows` becomes `{ readonly removals: readonly IndexedDbAdmissionMutation[]; }`.
- Produces, `packages/shared/alm/open-indexed-db-admission-database.ts`:
  `AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-09-f2c'`.
- Produces, `packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts`:
  `BrowserALRuntimeCleanupRead` loses `revision`; `BrowserALRuntimeCleanupComputed` loses
  `revisionWrite`; the `'revision-write-mismatch'` validation issue code and
  `validateBrowserALRuntimeCleanupRevision` are deleted.
- Consumes: `ALAdmissionWorkBackend` — **its contract does not change.** `readWithin`, `read`,
  `list`, `write` and `workQueue` keep their signatures
  (`packages/shared/alm/al-admission-work-backend.ts:29-41`), so `InMemoryAdmissionBackend`
  (`al-admission-backend.ts:63-163`) and `PSqlAdmissionWorkBackend`
  (`packages/shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts:36-136`) are
  untouched. The memory backend keeps its serialized `writeTail`; the PostgreSQL backend keeps its
  per-row `expectedRevision` collector.

**Deleted symbols, with their files** (no retained legacy):

| Symbol                                                                                                                                                          | File                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `AL_ADMISSION_REVISION_KEY`                                                                                                                                     | `packages/shared/alm/open-indexed-db-admission-database.ts:14`                               |
| `INITIAL_INDEXED_DB_ADMISSION_REVISION`                                                                                                                         | `packages/shared/alm/open-indexed-db-admission-database.ts:22-26`                            |
| `decodeIndexedDbAdmissionRevision`                                                                                                                              | `packages/shared/alm/open-indexed-db-admission-database.ts:81-91`                            |
| `IndexedDbAdmissionRevisionWrite`                                                                                                                               | `packages/shared/alm/write-indexed-db-admission-mutations.ts:32-36`                          |
| `computeIndexedDbAdmissionRevisionWrite`                                                                                                                        | `packages/shared/alm/write-indexed-db-admission-mutations.ts:58-66`                          |
| `WriteIndexedDbAdmissionMutationsInput.expectedRevision` / `.revisionWrite`                                                                                     | `packages/shared/alm/write-indexed-db-admission-mutations.ts:41,44`                          |
| `IndexedDbAdmissionReadSession.readRevision`                                                                                                                    | `packages/shared/alm/indexed-db-admission-read-session.ts:137-141`                           |
| `IndexedDbAdmissionReadSession.#expiredRevision`                                                                                                                | `packages/shared/alm/indexed-db-admission-read-session.ts:66,145-151,185`                    |
| `ExpiredIndexedDbAdmissionRows.expectedRevision`                                                                                                                | `packages/shared/alm/indexed-db-admission-read-session.ts:46`                                |
| `IndexedDbAdmissionSnapshot.revision`                                                                                                                           | `packages/shared/alm/read-indexed-db-admission-snapshot.ts:18,40-43`                         |
| `IndexedDbAdmissionSelection`'s `{ kind: 'revision' }` arm                                                                                                      | `packages/shared/alm/read-indexed-db-admission-snapshot.ts:26,68-69`                         |
| `IndexedDbAdmissionFencedWrite.expectedRevision`                                                                                                                | `packages/shared/alm/indexed-db-admission-backend.ts:252`                                    |
| `BrowserALRuntimeCleanupRead.revision`, `BrowserALRuntimeCleanupComputed.revisionWrite`, `validateBrowserALRuntimeCleanupRevision`, `'revision-write-mismatch'` | `packages/shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts:47-56,289-305,394-411` |

- [x] **Step 1: The row carries its revision (RED first).** Write the row-shape test before the
      change: in `al-admission-backend.test.ts`, assert that a row read back after one
      `backend.write(async (tx) => tx.set('version:first', 'a'))` has `revision`
      `INDEXED_DB_ADMISSION_FIRST_REVISION`, and that a second `set` on the same key stores
      revision 2. Then add `revision` to `IndexedDbAdmissionStoredRow` and to
      `decodeIndexedDbAdmissionStoredRow`'s required record fields
      (`indexed-db-admission-row.ts:25,32-37`), create `indexed-db-admission-fence.ts` with the four
      symbols above, and bump `AL_ADMISSION_SCHEMA_ID` to `'rallar-alm-2026-09-f2c'`
      (`open-indexed-db-admission-database.ts:17`).
      Command: `npx vitest run packages/tests/shared/alm/al-admission-backend.test.ts`
      Expected: RED before the change (no `revision` on the row), GREEN after.
- [x] **Step 2: The write buffer records the fence.** In `IndexedDbAdmissionWriteBuffer`
      (`indexed-db-admission-backend.ts:265-381`) add
      `readonly #observedRows = new Map<string, IndexedDbAdmissionObservedRevision>()` and
      `readonly #observedPrefixes = new Map<string, readonly string[]>()`, and a private
      `#observeRevision(key)` that returns the already-recorded observation when there is one and
      otherwise records `toIndexedDbAdmissionObservedRevision(await this.#session.readRow(key))`.
      First observation wins, so a key read twice, or set twice, keeps one baseline. Then:
      `read` records the key it read (already reading the row at `:288`); `list` records the prefix's
      returned key list and each returned row's revision; `set` awaits `#observeRevision(key)` and
      stores `revision: computeIndexedDbAdmissionWriteRevision(observed)`; `remove` awaits
      `#observeRevision(key)` and keeps its `#pending.set(key, undefined)`. `set` and `remove` are
      already `async`, so no signature moves. Add:

      ```ts
      fence(): IndexedDbAdmissionFence {
          return { rows: this.#observedRows, prefixes: this.#observedPrefixes };
      }
      ```

      A key the write phase writes without reading is therefore still guarded — the buffer reads it
      once inside the fence snapshot, which costs one unobserved request and no transaction.
      Command: `npx tsc -p packages/shared/tsconfig.json --noEmit`
- [x] **Step 3: The readwrite re-reads exactly the fence.** In
      `write-indexed-db-admission-mutations.ts` replace the single
      `store.get(AL_ADMISSION_REVISION_KEY)` (`:93,103,125-144`) with a fence read, keeping the
      existing callback style so nothing awaits a non-IndexedDB promise inside the transaction. Add
      `pendingFenceReads: number` to `IndexedDbAdmissionWriteContext` and three functions, each
      under 40 lines:
      `readIndexedDbAdmissionFence(context)` — sets `pendingFenceReads` to
      `fence.rows.size + fence.prefixes.size`, dispatches straight to the guarded-removal stage when
      it is zero, issues one `eligibility.observe(store.get(key))` per fenced row and one cursor walk
      per fenced prefix;
      `completeFencedIndexedDbAdmissionRow(context, key, observed, result)` — decodes the row
      (absent → `'absent'`), calls `abortIndexedDbAdmissionWrite` on a decode failure, sets
      `context.conflict = true` and aborts when the observed value differs, and otherwise decrements;
      `readFencedIndexedDbAdmissionPrefix(context, prefix, keys)` — walks the prefix cursor, conflicts
      when the returned key set differs from `keys` in either direction, and otherwise decrements.
      When `pendingFenceReads` reaches zero the chain continues into the existing
      `readGuardedIndexedDbAdmissionRemovals` / `applyIndexedDbAdmissionMutations` pair, and
      `applyIndexedDbAdmissionMutations` (`:216-226`) drops its `store.put(input.revisionWrite)` line.
      A guarded removal keeps its write-token comparison and contributes no revision entry: `set`
      mints a fresh `writeToken` on every write (`indexed-db-admission-backend.ts:336`), so the token
      is a strictly stronger per-row guard than a revision compare and the two never disagree.
      Then in `IndexedDbAdmissionBackend`: `#readFencedWrite` (`:221-238`) stops reading a revision
      and returns `{ buffer, result }`; `write` (`:191-206`) passes `fence: fenced.buffer.fence()`;
      `removeExpiredIndexedDbAdmissionValues` (`:383-404`) takes no `expectedRevision` and passes an
      empty fence, because each removal is already write-token guarded; `read` (`:130-144`) and
      `list` (`:150-177`) stop reading `snapshot.revision`.
      Command: `npx vitest run packages/tests/shared/alm packages/tests/shared-web/al-runtime`
      Expected: `al-inbound-admission-transactions.test.ts`'s interleave test now returns
      `'committed'` — flip it from `it.fails` to `it` in this commit.
- [x] **Step 4: Re-express the expiry fence on the per-row model.** In
      `indexed-db-admission-read-session.ts`, delete `readRevision` (`:137-141`) and
      `#expiredRevision` (`:66,185`); `#recordExpired` (`:179-186`) becomes synchronous in effect —
      it records only the `remove-if-write-token` removal — and `takeExpiredRows` (`:144-153`)
      returns `undefined` when `#expired` is empty and otherwise `{ removals }`. The removals' write
      tokens are the fence: a row replaced since the chain read it has a different token and the
      eviction aborts as a conflict exactly as it does today, so the deleted global revision removed
      a redundant guard and one unobserved read, not a protection. Update
      `IndexedDbAdmissionBackend.readWithin` (`:94-116`) to the narrowed contract.
      Command: `npx vitest run packages/tests/shared/alm/al-admission-backend.test.ts packages/tests/shared/alm/al-inbound-indexeddb-commit-deadline.test.ts`
- [x] **Step 5: Rows only from the snapshot reader, and the browser cleanup writer.** In
      `read-indexed-db-admission-snapshot.ts` make `readIndexedDbAdmissionSnapshot` return
      `readonly IndexedDbAdmissionStoredRow[]` (delete the `IndexedDbAdmissionSnapshot` interface and
      the second `Promise.all` leg, `:17-44`), delete the `{ kind: 'revision' }` selection arm
      (`:26,68-69`), and reduce `isIndexedDbAdmissionBookkeepingKey` (`:152-155`) to the schema key.
      In `browser-al-runtime-cleanup.ts` delete `BrowserALRuntimeCleanupRead.revision`,
      `BrowserALRuntimeCleanupComputed.revisionWrite`, `validateBrowserALRuntimeCleanupRevision` and
      its `'revision-write-mismatch'` issue, drop the `AL_ADMISSION_REVISION_KEY` row filter
      (`:275-277`), and have `writeBrowserALRuntimeCleanup` pass an empty fence with no
      `expectedRevision` parameter. Every deleted row there is already a `remove-if-write-token`
      mutation (`:295-301`), and `validateBrowserALRuntimeCleanupMutations` still checks each token.
      Rewrite `browser-al-runtime-cleanup-validation.test.ts` in the same commit: the
      `'revision-write-mismatch'` case (`:110-121`) goes, the `validComputed` fixture (`:38-52`)
      loses its revision write.
      Commands: `npx vitest run packages/tests/shared-web/al-runtime`
      `npm --workspace @ar-eye-hunter/shared-web run typecheck`
      `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
- [x] **Step 6: Same-key conflicts still conflict, over all three backends.** These must stay green
      and are not weakened: `al-outbound-admission-transactions.test.ts:173-185` (a stale bundle
      conflicts inside its own write phase and closes its fence snapshot),
      `al-inbound-admission-transactions.test.ts:325-353` (`setNextInboundCommitConflicted` writes a
      competing `set-msg-owner` on the same message, so the row the fence observed moved),
      `packages/tests/shared/alm/inbound-supersedence-concurrency.test.ts` and
      `packages/tests/shared/alm/outbound/al-outbound-admission-fences.test.ts` over PGlite. Add one
      new test in `al-inbound-admission-transactions.test.ts` that uses
      `setNextAdmissionWritePhaseInterleaved` to land a competing write **on a key the fenced
      attempt read** and asserts `'conflict'` — the interleave hook proves both directions with one
      mechanism. Extend `p-sql-admission-work-transactions.test.ts` with the disjoint-key equivalent
      over PGlite (two `backend.write` calls on disjoint keys, both committed) so the acceptance
      clause is pinned on all three backends; memory is covered by
      `createInboundTestStores({ storage: 'memory' })` in the same new test, where the serialized
      writer makes the second write land before the first's fence and neither conflicts.
      Commands:
      `npx vitest run packages/tests/shared/alm packages/tests/shared-server/al-runtime`
      `npx vitest run packages/tests/shared/alm/outbound/al-outbound-admission-fences.test.ts`
- [x] **Step 7: The storage reset, once.** Extend
      `packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts:16-49`: seed the
      database at the previous schema id `'rallar-alm-2026-09-f2'` with one admission row, open at
      `AL_ADMISSION_SCHEMA_ID`, and assert one `schema-id-mismatch` event carrying
      `previousSchemaId: 'rallar-alm-2026-09-f2'`, that the seeded row is gone, that the schema row
      holds the new id, and that a second open reports no further reset. Assert in the same test that
      the recreated store holds no `'__rallar_al_admission_revision__'` row, using the literal string
      because the constant is deleted.
      Command: `npx vitest run packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts`
- [x] **Step 8: The remaining callers of the deleted symbols.** Update
      `al-admission-backend.test.ts:472-535` (the guarded-removal corruption case passes a fence; the
      "rejects a revision row" case is deleted, since there is no revision row — replace it with a
      row whose `revision` field is not a number, asserting `ALAdmissionCorruptionError` for that
      key), `al-indexeddb-queue-admission.test.ts:324`, `al-outbound-retention-commit.test.ts:12,92`,
      `al-inbound-indexeddb-commit-deadline.test.ts:18,128` (drop the revision key from the
      bookkeeping filters, keep the schema key), `al-outbound-admission-fences.test.ts:26,277` (the
      per-row revision replaces the scalar assertion), and
      `tests/playwright/rallar-black-box/browser-indexeddb-transaction-writes-fixture.ts:12,234` (a
      fence in place of `computeIndexedDbAdmissionRevisionWrite`). Prove no symbol survives:
      `grep -rn 'AL_ADMISSION_REVISION_KEY\|computeIndexedDbAdmissionRevisionWrite\|decodeIndexedDbAdmissionRevision\|readRevision()\|expectedRevision' packages/shared/alm packages/shared-web/browser/al-runtime packages/tests/shared/alm packages/tests/shared-web/al-runtime tests/playwright`
      Expected: no matches in the ALM and browser-AL trees.
- [x] **Step 9: Verify and commit.** The transaction-shape pins stay at their counts
      (`['readonly', 'readonly', 'readwrite']` for a committing attempt, `liveWhenOpened()` all
      zeroes) and the operation-count pins stay at 6 + 2 for an inbound message and 10 / 15 for a
      default send.
      Commands: `npx vitest run packages/tests/shared/alm packages/tests/shared-web/al-runtime packages/tests/shared-server/al-runtime`
      `npx tsc -p packages/shared/tsconfig.json --noEmit`
      `npm --workspace @ar-eye-hunter/shared-web run typecheck`
      `npx dprint check <touched files>`
      `git commit -am 'feat(alm): per-row compare-and-set for the IndexedDB admission fence'`

### Task 2: One release per batch, with a disposition per entry

Per ruling R-F2c-2. `releaseEntries` already commits its whole array in one transaction on all three
queues — the IndexedDB implementation issues exactly one `work-release` observation and one
read/write pass for the array (`packages/shared/queuebox/indexed-db-queue-box.ts:306-337`), the
PostgreSQL one wraps the array in one `transaction` (`p-sql-queue-box.ts:297-341`), and the memory one
writes into its map. What forces N calls is the single shared `disposition`
(`queue-box-types.ts:356-359`) against per-claim `delayMs` and `readyAtMs`
(`al-work-queue-port.ts:165-192`), and a handler that releases inside its claim loop
(`al-work-handler.ts:330-337,351-360,392-400`).

`releaseEntries` has 102 call sites across 35 files. Two are production —
`packages/shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts:297-302` and
`:363` (the AppInbox dequeuer) and `packages/shared/alm/work/al-work-queue-port.ts:156` — and the
rest are tests, including Deno tests under `apps/api-v1/test/db/` that type against
`Parameters<PSqlQueueBox['releaseEntries']>`. **This moves a server-side contract**, so Task 6 runs
the medium-scale gate and `npm run test:deno`.

**Files:**

- Modify: `packages/shared/queuebox/queue-box-types.ts:85-95,356-359`,
  `packages/shared/queuebox/compute-indexed-db-queue-release.ts:23-77`,
  `packages/shared/queuebox/indexed-db-queue-box.ts:306-337`,
  `packages/shared/queuebox/in-memory-queue-box.ts:217-265`,
  `packages/shared-server/queuebox/postgres/p-sql-queue-box.ts:297-341`,
  `packages/shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts:293-302,363`,
  `packages/shared/alm/work/al-work-queue-port.ts:60-73,116,150-163`,
  `packages/shared/alm/work/al-work-handler.ts:315-348,351-360,362-400,402-419`
- Test: `packages/tests/shared/alm/work/al-work-handler.test.ts`,
  `packages/tests/shared/alm/work/al-work-queue-port.test.ts`,
  `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`,
  `packages/tests/shared/indexeddb-queuebox.test.ts`,
  `packages/tests/shared/in-memory-queuebox.test.ts`,
  `packages/tests/shared/in-memory-queuebox-value-ownership.test.ts`,
  `packages/tests/shared/psql-queuebox.test.ts`,
  `packages/tests/shared/queuebox-readiness-deferral.test.ts`,
  `packages/tests/shared/queuebox-work-page.test.ts`,
  `packages/tests/shared/queue.test.ts`,
  `packages/tests/shared/handler-finalized-rtc-topology.test.ts`,
  `packages/tests/shared/resource-inbox-attempt-telemetry.test.ts`,
  `packages/tests/shared/p-sql-resource-inbox-persistence.test.ts`,
  `packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts`,
  `packages/tests/shared/alm/al-inbound-queue-work.test.ts`,
  `packages/tests/shared/alm/al-inbound-persistence-validation.test.ts`,
  `packages/tests/shared/alm/al-indexeddb-queue-admission.test.ts`,
  `packages/tests/shared/alm/al-outbound-durable-effects.test.ts`,
  `packages/tests/shared/alm/al-outbound-message-runtime.test.ts`,
  `packages/tests/shared/alm/al-outbound-admission-decoding.test.ts`,
  `packages/tests/shared/alm/outbound-canonical-storage.test.ts`,
  `packages/tests/shared/queuebox/indexeddb-queuebox-indexed-reads.test.ts`,
  `packages/tests/shared-server/rallar-system/app-inbox/app-inbox-retry-exhaustion.test.ts`,
  `packages/tests/shared-server/rallar-system/app-inbox/client/app-inbox-reservation-client.test.ts`,
  `packages/tests/shared-server/integration/postgres/queuebox-observed-reservation.test.ts`,
  `packages/tests/shared-server/integration/postgres/al-admission-queue-work.test.ts`,
  `packages/tests/shared-server/al-runtime/postgres/p-sql-admission-work-transactions.test.ts`,
  `apps/api-v1/test/db/pglite-runtime-state-and-collisions.test.ts`,
  `apps/api-v1/test/db/pglite-topology-retry.test.ts`,
  `apps/api-v1/test/db/pglite-topology-command.test.ts`,
  `apps/api-v1/test/db/pglite-queue-and-crdt.test.ts`,
  `apps/api-v1/test/db/pglite-queue-schedule-timezone.test.ts`,
  `apps/api-v1/test/admin-operations/persistence/admin-prune-page-release.test.ts`

**Interfaces:**

- Produces, `packages/shared/queuebox/queue-box-types.ts`:

  ```ts
  /** One reservation and the disposition that releases it; a batch commits every pair together. */
  export interface ResourceInboxRelease {
      readonly entry: Resource.ResourceEntry;
      readonly disposition: ResourceInboxReleaseDisposition;
  }
  ```

  and on `DequeueResourceEntryRepository`:

  ```ts
  releaseEntries(
      releases: readonly ResourceInboxRelease[]
  ): Promise<Map<Resource.Key, Resource.ResourceEntry>>;
  ```

  `ResourceInboxReleaseDisposition` itself is unchanged (`:85-95`).
- Produces, `packages/shared/queuebox/compute-indexed-db-queue-release.ts`:

  ```ts
  interface ComputeIndexedDbQueueReleaseInput {
      readonly currentEntries: ReadonlyMap<string, ResourceEntry>;
      readonly releasedAt: Temporal.Instant;
      readonly releases: readonly ResourceInboxRelease[];
      readonly storedEntries: ReadonlyMap<string, StoredResourceEntry>;
  }
  ```

  The loop reads `release.entry` and `release.disposition` where it read `resource` and
  `input.disposition`; the returned `Either<ResourceInboxLostReservationError, ...>` is unchanged.
- Produces, `packages/shared/alm/work/al-work-queue-port.ts`:

  ```ts
  export interface ALWorkRelease {
      readonly claim: ALWorkClaim;
      readonly outcome: ALWorkOutcome;
  }
  ```

  and on `ALWorkQueuePort`, replacing `release(claim, outcome)`:

  ```ts
  /** Releases a whole batch in one queue write; a retained claim flushes a one-entry batch. */
  releaseAll(releases: readonly ALWorkRelease[]): Promise<void>;
  ```

- Consumes: `ResourceInboxLostReservationError.key` (`queue-box-types.ts:222-241`) and
  `isKeysEqual` (`packages/shared/queuebox/ResourceEntry.ts`), for the one-lost-reservation retry
  below.
- Produces, `packages/shared/alm/work/al-work-handler.ts`: `ALWorkBatchDiagnostics` keeps all five
  duration fields; `releaseDurationMs` now measures the single flush. `releaseClaim` is deleted.

- [x] **Step 1: The per-entry contract, mechanically (RED at the type level).** Change
      `releaseEntries` on `DequeueResourceEntryRepository` and add `ResourceInboxRelease`; then move
      the three implementations — `in-memory-queue-box.ts:217-265` (validate each entry's own
      disposition, and pass `release.disposition` into both `isIdempotentHandlerFinalizedRelease` and
      `computeResourceInboxRelease`), `indexed-db-queue-box.ts:306-337` (one
      `observer.observe({ owner: 'al-work', kind: 'work-release' })` for the batch, key strings from
      `releases.map((release) => toKeyAsString(release.entry.key))`, `computeIndexedDbQueueRelease`
      with `releases`), and `p-sql-queue-box.ts:297-341` (candidates built per release inside the one
      `this.resourceInbox.transaction`). Then rewrite every call site: `q.releaseEntries([e], d)`
      becomes `q.releaseEntries([{ entry: e, disposition: d }])`.
      Command: `npx tsc -p packages/shared/tsconfig.json --noEmit && npm run typecheck`
      Expected: RED across the 35 files listed above until each call site moves; no behaviour change
      once they have.
- [x] **Step 2: A mixed batch commits once (RED).** Before touching the handler, pin the contract in
      `packages/tests/shared/in-memory-queuebox.test.ts` and
      `packages/tests/shared/indexeddb-queuebox.test.ts`: reserve three entries, then release them in
      one call as `completed` (`delayMs: null`), `retry` with `delayMs: 37`, and
      `retry`/`reason: 'not-ready'` with a distinct `delayMs`, and assert each returned entry's own
      status and `nextTs`. On IndexedDB add, through `recordIndexedDbTransactions()`, that the flush
      opens `['readonly', 'readwrite']` — one read of the reserved rows, one conditional write — and
      that `byKind['work-release']` rose by exactly 1. Add the PGlite equivalent in
      `packages/tests/shared-server/al-runtime/postgres/p-sql-admission-work-transactions.test.ts`
      over `backend.workQueue`, spying on `sql.begin` (the file already does, `:23-32`) to assert one
      transaction for the mixed batch.
      Commands: `npx vitest run packages/tests/shared/in-memory-queuebox.test.ts packages/tests/shared/indexeddb-queuebox.test.ts packages/tests/shared-server/al-runtime/postgres`
      Expected: RED only where the mixed batch is new; the existing single-disposition assertions
      are rewritten, not weakened.
- [x] **Step 3: The port collects instead of releasing.** Replace `release` with `releaseAll` in
      `createALWorkQueuePort` (`al-work-queue-port.ts:116`) and rename `releaseALWorkClaim`
      (`:150-163`) to `releaseALWorkClaims`:

      ```ts
      /**
       * A batch whose one reservation was recovered elsewhere must not strand the releases beside
       * it: the queue validates the whole batch before it writes, so the lost key leaves the batch
       * and the rest is written. Each pass removes at least one release, so this terminates.
       */
      async function releaseALWorkClaims(
          queue: QueueBoxResourceEntryRepository,
          releases: readonly ResourceInboxRelease[]
      ): Promise<void> {
          let remaining = releases;
          while (remaining.length > 0) {
              try {
                  await queue.releaseEntries(remaining);
                  return;
              }
              catch (error) {
                  if (!(error instanceof ResourceInboxLostReservationError)) {
                      throw error;
                  }
                  remaining = remaining.filter((release) => !isKeysEqual(release.entry.key, error.key));
              }
          }
      }
      ```

      `releaseAll` maps each `ALWorkRelease` through the unchanged `toReleaseDisposition`
      (`:165-192`), so the per-claim jittered `delayMs` and the `not-ready` `readyAtMs` are computed
      exactly as they are today — one computation per claim, one write for the batch.
      Test in `al-work-queue-port.test.ts`: a three-entry batch where the middle reservation was
      already released elsewhere still releases the other two, and the retry delay of an entry with
      `attempts: 2` is unchanged from the single-release path.
      Command: `npx vitest run packages/tests/shared/alm/work/al-work-queue-port.test.ts`
- [x] **Step 4: The handler flushes once at the batch's end.** In `al-work-handler.ts`: delete
      `releaseClaim` (`:392-400`); `runSelectedWork` (`:315-348`) declares
      `const releases: ALWorkRelease[] = []` and passes it to `finalizeExhaustedWork` and `runOne`,
      which push `{ claim, outcome }` instead of awaiting a release; add

      ```ts
      private async flushReleases(
          releases: readonly ALWorkRelease[],
          progress: ALWorkBatchProgress
      ): Promise<void> {
          const { clock, port } = this.dependencies;
          const startedAtMs = clock.nowMs();
          await port.releaseAll(releases);
          progress.releaseDurationMs = computeElapsedMs(startedAtMs, clock.nowMs());
      }
      ```

      and call it once, after the claim loop and before `queueEngine.wakeAt`. The two
      `shutdown.signal.aborted` early returns (`:325,332`) flush first, so a disposed batch still
      releases the claims it already ran. `finalizeExhaustedWork` (`:351-360`) joins the same array
      and keeps incrementing `rejectedCount` as it goes. `releaseRetainedClaim` (`:402-419`) stays
      serial and calls `port.releaseAll([{ claim, outcome }])` — no timer, window, queue or registry.
      Tests in `al-work-handler.test.ts`: a batch of one completed, one retry and one non-retryable
      claim calls `releaseAll` exactly once with all three dispositions in claim order; the fake
      clock gives the flush a distinct value so `releaseDurationMs` is the flush's and no longer a
      sum; a batch aborted after its first claim still releases that claim; a retained claim's
      settlement releases on its own, after the batch, exactly as before. Flip Task 0 Step 3's
      `it.fails` to `it` in this commit.
      Commands: `npx vitest run packages/tests/shared/alm/work packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
      Expected: four completed claims now cost 1 `work-release` operation.
- [x] **Step 5: The owners' own suites.** Run the inbound and outbound runtimes over the new flush
      and rewrite the coupled spies in the same commit — `al-inbound-effect-worker-lifecycle.test.ts:400-407,775-778`
      and `al-inbound-queue-work.test.ts:403-404` mock `releaseEntries` with the old two-argument
      shape, `al-outbound-durable-effects.test.ts:699-706` and `al-outbound-message-runtime.test.ts:105`
      spy on it.
      Commands: `npx vitest run packages/tests/shared/alm packages/tests/shared/queue.test.ts packages/tests/shared/queuebox-readiness-deferral.test.ts packages/tests/shared/handler-finalized-rtc-topology.test.ts`
- [x] **Step 6: Verify and commit.** Include the AppInbox dequeuer's two call sites and the Deno
      tests.
      Commands: `npm run test:unit`
      `cd apps/api-v1 && deno task check` then `npm run test:deno`
      `npx dprint check <touched files>`
      `git commit -am 'feat(queuebox): release one work batch with a disposition per entry'`

### Task 3: The inbound figures in the observation snapshot

Per ruling R-F2c-3. `decodeALMObservationSnapshot`
(`packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts:54-78`) decodes
only `rallar.browser.alm.outbound_diagnostics` today, so nothing in the repository reproduces F2b's
inbound figures (survey §4). The inbound topic is `rallar.browser.alm.inbound_diagnostics` with kinds
`admission-outcome`, `effect-drain`, `claim-settled` and `rotation-alive`
(`packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md:199-297`); this task
decodes the first two. Each snapshot event carries an `agentId`, and the ALM lane mints it as
`alm-<role>` for `role` in `sender` / `receiver`
(`tests/playwright/rallar-black-box/full-stack-helpers.ts:838`), which is the direction the block
reports per.

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts`,
  `packages/shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts`,
  `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md`
- Test: `packages/tests/shared-test/alm-observation-regime.test.ts`

**Interfaces:**

- Produces, `alm-observation-snapshot.ts`:

  ```ts
  /**
   * Which page an inbound event came from. The ALM lane mints its agent ids as `alm-sender-…` and
   * `alm-receiver-…` (`full-stack-helpers.ts:838`); any other id is `unattributed` rather than
   * guessed, so a snapshot from another lane still decodes.
   */
  export type ALMObservationAgentRole = 'sender' | 'receiver' | 'unattributed';

  export interface ALMObservationInboundOutcome {
      readonly atEpochMs: number;
      readonly role: ALMObservationAgentRole;
      readonly workerId: string;
      /** `committed`, `pending`, `unauthorized`, `rejected` or `not-handled`, as the topic emits it. */
      readonly outcome: string;
  }

  export interface ALMObservationInboundDrain {
      readonly atEpochMs: number;
      readonly role: ALMObservationAgentRole;
      readonly workerId: string;
      readonly durationMs: number;
      readonly selectionDurationMs: number;
      readonly claimDurationMs: number;
      readonly runDurationMs: number;
      readonly releaseDurationMs: number;
      readonly queueWaitMs: number;
  }

  export function resolveALMObservationAgentRole(agentId: string): ALMObservationAgentRole;
  ```

  and on `ALMObservationSnapshot`, two required arrays beside the four it already carries:
  `inboundOutcomes: readonly ALMObservationInboundOutcome[]` and
  `inboundDrains: readonly ALMObservationInboundDrain[]`. `ALMObservationDiagnostic` gains a required
  `agentId: string` (an event without one is skipped, exactly as one without a topic is today).
- Produces, `compute-alm-observation-regime.ts`:

  ```ts
  export interface ALMObservationInboundPhases {
      readonly selectionMedianMs: number;
      readonly claimMedianMs: number;
      readonly runMedianMs: number;
      readonly releaseMedianMs: number;
      readonly queueWaitMedianMs: number;
      readonly drainMedianMs: number;
      readonly drainCount: number;
  }

  export type ALMObservationInboundDirection =
      | Readonly<{
          role: ALMObservationAgentRole;
          outcome: 'measured';
          pendingSharePercent: number;
          outcomeCount: number;
          phases: ALMObservationInboundPhases;
      }>
      | Readonly<{ role: ALMObservationAgentRole; outcome: 'no-events'; }>;
  ```

  and on `ALMObservationRegime`, one required field: `inbound: readonly ALMObservationInboundDirection[]`.
  A role with `admission-outcome` events but no drain reports `outcome: 'measured'` with
  `drainCount: 0` and zero medians; a role with neither reports `'no-events'`.
- Consumes: the private `computeMedian` and `toTwoDecimals` in `compute-alm-observation-regime.ts`
  (`:220-228`) — widened in place, never re-implemented.
- Unchanged: `computePerOperationCost` (`:119-127`) and `resolveRegimeName` (`:129-139`). The regime
  stays outbound-based, read from `send`-origin `commit-phases` inside the opening window.

- [x] **Step 1: Decode the inbound topic (RED first).** Add the test before the change, in
      `alm-observation-regime.test.ts`, using that file's synthetic builders (`:44-90`): a snapshot
      carrying `ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT` outbound `commit-phases` events plus inbound
      `admission-outcome` events from both agent ids (three `pending`, one `committed` on
      `alm-receiver-…`; one `pending`, one `committed` on `alm-sender-…`) and two `effect-drain`
      events per role with known phase values. Assert the decoded `inboundOutcomes` and
      `inboundDrains` lengths and roles, then implement `INBOUND_DIAGNOSTICS_TOPIC`,
      `resolveALMObservationAgentRole`, `toInboundOutcome` and `toInboundDrain` in
      `alm-observation-snapshot.ts` on the same `toTopicDiagnostics` path the outbound topic uses. An
      event whose kind or fields do not match is skipped, not reported — the file's existing rule
      (`:49-53`).
      Command: `npx vitest run packages/tests/shared-test/alm-observation-regime.test.ts`
- [x] **Step 2: The `inbound` block on the regime.** Add `computeInboundDirections(snapshot)` to
      `compute-alm-observation-regime.ts`, grouping both arrays by `role` over the three role values
      in a fixed order (`sender`, `receiver`, `unattributed`), and dropping a role with no events to
      `'no-events'`. `pendingSharePercent` is `toTwoDecimals(100 * pending / outcomeCount)`; each
      phase median is `toTwoDecimals(computeMedian(...))` over that role's drains and is taken over
      the whole cell, not the opening window — the window exists to read the runner, and this block
      reads the receiver. Set `inbound: []` in `createUnreadableALMObservationRegime` (`:93-109`).
      Tests: the two hosted fixtures still classify exactly as they do today
      (`alm-observation-regime.test.ts:93-110`, medians `24.06` / 18 samples) and now report
      `inbound: []`, because neither trimmed fixture carries an inbound event; the synthetic snapshot
      reports 75 % pending for the receiver, 50 % for the sender, and the medians the builder set.
      Command: `npx vitest run packages/tests/shared-test/alm-observation-regime.test.ts`
      Expected: every pre-existing regime assertion unchanged.
- [x] **Step 3: Document the block.** Add an `inbound` bullet list to the regime-file section of
      `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md:42-64`: what each field
      answers, that the direction comes from the lane's `alm-<role>` agent ids and is `unattributed`
      for any other id, that the medians are whole-cell and the `perOperation` median is
      opening-window, that the four inbound phases do not sum to `durationMs` for the reasons the
      diagnostic contract already gives (`runtime-diagnostic-contract.md:240-256`), and that F2c's
      acceptance figure is read from this block rather than from a session script. Leave "The budgets
      stay" and "Reading a red" untouched.
      Command: `npx dprint check packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md`
- [x] **Step 4: Verify and commit.**
      Commands: `npx vitest run packages/tests/shared-test`
      `npx tsc -p packages/shared/tsconfig.json --noEmit`
      `npx dprint check <touched files>`
      `git commit -am 'feat(rallar-bb-test): record the inbound pending share and drain phases per cell'`

### Task 4: The navigation maps and the local lane

**Files:**

- Modify: `packages/shared/alm/inbound/README.md:80-90,190-204`,
  `packages/shared/alm/outbound/README.md:200-232`
- Test: none of its own; the lane run is the evidence.

**Interfaces:** none. Documentation only, plus the local lane run.

- [x] **Step 1: The inbound map tells the truth about the fence.** In `inbound/README.md`, keep the
      sentence that the session never writes and that `requireOriginalObservations` re-reads the whole
      observed surface inside the write (`:87-90`) — that is still exactly what happens — and add
      what now makes the commit conditional: the backend compares the revision of every row the write
      phase read or wrote and the key set of every prefix it listed, so a commit conflicts only when
      one of those moved, and an unrelated admission, send or ACK on another message no longer does.
      Say that the three backends are now conflict-equivalent: memory serializes writers, IndexedDB
      and PostgreSQL both compare per row.
- [x] **Step 2: The outbound map tells the truth about the write and the releases.** In
      `outbound/README.md`, rewrite "A stale admission revision, queue revision, or guarded removal
      rolls back the whole transaction" (`:211-213`) and "Any metadata read, list, set, or removal
      retains the metadata revision check" (`:225-227`) as the per-row fence, and add that one work
      batch releases its claims in a single queue write with a disposition per entry, that
      `releaseDurationMs` measures that one write, and that a retained claim releases on its own
      settlement, one at a time, with no coalescing window or timer.
- [x] **Step 3: The local lane, three carriers.** `npm run test:rallar:full-stack:memory:alm`.
      Expected: three cells pass and each writes `test-results/alm-observation/<carrier>-smoke.json`
      with a non-empty `inbound` block carrying both roles. Record the local per-operation median, the
      inbound pending share and the release median per cell in the PR body draft. A cell whose
      `inbound` block is empty means the relay is not reaching the snapshot — diagnose that before
      pushing, because Task 5 reads the same block.
- [x] **Step 4: Commit.**
      Commands: `npx dprint check packages/shared/alm/inbound/README.md packages/shared/alm/outbound/README.md`
      `git commit -am 'docs(alm): per-row admission fence and batched work releases'`

### Task 5: Re-observe on the runner under the regime rule, and the PR

**Files:** none in production; the lane's own artifacts and the pull request.

- [x] **Step 1: Push and let the observation job run.** The Release Gate's non-blocking
      `alm-conformance-observation` job uploads `alm-conformance-lane-<sha>`. Download it.
- [x] **Step 2: Classify before judging.** Read `regime` in every cell's
      `alm-observation/<carrier>-smoke.json`. Take the **rtc** cell's regime as the runner's verdict;
      a `normal` regime on ws or fallback is unattributed (4–13 opening-window samples). Rules, from
      `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md:66-82`: both `normal` → a
      red is a product regression; red `slow` against a `normal` baseline → a measurement of the
      runner, not a verdict; either `unclassified` → no regime evidence, rerun. The thresholds
      (`ALM_OBSERVATION_NORMAL_REGIME_MAX_MS_PER_OPERATION` 30,
      `ALM_OBSERVATION_SLOW_REGIME_MIN_MS_PER_OPERATION` 35) are constants, not knobs.
- [x] **Step 3: The acceptance figures, from the repo-owned block.** Record per cell, from
      `alm-observation/<carrier>-smoke.json`: `regime` and `perOperation.medianMs`; and from the new
      `inbound` block, per role, `pendingSharePercent`, `phases.releaseMedianMs`,
      `phases.runMedianMs`, `phases.drainMedianMs` and `phases.queueWaitMedianMs`. Compare against
      F2b's slow-regime baseline (`plans/alm-f2b-inbound-owner-implementation-plan.md:437-449`):
      rtc pending share 77 / 76 %, rtc release 4.0 / 2.3 s, rtc drain 14.0 / 10.5 s.
      **Acceptance:** in a `slow` regime with a same-regime baseline, the rtc cell's inbound pending
      share and release median are both below those figures. A red in a regime with no same-regime
      green baseline is not a verdict: rerun once, and if it reds again write the diagnosis as a
      session record in the shape of the earlier ones and route it to the maintainer rather than
      tuning a budget or a threshold. Two iterations are allowed before the maintainer is asked
      again.
- [x] **Step 4: The PR body.** Goal, Changes, Acceptance, Validation, Risk and rollback, Follow-up,
      in the F2b shape. Acceptance names the conformance scenarios, the three-backend disjoint-key
      pins, the re-stated transaction-shape and operation-count pins, and the one-`work-release`
      batch. Validation names the artifacts and the commands, with the commit each figure was
      measured on. Risk and rollback states that the schema-id move to `rallar-alm-2026-09-f2c`
      deletes each browser's ALM database once — list what is discarded: retained `admit-message` and
      `admit-control` pending admissions, `dispatch-local` and `forward-message` delivery effects,
      canonical inbound and outbound message rows, ack and control bookkeeping, and the queued
      `alm-work` rows beside them. Record both bundle figures (`browser/rallar.ts` and the headless
      bundle) against their budgets; a crossed budget is raised to the next whole KiB with the
      measured figure recorded and reported (maintainer ruling 2026-09-05).
      `npm run pr:delivery -- status` decides the next action; `ready` and auto-merge are not used.
- [x] **Step 5: Branch Release Gate.** Green on the final feature-branch commit before review is
      requested. Any change after a passing gate invalidates it.

**Task 5 outcome (2026-09-22):** two hosted reads on code-identical heads. `f33dd8118` (run 35756050199,
smoke): WS passed, normal, 29.78 ms/op; RTC failed, unclassified, 33.56; fallback failed, unclassified,
30.22 — both at the S1 `delivery-lifecycle` `receive-replacement` wait. `f870feaf4` (run 35757310189,
the rerun): WS failed, unclassified, 33.44; RTC failed, normal, 20.78 (`receive-submission`); fallback
failed, normal, 29.22 (`receive-replacement`) — every failure is the S1 lifecycle intermittent recorded
on #570, not an F2c scenario. The inbound block, sender / receiver, across both reads: pending share
5.88–6.25 % / 7.14–10.71 % (16–30 outcomes); release medians 525–764 / 574–908 ms; drain medians
4.1–9.0 / 3.8–7.7 s. Against F2b's slow-regime baseline (pending 63–77 %, release 2.3–4.0 s, drains
5.1–14.1 s) at 30–34 ms/op there, the pending share fell about sevenfold and the release phase three to
five times; in the normal-regime cells the figures hold. The regime rule: the RTC and fallback reds on
`f870feaf4` are normal-regime reds in S1's scenarios with the same signature as before F2c, so they are
not attributed to this slice; the WS red is unclassified (no regime evidence). No budget changed.

### Task 6: Final gates

- [x] **Step 1: The full local list on the final tree.** `npm run test:unit`; `npm run typecheck`;
      `cd apps/api-v1 && deno task check`, and the same for `apps/rallar-black-box-control-server`
      and `apps/relic-hunter-server-v1`; `npm run test:deno`; `npx dprint check`;
      `npm run check:repo-style:changed -- origin/main HEAD`;
      `node scripts/check-tests-typecheck.mjs`;
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`;
      `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`; `npm run build`;
      `npm run test:ci`. Report which passed, failed, or were skipped, and why.
      `npm run test:deno` is not optional here: Task 2 moves `PSqlQueueBox.releaseEntries`, and five
      Deno test files under `apps/api-v1/test/db/` type against its signature, which
      `deno task check` (src only) does not read.
- [x] **Step 2: Postgres lanes.** `npm run db:test:up`, then
      `npm run test:api-v1:black-box:postgres:medium-scale` and
      `npm run test:integration:postgres`. The medium-scale gate **is** required for this slice:
      Task 2 changes `releaseEntries` on the PostgreSQL queue and both release call sites of the
      AppInbox dequeuer (`create-default-resource-inbox-dequeuer.ts:293-302,363`), which is an
      authoritative mutation path. Task 1 alone would not have required it — it changes only the
      browser IndexedDB backend. Never weaken the gate's constants, operation matrix or assertions.
- [x] **Step 3: Report.** Name every command that passed, failed, or was skipped, with the head it
      ran on, in the PR body's Validation section.

---

**Task 6 outcome (2026-09-22, `f870feaf4`):** passed — `npx dprint check` (whole tree), `npm run typecheck`,
`check:repo-style:changed -- origin/main HEAD`, `check-tests-typecheck`, the coupling check,
`check:browser-bundles`, the three `deno task check`, `npm run build`, `npm run test:deno`, `npm run test:e2e`
(40 + 210), `npm run test:full-stack:memory` (7), the ALM smoke lane (3 passed, normal). `npm run test:ci` as
one process stopped twice in the unit leg on the untouched `rtc-observation-publication-shell.test.ts`
(13.7 s against the 5 s default; 4 passed three times in isolation at ~4 s), so its legs are reported
separately; that borderline test is flagged as its own follow-up. The API v1 Medium-Scale, Formation and
Topology Replay gates were green on the queue-contract head `9d0ea0435`; the Branch Release Gate result on
the final commit is recorded on the pull request.

## Not in this slice

- **Narrowing `requireOriginalObservations`' ordering scan** (R20 lever 1, survey §6). The fence
  keeps its shape: it still lists and re-decodes every buffered row under a busy track's prefix on
  every attempt. R-F2c-1 excludes it explicitly, and Task 1's per-row fence is what makes that cost
  visible as a cost rather than as a conflict.
- **Batching retained-claim releases.** `releaseRetainedClaim` settles after its batch ended, so it
  cannot join the batch's flush; grouping it needs a coalescing window, which the no-new-timer
  constraint rules out. It stays one claim at a time and the README says so (R-F2c-2).
- **Decoupling the ack bookkeeping from the data admission.** A control or ACK commit on the _same_
  message still conflicts the data admission, because both write `pendingAck`, `acks` and
  `controlOwners` (survey §2). That is a genuine overlap the per-row fence keeps, and splitting it
  into independent conditional writes is an admission-design question for S2's one-identity slice.
- **The harness budgets and the regime thresholds.** `CONNECT_READINESS_TIMEOUT_MS` 30 000,
  `CONFORMANCE_DEADLINE_MS` 18 000 and the receiver window derived from it,
  `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500, and the 30 / 35 ms per-operation
  thresholds all stay as they are. This slice earns its margin from the owner, not the budget.
- **Returning the lane to `test:ci`.** It stays the Release Gate's non-blocking observation job until
  the maintainer says otherwise; F2c's acceptance is evidence for that decision, not the decision.
- **`claim-settled` and `rotation-alive` in the snapshot.** Task 3 decodes `admission-outcome` and
  `effect-drain` only, which is what R-F2c-3 names. The other two kinds stay in the control snapshot
  for a reader who wants them.
- **The RTC `not-yet-in-sync` retention and the sender's retry** (S2) and **delivery-level fallback**
  (S3), both carried forward from F2.

## Self-review

- Spec coverage, per the roadmap's "Release 3, F2c" Changes items:
  1. _Per-row optimistic concurrency on IndexedDB, global revision key deleted, schema id bumped_ →
     Task 1, with Task 0 Step 2 as its RED pin and Task 1 Step 7 as the reset proof.
  2. _`releaseEntries` takes a disposition per entry on all three queues; the handler flushes one
     batch once; retained releases stay serial_ → Task 2, with Task 0 Step 3 as its RED pin and
     Task 2 Step 4's `releaseRetainedClaim` paragraph as the serial guarantee.
  3. _The snapshot decodes the inbound topic so each cell records the pending share and the phase
     medians_ → Task 3, documented in Task 3 Step 3 and read back in Task 5 Step 3.
- Acceptance clause coverage: two disjoint admissions interleaved across the fence commit on all
  three backends → Task 1 Step 6 (IndexedDB and memory in `al-inbound-admission-transactions.test.ts`,
  PGlite in `p-sql-admission-work-transactions.test.ts`); transaction-shape pins re-stated → Task 0
  Step 4 and Task 1 Step 9; one default inbound admission and one default send keep their operation
  counts → Task 0 Step 4's mechanism note and Task 1 Step 9; a batch of N completed claims costs one
  `work-release` → Task 0 Step 3 and Task 2 Step 4; the local lane green on three carriers → Task 4
  Step 3; the runner figures read from the repo-owned snapshot against 77 % / 4.0 s → Task 5 Step 3;
  no harness budget changed and no new cognitive-load pin → Global Constraints, checked by Task 6
  Step 1's `check:repo-style:changed`.
- Type consistency across tasks: `IndexedDbAdmissionFence`, `IndexedDbAdmissionObservedRevision` and
  `INDEXED_DB_ADMISSION_FIRST_REVISION` are defined in Task 1's Interfaces before Task 1 Steps 2, 3
  and 5 consume them; `ResourceInboxRelease` and `ALWorkRelease` are defined in Task 2's Interfaces
  before Steps 1, 3 and 4 consume them; `ALMObservationAgentRole` is defined in Task 3's Interfaces
  before `ALMObservationInboundDirection` uses it. No type is introduced twice and no alias renames
  an existing one. Task 0's `InboundTestBackendStores` and `setNextAdmissionWritePhaseInterleaved`
  are defined before Task 1 Step 6 reuses the hook.
- File-size discipline: every function this plan adds is under 40 lines, and the three largest files
  it touches — `packages/shared/queuebox/indexed-db-queue-box.ts` (874 lines),
  `packages/shared/queuebox/in-memory-queue-box.ts` (641) and
  `packages/shared/alm/work/al-work-handler.ts` (444, shrinking by one method) — stay far below the
  1 200-line navigation backstop. `write-indexed-db-admission-mutations.ts` grows from 226 lines to
  roughly 320; if `check:repo-style:changed` reports a worsened `file.cognitive-load` finding there,
  the three fence-read functions move into `indexed-db-admission-fence.ts`, which already owns the
  value, behind one `readIndexedDbAdmissionFence(context)` entry point.
- Placeholder scan: every step carries file paths with line ranges, the symbol it changes, the test
  code or the exact edit, and the command to run. No step says "add validation", "TBD", or "similar
  to Task N".
- Where this plan refines the survey's open questions: (1) the shared `AL_ADMISSION_REVISION_KEY` was
  new information, and D17 reframes "narrow the fence" as the backend change Task 1 makes rather than
  an `al-inbound-admission-store.ts` change; (2) `releaseEntries`' disposition is widened to
  per-entry, so retry and not-ready claims batch too, and the single-disposition form is deleted;
  (3) the inbound baseline becomes repo-owned in Task 3, so F2c's acceptance no longer depends on
  session-only scripts.
