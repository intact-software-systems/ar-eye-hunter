# ALM S1 Delivery Lifecycle and Handle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A typed message send returns a handle with a stable message id before admission resolves,
and the handle observes the message's whole delivery lifecycle — `submitted`, `rejected`,
`pending-authority`, `accepted`, `queued`, `transport-accepted`, `acknowledged`, `expired`,
`superseded`, `failed`, `cancelled`, and `unobservable` — fed by a per-message settlement stream the
outbound owner emits at every point where it decides a delivery fact today and throws it away. The
public `RallarMessageSendResult` and the internal `ALOutboundEnqueueStatus` union are both gone when
the plan finishes; the black-box ledger becomes a projection of the same stream; AR Eye Hunter's match
capability consumes the handle.

**Architecture:** Approach C of the proposal. One lifecycle vocabulary lives in
`packages/shared/alm/delivery/` — the state union, the settlement-event union, the structured
admission verdict, the evidence shape, and a pure reducer with a terminal guard — so the browser
handle, the black-box ledger, and the server's admission consumers read one definition.
`ALOutboundMessageRuntime` gains a second sink beside its diagnostics sink and a per-message cancel;
it emits settlements for the facts it already decides (pending replay, attempt start and settlement,
acknowledgement, expiry, cancellation) and stamps its carrier on them. The admission verdict for the
first attempt is recorded by the browser sender, which is the only owner that knows the send strategy.
The live registry is a browser-owned in-memory observation store with bounded retention, constructed
once in the facade composition, fed by both carrier runtimes at every connect, and never written to
IndexedDB. Persistence is a declared seam with no durable implementation in S1 (D13).

**Tech Stack:** TypeScript across Node, Deno, and browser; Vitest with `fake-indexeddb`; PGlite and
PostgreSQL for the server backend; Playwright for the conformance lane; dprint.

**Spec:** [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md),
section "Release 3, S1: delivery lifecycle and handle", the decision record D9–D16, and the product
description's "result stages" (`playground/alm/alm-complete-product-description.md:94-119`). The design
argument and the survey facts are in
[playground/alm/alm-s1-design-proposal.md](../playground/alm/alm-s1-design-proposal.md) (section 4
holds the maintainer's decisions). F2b is merged on `main` as `a336ad41c`; S1 starts from it (D16)
while F2c runs in its own slice.

## Global Constraints

- Decisions D9–D16 bind every task: hop-level evidence under hop names; `pending-authority` is the
  authority wait only, `submitted` is the initial state, `pending-admission` leaves the public
  vocabulary; WS ordering stays S2; AR Eye Hunter only; no reload survival, a lost observation is
  `unobservable`, never `failed`; the public result goes first and the internal union goes before the
  plan finishes; the game result carries the handle, `rallar.realtime` is untouched.
- Decision D8: search `packages/**` before writing anything; ask before an internal library; no new
  third-party dependency. `notifyListener` (`packages/shared-web/browser/messages/rallar-listener-delivery.ts`),
  `RallarWaitForOpenOptions` (`packages/shared-web/browser/rallar-rtc-facade.ts:43-46`),
  `RallarUnsubscribe`, and `Either` are reused, never re-implemented.
- **Zero new IndexedDB operations on the default typed send.** Task 0 pins the `al-admission` and
  `al-work` operation counts for one send over IndexedDB; Task 12 proves they are unchanged. The
  registry is in-memory; no lifecycle row, no schema-id bump.
- **Settlements never travel through `ALOutboundRuntimeDiagnosticsSink`** and are never relayed
  per event to the black-box page bridge (a per-round relay doubled the page's per-operation cost in
  F2b). The registry consumes them in-page; the harness reads the registry.
- The outbound runtime introduces **no additional queue, pending-work registry, or timer** for
  settlement (`packages/shared/alm/outbound/README.md:172-176`); emission is synchronous at the
  decision point and guarded so a throwing sink never changes work behaviour.
- No retained legacy: every replaced path, type, test, and doc sentence is removed in the commit that
  replaces it; obsolete coupled tests are rewritten in the same commit; nothing is renamed through an
  alias; `mod.ts` boundaries re-export canonical names only.
- Touched-file standards closure: every touched human-authored file is reviewed and remediated in
  full; a support file changed by that remediation enters closure recursively; independent untouched
  code stays outside.
- Canonical verbs (`toXxx`, `computeXxx`, `validateXxx`, `readXxx`/`writeXxx`, `getXxx`/`setXxx`,
  `createXxx`, `resolveXxx`); `handle` as a verb, `process`, `execute`, `util`, `helper`, `data` do not
  appear in touched files (the noun `handle` names the public object, as `RallarCallHandle` already
  does).
- Expected failure is a value: a rejected admission is a `rejected` handle state, a lost observation is
  `unobservable`; only a send that cannot form a message (input validation before an `ALMessage`
  exists) still throws `RallarValidationError`.
- Required fields by default in every new contract; an optional field only where absence has domain
  meaning, stated in the field's comment. At most three positional parameters.
- One canonical name per type: the browser surface exposes the shared `ALDelivery*` names directly;
  no `RallarMessageDeliveryState = ALDeliveryState` alias.
- Sizes: no new `file.cognitive-load` pin and no new disposition entry under `packages/shared/alm`
  or `packages/shared-web/browser/messages`; `packages/shared/alm/outbound` already trips
  `layout.directory-density` (21 files) and `layout.feature-prefix-cluster`, so S1's new shared files
  go under `packages/shared/alm/delivery/`, not the outbound directory; `browser/rallar.ts` stays at
  11 runtime value exports (add no runtime export there); `rallar-messages.ts` stays type-only.
- Bundle budgets: `browser/rallar.ts` 207 KiB (measured 206.198), headless 260 KiB (measured
  259.063), `rallar-messages.ts` 3 KiB. A crossed budget is raised to the next whole KiB with the
  measured figure recorded in both `shared-web-browser-bundle-boundaries.test.ts` and
  `packages/shared-web/scripts/measure-browser-bundles.mjs` (maintainer ruling 2026-09-05), reported
  in the PR body.
- **Never weaken a harness budget or a lane constant.** `CONNECT_READINESS_TIMEOUT_MS` 30 000,
  `CONFORMANCE_DEADLINE_MS` 18 000, `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500, the
  regime thresholds 30/35 ms per operation stay as they are.
- Tasks 6 to 9 are one cutover: between Task 6's commit and Task 9's, the consumers Task 6 lists
  (director, calls, AI, game, the black-box app, the harness) may fail their package typecheck;
  `npm run typecheck` is green again when Task 9 completes and stays green at every later commit.
  Every other task keeps its package typecheck green at each commit.
- Every commit keeps focused Vitest, `npx dprint check <files>`, and the package typecheck green;
  before pushing: `npm run test:unit`, the three Deno checks, `npx dprint check`,
  `npm run check:repo-style:changed -- origin/main HEAD`, `node scripts/check-tests-typecheck.mjs`,
  `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`,
  `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`,
  `npm run test:rallar:full-stack:memory:alm`.
- `packages/shared/alm/outbound/README.md`, `packages/shared-web/browser/README.md`,
  `packages/shared-web/game/README.md`, `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`
  and `docs/rallar-api-reference.md` are updated in the same PR and never claim behaviour the code
  does not have.

---

### Task 0: Pin the starting point

**Files:**

- Modify: `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
- Test: the same file; `packages/tests/shared/alm/outbound-runtime-test-fixture.ts` (read only)

**Interfaces:** consumes `createCountingIndexedDbOperationObserver`, `IndexedDbAdmissionBackend`,
`createDefaultOutboundTestRuntime`; produces no runtime surface.

- [ ] **Step 1: The default-send operation pin (GREEN at HEAD).** Add
      `describe('outbound default send IndexedDB volume')` that builds a real outbound runtime over
      `IndexedDbAdmissionBackend` with a counting observer (the shape
      `outbound-commit-phase-diagnostics.test.ts:30-57` uses), enqueues one message with
      `sendPreparedMessage: async () => ({ status: 'sent' })`, drains one batch, and pins
      `counts.byOwner['al-admission']` and `counts.byOwner['al-work']` at today's figures with the
      figures in the assertion message. This is the "no new default write" witness Task 12 re-runs.
      Command: `npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
      Expected: GREEN, the two numbers recorded in the test.
- [ ] **Step 2: Commit.** One commit, message naming the measured counts.

### Task 1: The lifecycle vocabulary and reducer

**Files:**

- Create: `packages/shared/alm/delivery/al-delivery-lifecycle.ts`,
  `packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts`
- Test: `packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts`

**Interfaces:**

- Consumes: `ALAckMode` from `packages/shared/al-contracts/al-contract.ts:87`.
- Produces (every later task imports these by their canonical names):

```ts
// al-delivery-lifecycle.ts — contracts, the state list, the initial lifecycle, the terminal test
export type ALDeliveryState =
    | 'submitted'
    | 'rejected'
    | 'pending-authority'
    | 'accepted'
    | 'queued'
    | 'transport-accepted'
    | 'acknowledged'
    | 'expired'
    | 'superseded'
    | 'failed'
    | 'cancelled'
    | 'unobservable';

/** Every state, in lifecycle order; the harness decoders and the capability prose derive from it. */
export const AL_DELIVERY_STATES: readonly ALDeliveryState[] = [
    'submitted',
    'rejected',
    'pending-authority',
    'accepted',
    'queued',
    'transport-accepted',
    'acknowledged',
    'expired',
    'superseded',
    'failed',
    'cancelled',
    'unobservable'
];

/** The states a wait for admission resolves on: everything the first verdict can produce. */
export const AL_DELIVERY_ADMITTED_STATES: readonly ALDeliveryState[] = AL_DELIVERY_STATES.filter((
    state
) => state !== 'submitted');

export type ALDeliveryCarrier = 'rtc' | 'ws';

/** What one carrier's attempt settled to; the seven transport outcomes plus a refused admission. */
export type ALDeliveryAttemptOutcome =
    | 'sent'
    | 'not-ready'
    | 'failed'
    | 'no-targets'
    | 'cancelled'
    | 'expired'
    | 'superseded'
    | 'unroutable';

export type ALDeliveryAdmissionVerdict =
    | Readonly<{ kind: 'admitted'; durable: boolean; queuedAttempts: number; }>
    | Readonly<{ kind: 'duplicate'; }>
    /** A retained admission conflict: the owner replays it; the handle stays `submitted`. */
    | Readonly<{ kind: 'pending'; }>
    | Readonly<{ kind: 'deferred'; reason: 'not-yet-in-sync'; detail: string; }>
    | Readonly<{
        kind: 'refused';
        reason: 'unauthorized' | 'malformed' | 'oversized' | 'unsupported';
        detail: string;
    }>
    | Readonly<{
        kind: 'unroutable';
        reason: 'no-route' | 'rate-limited' | 'circuit-open';
        detail: string;
    }>
    | Readonly<{ kind: 'superseded'; detail: string; }>
    | Readonly<{ kind: 'expired'; detail: string; }>
    | Readonly<{
        kind: 'skipped';
        reason: 'disposed' | 'repair-exhausted' | 'pending-terminated' | 'planner-drop';
        detail: string;
    }>
    | Readonly<{ kind: 'failed'; detail: string; }>;

export type ALDeliverySettlement =
    | Readonly<{
        kind: 'admission';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        verdict: ALDeliveryAdmissionVerdict;
    }>
    /** The sender's strategy has no carrier left to try after an `unroutable` verdict. */
    | Readonly<{
        kind: 'attempts-exhausted';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        detail: string;
    }>
    | Readonly<{
        kind: 'attempt-started';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        attemptId: string;
    }>
    | Readonly<{
        kind: 'attempt-settled';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        attemptId: string;
        outcome: ALDeliveryAttemptOutcome;
        submissionAttempted: boolean;
        detail: string | undefined;
        /** The owner keeps the row and will attempt again; a settled attempt that ends the message says false. */
        willRetry: boolean;
    }>
    | Readonly<{
        kind: 'acknowledgement';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        confirmedHopPeerIds: readonly string[];
        unconfirmedHopPeerIds: readonly string[];
        complete: boolean;
    }>
    | Readonly<{
        kind: 'expired';
        msgId: string;
        carrier: ALDeliveryCarrier;
        atMs: number;
        detail: string;
    }>
    | Readonly<{ kind: 'cancelled'; msgId: string; carrier: ALDeliveryCarrier; atMs: number; }>;

export type ALDeliverySettlementSink = (settlement: ALDeliverySettlement) => void;

export interface ALDeliveryAttempt {
    readonly attemptId: string;
    readonly carrier: ALDeliveryCarrier;
    readonly startedAtMs: number;
    /** Undefined while the carrier still owns the attempt. */
    readonly settledAtMs: number | undefined;
    readonly outcome: ALDeliveryAttemptOutcome | undefined;
    readonly submissionAttempted: boolean;
    readonly detail: string | undefined;
}

export interface ALDeliveryEvidence {
    readonly submittedAtMs: number;
    /** Undefined until an `admitted` or `duplicate` verdict. */
    readonly admittedAtMs: number | undefined;
    readonly attempts: readonly ALDeliveryAttempt[];
    readonly confirmedHopPeerIds: readonly string[];
    readonly unconfirmedHopPeerIds: readonly string[];
    /** The detail of the settlement that made the state terminal; undefined before that. */
    readonly reason: string | undefined;
}

export interface ALDeliveryLifecycle {
    readonly msgId: string;
    readonly typeId: string;
    readonly ackMode: ALAckMode;
    /** Undefined only for a message without a deadline; every browser send carries one. */
    readonly expiresAtMs: number | undefined;
    readonly state: ALDeliveryState;
    readonly evidence: ALDeliveryEvidence;
    /** Settlements that arrived after a terminal state; they never reopen it. */
    readonly lateSettlementCount: number;
}

export interface CreateInitialALDeliveryLifecycleInput {
    readonly msgId: string;
    readonly typeId: string;
    readonly ackMode: ALAckMode;
    readonly expiresAtMs: number | undefined;
    readonly submittedAtMs: number;
}

export function createInitialALDeliveryLifecycle(
    input: CreateInitialALDeliveryLifecycleInput
): ALDeliveryLifecycle;
/** `transport-accepted` is terminal only for a best-effort send (`ackMode === 'none'`). */
export function isALDeliveryTerminal(lifecycle: ALDeliveryLifecycle): boolean;
export function isALDeliveryTerminalState(state: ALDeliveryState, ackMode: ALAckMode): boolean;

// compute-al-delivery-lifecycle.ts — the pure reducer
export function computeALDeliveryLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliverySettlement
): ALDeliveryLifecycle;
```

The transition table `computeALDeliveryLifecycle` implements (rows are settlements, the state column
is the result from any non-terminal state unless stated; a settlement against a terminal lifecycle
returns it with `lateSettlementCount + 1` and, for `attempt-settled` and `acknowledgement`, the
evidence appended — the state never changes):

| Settlement                                                                                   | Result                                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admission` `admitted`                                                                       | `queued` when `queuedAttempts > 0`, else `accepted`; `evidence.admittedAtMs = atMs`                                                                                |
| `admission` `duplicate`                                                                      | `accepted`; `admittedAtMs = atMs`                                                                                                                                  |
| `admission` `pending`                                                                        | unchanged (`submitted` or `pending-authority`)                                                                                                                     |
| `admission` `deferred`                                                                       | `pending-authority`; `reason` stays undefined (non-terminal)                                                                                                       |
| `admission` `refused`                                                                        | `rejected`; `reason = detail`                                                                                                                                      |
| `admission` `unroutable`                                                                     | state unchanged; one attempt appended with `attemptId = admission:${carrier}:${atMs}`, `outcome: 'unroutable'`, `submissionAttempted: false`, `settledAtMs = atMs` |
| `admission` `superseded` / `expired` / `failed`                                              | `superseded` / `expired` / `failed`; `reason = detail`                                                                                                             |
| `admission` `skipped`                                                                        | `failed`; `reason = detail` (a disposed owner admitted nothing: honest as `failed`, not `cancelled`, because the caller did not cancel)                            |
| `attempts-exhausted`                                                                         | `failed`; `reason = detail`                                                                                                                                        |
| `attempt-started`                                                                            | state unchanged; attempt appended with `outcome: undefined`, `settledAtMs: undefined`                                                                              |
| `attempt-settled` `sent`                                                                     | `transport-accepted`; the attempt row settled with `submissionAttempted`                                                                                           |
| `attempt-settled` `not-ready` / `failed` / `no-targets` / `cancelled` with `willRetry: true` | state unchanged; attempt row settled                                                                                                                               |
| `attempt-settled` `failed` / `no-targets` with `willRetry: false`                            | `failed`; `reason = detail`                                                                                                                                        |
| `attempt-settled` `cancelled` with `willRetry: false`                                        | state unchanged (a disposal settles the attempt, not the message); attempt row settled                                                                             |
| `attempt-settled` `expired` / `superseded`                                                   | `expired` / `superseded`; `reason = detail`                                                                                                                        |
| `acknowledgement`                                                                            | lists replaced from the settlement; `acknowledged` when `complete`, else unchanged                                                                                 |
| `expired`                                                                                    | `expired`; `reason = detail`                                                                                                                                       |
| `cancelled`                                                                                  | `cancelled`; `reason = 'Cancelled by the sender.'`                                                                                                                 |

Terminal states: `rejected`, `acknowledged`, `expired`, `superseded`, `failed`, `cancelled`,
`unobservable`, and `transport-accepted` when `ackMode === 'none'`. An `attempt-settled` whose
`attemptId` is unknown appends a row (the observer may have opened after the start); an
`attempt-started` whose id already exists leaves the row alone.

- [ ] **Step 1: Write the failing tests.** One `it.each` per table row over both `ackMode: 'none'` and
      `ackMode: 'receiver'`, plus: the terminal guard (a `sent` after `cancelled` leaves `cancelled`
      and counts one late settlement, the attempt row still appended); `transport-accepted` terminal
      only for `'none'`; `pending` keeps `pending-authority`; `AL_DELIVERY_ADMITTED_STATES` equals every
      state but `submitted`; the reducer never mutates its inputs (`Object.isFrozen` on a frozen
      previous, deep-equal before/after).
      Command: `npx vitest run packages/tests/shared/alm/delivery/compute-al-delivery-lifecycle.test.ts`
      Expected: FAIL (module missing).
- [ ] **Step 2: Implement the two modules** exactly as the interfaces above; keep the reducer as one
      `switch (settlement.kind)` that dispatches to one pure function per family
      (`toAdmissionLifecycle`, `toAttemptLifecycle`, `toAcknowledgementLifecycle`, `toTerminalLifecycle`),
      each under 40 lines; `AL_DELIVERY_STATES` is the single runtime list every other list derives from.
      Command: the Step 1 command; `npx tsc -p packages/shared/tsconfig.json --noEmit`
      Expected: PASS.
- [ ] **Step 3: Commit.** `npx dprint check` on the three files.

### Task 2: The structured admission verdict inside the outbound owner

**Files:**

- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (`ALOutboundDispatchPlan`
  `:101-110`, `ALOutboundEnqueueResult` `:199-205`),
  `packages/shared/alm/outbound/compute-al-outbound-dispatch.ts` (`:57-81`, `:160-197`, `:297-326`),
  `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts` (`:116-124`, `:149-159`,
  `:240-248`, `:255-282`, `:299-305`), `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts`
  (`:191-199`, `:222-252`, `:865-872`), `packages/shared/multicast/rtc-room-snapshot-admission.ts` (`:113-114`)
- Create: `packages/shared/alm/outbound/to-al-outbound-enqueue-status.ts` (temporary until Task 11)
- Test: `packages/tests/shared/alm/outbound-dispatch-values.test.ts`,
  `packages/tests/shared/al-outbound-message-runtime.test.ts` (`:121`, `:166`, `:557`, `:581`),
  `packages/tests/shared/multicast/rtc-room-snapshot-admission.test.ts`, a new
  `packages/tests/shared/alm/outbound-admission-verdict.test.ts`

**Interfaces:**

- Consumes: `ALDeliveryAdmissionVerdict` (Task 1).
- Produces: `ALOutboundDispatchPlan.dropReasonCode: 'unauthorized' | 'not-yet-in-sync' | 'no-route' | 'superseded' | 'expired' | 'duplicate' | 'planner-drop' | undefined`
  (required field, `undefined` means "not dropped"); `ALOutboundEnqueueResult.verdict: ALDeliveryAdmissionVerdict`
  beside the existing `status`, with `status` derived by `toALOutboundEnqueueStatus(verdict)` in the
  new temporary module so every current consumer compiles unchanged; `ALOutboundComputedDto.verdict`.

- [ ] **Step 1: Failing tests.** In `outbound-admission-verdict.test.ts`: `computeALOutboundDispatch`
      yields `{ kind: 'admitted', durable: true, queuedAttempts: 1 }` for a persisted plan with one
      prepared attempt, `{ kind: 'admitted', durable: false, queuedAttempts: 1 }` for a volatile plan,
      `{ kind: 'unroutable', reason: 'no-route' }` for an enqueue with no attempts, `duplicate` for a
      sent snapshot, `superseded`, `expired`, and — the two defects the survey found —
      `{ kind: 'refused', reason: 'unauthorized' }` for `dropReasonCode: 'unauthorized'` and
      `{ kind: 'deferred', reason: 'not-yet-in-sync' }` for `dropReasonCode: 'not-yet-in-sync'`, where
      today both collapse to `'skipped'` (`compute-al-outbound-dispatch.ts:325`). Also pin
      `toALOutboundEnqueueStatus` as a total function over every verdict kind.
      Command: `npx vitest run packages/tests/shared/alm/outbound-admission-verdict.test.ts`
      Expected: FAIL.
- [ ] **Step 2: Carry the code, not the string.** Add `dropReasonCode` to `ALOutboundDispatchPlan`;
      the RTC planner sets it where it sets `dropReason` (`web-rtc-overlay-multicast-manager.ts:865-872`
      from `admission.kind`, `rtc-room-snapshot-admission.ts:113-114` already has a code); the WS
      planners set `undefined`. Replace `toALOutboundEnqueueStatusFromReason` (`:297-326`, the
      `normalized.includes` sniff) with `toALOutboundAdmissionVerdict(plan)` keyed on the code; delete
      the sniff. `computeALOutboundDispatch` computes `verdict` first and `status` from it; the same for
      `toDuplicateDispatchResult`, `toEarlyDispatchResult`, the rate-limit and breaker results in the RTC
      manager (`unroutable` with `rate-limited` / `circuit-open`), and the five dispatch-admission
      results (`failed` for validation issues, conflict, and the escaped `NonRetryableException`;
      `expired` at commit; `skipped` with `disposed` / `pending-terminated`; `pending`).
      Command: `npx tsc -p packages/shared/tsconfig.json --noEmit`; the Step 1 command; the four listed
      suites.
      Expected: all green; no consumer outside these files changed.
- [ ] **Step 3: Commit.**

### Task 3: The settlement stream in the outbound owner

**Files:**

- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (`Dependencies` `:240-275`,
  `SendLifecycle` `:212-218`, `runOutboundClaim` `:458-473`, `runDurableEffect` `:500-540`,
  `dispose` `:353-358`), `packages/shared/alm/outbound/al-outbound-message-effects.ts`
  (`admitPendingMessage` `:35-70`, `writePreparedMessage` `:130-165`, `computeALOutboundSendDisposition` `:172-196`),
  `packages/shared/alm/outbound/control/al-outbound-control-admission.ts` (`admit` `:99-126`,
  `computePendingAckWrite` consumer), `packages/shared/alm/outbound/create-default-al-outbound-message-runtime.ts`,
  `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts` (`:154-159` wiring, `toALOutboundRtcSettlement` `:934-954`),
  `packages/shared/services/ws-queue-box-client-service.ts` (`:207-216`, `:646-682`),
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts` (`:210-211`, `:551-592`),
  `packages/tests/shared/alm/outbound-runtime-test-fixture.ts` (`:48-52`, `:150`)
- Test: new `packages/tests/shared/alm/outbound-delivery-settlements.test.ts`;
  `packages/tests/shared/al-outbound-durable-effects.test.ts`;
  `packages/tests/shared/multicast/rtc-outbound-transport-results.test.ts`;
  `packages/tests/shared/al-outbound-message-runtime.test.ts:1150` (ack while sending)

**Interfaces:**

- Consumes: `ALDeliverySettlement`, `ALDeliverySettlementSink`, `ALDeliveryCarrier` (Task 1);
  `ALOutboundPendingAckSnapshot` (`transition-al-outbound-pending-ack.ts`).
- Produces: `ALOutboundMessageRuntime.Dependencies.carrier: ALDeliveryCarrier` (required) and
  `.settlements: ALDeliverySettlementSink | undefined` beside `diagnostics`;
  `ALOutboundSettledSendResult.submissionAttempted: boolean` (required on all 20 construction sites:
  RTC copies `QRtcDataChannel.SendSettlement.submissionAttempted`, the WS carriers say `true` for
  `sent` and `false` otherwise); every emission below. `SendLifecycle` is unchanged in this task.

Emission points, each guarded by one private `emitSettlement(settlement)` per owner that catches and
`console.error`s exactly as `ALOutboundDispatchAdmission.emitDiagnostics` (`:430-437`) does:

| Fact                                                                                     | Owner and line today                                                                             | Settlement                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| retained admission replayed                                                              | `ALOutboundMessageEffects.admitPendingMessage` after `commitDispatchPlan`                        | `admission` with `computed.verdict`                                                                                                                                                                   |
| replay aborted / expired / authority rejected / authority not ready (`:42-52`)           | same                                                                                             | `cancelled`-shaped evidence is NOT emitted for the aborted branch (disposal); `expired` for the deadline; `admission` `refused` `unauthorized` for `rejected`; `admission` `deferred` for `not-ready` |
| attempt begins                                                                           | `ALOutboundMessageRuntime.runDurableEffect` `case 'send-prepared'` before `writePreparedMessage` | `attempt-started` with `attemptId = effect.effectId`                                                                                                                                                  |
| attempt skipped before the transport (`writePreparedMessage:136-148`)                    | superseded / receipt complete / expired-or-aborted                                               | `attempt-settled` `superseded` / no settlement for a completed receipt (the acknowledgement already said it) / `expired` when the deadline passed, nothing when only aborted                          |
| transport settled, immediate or retained                                                 | `writePreparedMessage` both branches, with the `ALWorkOutcome` known                             | `attempt-settled` with `outcome = settled.status`, `submissionAttempted`, `detail = settled.reason`, `willRetry = outcome.status === 'retry' \|\| outcome.status === 'not-ready'`                     |
| deadline reached at claim or effect (`runOutboundClaim:459`, `runDurableEffect:503-505`) | runtime                                                                                          | `expired` with the message id from the effect's canonical message                                                                                                                                     |
| acknowledgement accepted                                                                 | `ALOutboundControlAdmission.admit` when the pending-ack write is `set` or `remove`               | `acknowledgement` with `confirmedHopPeerIds = ackedPeerIds`, `unconfirmedHopPeerIds = expectedPeerIds − ackedPeerIds`, `complete = isALOutboundReceiptComplete`                                       |
| cancel (Task 4)                                                                          | runtime                                                                                          | `cancelled`                                                                                                                                                                                           |

- [ ] **Step 1: Failing tests.** `outbound-delivery-settlements.test.ts` over memory and IndexedDB
      (the `it.each(['memory', 'indexeddb'])` shape of `outbound-commit-phase-diagnostics.test.ts`),
      collecting settlements from a runtime built with `carrier: 'ws'` and a stub transport: (a) one
      enqueue + drain with `{ status: 'sent', submissionAttempted: true }` yields exactly
      `attempt-started` then `attempt-settled sent` in order, with `attemptId` equal to the committed
      effect id and `carrier: 'ws'`; (b) `not-ready` yields `attempt-settled` with `willRetry: true`;
      (c) a retained (`queued`) send whose `settled` resolves later yields the settled event when it
      resolves; (d) an ack that completes the receipt yields `acknowledgement` with the peer lists and
      `complete: true`, a partial ack `complete: false`; (e) a claim past the deadline yields `expired`;
      (f) a retained conflict's replay yields `admission` with the replay's verdict; (g) a throwing sink
      changes no work outcome and no counter. Extend `rtc-outbound-transport-results.test.ts` so
      `toALOutboundRtcSettlement` carries `submissionAttempted` through.
      Command: `npx vitest run packages/tests/shared/alm/outbound-delivery-settlements.test.ts packages/tests/shared/multicast/rtc-outbound-transport-results.test.ts`
      Expected: FAIL.
- [ ] **Step 2: Thread the sink and the carrier.** Add both dependencies; thread `settlements` into
      `ALOutboundMessageEffects` and `ALOutboundControlAdmission` through their `Dependencies`; the
      three composition roots supply the carrier (`'rtc'` in the multicast manager, `'ws'` in both WS
      services) and `settlements` (`undefined` from the two WS services' own inputs for now — Task 6
      wires the browser). Restructure `ALOutboundSettledSendResult` with the required
      `submissionAttempted` and update the 20 construction sites; the WS server's aborted send reports
      `'cancelled'`, not `'expired'` (`ws-queue-box-server-service.ts:559-561`) — that is a settlement
      fact the union exposes and the plan settles here. Emit at every row of the table. The test
      fixture (`outbound-runtime-test-fixture.ts:48-52,150`) gains `carrier` (default `'ws'`) and
      `settlements`.
      Command: the Step 1 command; `npx vitest run packages/tests/shared/al-outbound-durable-effects.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared/alm packages/tests/shared/multicast packages/tests/shared/services`; `npx tsc -p packages/shared/tsconfig.json --noEmit`; `cd apps/api-v1 && deno task check`
      Expected: green; `readOperationCount` pins in `outbound-commit-phase-diagnostics.test.ts` unchanged.
- [ ] **Step 3: Commit.**

### Task 4: Per-message cancellation in the outbound owner

**Files:**

- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (`sendAbortController` `:276`,
  `sendSignal` `:360-362`, `runDurableEffect` `:500-540`, `dispose` `:353-358`),
  `packages/shared/alm/outbound/al-outbound-message-effects.ts` (`Dependencies.sendSignal` `:23`, `:45`, `:145`)
- Test: `packages/tests/shared/alm/outbound-delivery-settlements.test.ts` (extend),
  `packages/tests/shared/rtc-queued-send-settlement.test.ts` (must stay green unchanged),
  `packages/tests/shared/al-outbound-durable-effects.test.ts:489,521` (dispose family)

**Interfaces:**

- Produces: `ALOutboundMessageRuntime.cancel(msgId: string): ALOutboundCancelOutcome` with
  `export type ALOutboundCancelOutcome = 'cancelled' | 'already-cancelled'` (a cancel for a message the
  owner never saw is still `cancelled`: the owner remembers the id and completes any row it later
  claims for it, so the caller's decision holds whether or not work exists yet); `SendLifecycle.signal`
  becomes the message's own signal; `sendSignal` stays the disposal signal.

- [ ] **Step 1: Failing tests.** (a) `cancel(msgId)` before the drain: the claimed `send-prepared`
      effect completes without calling the transport and the runtime emits exactly one `cancelled`
      settlement; (b) `cancel` during a retained RTC-shaped send: the lifecycle signal handed to
      `sendPreparedMessage` is aborted, the transport settles `cancelled`, the settlement stream shows
      `cancelled` then `attempt-settled cancelled` with `willRetry: false`, and the work row is released
      `completed`; (c) `dispose()` aborts every live per-message signal and emits **no** `cancelled`
      settlement (the attempts settle `cancelled`, the messages do not); (d) an `ack-timeout` or
      `repair-hint` effect for a cancelled message completes without repair; (e) `rtc-queued-send-settlement.test.ts`
      unchanged and green — the per-send signal semantics at the channel are not touched.
      Command: `npx vitest run packages/tests/shared/alm/outbound-delivery-settlements.test.ts packages/tests/shared/rtc-queued-send-settlement.test.ts packages/tests/shared/al-outbound-durable-effects.test.ts`
      Expected: the new cases FAIL, the rest GREEN.
- [ ] **Step 2: Implement.** A `Map<string, AbortController>` of live attempt controllers keyed by
      msgId (created in `runDurableEffect` for `send-prepared`, removed when the attempt settles) and a
      `Set<string>` of cancelled ids on the runtime; `cancel()` adds the id, aborts a live controller,
      emits `cancelled` once; `runDurableEffect` returns `{ status: 'completed' }` for any effect whose
      canonical message id is in the set; `dispose()` aborts every live controller and the disposal
      signal. No `AbortSignal.any`: the lifecycle carries the message's own signal, and disposal
      reaches it through the map, so the three carrier reads of `lifecycle.signal.aborted` need no
      change (`web-rtc-overlay-multicast-manager.ts:629`, `ws-queue-box-client-service.ts:672`,
      `ws-queue-box-server-service.ts:559`). Record in the outbound README that cancellation is held
      for the owner's lifetime: a row still pending when the owner is disposed may be drained by the
      next owner (D13; the durable cancel fact is S3/I2 work).
      Command: the Step 1 command; `npx tsc -p packages/shared/tsconfig.json --noEmit`
      Expected: PASS.
- [ ] **Step 3: Commit.**

### Task 5: The browser delivery registry and the handle contract

**Files:**

- Create: `packages/shared-web/browser/messages/browser-rallar-delivery-registry.ts`
- Modify: `packages/shared-web/browser/messages/rallar-message-contracts.ts` (add the handle
  contracts; `RallarMessageSendResult` is deleted in Task 6)
- Test: new `packages/tests/shared-web/messages/browser-rallar-delivery-registry.test.ts`

**Interfaces:**

- Consumes: `ALDeliveryLifecycle`, `ALDeliverySettlement`, `computeALDeliveryLifecycle`,
  `createInitialALDeliveryLifecycle`, `isALDeliveryTerminal`, `AL_DELIVERY_ADMITTED_STATES` (Task 1);
  `notifyListener` (`rallar-listener-delivery.ts`); `RallarWaitForOpenOptions` (`rallar-rtc-facade.ts:43-46`);
  `RallarUnsubscribe`; `ALMessage`.
- Produces:

```ts
// rallar-message-contracts.ts (public; re-exported through rallar-facade-contract.ts's star export)
export type RallarMessageDeliveryListener = (
    lifecycle: ALDeliveryLifecycle
) => void | Promise<void>;

export interface RallarMessageWaitOptions extends RallarWaitForOpenOptions {
    /** Resolve at the first of these states as well as at any terminal state. */
    readonly until?: readonly ALDeliveryState[];
}

export interface RallarMessageDeliveryOutcome {
    readonly status: 'settled' | 'timeout' | 'aborted';
    readonly lifecycle: ALDeliveryLifecycle;
}

export interface RallarMessageHandle {
    readonly msgId: string;
    readonly typeId: string;
    /** The current lifecycle; the deadline is applied lazily, so a read after `expiresAtMs` says `expired`. */
    lifecycle(): ALDeliveryLifecycle;
    onEvent(listener: RallarMessageDeliveryListener): RallarUnsubscribe;
    wait(options?: RallarMessageWaitOptions): Promise<RallarMessageDeliveryOutcome>;
    cancel(): void;
}

// browser-rallar-delivery-registry.ts
export namespace BrowserRallarDeliveryRegistry {
    export interface Input {
        readonly nowMs: () => number;
        /** Terminal entries are kept this long so a late `wait()` still reads its evidence. */
        readonly retainTerminalMs: number;
        readonly maxEntries: number;
        /** Reaches every carrier owner the message was admitted to; the registry records the `cancelled` settlement itself. */
        cancel(msgId: string): void;
    }
}
export class BrowserRallarDeliveryRegistry {
    constructor(input: BrowserRallarDeliveryRegistry.Input);
    /** Returns the existing handle for the same msgId (fallback re-sends the same envelope). */
    open(message: ALMessage): RallarMessageHandle;
    /** The sink one carrier owner writes into; a sink is closed by `closeSink` when its owner is detached (a batch that outlives dispose must not reach the registry). */
    createSink(): { readonly sink: ALDeliverySettlementSink; close(): void; };
    record(settlement: ALDeliverySettlement): void;
    /** Every non-terminal entry resolves `unobservable`; used by logout and facade disposal. */
    releaseAll(): void;
    size(): number;
}
```

Retention is applied on `open()`: terminal entries older than `retainTerminalMs` are dropped, then
the oldest terminal entries until `maxEntries` holds, then the oldest non-terminal entries, each
resolved `unobservable` before removal. Defaults are decided in Task 6's composition root
(`retainTerminalMs: 60_000`, `maxEntries: 512`). No timer runs per entry: `wait()` arms one timer for
its own timeout and one for the message deadline when it is nearer; `lifecycle()` compares the
deadline on read. `cancel()` on a terminal handle is a no-op.

- [ ] **Step 1: Failing tests.** (a) `open` returns a handle whose `lifecycle().state` is `submitted`
      and whose `msgId`/`typeId` come from the envelope; a second `open` for the same msgId returns the
      same handle; (b) `record` moves the state through `admission admitted` → `attempt-started` →
      `attempt-settled sent` and each step reaches an `onEvent` listener once, in order, through
      `notifyListener`; (c) `wait()` resolves `settled` at the first terminal state and `timeout` with
      the current lifecycle after `timeoutMs`; `wait({ until: AL_DELIVERY_ADMITTED_STATES })` resolves at
      `accepted`; an aborted `signal` resolves `aborted`; (d) a deadline in the past turns
      `lifecycle().state` into `expired` on read and resolves pending waits; (e) `cancel()` calls the
      port once and records `cancelled`; (f) a closed sink's settlements are dropped; (g) retention:
      `maxEntries: 2` with three opens resolves the oldest non-terminal `unobservable` and its waiters
      see `settled` with that state; (h) `releaseAll` resolves every non-terminal entry `unobservable`.
      Command: `npx vitest run packages/tests/shared-web/messages/browser-rallar-delivery-registry.test.ts`
      Expected: FAIL.
- [ ] **Step 2: Implement** the registry as the one stateful owner (a class: it owns subscriptions
      and retention), the handle as a plain object literal closing over it
      (`browser-call-session-runtime.ts:63-76` is the precedent). Keep the file under the cognitive
      warn tier; if the wait machinery pushes it over, split `browser-rallar-delivery-wait.ts` as its
      own owner rather than a helper.
      Command: the Step 1 command; `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
      Expected: PASS.
- [ ] **Step 3: Commit.**

### Task 6: The sender returns the handle; composition, lifecycle, and the public surface

**Files:**

- Modify: `packages/shared-web/browser/messages/browser-rallar-message-sender.ts` (all four public
  sends, `sendRoomWithFallback` `:168-192`, `sendCapturedMessage` `:194-217`, `toRallarMessageSendResult` `:330-342`,
  `computeFallbackDisposition` `:319-328`, `wakeQueueBoxEngineIfQueued` `:348-355`),
  `packages/shared-web/browser/messages/browser-rallar-messages-controller.ts` (`Input` `:23-39`, `:68-81`),
  `packages/shared-web/browser/messages/rallar-message-contracts.ts` (`:68-75`, `:77-80`, `:101-107`),
  `packages/shared-web/browser/messages/rallar-message-operations.ts` (`:13-27`),
  `packages/shared-web/browser/messages/browser-typed-message-channels.ts`,
  `packages/shared-web/browser/composition/browser-communication-composition.ts` (`:50-88`),
  `packages/shared-web/browser/composition/create-rallar-facade.ts` (`:81-92`, `:151-158`),
  `packages/shared-web/browser/composition/browser-lifecycle-composition.ts` (`:18-25`, `:48-57`),
  `packages/shared-web/browser/session/session-auth-lifecycle.ts` (`:97`, `:260-304`),
  `packages/shared-web/browser/session/session-connection-lifecycle.ts` (`:182-186`),
  `packages/shared-web/browser/connection/initialise-browser-middleware.ts` (`MiddlewareInitOptions` `:62-63`, `:235`, `:284`),
  `packages/shared-web/browser/connection/browser-transport-runtime.ts` (`:14`, `:44`, `:97`),
  `packages/shared-web/browser/websocket/create-browser-web-socket-queue-box.ts` (`:54`),
  `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts` (`:63`),
  `packages/shared-web/browser/rallar.ts` (`:134`, the type list), `packages/shared-web/browser/rallar-core.ts` (`:59`),
  `packages/shared-web/browser/rallar-messages.ts` (`:9`),
  `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` (`:114`, `:292`, `:515`),
  `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts` and
  `packages/shared-web/scripts/measure-browser-bundles.mjs` (only if a budget is crossed),
  `packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts` (`:186-220`)
- Test: `packages/tests/shared-web/messages/browser-rallar-message-sender.test.ts` (rewrite the 14
  cases), `packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts`,
  `packages/tests/shared-web/messages/browser-typed-message-channels.test.ts`,
  `packages/tests/shared-web/composition/browser-runtime-construction.test.ts:58`,
  `packages/tests/shared-web/composition/browser-facade-behavior.test.ts:215`,
  `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts`

**Interfaces:**

- Consumes: Tasks 1–5.
- Produces: `RallarMessageLane.send(...)`, `RallarRtcMessageLane.send`, `RallarWsMessageLane.send`,
  `RallarTypedMessageChannel.send/sendRtc/sendWs`, and `BrowserRallarMessageSender.sendTyped/sendWs/sendRtc/sendWsUnicast`
  all return `Promise<RallarMessageHandle>`; `RallarMessageSendResult` deleted from the contracts and
  the three entry-point lists; `RallarMessageHandle`, `RallarMessageWaitOptions`,
  `RallarMessageDeliveryOutcome`, `RallarMessageDeliveryListener`, and the shared `ALDeliveryLifecycle`,
  `ALDeliveryState`, `ALDeliveryEvidence`, `ALDeliveryAttempt`, `AL_DELIVERY_STATES`,
  `AL_DELIVERY_ADMITTED_STATES` exported as types (the two constants are values and are re-exported from
  `rallar-core.ts` only, keeping `rallar.ts` at 11 runtime exports and `rallar-messages.ts` type-only:
  consumers that need the constants import `@shared/alm/delivery/al-delivery-lifecycle.ts`, as apps
  already import `@shared/*`); `MiddlewareInitOptions.deliverySettlements: { readonly ws: ALDeliverySettlementSink; readonly rtc: ALDeliverySettlementSink; }`;
  `BrowserRallarMessageSender.Input.deliveries: BrowserRallarDeliveryRegistry`.

Send semantics after this task: the handle promise resolves as soon as the envelope exists and is
open in the registry (after `connect()`, before admission); admission continues and is recorded as an
`admission` settlement with the carrier; input validation before an envelope exists still throws
`RallarValidationError`; `decodeALMessageValue` failure (`malformed`/`oversized`) records
`admission refused` instead of throwing; a deadline elapsed before admission records `admission expired`;
`sendRoomWithFallback` keeps one msgId over both carriers (`:191`), records the first carrier's verdict,
and after `computeFallbackDisposition` says `stop` on an `unroutable` verdict records
`attempts-exhausted`; a direct `sendWs`/`sendRtc` records `attempts-exhausted` immediately after an
`unroutable` verdict. `wakeQueueBoxEngineIfQueued` keys on `verdict.kind === 'admitted' || 'duplicate'`.

- [ ] **Step 1: Failing tests.** Rewrite `browser-rallar-message-sender.test.ts`: the four
      input-validation throws stay (`:282`, `:297`, `:312`); `:326` becomes "an oversized payload
      resolves a handle in `rejected` with reason `Payload exceeds…`"; the status-with-message cases
      (`:352`, `:534`) become "resolves a handle whose lifecycle is `submitted` before the stubbed
      admission resolves and `queued` after"; the wake cases key on the verdict; a new case pins that
      `send()` resolves before `enqueueOutboxIfAbsent` resolves (a deferred stub). In
      `browser-message-fallback-identity.test.ts` add: an RTC `unroutable` verdict followed by a WS
      `admitted` verdict leaves one handle with two attempts in evidence and state `queued`; RTC
      `unroutable` with `strategy: 'rtc'` resolves `failed` with the reason. In
      `browser-typed-message-channels.test.ts:206` the fallback case reads the handle.
      Command: `npx vitest run packages/tests/shared-web/messages`
      Expected: FAIL on the new expectations.
- [ ] **Step 2: Compose and wire.** Construct `BrowserRallarDeliveryRegistry` in
      `createBrowserFacadeCompositions` before the session composition (its `nowMs` from
      `foundation.runtime`'s clock, the two defaults above, `cancel` reaching both carrier owners through
      `session.readMiddleware()` — `rtcRxStreamer.cancelOutbox(msgId)` and `webSocketQueueBox.cancelOutbox(msgId)`,
      two new one-line pass-throughs to `ALOutboundMessageRuntime.cancel`, mirroring
      `enqueueOutboxIfAbsent` at `web-rtc-rx-streamer-service.ts:421-423` and
      `ws-queue-box-client-service.ts:575-586`; a cancel with no middleware records `cancelled` only).
      Hand the registry to `createBrowserMessagingComposition` → `BrowserRallarMessagesController` →
      `BrowserRallarMessageSender.Input.deliveries`. Hand `registry.createSink()` pairs to the session
      composition so `session-auth-lifecycle.ts:97` and `session-connection-lifecycle.ts:182-186` put
      `deliverySettlements` on `MiddlewareInitOptions`, and `initialise-browser-middleware.ts` passes
      `deliverySettlements.ws` into `createBrowserWebSocketQueueBox` and `deliverySettlements.rtc` into
      `initialiseBrowserRtcRuntime`, which pass them to the runtimes' `settlements` dependency. Register
      a lifecycle participant `{ id: 'message-delivery-registry', order: 35 }` whose `attach` opens the
      two sinks for the connection and whose `detach` closes them (the R43 fence); `releaseAll()` runs
      from `session-auth-lifecycle.ts`'s ended-session cleanup (`:260-304`).
      Command: `npx vitest run packages/tests/shared-web/composition packages/tests/shared-web/al-runtime`
      Expected: `browser-runtime-construction.test.ts:58` still green (the registry touches no session
      at construction).
- [ ] **Step 3: The sender and the public surface.** Implement the semantics above; delete
      `RallarMessageSendResult` and `toRallarMessageSendResult`; update the three export lists and the
      snapshot arrays (`RallarMessageHandle` sorts between `RallarMessageHandler` and `RallarMessageLane`);
      update the facade test double. If `browser-rallar-message-sender.ts` crosses cognitive load 50,
      move `sendRoomWithFallback` and `sendCapturedMessage` into a sibling owner
      `browser-rallar-message-dispatch.ts` (class `BrowserRallarMessageDispatch`, constructed by the
      controller) rather than a helper module.
      Command: `npx vitest run packages/tests/shared-web/messages packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`; `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
      Expected: green; the three suites that still reference the result (`director`, `game`, black-box)
      fail to typecheck until Tasks 7 and 9 — run them under `--reporter=dot` and list them in the
      report as expected reds, then continue.
- [ ] **Step 4: Commit** (one commit for composition, one for the sender and the surface is acceptable;
      both keep `npx tsc -p packages/shared-web/tsconfig.json --noEmit` green except the listed
      consumers).

### Task 7: The shared-web consumer cutover

**Files:**

- Modify: `packages/shared-web/browser/director/browser-director-relay-transport.ts` (`:25-27`,
  `:77-125`, `:188-191`), `packages/shared-web/browser/director/rallar-director-facade.ts` (`:63-76`),
  `packages/shared-web/browser/calls/browser-call-signal-runtime.ts` (`:50`),
  `packages/shared-web/browser/rallar-calls-facade.ts` (`:114`), `packages/shared-web/browser/rallar-ai.ts` (`:44`),
  `packages/shared-web/game/transport/rallar-game-send-result.ts` (`:19`),
  `packages/shared-web/game/match/match-capability.ts` (`:57-81`),
  `packages/shared-web/game/authority/rallar-game-authority-message-results.ts` (`:14-19`),
  `apps/rallar-black-box/src/direct-rallar-operations.ts` (`:8`, `:48`, `:721-735`),
  `packages/shared-web/browser/README.md` (`:198-213`), `packages/shared-web/game/README.md` (`:42`)
- Test: `packages/tests/shared-web/director/browser-director-relay-runtime.test.ts`,
  `packages/tests/shared-web/rallar-game-match.test.ts` (`:76-97`, `:1076`),
  `packages/tests/shared-web/calls/browser-call-signal-runtime.test.ts:59`,
  `packages/tests/shared-web/ai/browser-rallar-ai-test-runtime.ts:92-95`,
  `packages/tests/shared-web/rallar-game-authority-client.test.ts`,
  `packages/tests/rallar-black-box/direct-rallar-operations.test.ts:469-472`

**Interfaces:**

- Consumes: `RallarMessageHandle`, `AL_DELIVERY_ADMITTED_STATES`, `ALDeliveryLifecycle`.
- Produces: `RallarDirectorRelaySendResult.rtc?: RallarTargetedSendResult | RallarMessageHandle`,
  `.ws?: RallarMessageHandle`; `RallarCallSignalSend.result: RallarMessageHandle`;
  `RallarBrowserAiBroadcastResult.message?: RallarMessageHandle`; `RallarGameSendResult.ws?: RallarMessageHandle`;
  one shared predicate `isALDeliveryAdmitted(lifecycle: ALDeliveryLifecycle): boolean` in
  `packages/shared/alm/delivery/al-delivery-lifecycle.ts` (true for `accepted`, `queued`,
  `transport-accepted`, `acknowledged`).

Each consumer that branched on the admission status now awaits
`handle.wait({ until: AL_DELIVERY_ADMITTED_STATES, timeoutMs })` with the timeout it already used for
its send (or `BrowserRallarMessageSender.DEFAULT_MESSAGE_TTL_MS` where it had none) and branches on
`isALDeliveryAdmitted(outcome.lifecycle)`. The director relay keeps counting a `superseded` intent as
sent (a newer intent replaced it; falling back over WS would resend stale state) with that sentence as
the comment; the match capability and the authority results do not — the three predicates collapse to
the shared one plus that single documented exception.

- [ ] **Step 1: Failing tests.** Rewrite each listed suite's send double to resolve a handle (a
      `createTestMessageHandle(lifecycle)` in `packages/tests/shared-web/messages/test-message-handle.ts`,
      one owner for every suite) and assert the consumer outcomes: relay `sent` on `queued`, WS fallback
      on `failed`, `sent` on `superseded`; match capability `{ status: 'sent', transport: 'ws', ws: handle }`
      on `queued` and `failed` with the reason on `rejected`; authority results the same two branches.
      Command: `npx vitest run packages/tests/shared-web/director packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-authority-client.test.ts packages/tests/shared-web/calls packages/tests/shared-web/ai packages/tests/rallar-black-box/direct-rallar-operations.test.ts`
      Expected: FAIL.
- [ ] **Step 2: Cut over** every listed file; delete the three private predicates; update the two
      READMEs' sentences about "QueueBox enqueue results" and the canonical game result.
      Command: the Step 1 command; `npx tsc -p packages/shared-web/tsconfig.json --noEmit`;
      `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
      Expected: green (the `game/mod.ts` snapshot is name-level and unchanged).
- [ ] **Step 3: Commit.**

### Task 8: The AR Eye Hunter consumer proof

**Files:**

- Modify: `apps/ar-eye-hunter-v1/src/game/arena-runtime/match/use-arena-director-appointment.ts`
  (`:74-91`) and the diagnostics/state shape it feeds (`toDirectorAttemptState`)
- Test: the app's existing test for that hook under `packages/tests/ar-eye-hunter-v1/**` (find it with
  `rg -l useArenaDirectorAppointment packages/tests`), extended

**Interfaces:** consumes `RallarGameSendResult.ws` as the handle (Task 7).

- [ ] **Step 1: Failing test.** The hook records the capability report's delivery as
      `{ state: 'pending' }` when the handle is `submitted`/`queued`, `{ state: 'confirmed' }` on
      `transport-accepted`, and `{ state: 'failed', reason }` on `rejected`/`failed`, driven by
      `handle.onEvent`, and unsubscribes on cleanup.
- [ ] **Step 2: Implement.** `reportCapability()`'s result is no longer discarded: its `ws` handle
      feeds a `capabilityDelivery` field on the director attempt state through `onEvent`; the UI that
      renders `directorAttempt` shows it beside the attempt status. Keep it to the one hook and the one
      state shape; no new component.
      Command: `npx vitest run <the test>`; `npm --workspace ar-eye-hunter-v1 run typecheck` (or the
      workspace's check script named in its `package.json`)
      Expected: PASS.
- [ ] **Step 3: Commit.**

### Task 9: The black-box ledger becomes a projection

**Files:**

- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging-controller.ts`
  (`:157-167`, `:169-189`, `:191-203`, `:205-240`, `:242-264`, `:299`, `:698-705`, `:715-763`),
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts`
  (`:116`, `:291`, `:360-399`, `:1139-1175`, `:1250-1252`),
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts` (`:318-332`),
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts` (`:220`, `:240`, `:245-296`),
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts` (`:31-41`, `:136-146`),
  `packages/shared-test/rallar-bb-test/alm/control-protocol-alm-commands.ts` (`:40-50`, `:279-285`),
  `packages/shared-test/rallar-bb-test/alm/browser-adapter-alm-commands.ts` (`:518-531`),
  `packages/shared-test/rallar-bb-test/types.ts` (`:899-920`), `packages/shared-test/rallar-bb-test/schema.ts` (`:1345-1364`, `:1412-1429`),
  `packages/shared-test/rallar-bb-test/fixtures/schema/v1/golden-compatibility-corpus.json` (`:134-183`),
  `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md` (`:121-156`),
  `packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts` (`:147`, `:381`)
- Test: `packages/tests/rallar-black-box/browser-rallar-runtime.test.ts` (`:106-128`, `:155-173`,
  `:176-250`, `:333-359`, `:361-392`, `:394-424`, `:444-455`, `:457-527`),
  `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts` (`:76-83`, `:259-291`, `:532-548`),
  `packages/tests/shared-test/rallar-bb-test-schema.test.ts`,
  `packages/tests/shared-test/rallar-browser-runtime/messaging.test.ts`

**Interfaces:**

- Consumes: `RallarMessageHandle`, `AL_DELIVERY_STATES`, `AL_DELIVERY_ADMITTED_STATES`, `ALDeliveryState`.
- Produces: `BlackBoxRallarDeliveryObservation { handleId; state: ALDeliveryState; submitted: boolean; confirmedHopPeerIds; unconfirmedHopPeerIds; attempts: number; reason: string | undefined; }`
  (the two peer lists renamed per D9 across the contract, the adapter decoder, the recipe result type,
  the schema capability prose, the corpus, and the doc; `attempts = lifecycle.evidence.attempts.length`;
  `submitted = attempts.some((attempt) => attempt.submissionAttempted)`);
  `BlackBoxRallarMessageSendDiagnostics.status: ALDeliveryState` (the state after admission),
  `.message` removed, `.reason` from the evidence; the `hasMessageAdmission` port,
  `hasBlackBoxBrowserMessageAdmission`, `DELIVERY_POLL_INTERVAL_MS`, `PendingMessageAdmission`,
  `toDeliveryObservationState`, `readTypedSendAdmission`, and the 25 ms `#observeDelivery` loop deleted;
  the two literal state lists replaced by `AL_DELIVERY_STATES`.

Ledger semantics: `sendTypedMessage` stores the handle under `handleId`, then awaits
`handle.wait({ until: AL_DELIVERY_ADMITTED_STATES, timeoutMs: send.timeoutMs })` for the send result's
`status`; `observeDelivery` is `handle.wait({ until: observe.state, timeoutMs })` and throws the same
`deliveryStateTimeout` message when the outcome is `timeout`; `cancelDelivery` calls `handle.cancel()`
and returns the observation; `readReceipts` reads the observation; an unknown `handleId` returns an
observation with `state: 'unobservable'`, `attempts: 0`, empty lists (the page-reload case, D13) instead
of throwing; `resetDeliveryLedger` is deleted with its reconnect call: handles outlive a reconnect
because the registry does, and the doc sentence "Connecting clears it" goes with it.

- [ ] **Step 1: Failing tests.** Rewrite the ledger cases in `browser-rallar-runtime.test.ts`: the
      11-row fold table becomes a table over lifecycle states produced by a test handle; send → observe
      `queued` → cancel `cancelled` → receipts with hop lists; observe timeout message unchanged; the
      unknown handle reads `unobservable`; the storage counters during an observe over a `pending`
      admission stay flat (no poll). Update the adapter suite's `DELIVERY_OBSERVATION` fixture to the new
      field names and the schema suite's corpus.
      Command: `npx vitest run packages/tests/rallar-black-box/browser-rallar-runtime.test.ts packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-browser-runtime`
      Expected: FAIL.
- [ ] **Step 2: Implement** the projection; delete the listed members; derive both runtime state lists
      from `AL_DELIVERY_STATES`; rewrite `schema-and-capabilities.md:136-149` to describe the
      settlement-fed ledger, the twelve states, the hop-level lists, and that `messages.cancel` stops
      the owner's remaining attempts without recalling a submitted frame.
      Command: the Step 1 command; `npx tsc -p packages/shared-test/tsconfig.json --noEmit`;
      `npm run test:repo-governance`
      Expected: green.
- [ ] **Step 3: Commit.**

### Task 10: The S1 conformance scenarios

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts`
  (`:20-29`, `:61-63`, `:131-160`, the builders), `apps/rallar-black-box/src/hetzner-distributed-manifests.ts` (`:822-823`),
  `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json` (regenerated by
  `apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`)
- Test: `packages/tests/shared-test/alm-conformance-recipe-validation.test.ts:22-26`,
  `packages/tests/shared-test/alm-conformance-recipes.test.ts:139-176`,
  `packages/tests/shared-test/alm-conformance-deadline-expiry.test.ts`,
  `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts:1017-1021`

**Interfaces:** consumes the recipe command shapes unchanged (no new command kind, no new registry
beyond the four the survey names); produces two scenario ids.

- `delivery-lifecycle` (`smoke`, all three carriers): the sender sends with `ack: 'receiver'` and
  observes `queued`, then `transport-accepted`; on the RTC carriers it then observes `acknowledged`
  with a non-empty `confirmedHopPeerIds`; on `ws` it observes `transport-accepted` and the receipts show
  empty lists (D11: WS has no receipt in S1 — the recipe states this in its assertion message). A
  second message with an `EXPIRY_TTL_MS` deadline and a drop fault on its first frame is cancelled
  from the sender after `queued` and observes `cancelled`; a third and fourth message share a
  supersedence key and the third observes `superseded`. The existing `deadline-expiry` scenario's
  sender additionally observes `expired` after its receiver-absence window (the sender-side terminal the
  ledger can now produce).
- `delivery-reload` (`full`, all three carriers): the sender sends, observes `queued`, runs
  `agent.reload`, and observes `unobservable` for the same handle within `NON_EXPIRING_SEND_TIMEOUT_MS`;
  the receiver still receives the message (the work resumed from storage).

Budgets: every scenario stays inside `CONFORMANCE_DEADLINE_MS`; the new observe steps use the
existing per-command timeouts; the smoke cell's wall time grows by at most the two new scenarios and is
recorded in Task 12.

- [ ] **Step 1: Failing tests.** Add both ids to `CARRIER_SCENARIO_IDS`, the tag matrix, the command-kind
      set (unchanged kinds), the deadline arithmetic, and the manifest `scenarios` array.
      Command: `npx vitest run packages/tests/shared-test/alm-conformance-recipe-validation.test.ts packages/tests/shared-test/alm-conformance-recipes.test.ts packages/tests/shared-test/alm-conformance-deadline-expiry.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`
      Expected: FAIL.
- [ ] **Step 2: Implement** the two definitions and their builders, extend `deadline-expiry`, update
      the manifest description prose, regenerate the JSON.
      Command: the Step 1 command; `npm run test:rallar:full-stack:memory:alm` (all carriers), then
      `RALLAR_BLACK_BOX_ALM_SCOPE=full RALLAR_BLACK_BOX_ALM_CARRIERS=rtc npm run test:rallar:full-stack:memory:alm`
      Expected: green locally in a normal regime; the per-carrier medians and the new scenarios'
      durations recorded in the PR body draft.
- [ ] **Step 3: Commit.**

### Task 11: Retire `ALOutboundEnqueueStatus` (D14)

**Files:**

- Delete: `packages/shared/alm/outbound/to-al-outbound-enqueue-status.ts`
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (`:186-205`: delete the union
  and `ALOutboundEnqueueResult.status`), `packages/shared/alm/outbound/compute-al-outbound-dispatch.ts`,
  `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts`,
  `packages/shared/webrtc/qrtc-signaling-admission.ts` (`:7-13`, `:23`),
  `packages/shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts` (`:122-155`),
  `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts` (`:24`, `:243`),
  `packages/shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts` (`:3`, `:41`),
  `packages/shared-server/rallar-system/websocket/router/publish-rallar-server-ws-message.ts` (`:118-145`),
  `packages/shared-web/browser/rallar-rtc-facade.ts` (`:129-144` — `RallarRtcSignalAdmission.status: string` becomes the verdict),
  `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (`:102-104`)
- Test: `packages/tests/shared/webrtc/ws-rtc-signaling-transport.test.ts:17,124`,
  `packages/tests/shared/webrtc/ws-rtc-signaling-admission-recovery.test.ts`,
  `packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts:758`,
  `packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts:15,146`,
  `packages/tests/rallar-black-box/browser-rallar-runtime.test.ts` (any residual import),
  `packages/tests/shared-test/rallar-browser-runtime/diagnostics.test.ts:303`

**Interfaces:**

- Produces: `RallarServerWsPublishResult.verdict: ALDeliveryAdmissionVerdict` replacing `enqueueStatus`
  (`RallarServerWsPublishStatus` keeps its own thirteen publish literals; `toOutboxPublishStatus(verdict)`
  stays a total switch over the verdict kinds); `QRtcSignalingAdmission` `rejected` carries
  `verdict: ALDeliveryAdmissionVerdict`; `toSignalAdmissionOutcome(verdict)`: `admitted`/`duplicate`/`pending`
  → `accepted`, `unroutable`/`deferred` → `retryable`, the rest → `terminal`; the RTC manager's
  `Extract<ALOutboundEnqueueStatus, …>` becomes its own `'rate-limited' | 'circuit-open' | 'failed'` union
  named where it is used; `RallarRtcSignalAdmission.status: string` becomes `verdict`.

- [ ] **Step 1: Failing tests.** Re-type the listed suites onto verdicts; add a case per exhaustive
      switch that a `deferred` verdict is retryable for signaling and `queued-outbox` for the router.
      Command: the listed suites.
      Expected: FAIL until Step 2.
- [ ] **Step 2: Delete the union** and every derivation; re-type the two switches and the three
      consumers; update the diagnostic-contract doc's admission shape.
      Command: `npx tsc -p packages/shared/tsconfig.json --noEmit`; `npx tsc -p packages/shared-server/tsconfig.json --noEmit`;
      `npx tsc -p packages/shared-web/tsconfig.json --noEmit`; `cd apps/api-v1 && deno task check` and
      the same in `apps/rallar-black-box-control-server` and `apps/relic-hunter-server-v1`
      (`RallarServerWsPublishResult` reaches `relic-game-service.ts` through `shared-server/mod.ts`);
      `npm run test:deno`; `rg -n "ALOutboundEnqueueStatus|pending-admission" packages apps --glob '!**/node_modules/**'`
      returns only the admission-store internals that name the retained-conflict row (the `pending`
      verdict's storage), never a public or consumer surface.
      Expected: green, grep as stated.
- [ ] **Step 3: Commit.**

### Task 12: Measurement, budgets, docs, final gates, and the PR

**Files:** `packages/shared/alm/outbound/README.md` (`:153-176` settlement section, `:223-226`),
`docs/rallar-api-reference.md` (`:629-667`), `.agents/skills/building-rallar-apps/references/app-scaffolding.md`
(`:173-210`, whose `RallarMessageSendStatus` import never existed), `examples/room-message-channel/README.md`
(`:28`, `:39`), `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` (Task 0's pin),
`packages/tests/shared/alm/al-storage-snapshot.test.ts`, the two bundle files if a budget moved.

- [ ] **Step 1: The zero-new-operation proof.** Re-run Task 0's pin unchanged; re-run
      `al-storage-snapshot.test.ts` and record the standard-workload snapshot is byte-identical to
      `main`'s. Command: `npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts`
- [ ] **Step 2: Docs.** The outbound README's settlement section says what the owner emits and
      where; `:223-226` no longer calls the handle roadmap work; the API reference's sample consumes the
      handle (`await roomChat.send(...)` then `wait`), the skill example's broken import is replaced by the
      handle, the example README follows. `npm run test:repo-governance` after the skill edit.
- [ ] **Step 3: Bundle figures.** `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`;
      `npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`. A
      crossed ceiling is raised to the next whole KiB with the measured figure in both files and the PR
      body.
- [ ] **Step 4: The full local list on the final tree.** `npm run test:unit`; `npm run typecheck`;
      the three Deno checks; `npm run test:deno`; `npx dprint check`;
      `npm run check:repo-style:changed -- origin/main HEAD`; `node scripts/check-tests-typecheck.mjs`;
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`; `npm run build`;
      `npm run test:ci`; `npm run test:rallar:full-stack:memory:alm`. Report which passed, failed, or
      were skipped, and why.
- [ ] **Step 5: Postgres lanes.** `npm run db:test:up`, then `npm run test:integration:postgres`
      (the settlement sink over the PostgreSQL backend) and, because the server WS router's publish
      result changed, `npm run test:api-v1:black-box:postgres:medium-scale`. Never weaken their
      constants or assertions.
- [ ] **Step 6: The observation job and the PR.** Push; read the `alm-conformance-lane-<sha>` artifact
      under the regime rule (a red counts only against a same-regime green baseline; the F2b baseline is
      slow at 48–55 ms per operation with every cell red); record per cell the regime, the per-operation
      median, and each S1 scenario's outcome. PR body in the F2b shape: Goal, Changes, Acceptance (the
      state matrix over both carriers, the ledger transitioning for real, the late-event fence, the
      reload scenario, the zero-new-operation pin), Validation, Risk and rollback (no schema-id move;
      revert restores the send result), Follow-up (the durable cancel fact for S3/I2; WS receipts in S2;
      the lane's return to `test:ci` is the maintainer's). `pr:delivery status` decides the next action;
      `ready` and auto-merge are not used.
- [ ] **Step 7: Branch Release Gate** green on the final feature-branch commit before review is
      requested; its result is recorded on the pull request, not here. Any change after a passing gate
      invalidates it.

---

## Not in this slice

- **Logical receipts, the frozen audience, and WS `seq`/`orderingKey`** (D9, D11): S2. The handle's
  `acknowledged` is hop-level; on WS no ack exists, so a reliable WS send in S1 ends `transport-accepted`
  and then `expired` at its deadline, and the matrix says so.
- **A durable lifecycle row, reload-surviving handles, cross-tab or post-disposal cancellation**
  (D13): the sink seam is declared; S3 or I2 implements it.
- **Relic's REST-to-`command` move** (D12): S3.
- **Delivery-level fallback** on a dropped or unreceipted RTC send: S3, on this handle.
- **`rallar.realtime`** (D15): untouched.
- **Server-side handles**: the WS server runtime gets the sink dependency and emits like every owner,
  but no server consumer subscribes in S1.
- **The harness budgets and the lane's blocking status**: unchanged; the lane returns to `test:ci`
  only by the maintainer's decision on evidence.

## Self-review

- Spec coverage: states and evidence → Task 1; the settlement stream the proposal says must be
  created → Tasks 2–3; per-message cancel → Task 4; the registry and handle → Task 5; composition,
  epoch fencing, and the public cutover → Task 6; consumers → Task 7; the game proof → Task 8; the
  ledger projection → Task 9; the lifecycle matrix → Task 10; the internal union's retirement → Task 11;
  measurement, docs, budgets, gates → Task 12.
- Decision coverage: D9 hop names in Task 1's evidence and Task 9's contract; D10 in Task 1's table
  (`pending` keeps `submitted`, `deferred` is the only path to `pending-authority`) and Task 2's codes;
  D11 in Task 10's WS assertion; D12 in Task 8 and "Not in this slice"; D13 in Task 5's retention and
  `unobservable`, Task 9's unknown handle, Task 10's reload scenario; D14 in Tasks 6 and 11; D15 in
  Task 7's `RallarGameSendResult` and the untouched realtime facade; D16 in the Spec paragraph.
- Type consistency: `ALDeliverySettlement` kinds used in Task 3's table, Task 5's tests, and Task 9
  match Task 1's union; `AL_DELIVERY_ADMITTED_STATES` is the same constant in Tasks 6, 7, and 9;
  `submissionAttempted` is required on `ALOutboundSettledSendResult` (Task 3) and read by the reducer
  (Task 1) and the ledger's `submitted` (Task 9).
- Placeholder scan: every step names its files, symbols, commands, and expected results; the two
  numbers Task 0 records are the only values filled at execution, by measurement.
