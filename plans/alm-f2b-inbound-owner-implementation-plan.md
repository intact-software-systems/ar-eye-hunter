# ALM F2b Inbound Owner on Slow Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the inbound owner the treatment F2 Task 13 gave the outbound one, so a receiver on
slow storage delivers inside the conformance window. Every inbound decision surface reads from one
readonly transaction; the pending-admission path stops paying a second full decision surface for a
message it already read; a drained message reaches the page in the round that claimed it; and the
inbound diagnostics name where a batch's seconds went, per batch and per claim, so the next red is
read rather than guessed.

**Architecture:** `packages/shared/alm/inbound/` keeps its owners. `ProviderBackedALInboundAdmissionStore`
stops calling `backend.read`/`backend.list` one key at a time and runs each read chain inside
`ALAdmissionWorkBackend.readWithin`, the session contract Task 13 added
(`packages/shared/alm/al-admission-work-backend.ts:20-35`) and the outbound store already uses.
`ALInboundMessageAdmission` carries its first-phase read forward into the replay that a retained
conflict schedules, instead of re-deriving it. `ALInboundAdmittedDelivery` stops reading the same
rows twice for one message — once to answer the rotation's eligibility question, once to dispatch.
`ALInboundRuntimeDiagnosticsEvent` grows the phase split the outbound's `commit-phases` already has.
No public surface changes; the rotation keeps its shape (see Task 4 Step 0).

**Tech Stack:** TypeScript across Node, Deno, and browser; Vitest with `fake-indexeddb`; PGlite and
PostgreSQL for the server backend; Playwright for the conformance lane; dprint.

**Spec:** [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md),
section "Release 3, F2b: the inbound owner on slow storage" (the observation-status paragraph under
"Conformance lane" carries the runner-regime rule). F2 is merged on `main` as `f8db93762`; F2b builds on Task 13's `readWithin`
session, Task 13's single fence snapshot in `IndexedDbAdmissionBackend#readFencedWrite`, and Task 14's
regime file.

## Global Constraints

- Decision D8: search `packages/**` before writing anything; ask before an internal library; no new
  third-party dependency.
- No retained legacy: every replaced path is removed in the commit that replaces it, including its
  tests; obsolete coupled tests are rewritten in the same commit.
- Touched-file standards closure: every touched human-authored file is reviewed and remediated in
  full; a support file changed by that remediation enters closure recursively; independent untouched
  code stays outside.
- No duplicated logic: the outbound test\'s IndexedDB transaction spy moves to one shared test support
  module (`packages/tests/shared/alm/record-indexed-db-transactions.ts`) that both suites import; a
  private reader that already exists is widened, never re-implemented beside itself.
- Canonical verbs (`readXxx`, `computeXxx`, `validateXxx`, `resolveXxx`, `toXxx`); `handle`,
  `process`, `execute`, `util`, `helper`, `data` do not appear in the touched files.
- Expected failure is an `Either` value or a typed outcome; `assertXxx` is reserved for programmer
  invariants. A conflict stays a value.
- Required fields by default in the diagnostics contracts this slice extends; an optional field is
  valid only where absence has a distinct domain meaning (state it in the field's comment).
- No new `file.cognitive-load` pin on an ALM file and no new disposition entry — the F2 constraint
  survives this slice.
- **Never weaken a harness budget to make a run pass.** `CONNECT_READINESS_TIMEOUT_MS` 30 000, the
  receiver window derived from `CONFORMANCE_DEADLINE_MS` 18 000, `NON_EXPIRING_SEND_TIMEOUT_MS`
  10 000 and `EXPIRY_TTL_MS` 7 500 are fixed by the 2026-09-11 maintainer decision.
- Every commit keeps focused Vitest, `npx dprint check <files>`, and the package typecheck green;
  before pushing: `npm run test:unit`, the three Deno checks, `npx dprint check`,
  `npm run check:repo-style:changed -- origin/main HEAD`, `node scripts/check-tests-typecheck.mjs`,
  `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`,
  `npm run test:rallar:full-stack:memory:alm`.
- `packages/shared/alm/inbound/README.md` is updated in the same PR and never claims behaviour the
  code does not have.

## The measured starting point

The F2 session measured the slow regime on the branch (diagnoses of the observation runs on `902fa30a7`
and `04f0f70a1`, session records handed to the implementer with the dispatch), and merged `main`
reproduced it on 2026-09-11: the Release Gate observation job on `f8db93762` ran every cell in the
`slow` regime (ws 48, rtc 39.6, rtc-with-ws-fallback 37.2 ms per operation) and all three failed — the ws
cell at `delivery-baseline-receiver` (0 of 1 received), both RTC cells with every command at
`RTC connect timed out waiting for room transport readiness` (peer readiness never observed in 83–101 s).
That run is the F2b baseline.

| Evidence                                               | Figure                                                                                                | Source                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Inbound `effect-drain` median per batch, slow regime   | 5 067 / 6 522 / 14 100 ms (rtc / ws / fallback)                                                       | `alm-observation-902fa30a7-diagnosis.md` §1.3                            |
| Inbound `effect-drain` median per batch, normal regime | 1 147 / 996 / 282 ms                                                                                  | same table, column `04f0f70a1`                                           |
| Outbound `effect-drain` median, same runs              | 1 747 / 1 409 / 1 849 vs 477 / 414 / 361 ms                                                           | same table                                                               |
| Receiver-only inbound median, slow regime              | 18 556 ms (rtc), 23 712 ms (fallback)                                                                 | per-page split, `tools/inb.mjs`                                          |
| `pending` share of inbound `admission-outcome`         | 33 / 38 / 40 % normal → 63 / 47 / 65 % slow                                                           | `alm-observation-902fa30a7-diagnosis.md` §3.2                            |
| The lost ws frame                                      | admitted `pending` at 78.65 s, one 1 008 ms drain at 79.65 s, window closed 81.77 s, never dispatched | same, §2.2–2.3                                                           |
| The RTC offer                                          | fully admitted at 15.35 s, zero outbound signaling for the next 20 s                                  | same, §3.1                                                               |
| Merged `main` `f8db93762`, slow regime                 | ws receiver 0 of 1; rtc and fallback 12 of 12 readiness timeouts; 48 / 39.6 / 37.2 ms per op          | `alm-conformance-lane-f8db93762…`, the Deploy run's observation artifact |

Artifacts: the Release Gate observation artifacts (`alm-conformance-lane-<sha>`) of `902fa30a7`,
`04f0f70a1`, `c99cf654e` and `f8db93762`, each with three cell directories holding `alm-<carrier>-smoke.json`.
`c99cf654e` predates the inbound diagnostics relay (0 inbound drains) — do not use it for drain figures.
Only `f8db93762` carries `alm-observation/` regime files; recompute the others with
`computeALMObservationRegime` if needed. The F2 session's diagnosis notes and its event-extraction
scripts (`inb.mjs` inbound events, `adm2.mjs` outcomes by agent and direction, `cp.mjs` commit phases,
`sc.mjs` storage counters) are session records, not repository files; the dispatch names their paths.

## The inbound decision surfaces today

Every entry is one `backend.read`/`backend.list` call, and on IndexedDB each opens its own readonly
transaction (`indexed-db-admission-backend.ts:120-157`). `commitBundle` is already one fence
snapshot plus one readwrite — Task 13's `#readFencedWrite` serves both directions, so the commit is
**not** where the inbound cost sits.

| Surface                                | Site                                                      | Reads (transactions) today                                                                                                                                          |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readIncomingMessage` — ws/RTC ingress | `al-inbound-admission-store.ts:433-477`                   | owner 1, dedup 1, ordering 0 or 2+B, supersedence 0 or 2, delivery progress 0 or 1, acks 2, control owners 1 → **5 plain; 10 + B ordered and supersedence-tracked** |
| `readBufferedRelease`                  | `:500-559`                                                | buffered 1, canonical 1, owner 1, progress 1, supersedence 0–2, acks 2, control owners 1 → **7–9**                                                                  |
| `readStoredPlanningState`              | `:578-592`                                                | owner 1, supersedence 0–2 → **1–3**                                                                                                                                 |
| `readOrderedDelivery`                  | `al-inbound-durable-effect-store.ts:40-70`                | progress 1, buffered 1, canonical 1, predecessor scan → **1–4**                                                                                                     |
| `readInboundMessage`                   | `:811-818`                                                | **1**                                                                                                                                                               |
| `readControlAdmission`                 | `inbound/control/al-inbound-control-admission.ts:118-130` | owner index 1, owner 1, pending 1, acks 1 → **4** (one dependency hop)                                                                                              |
| `commitBundle`                         | `:606-631`                                                | 1 readonly fence + 1 readwrite = **2**                                                                                                                              |

Two of these run per work row **per rotation round**: `ALInboundAdmittedDelivery.readReadiness`
(`al-inbound-admitted-delivery.ts:56-89`) calls `readInboundMessage` + `readStoredPlanningState`
(+ `readOrderedDelivery` for an ordered message), and `readALInboundWorkSelection`
(`read-al-inbound-work-selection.ts:63-104`) calls it for every entry on the page, up to
`AL_INBOUND_WORK_PAGE_SIZE` 16. `deliver` → `dispatchAdmittedMessage` (`:152-205`) then reads the
same rows again before dispatching.

---

### Task 0: Pin the current costs

**Files:**

- Create: `packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts`,
  `packages/tests/shared/alm/record-indexed-db-transactions.ts`
- Modify: `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`,
  `packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts` (imports the moved spy)
- Read only: the diagnosis notes and the artifacts named above.

**Interfaces:** consumes `IndexedDbAdmissionBackend`, `createALInboundAdmissionStore`,
`createCountingIndexedDbOperationObserver`; produces no runtime surface.

- [x] **Step 0: Read the evidence.** Read the `902fa30a7` diagnosis §1.3, §2.2, §2.3, §3.1, §3.2 and
      §5.2; the `04f0f70a1` diagnosis §3.1 (the same ws frame passing with 15 s unused); the
      `c99cf654e` diagnosis §"storage counters" for the `work-page` share; and the `f8db93762`
      regime files. Record in the PR body draft the figures from "The measured starting point" with
      the head each was measured on. Do not build on
      `commit-phases.transportSettleDurationMs`: it is emitted in no run.
- [x] **Step 1: Transaction pins (RED).** Move the spy
      `recordIndexedDbTransactions` with its `RecordedIndexedDbTransactions` contract and the
      `IDBTransaction.prototype.abort` patch from
      `packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts:50-92` into
      `packages/tests/shared/alm/record-indexed-db-transactions.ts`; both suites import it and the
      outbound suite stays green. Assert `recorded.modes()` for: a plain `readIncomingMessage`, an
      ordered-and-supersedence-tracked `readIncomingMessage` with two buffered rows, a
      `readBufferedRelease`, a `readStoredPlanningState`, and `readControlAdmission`. Write each
      expectation as the **target** (`['readonly']`) so the test is RED at the measured count, and
      record the measured count in the assertion message. Also assert
      `recorded.liveWhenOpened()` is all zeroes for `commitBundle` (the fence snapshot must already
      close before the readwrite — this one starts GREEN and is the regression guard).
      Command: `npx vitest run packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts`
      Expected: the five surface pins fail with the real counts; the `commitBundle` pin passes.
- [x] **Step 2: Drain-shape pin (RED).** In `al-indexeddb-operation-counts.test.ts`, add a
      `describe('inbound work owner IndexedDB scan volume')` that builds a real
      `ALInboundMessageRuntime` over `IndexedDbAdmissionBackend` with a counting observer, commits one
      `dispatch-local` effect, runs one batch, and pins `counts.byOwner['al-admission']` for
      (a) one rotation round over a page holding one row and (b) the whole admit → deliver path for
      one unordered message. Both RED at today's figure, with the target in the message.
      Command: `npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
- [x] **Step 3: Commit the pins.** One commit, message naming the measured counts. The roadmap's
      red-head rule (every commit keeps `test:unit` green) decides the shape: the five surface pins and
      the two drain-shape pins are `it.fails` at this commit, each named with its target and its
      measured count, and Tasks 1–3 flip each to `it` in the commit that earns it. `commitBundle`'s
      pin is a plain `it` from the start.

### Task 1: One readonly transaction per inbound decision surface

**Files:**

- Modify: `packages/shared/alm/inbound/al-inbound-admission-store.ts`,
  `packages/shared/alm/inbound/al-inbound-durable-effect-store.ts`,
  `packages/shared/alm/inbound/control/al-inbound-control-admission.ts`
- Test: `packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts`,
  `packages/tests/shared/alm/al-inbound-admission-preparation.test.ts`,
  `packages/tests/shared/alm/al-inbound-persistence-validation.test.ts`,
  `packages/tests/shared/alm/inbound-supersedence-concurrency.test.ts`,
  `packages/tests/shared/alm/al-inbound-indexeddb-commit-deadline.test.ts`

**Interfaces:**

- Consumes: `ALAdmissionReadSession` (`read`, `list`, `readWork`) and
  `ALAdmissionWorkBackend.readWithin`.
- Produces: no public surface change. The store's public methods keep their signatures; only their
  bodies move inside a session, exactly as `outbound/admission/al-outbound-admission-store.ts:355-386` does.

- [x] **Step 1: Thread the session through the private readers.** Every private reader already takes
      `database: Pick<ALAdmissionBackend, 'read' | 'list'>` (`readOrderingState`,
      `readStoredMessageOwner`, `readStoredAcknowledgements`, `readSupersedenceState`) — keep that
      shape and widen `readDeliveryProgress`, `readMessageOwner`, `readInboundMessage` and
      `readControlOwnerIndex` to take it too. No behaviour change; typecheck only.
      Command: `npx tsc -p packages/shared/tsconfig.json --noEmit`
- [x] **Step 2: `readIncomingMessage` inside one session.** Wrap the body in
      `await this.backend.readWithin(async (session) => …)` and pass `session` to every reader. The
      dependency hops stay in place and stay sequential: `ordering.trackKey` feeds
      `readDeliveryProgress`, `prePlan.supersedence.key` feeds `readSupersedenceState`, and each
      buffered snapshot feeds its own `readALInboundBufferedMessage`. Await only session promises
      inside the callback — a non-IDB await between requests ends the snapshot
      (`indexed-db-admission-read-session.ts:59-63`, `:188-201`).
      Expected: the plain and ordered pins from Task 0 Step 1 go GREEN at `['readonly']`.
- [x] **Step 3: The remaining four surfaces.** Same treatment for `readBufferedRelease`,
      `readStoredPlanningState`, `readOrderedDelivery` (in the durable effect store, which owns its
      own `backend`), and `readControlAdmission` (which reads through three public store methods —
      add one `readControlDecisionSurface(session, ack)` on the store and have the control admission
      call it inside a single `readWithin`).
      Expected: all five pins GREEN; `recorded.modes()` is `['readonly']` for each.
- [x] **Step 4: Fences over all three backends.** Run the inbound suites over memory, IndexedDB and
      PGlite. `requireOriginalObservations` (`:648-712`) is unchanged and still re-reads the whole
      surface inside the write — that is the fence, and it must stay.
      Commands:
      `npx vitest run packages/tests/shared/alm/inbound packages/tests/shared/alm/al-inbound-*.test.ts packages/tests/shared/alm/inbound-*.test.ts`
      `npm run test:integration:postgres -- --grep al-admission` (or the focused PGlite file if the
      Postgres compose is not up: `npx vitest run packages/tests/shared-server/integration/postgres/al-admission-queue-work.test.ts`)
      Expected: green; no test's assertions weakened.
- [x] **Step 5: Commit.** One commit with the production change and its tests.
      `npx dprint check <touched files>`, `npx tsc -p packages/shared/tsconfig.json --noEmit`,
      focused Vitest.

### Task 2: The pending-admission second phase

The retained path costs a full second decision surface. `attempt()` reads the surface, computes,
commits, gets `'conflict'`, and returns a `pending` value (`al-inbound-message-admission.ts:108-117`).
`retainPending` writes one work row. A later rotation round claims it and `replay()`
(`:155-179`) calls `attempt()` again from scratch — a second `readIncomingMessage`, a second plan, a
second commit. On the runner that second phase is a whole rotation round away, and the pending share
rose from 33–40 % to 63–65 % in the slow regime.

**Files:**

- Modify: `packages/shared/alm/inbound/al-inbound-message-admission.ts`,
  `packages/shared/alm/inbound/al-inbound-pending-admission.ts`,
  `packages/shared/alm/inbound/al-inbound-message-runtime.ts`
- Test: `packages/tests/shared/alm/al-inbound-pending-admission.test.ts`,
  `packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts`,
  `packages/tests/shared/alm/al-inbound-admission-commit-deadline.test.ts`

**Interfaces:**

- Consumes: `ALInboundPendingAdmission` (`kind`, `msg`, `source`).
- Produces: `ALInboundMessageAdmission.Attempt`'s `conflict` arm carries one extra required field
  naming the attempt that produced it, so the replay can say whether its own re-read was needed.
  `ALInboundPendingAdmission` is a persisted contract — any field added to it changes the work row's
  decoded shape, so `decodeALInboundWorkEntry` must reject a row without it, and the ALM schema id
  must move in the same commit (Decision D3: the browser store resets, and the PR body lists what
  pending work is discarded).

- [x] **Step 1: Name what the second phase must re-read (RED test first).** Write a test that runs a
      conflicting admission and asserts, through the transaction spy, how many readonly transactions
      the retain-then-replay pair costs today versus one `attempt()`. Then decide, in the test's own
      comment, which observations are **authority-bearing** and must be re-read on replay (the
      admission fence's inputs: message owner, dedup, ordering snapshot, supersedence pair, delivery
      progress, acks, control owners — all of them, because the conflict means at least one moved)
      and which are **immutable** and can be carried (the decoded message, its resolved deadline, the
      validated source, the effect facts from `readALInboundEffectFacts`).
      Expected conclusion, to be confirmed by the test rather than assumed: the surface must be
      re-read; the _decode, plan pre-pass, deadline resolution and validation_ must not.
- [x] **Step 2: Carry the immutable half — not executed (measurement, ruling R11).** Step 1 measured
      one committing attempt at `[readonly, readonly, readwrite]` and retain-then-replay at
      `[readonly (absence guard), readwrite (row), readonly, readonly, readwrite]`: the replay already
      costs one surface, one fence and one write, and `retainPending` already persists the decoded
      message with its resolved deadline and the validated source. The carry would move the schema id
      (D3 reset) for no storage saving, so `ALInboundPendingAdmission` and `AL_ADMISSION_SCHEMA_ID`
      stay as they are; the entry-point split would only move pure calls. Original text kept below
      for the record.
      _Original:_ `retainPending` already stores the message with its
      resolved deadline (`toALInboundMessageWithDeadline`). Extend the retained payload with the
      validated `source` it already has plus the resolved `deadline`, and have `replay()` skip
      `resolveALMessageExpireAtMs` and the pre-plan pass, entering `attempt()` at the read. Split
      `attempt()` into `attemptFromDecoded(admitted, source, planner, facts)` and keep `attempt()` as
      the ingress entry that decodes and pre-plans. No decision moves down the call stack: the
      deadline and the source are decided at the boundary, once, and persisted.
- [x] **Step 3: Do not make the replay wait a round for a rotation.** `retainConflictedAdmission`
      (`al-inbound-message-runtime.ts:299-308`) calls `commitWork()`, which calls
      `workSelector.restartScan()` and `work.committed()` — the handler runs a batch immediately when
      idle (`al-work-handler.ts:166-175`). Pin that a retained conflict reaches its replay in the
      same batch when the owner is idle, and in the immediately following one when it is not
      (`commitPending` → `runPendingCommit`). If the pin fails, the fix is in the handler's
      `commitPending` path, not in a new timer.
- [x] **Step 4: Verify and commit.** Focused Vitest over
      `packages/tests/shared/alm/al-inbound-pending-admission.test.ts` and the transaction test; the
      schema-id move verified by `packages/tests/shared-web/al-runtime/browser-al-storage-reset.test.ts`.
      Commands: `npx vitest run packages/tests/shared/alm/al-inbound-pending-admission.test.ts packages/tests/shared/alm/inbound packages/tests/shared-web/al-runtime`

### Task 3: The dispatch to the page after admission

**The mechanism, from the code.** A committed admission writes a `dispatch-local` durable effect. It
reaches the page only through a rotation round that (1) reads the work page, (2) calls
`ALInboundAdmittedDelivery.readReadiness` for that row, and (3) claims it and calls `deliver` →
`dispatchAdmittedMessage` → `dispatchInboxEntry`. Steps 2 and 3 read the same rows twice:
`readReadiness` (`al-inbound-admitted-delivery.ts:80-88`) does `readAdmittedMessage` +
`readStoredPlanningState` + `isLocalDeliveryReady`, and `dispatchAdmittedMessage` (`:159-171`,
`:184`) repeats every one of them. Nothing is carried between them — not the message, not the plan,
not the readiness — because the port's `claim` sits between them
(`read-al-inbound-work-selection.ts:183`). So one delivered message pays its decision surface twice,
and a page whose rows are all `dispatch-local` pays step 2 for every row on the page, claimed or not.

That is why the lost ws frame was admitted, drained, and never dispatched: it was retained `pending`
at 78.65 s, the 1 008 ms drain at 79.65 s ran its **replay** (claimed 1 / completed 1) and committed
the `dispatch-local` effect, and the _next_ round — the one that would have read the readiness and
dispatched it — did not come round in the 2.1 s left before the window closed at 81.77 s. There is no
retry and no drop: the work row simply outlived the observation window. The RTC offer at 15.35 s is
the same shape one stage earlier — admitted, never handed to the code that would answer it.

**Files:**

- Modify: `packages/shared/alm/inbound/al-inbound-admitted-delivery.ts`,
  `packages/shared/alm/inbound/read-al-inbound-work-selection.ts`
- Test: `packages/tests/shared/alm/inbound/al-inbound-work-selection.test.ts`,
  `packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts`,
  `packages/tests/shared/alm/inbound/al-inbound-admission-transactions.test.ts`

**Interfaces:**

- Produces: `ALInboundDeliveryReadiness` — `{ ready: boolean; observed: ALInboundDeliveryObservation | undefined }`
  returned by `readReadiness` and accepted by `deliver`, so the eligibility read and the dispatch
  share one observation. `observed` is optional exactly because a not-ready row has nothing to carry;
  say so in its comment.
- Consumes: `ALWorkReadySelection.claims` — the selection already knows which entries it claimed, so
  the observation is keyed by the entry it was read for.

- [x] **Step 1: Pin the double read (RED).** In the transaction test, assert the readonly-transaction
      count for one unordered `dispatch-local` row taken from `readReadiness` through `deliver`.
      Target: the readiness read and the dispatch share one snapshot for the message and its planning
      state. Expected RED at today's count.
- [x] **Step 2: Carry the observation.** `readALInboundWorkSelection` keeps the
      `ALInboundDeliveryObservation` it read per claimable entry; `selectReady` passes it with the
      claim; `runInboundClaim` passes it to `deliver`, which re-validates only what the claim window
      could have changed (the entry's expiry and `shouldRetryALInboundDelivery(plan)` against a fresh
      `clock.nowMs()`) and re-reads nothing else. The ordering readiness stays a fresh read for an
      ordered message — a predecessor can land between the two — and the test says so.
- [x] **Step 3: Do not read readiness for rows the page will not claim.** `readALInboundWorkSelection`
      currently calls `readReadiness` for every entry on the page before `port.claim` bounds it to
      `pageSize`. Bound the readiness reads to the entries the batch can actually claim, in
      observation order, and stop at the bound. Pin the admission-read count per rotation round over
      a page of 16 rows with `pageSize` 16 and with a smaller bound.
- [x] **Step 4: The witness for the gap this slice cannot close.** A committed `dispatch-local` that
      the window outlives must still be visible. Add nothing new here — Task 4's
      `admission-outcome` → `dispatch` correlation covers it — but assert in
      `al-inbound-effect-worker-lifecycle.test.ts` that a message admitted `pending` and then
      committed by a replay is dispatched inside the same batch when the owner is idle.
- [x] **Step 5: Verify and commit.**
      `npx vitest run packages/tests/shared/alm/inbound packages/tests/shared/alm/al-inbound-effect-worker-lifecycle.test.ts`

### Task 4: Drain-latency instrumentation in the inbound diagnostics

Today `effect-drain` (`al-inbound-runtime-diagnostics.ts:27-35`) carries `durationMs`,
`claimedCount`, `completedCount`, `rescheduledCount`, `rejectedCount` and nothing else, so a 22 s
batch cannot be split into selection, claims and releases. `readiness-probe` is emitted by the
handler and dropped on the floor by `recordWorkDiagnostics` (`al-inbound-message-runtime.ts:203-207`).
`rotation-alive` fires only after 64 consecutive **empty** rounds, which a crawling non-empty
rotation never reaches — 0 events in every observation run.

**Files:**

- Modify: `packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts`,
  `packages/shared/alm/inbound/al-inbound-message-runtime.ts`,
  `packages/shared/alm/work/al-work-handler.ts`,
  `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`
- Test: `packages/tests/shared/alm/inbound-admission-diagnostics.test.ts`,
  `packages/tests/shared/alm/work/al-work-handler.test.ts`

**Interfaces:**

- Produces, on `effect-drain`: `selectionDurationMs` (the page read plus every readiness read),
  `claimDurationMs` (the port's reservation), `runDurationMs` (every claim's own work),
  `releaseDurationMs`, and `queueWaitMs` — how long the earliest claimed row had been ready before
  this batch started, from the row's `resolveALInboundWorkReadyAt`. All required.
- Produces, new event `claim-settled`: `workerId`, `msgId`, `typeId`, `payloadKind`
  (`admit-message` | `admit-control` | `dispatch-local` | `forward-message` | `send-control` |
  `release-buffered`), `durationMs`, `attempts`, `outcome` (`completed` | `retry` | `not-ready` |
  `non-retryable`), `queueWaitMs`. One per claim, so a delivery can be followed from its
  `admission-outcome` to the claim that ran it.
- Produces, new event `readiness-probe` relayed from the handler with its `cause` and `readyAtMs`,
  and with a `durationMs` of its own. Task 13 Step 4's reason for suppressing it — one probe per
  engine round — no longer holds once Task 3 Step 3 bounds the probe's reads; pin the per-second
  event rate in the test and keep the suppression if the pin says the relay is too loud.
- Produces, `rotation-alive` gains `longestRoundMs`, so a slowed non-empty rotation reports.

- [ ] **Step 0: Settle the rotation question in the code, not in prose.** `ALInboundMessageRuntime`
      passes `readinessMemoryMs: AL_WORK_PROBE_EVERY_ROUND` (0) deliberately: the rotation advances one
      status per probe, so a remembered answer would strand a status. The outbound's
      remembered-readiness treatment is therefore **not** what inbound needs — confirm this by
      measurement in Task 0 Step 2 (`work-page` per idle second is already ~1 per round, 92 ops on the
      receiver page of run 7 against 566 on the green head). Record the conclusion in the inbound
      README. If the measurement contradicts it, stop and route to the maintainer.
- [ ] **Step 1: Split the batch.** Add the five duration fields to `ALWorkBatchDiagnostics` in
      `al-work-handler.ts` (`runSelectedWork`, `:274-303`) and relay them on `effect-drain`. Pin them
      in `al-work-handler.test.ts` with a fake clock so each phase has a distinct, asserted value.
- [ ] **Step 2: Per-claim events.** Emit `claim-settled` from `runOne` through the diagnostics sink,
      with the payload kind decoded by the inbound runtime (the handler is generic and must not decode
      an inbound payload — pass the kind in from `runInboundClaim`). Pin one event per claim with the
      right outcome for completed, retry and non-retryable.
- [ ] **Step 3: Relay `readiness-probe` and extend `rotation-alive`.** Pin the event rate per idle
      second over a fake engine; keep the relay only if it stays under the rate Task 0 Step 2
      measured for the green head.
- [ ] **Step 4: Contract doc and commit.** Update `runtime-diagnostic-contract.md` with the new fields
      and events and what each answers. Record in it that `commit-phases.transportSettleDurationMs` is
      never emitted, so no reader may depend on it.
      `npx vitest run packages/tests/shared/alm/inbound-admission-diagnostics.test.ts packages/tests/shared/alm/work`

### Task 5: Re-observe on the runner with the regime rule

**Files:** none in production; the lane's own artifacts.

- [ ] **Step 1: Local lane first.** `npm run test:rallar:full-stack:memory:alm`. Expected: three cells
      pass and each writes `test-results/alm-observation/<carrier>-smoke.json` plus its snapshot.
      Read the new `effect-drain` phase split from the snapshot and record the local medians.
- [ ] **Step 2: Push and let the observation job run.** Download `alm-conformance-lane-<sha>`.
- [ ] **Step 3: Classify before judging.** Read `regime` in every cell's
      `alm-observation/<carrier>-smoke.json`. Take the **rtc** cell's regime as the runner's verdict;
      a `normal` regime on ws or fallback is unattributed (too few opening-window samples). Rules, from
      `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md`: both `normal` → a red is a
      product regression; red `slow` against a `normal` baseline → a measurement of the runner, not a
      verdict; either `unclassified` → no regime evidence, rerun. The thresholds
      (`ALM_OBSERVATION_NORMAL_REGIME_MAX_MS_PER_OPERATION` 30,
      `ALM_OBSERVATION_SLOW_REGIME_MIN_MS_PER_OPERATION` 35) are constants, not knobs.
- [ ] **Step 4: The acceptance figures.** Record, against the run-7 slow-regime baseline: inbound
      `effect-drain` median per cell and per page; the `selectionDurationMs` / `runDurationMs` split;
      the pending share of `admission-outcome`; the ws `delivery-baseline` end-to-end latency and the
      window left at arrival; whether the RTC receiver emitted an answer. **Acceptance:** in a `slow`
      regime the receiver's inbound median is at or below the outbound owner's for the same cell
      (run 7: inbound 5.1–14.1 s against outbound 1.4–1.8 s), and the ws cell delivers. Two
      iterations are allowed before the maintainer is asked again.
- [ ] **Step 5: A red you cannot attribute.** If a cell reds in an `unclassified` or `slow` regime
      with no same-regime green baseline, rerun once. If it reds again, write the diagnosis as a
      session record in the shape of the earlier ones and route it to the maintainer
      rather than tuning a budget.

### Task 6: Final gates and the PR

- [ ] **Step 1: The full local list on the final tree.** `npm run test:unit`;
      `npm run typecheck`; `cd apps/api-v1 && deno task check`, and the same for
      `apps/rallar-black-box-control-server` and `apps/relic-hunter-server-v1`; `npm run test:deno`;
      `npx dprint check`; `npm run check:repo-style:changed -- origin/main HEAD`;
      `node scripts/check-tests-typecheck.mjs`;
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`;
      `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`; `npm run build`;
      `npm run test:ci`. Report which passed, failed, or were skipped, and why.
- [ ] **Step 2: Postgres lanes.** `npm run db:test:up`, then
      `npm run test:api-v1:black-box:postgres:medium-scale` and
      `npm run test:integration:postgres`. Never weaken their constants or assertions.
- [ ] **Step 3: Bundle figures.** Record `browser/rallar.ts` and the headless bundle against their
      budgets. A crossed budget is raised to the next whole KiB with the measured figure recorded and
      reported (maintainer ruling 2026-09-05); both figures go in the PR body.
- [ ] **Step 4: README and PR.** Update `packages/shared/alm/inbound/README.md` with the read-session
      rule, the pending-admission carry, the readiness/dispatch observation, and the rotation
      conclusion from Task 4 Step 0. PR body in the F2 shape: Goal, Changes, Acceptance (the
      conformance scenarios and the transaction pins), Validation (the artifacts and the commands),
      Risk and rollback (schema-id move discards pending ALM work — list what), Follow-up.
      `pr:delivery status` decides the next action; `ready` and auto-merge are not used.
- [ ] **Step 5: Branch Release Gate.** Green on the final feature-branch commit before review is
      requested. Any change after a passing gate invalidates it.

---

## Not in this slice

- **The RTC `not-yet-in-sync` retention and the sender's retry.** A frame denied by
  `computeRtcRoomSnapshotAdmission` (`packages/shared/multicast/rtc-room-snapshot-admission.ts`) is
  dropped without retention and the sender's retry never fires
  (`alm-observation-04f0f70a1-diagnosis.md` §"loss stage"). That is S2's, and it is a different
  defect from the one this slice fixes — run 7 has zero `not-yet-in-sync` anywhere.
- **Delivery-level fallback** (a WS delivery when the RTC lane cannot carry it). S3's.
- **The harness budgets.** `CONNECT_READINESS_TIMEOUT_MS` 30 000, the 18 000 ms scenario deadline and
  the receiver window derived from it, `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500
  all stay as they are (maintainer decision, 2026-09-11). This slice earns its margin from the owner,
  not from the budget.
- **Returning the lane to `test:ci`.** It stays the Release Gate's non-blocking observation job until
  the maintainer says otherwise; F2b's acceptance is the evidence for that decision, not the decision.
- **`transportSettleDurationMs`.** Never emitted in any run; populating it is a separate instrumentation
  item, recorded in Task 4 Step 4's doc note.
- **The eviction interval pinned to the first session** (F2 ruling R52–R55) and the batch that can
  outlive `dispose()` (R39/R43). Both recorded, both S1's.

## Self-review

- Spec coverage: "one transaction per decision surface" → Task 1; "the two-phase cost" → Task 2 (the
  pending replay) and Task 3 (readiness then dispatch); "drain-latency instrumentation" → Task 4; the
  regime rule → Task 5.
- Where the measurements refined the roadmap's earlier F2b sentence (folded into its concrete
  "Release 3, F2b" section): (1) the commit's fence
  is **already** one snapshot, so "the two-phase cost" on the inbound is the pending replay and the
  readiness/dispatch pair, not the write phase; (2) the RTC answer is emitted by the **outbound**
  owner — the inbound fix is necessary but the emitting side was already treated in Task 13; (3) the
  pending share's slow-regime figure is 63–65 % for the RTC cells and 47 % for the ws cell, so
  "63–65 %" is the RTC reading, not the whole run; (4) the rotation's `AL_WORK_PROBE_EVERY_ROUND` is a
  deliberate opt-out from the outbound's remembered readiness and this slice keeps it (Task 4 Step 0).
- Placeholder scan: every step carries file paths, function names and the exact command; nothing is
  left to fill in later.
