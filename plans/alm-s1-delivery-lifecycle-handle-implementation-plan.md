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
- Sizes: no new `file.cognitive-load` pin except the six exact maintainer-approved caps below
  (2026-09-20), following the completed cohesion/separation reviews. These are bounded exceptions,
  not false-positive classifications; growth above a cap no longer matches its disposition and
  remains subject to the unchanged base-comparison rules. No other rule or global threshold is waived.

  | Exact owner                                                                                    | Maximum cognitive load |
  | ---------------------------------------------------------------------------------------------- | ---------------------: |
  | `apps/rallar-black-box-control-server/src/control-service.ts`                                  |                    125 |
  | `apps/rallar-black-box-control-server/src/recipe-reload/compute-control-recipe-reload-step.ts` |                     52 |
  | `apps/rallar-black-box-control-server/src/recipe-reload/control-recipe-reload-commands.ts`     |                     59 |
  | `apps/rallar-black-box-control-server/src/recipe-reload/control-recipe-reload-evidence.ts`     |                     64 |
  | `packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-reload-identity.ts`            |                     54 |
  | `packages/shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts`          |                     68 |

  Retain the reviewed coherent owners rather than split synchronous lifecycle or complete reload
  decisions merely to lower a score. Re-review the exact owner when its responsibilities change;
  raising any listed cap requires fresh explicit maintainer approval. The existing disposition
  mechanism records only these exact paths and `file.cognitive-load` with `symbol: undefined`.
  No new size/cognitive-load disposition entry is permitted under `packages/shared/alm`
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
  (director, calls, CRDT transport, AI, game, the black-box app, the harness) may fail their package typecheck;
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

/** Why a carrier admission found no route: no peer at all, or the sender's own rate limit or open circuit. */
export type ALDeliveryUnroutableReason = 'no-route' | 'rate-limited' | 'circuit-open';

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
        reason: ALDeliveryUnroutableReason;
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
    /** Undefined on a carrier attempt: only an `unroutable` admission row states a reason. */
    readonly unroutableReason: ALDeliveryUnroutableReason | undefined;
}

export interface ALDeliveryEvidence {
    readonly submittedAtMs: number;
    /** Undefined until an `admitted` or `duplicate` verdict. */
    readonly admittedAtMs: number | undefined;
    /** Undefined until an `admitted` verdict: a duplicate states nothing about the durability of the original. */
    readonly admittedDurable: boolean | undefined;
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

| Settlement                                                                                   | Result                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admission` `admitted`                                                                       | `queued` when `queuedAttempts > 0`, else `accepted`; `evidence.admittedAtMs = atMs`, `evidence.admittedDurable = durable`                                                                                                                                                                  |
| `admission` `duplicate`                                                                      | `accepted`; `admittedAtMs = atMs`; `admittedDurable` unchanged, because a duplicate states nothing about the durability of the original admission                                                                                                                                          |
| `admission` `pending`                                                                        | unchanged (`submitted` or `pending-authority`)                                                                                                                                                                                                                                             |
| `admission` `deferred`                                                                       | `pending-authority`; `reason` stays undefined (non-terminal)                                                                                                                                                                                                                               |
| `admission` `refused`                                                                        | `rejected`; `reason = detail`                                                                                                                                                                                                                                                              |
| `admission` `unroutable`                                                                     | state unchanged; one attempt appended with `attemptId = admission:${carrier}:${atMs}`, `outcome: 'unroutable'`, `submissionAttempted: false`, `settledAtMs = atMs`, `unroutableReason = reason`                                                                                            |
| `admission` `superseded` / `expired` / `failed`                                              | `superseded` / `expired` / `failed`; `reason = detail`                                                                                                                                                                                                                                     |
| `admission` `skipped`                                                                        | `failed`; `reason = detail` (a disposed owner admitted nothing: honest as `failed`, not `cancelled`, because the caller did not cancel)                                                                                                                                                    |
| `attempts-exhausted`                                                                         | `failed`; `reason = detail`                                                                                                                                                                                                                                                                |
| `attempt-started`                                                                            | state unchanged; attempt appended with `outcome: undefined`, `settledAtMs: undefined`                                                                                                                                                                                                      |
| `attempt-settled` `sent`                                                                     | `transport-accepted`; the attempt row settled with `submissionAttempted`                                                                                                                                                                                                                   |
| `attempt-settled` `not-ready` / `failed` / `no-targets` / `cancelled` with `willRetry: true` | state unchanged; attempt row settled                                                                                                                                                                                                                                                       |
| `attempt-settled` `failed` / `no-targets` with `willRetry: false`                            | `failed` with `reason = detail` when no attempt in the evidence (this one included) has outcome `sent`; otherwise unchanged, the failed hop recorded — the RTC owner commits one row per next-hop peer, and a failed sibling hop must not demote a message another hop carried (ruling R3) |
| `attempt-settled` `cancelled` with `willRetry: false`                                        | state unchanged (a disposal settles the attempt, not the message); attempt row settled                                                                                                                                                                                                     |
| `attempt-settled` `expired` / `superseded`                                                   | `expired` / `superseded`; `reason = detail`                                                                                                                                                                                                                                                |
| `acknowledgement`                                                                            | lists replaced from the settlement; `acknowledged` when `complete`, else unchanged                                                                                                                                                                                                         |
| `expired`                                                                                    | `expired`; `reason = detail`                                                                                                                                                                                                                                                               |
| `cancelled`                                                                                  | `cancelled`; `reason = 'Cancelled by the sender.'`                                                                                                                                                                                                                                         |

Terminal states: `rejected`, `acknowledged`, `expired`, `superseded`, `failed`, `cancelled`,
`unobservable`, and `transport-accepted` when `ackMode === 'none'`. An `attempt-settled` whose
`attemptId` is unknown appends a row (the observer may have opened after the start); an
`attempt-started` whose id already exists leaves the row alone.

The evidence keeps the two admission facts the verdict carries and the state cannot recover:
`admittedDurable`, because a durable admission and a volatile one both read `accepted`, and
`unroutableReason` on the synthetic admission row, because a rate-limited carrier, an open circuit
and a carrier with no peer all read `unroutable`. Every later observer reads them from the evidence
rather than from a second channel of its own.

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
- Create: `packages/shared/alm/delivery/to-al-outbound-enqueue-status.ts` (temporary until Task 11; ruling R7 moved it out of the outbound directory, whose density finding it worsened)
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

Emission points. The runtime owns the single guarded emitter (it catches and `console.error`s exactly as
`ALOutboundDispatchAdmission.emitDiagnostics` (`:430-437`) does, stamps `carrier` and `atMs`, and is a
no-op when `settlements` is `undefined`); the effects owner and the control admission receive that
already-guarded sink as a dependency and call it bare — one guard, not three (ruling R4):

| Fact                                                                                                                                                                                                                            | Owner and line today                                                                             | Settlement                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| retained admission replayed                                                                                                                                                                                                     | `ALOutboundMessageEffects.admitPendingMessage` after `commitDispatchPlan`                        | `admission` with `computed.verdict`                                                                                                                                                                                                                                                                                                                                                                                                                             |
| replay aborted / expired / authority rejected / authority not ready (`:42-52`)                                                                                                                                                  | same                                                                                             | `cancelled`-shaped evidence is NOT emitted for the aborted branch (disposal); `expired` for the deadline; `admission` `refused` `unauthorized` for `rejected`; `admission` `deferred` for `not-ready`                                                                                                                                                                                                                                                           |
| attempt begins                                                                                                                                                                                                                  | `ALOutboundMessageRuntime.runDurableEffect` `case 'send-prepared'` before `writePreparedMessage` | `attempt-started` with `attemptId = effect.effectId`                                                                                                                                                                                                                                                                                                                                                                                                            |
| attempt skipped before the transport (`writePreparedMessage:136-148`)                                                                                                                                                           | superseded / receipt complete / expired-or-aborted                                               | `attempt-settled` `superseded` / no settlement for a completed receipt (the acknowledgement already said it) / `expired` when the deadline passed / `attempt-settled` `cancelled` (`submissionAttempted: false`, `willRetry: false`) when the message's signal was aborted before the transport — every started attempt terminates (ruling R10); the pending-admission aborted branch stays silent because no attempt started there                             |
| the carrier throws (the WS server does so deliberately on an encode or send failure)                                                                                                                                            | `writePreparedMessage`'s catch around the attempted send                                         | `attempt-settled` `failed`, `submissionAttempted: false`, `detail` = the error message, `willRetry: true`, then the error is rethrown unchanged so the work handler reschedules the row                                                                                                                                                                                                                                                                         |
| transport settled, immediate or retained                                                                                                                                                                                        | `writePreparedMessage` both branches, with the `ALWorkOutcome` known                             | `attempt-settled` with `outcome = settled.status`, `submissionAttempted`, `detail = settled.reason`, `willRetry = outcome.status === 'retry' \|\| outcome.status === 'not-ready'`; when the deadline guard in `computeALOutboundSendDisposition` made the outcome `completed`, the real outcome is emitted and then `expired` (a transport `not-ready` under that guard emits only `expired`; `not-ready` with `willRetry: false` is never emitted) — ruling R5 |
| deadline reached at the effect (`runDurableEffect:503-505`; the claim-time guard at `runOutboundClaim:459` ran before any row was read and had no message id, so it is deleted and the read path owns the decision — ruling R6) | runtime                                                                                          | `expired` with the message id from the effect's canonical message, only for the row kinds whose expiry is the message deadline (`send-prepared`, `admit-message`, `dequeue-message`); an `ack-timeout`, `nack-retry`, `admit-control`, or `repair-hint` row aging out returns `completed` silently (ruling R9)                                                                                                                                                  |
| acknowledgement accepted                                                                                                                                                                                                        | `ALOutboundControlAdmission.admit` when the pending-ack write is `set` or `remove`               | `acknowledgement` with `confirmedHopPeerIds = ackedPeerIds`, `unconfirmedHopPeerIds = expectedPeerIds − ackedPeerIds`, `complete = isALOutboundReceiptComplete`                                                                                                                                                                                                                                                                                                 |
| cancel (Task 4)                                                                                                                                                                                                                 | runtime                                                                                          | `cancelled`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
    open(message: ALMessage, carrier: ALDeliveryCarrier): RallarMessageHandle;
    /** Adopt a shorter effective admitted deadline on the same observation and active waits. */
    updateDeadline(message: ALMessage): void;
    record(settlement: ALDeliverySettlement): void;
    /** Release the single observation whose captured middleware disappeared before admission. */
    release(msgId: string): void;
    /** Every non-terminal entry resolves `unobservable`; used by session end/replacement. */
    releaseAll(): void;
    size(): number;
}
```

The two transitions no owner emits — the lazy deadline and the lost observation — are pure functions
beside the reducer, `computeALDeliveryDeadline(lifecycle, nowMs)` and
`computeALDeliveryUnobservable(lifecycle)` in `compute-al-delivery-lifecycle.ts`, not synthetic
settlements, because a settlement carries a carrier the registry does not have (ruling R11). `open`
records the first carrier the sender will try and the entry remembers the last carrier seen; the
handle's `cancel()` calls the port first and records its own `cancelled` only if the owners' own
emission has not already terminated the entry (ruling R12). `cancel()`, `wait()`'s `timeout` and
`aborted` outcomes, and every terminality decision apply the deadline first; `wait`'s deadline timer
re-arms when the clock still lags the deadline at fire time; eviction collects its victims before
notifying anyone; `releaseAll()` resolves entries without removing them, and retention ages them on
the next `open()` (ruling R14). The facade ceiling moved to 209 KiB when Tasks 2–4 measured
208.094 KiB on the branch (ruling R13).

Retention is applied on `open()`: terminal entries older than `retainTerminalMs` are dropped, then
the oldest terminal entries until `maxEntries` holds, then the oldest non-terminal entries, each
resolved `unobservable` before removal. Defaults are decided in Task 6's composition root
(`retainTerminalMs: 60_000`, `maxEntries: 512`), with one volatile registry shared browser-wide
by the existing session/carrier transport owner. Facade disconnect retains its entries; actual session
end or replacement releases the matching session observations. These are browser-wide bounds, not
per-facade capacity. Page replacement loses this volatile observation; unknown IDs are unobservable.
No timer runs per entry: `wait()` arms one timer for
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
      port once and records `cancelled`; (f) epoch sink fencing is proved at the actual Task 6 transport owner; (g) retention:
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
open in the registry (after `connect()`, before admission). Admission continues and is recorded as an
`admission` settlement with the carrier. Payload validation runs the configured size policy once:
nonserializable or corrupt payloads that cannot form an envelope throw `RallarValidationError`;
serializable oversized payloads resolve a `rejected` handle with the existing size-policy detail.
Canonical `decodeALMessageValue` rejection also records `admission refused`. A deadline already
elapsed before admission records `admission expired`.

The admitted envelope may contain a topic-shortened effective deadline. Before recording its
admission, update the same live handle's deadline from that envelope and rearm existing caller
waits. Reuse the canonical deadline reducer; preserve already terminal outcomes. Fallback receives
the admitted envelope and its effective deadline unchanged. It preserves one msgId and one handle,
records each carrier's verdict, and records `attempts-exhausted` after a final `unroutable` verdict.
A queued admission alone is not a transport attempt: evidence gains a second attempt only when the
second carrier actually emits `attempt-started`. Queue wakes key on `admitted` or `duplicate`.

Observation belongs to one bounded browser-session registry alongside the existing shared browser
transport, because persisted queues are scoped by session and carrier. The transport owns paired
synchronous sinks and a fence for each actual middleware epoch, opened before initialization.
Transport shutdown or failed initialization fences the old epoch. Ordinary facade detach retains
all observations: another facade's subsequently active owner can settle the original handle and
waiter. No per-facade registration, fanout, message-routing map, copied settlement history, queue,
timer, persistence scope, or diagnostic relay is added. The registry's listener notification still
isolates individual listener failures. Actual session end/replacement releases live observations
using the canonical client/session identity; stale end cannot clear a newer auth session, stop its
transport, or release its observations. A sender captures both its actual `ApiMiddleware` identity
and epoch: a context replaced before admission releases that handle `unobservable`; an admission
already awaiting an old owner cannot publish through a new epoch. Actual carrier/runtime exceptions
remain failure values.

- [ ] **Step 1: Failing tests.** Rewrite `browser-rallar-message-sender.test.ts`: the four
      input-validation throws stay (`:282`, `:297`, `:312`); `:326` becomes "an oversized payload
      resolves a handle in `rejected` with reason `Payload exceeds…`"; the status-with-message cases
      (`:352`, `:534`) become "resolves a handle whose lifecycle is `submitted` before the stubbed
      admission resolves and `queued` after"; the wake cases key on the verdict; a new case pins that
      `send()` resolves before `enqueueOutboxIfAbsent` resolves (a deferred stub). In
      `browser-message-fallback-identity.test.ts` add: an RTC `unroutable` verdict followed by a WS
      `admitted` verdict leaves one handle `queued`, with a second evidence attempt only after WS emits
      `attempt-started`; RTC
      `unroutable` with `strategy: 'rtc'` resolves `failed` with the reason. In
      `browser-typed-message-channels.test.ts:206` the fallback case reads the handle.
      Command: `npx vitest run packages/tests/shared-web/messages`
      Expected: FAIL on the new expectations.
- [ ] **Step 2: Compose and wire.** Construct the completed shared transport first, then one
      browser-wide `BrowserRallarDeliveryRegistry`, then its `BrowserSessionDeliveries` session owner,
      then facade session and messaging consumers. The canonical shared delivery composition injects
      `Date.now`, retains terminal observations for 60 000 ms, and bounds the browser to 512 entries.
      Cancellation reads the already-completed shared transport directly to reach both
      `rtcRxStreamer.cancelOutbox(msgId)` and `webSocketQueueBox.cancelOutbox(msgId)`; RTC forwards
      through its multicast owner to the same `ALOutboundMessageRuntime.cancel`. No later session or
      facade runtime is forward-captured. A cancel without middleware records `cancelled` locally.
      Hand the same registry through messaging composition, controller, and sender. The shared
      transport opens paired epoch sinks while constructing `MiddlewareInitOptions`, before middleware
      and carrier owners initialize. Pass WS to `createBrowserWebSocketQueueBox` and RTC to
      `initialiseRtcOverlayMulticastManager`, the actual outbound owner. Facade disconnect closes the
      actual shared middleware epoch and preserves the shared registry: another facade can reconnect,
      complete durable work, and settle the original handle and waiter while that facade stays detached.
      There is no facade registration/fanout layer, settlement history, per-message router, or new
      public disposal API. Actual auth end/replacement releases affected live observations using the
      matching client/session identity; stale invalidation cannot release a newer session's handles.
      Test synchronous early settlements, cached two-facade connection, failed initialization, detach,
      late old admissions, sibling reconnect completion and acknowledged evidence surviving its deadline,
      both-carrier cancellation, sibling session end/replacement, and stale session invalidation.
      Preserve shared transport behavior; this does not introduce independent authentication or cache
      scopes per facade or change persisted queue identity/storage operations.
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
      The harness's alternate composition root remains in Task 9's cutover: its session input lacks
      `sessionDeliveries`, and its messaging input lacks `deliveries`, `sessionDeliveries`, and `nowMs`.
      These two named type diagnostics in
      `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts`
      are permitted until Task 9. The earlier third lifecycle registration diagnostic disappears with
      removal of the unnecessary facade observation participant. Task 9 must consume the canonical
      shared `browser-delivery-composition.ts` when wiring the second root, close that root's diagnostic
      `setRecorder` construction seam and workflow callbacks in full, and restore package typechecks.
      Task 6 does not introduce a second registry composition or alter the untouched harness root.

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
  `packages/shared-web/game/authority/rallar-game-authority-message-results.ts`,
  `packages/shared-web/game/authority/rallar-game-authority-client.ts` (WS and RTC assist branches),
  `packages/shared-web/browser/crdt/create-rallar-crdt-message-transport.ts`,
  `packages/shared-web/browser/messages/browser-rallar-message-sender.ts` (reuse the existing TTL),
  `packages/shared/alm/delivery/al-delivery-lifecycle.ts` (canonical admission predicate),
  `apps/rallar-black-box/src/direct-rallar-operations.ts` (`:8`, `:48`, `:721-735`),
  `packages/shared-web/browser/README.md` (`:198-213`), `packages/shared-web/game/README.md` (`:42`)
- Test: `packages/tests/shared-web/director/browser-director-relay-runtime.test.ts`,
  `packages/tests/shared-web/rallar-game-match.test.ts` (`:76-97`, `:1076`),
  `packages/tests/shared-web/calls/browser-call-signal-runtime.test.ts:59`,
  `packages/tests/shared-web/ai/browser-rallar-ai-test-runtime.ts:92-95`,
  `packages/tests/shared-web/rallar-game-authority-client.test.ts`,
  `packages/tests/rallar-black-box/direct-rallar-operations.test.ts:469-472`

The named-input subscription cutover also owns the two live diagnostic controllers under
`apps/rallar-black-box/src/legacy/diagnostics/{quick-test,websocket}`, their action owners, and
`observe-raw-web-socket.ts`. These are active consumers; their directory name does not make their
verified behavior disposable. Tests also cover the built-in CRDT adapter, delayed director/authority
admission, and diagnostic lifecycle preservation. The canonical real-registry fixture is
`packages/tests/shared-web/messages/test-message-delivery.ts`; the existing
`packages/tests/shared-test/rallar-browser-runtime/browser-runtime-facade-test-double.ts` consumes it.

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

- [x] **Step 1: Failing tests.** Rewrite each listed suite's send double to resolve a handle (a
      real-registry `createMessageDelivery(carrier, verdict)` in
      `packages/tests/shared-web/messages/test-message-delivery.ts`, one owner for every suite) and assert the consumer outcomes: relay `sent` on `queued`, WS fallback
      on `failed`, `sent` on `superseded`; match capability `{ status: 'sent', transport: 'ws', ws: handle }`
      on `queued` and `failed` with the reason on `rejected`; authority results the same two branches.
      Command: `npx vitest run packages/tests/shared-web/director packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-authority-client.test.ts packages/tests/shared-web/calls packages/tests/shared-web/ai packages/tests/rallar-black-box/direct-rallar-operations.test.ts`
      Expected: FAIL.
- [x] **Step 2: Cut over** every listed file; delete the three private predicates; update the two
      READMEs' sentences about "QueueBox enqueue results" and the canonical game result.
      Command: the Step 1 command; `npx tsc -p packages/shared-web/tsconfig.json --noEmit`;
      `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
      Expected: green (the `game/mod.ts` snapshot is name-level and unchanged).
      Include `packages/tests/shared-web/crdt`, `packages/tests/shared-web/rallar-crdt.test.ts`,
      `packages/tests/rallar-black-box/diagnostic-controller-lifecycle.test.ts`, and
      `packages/tests/rallar-black-box/websocket-command-center.test.ts` in focused validation.
      Keep the independent custom-provider result policy in `browser-crdt-transport.ts` unchanged.
      Direct operation events contain handle identity and a lifecycle snapshot, while operation
      completion keeps its existing meaning. Subscription start/join failures release the registered
      listener once. Hook extraction tests prove preserved behavior against the base through module
      replacement; they are distinct from the consumer RED/GREEN tests.
- [x] **Step 3: Commit.**

### Task 8: The AR Eye Hunter consumer proof

**Files:**

- Modify: `apps/ar-eye-hunter-v1/src/game/arena-runtime/match/use-arena-director-appointment.ts`
  (`:74-91`) and the diagnostics/state shape it feeds (`toDirectorAttemptState`)
- Test: the app's existing test for that hook under `packages/tests/ar-eye-hunter-v1/**` (find it with
  `rg -l useArenaDirectorAppointment packages/tests`), extended

**Interfaces:** consumes `RallarGameSendResult.ws` as the handle (Task 7).

- [x] **Step 1: Failing test.** The hook records the capability report's delivery as
      `{ state: 'pending' }` when the handle is `submitted`/`queued`, `{ state: 'confirmed' }` on
      `transport-accepted`, and `{ state: 'failed', reason }` on `rejected`/`failed`, driven by
      `handle.onEvent`, and unsubscribes on cleanup.
- [x] **Step 2: Implement.** `reportCapability()`'s result is no longer discarded: its `ws` handle
      feeds a `capabilityDelivery` field on the director attempt state through `onEvent`; the UI that
      renders `directorAttempt` shows it beside the attempt status. Keep delivery observation in the one hook and state shape. The authorized
      closure replan below permits extracting existing UI responsibilities without adding a feature.
      Command: `npx vitest run <the test>`; `npm --workspace ar-eye-hunter-v1 run typecheck` (or the
      workspace's check script named in its `package.json`)
      Expected: PASS.
- [x] **Step 3: Commit.**

**Authorized closure replans and final ownership:**

- The original no-new-component constraint permits extracting the existing App and diagnostics
  responsibilities solely for touched-file standards closure. `src/app.tsx` now composes
  `src/arena-ui/` presentation, operations, diagnostics, presence notices and match results with the
  same visible product surface. The manually imported App filename is kebab-case; `main.tsx`
  contains one Temporal installation. No forwarding alias remains.
- The real browser startup prerequisite is fixed in `BrowserDirectorStatusRuntime`: current-room
  and snapshot reads use `readConfiguredValue` for an unconfigured repository. Explicit room
  identity, configured status and unrelated faults remain intact; failed initial `onStatus` reads
  do not register listeners. `rooms.state()` still intentionally throws before configuration.
- `ArenaDirectorAppointment` owns a complete attempt identity and one observation subscription.
  It reads initial lifecycle, subscribes to direct lifecycle events without replay, and guards the
  current attempt, match, room and generation after report, before appointment, after awaited work,
  and inside state updaters. Appointment completion preserves delivery evidence; delivery updates
  preserve appointment fields. Replacement, abort and unmount unsubscribe without cancelling work.
- Removed the mixed `arena-connection-helpers.ts` module and its wrapper error conversion. HTTP
  probing and pure pose normalization live with their existing owners; match input/intent consumers
  use canonical `accept` names. Recursive closure covers their auth, transport, message and AI
  consumers. Clocks are supplied at existing composition boundaries, with timestamps captured
  before state projection. No new lifecycle registry, reducer, polling or library was introduced.
- `apps/ar-eye-hunter-v1/README.md` is the durable entry-to-result navigation map for the arena
  runtime families. This remains one Task 8 change: the UI extraction and startup fix are necessary
  to make the authorized consumer proof reviewable, and the support edits close those same paths.

**Task 8 evidence:** genuine startup, handle and visible diagnostics RED runs are followed by
focused GREEN runs. The app suite includes stale-report and same-generation frozen-time
replacement, stale delivery callbacks, abort/unmount cleanup, independent appointment/delivery
updates and clipboard cleanup. The real-service browser test logs in, creates an arena, observes the
existing appointment HTTP response, then verifies visible completion and manual capability delivery
with JSON readback. It keeps the existing 45-second test and 8-second assertion budgets. The
response synchronization replaces an unsupported assumption that the asynchronous initial
appointment always finishes within eight seconds; no product latency contract was changed.

The final acceptance configuration has a desktop Chromium project for the authenticated delivery
workflow and preserves all three original mobile projects and their mobile-control assertions.
Exploratory delivery runs on high-DPI mobile profiles exposed unresolved end-to-end timing limits,
including full-test timeouts with and without continuous tracing; these are recorded rather than
claimed fixed by desktop coverage. This authorized acceptance split matches Task 8's distinct
requirements: actual authenticated delivery observation and preservation of the existing mobile
control surface. All 45-second test, 8-second expectation and existing lane budgets remain intact.

Task 8 validation completed: focused app/shared-web/Playwright-config Vitest170/19; shared and
shared-web native typechecks plus the app typecheck pass; both game builds pass with existing
large-chunk warnings; browser public entrypoint/snapshot and bundle-budget checks pass. The
configured browser acceptance run passes4 tests with3 existing orientation skips; the final
headed desktop delivery proof passes1/1. Its headless desktop run took43.6s within45s, so timing
margin remains a disclosed limitation. Repo-governance checks pass428/27. The test compiler's
remaining8 errors are exclusively the5 known Task9 harness/test paths permitted by the coupled
Tasks6–9 cutover; no Task8 error remains. Task9 and final S1 conformance remain incomplete.

Clipboard closure was recreated after a failing regression in its current extracted owner; the
fresh implementation passes the96-test app suite and a real browser clipboard copy/reopen proof.
The existing test-boundary registry removes two obsolete auto-election call-count entries and
classifies the narrow diagnostics polling, clipboard payload and stale-report appointment fences.
No unrelated registry contract or production legacy approval was changed.

**Task 8 review correction:** Accepted hit/pickup event-to-snapshot continuations
retain and revalidate the owning match, room and network generation. The only
verified raw fallback, accepted shots without a fresh director, carries mandatory
full `roomRef` directly on its app payload and uses scoped room realtime sends.
Its receive subscription belongs to the existing match lifetime, validates the
current full scope, and guards deferred shot projection. Raw and canonical
accepted shots share one projection owner. Unused raw listeners/output branches
and ineffective raw hit/pickup/match-start sends are removed; working local and
remote intent acceptance converges on the canonical match receiver. The stale
diagnostic-read count and its unsupported registry classification are removed,
while observable stale-state assertions remain.

This is the authorized bounded app repair. The independent, untouched generic
game envelope still uses bare `roomId`; this correction neither changes its public
wire contract nor claims general canonical scope isolation. Existing desktop
browser acceptance and mobile timing limitations remain unchanged.

The second review correction carries the same captured lifetime through deferred
start/end, event, accepted hit/pickup/eye and motion publications. The existing
state acceptance owner centralizes snapshot/ref/derived-event projection, captures
the injected clock before deferred work, and retains the match/room/lifetime
across match-start event egress. Its required runtime/intent callers also guard
queued snapshots. Real mounted-owner tests control publication ordering; these
are callback-lifetime proofs, not browser scheduling reproductions. No new
lifecycle framework or shared wire contract is introduced.

Consumer tests follow the three actual owners: authentication/room lifecycle,
director delivery/appointment, and game realtime acceptance/egress. Their shared
external network fixture and mounted-hook lifecycle live in one test harness;
domain-only intent/shot fixtures remain beside their realtime suite. This closes
the oversized auth test's navigation boundary without duplicating setup or
removing assertions. Existing coupling metadata follows the moved semantic tests.

### Task 9: The black-box ledger becomes a projection

The alternate browser composition uses the canonical browser delivery composition and its one
session registry. Its connection lifetime and completed diagnostics ports are explicit owners;
settlements stay in-page. Command dispatch uses `dispatchAlmBrowserCommand` and the browser
adapter's actual HTTP, WebSocket, RTC stream, event and command-input owners. The old adapter,
runtime and schema files cannot retain oversized or duplicated ownership as a cutover shortcut.
The existing `packages/shared-test/architecture.md` is the navigation map for the resulting owners.

The maintainer approved strict recipe v1 during this slice: every recipe requires
`schemaVersion: 1`, including nested and inline recipes. Schema, control-message validation and
local execution reject missing or unsupported versions. Repository producers, examples and
fixtures emit the canonical form; no saved/external recipe conversion or compatibility adapter
is introduced. Remove the old recipe compatibility result, warnings and catalog status. Quick
Test export keeps requirements in recipe metadata and provider selection in `config.control`.
This public accepted-input/result change is limited to the approved recipe-format decision.

That validation cutover brings the recipe runtime and control protocol into full-file closure.
The runtime owns result caching, state and cleanup; per-command loop/parallel owners own scheduling
and collected evidence, with explicit clocks and cancellation ports. Control command validation
uses canonical schema field definitions; envelope parsing retains its public wire contracts.
The unused exported `ControlServerEnvelope` rename-only alias is removed; the verified
`ControlCommandEnvelope` name and wire shape remain. Every necessary support edit enters the
same recursive standards closure, including recipe builders and their tests.

The owner-name closure replaces the three repository source-module basenames with
`create-rallar-black-box-test-runtime.ts`, `rallar-black-box-test-contracts.ts`, and
`create-rallar-black-box-browser-test-runtime.ts`. These modules belong to the private source
package; its intentional `mod.ts` entry preserves the canonical exports and callable behavior.
Update the verified source consumers directly, without forwarding aliases. Every causally changed
consumer enters the same closure, including the distributed monitor, control service, browser
validation clients, SPA composition and their tests. The existing source navigation map follows the
actual owner paths. New structural tests must prove behavior and boundaries rather than old paths.

Task 9's `control-service.ts` closure removes its type re-export block, which brings
`control-artifact-recorder.ts` into the same closure and exposed a separate, approved
artifact-directory cutover: `safePathSegment` (`encodeURIComponent` with `%` rewritten to `_`)
collided distinct run IDs (`"%"` and `"_25"`; `"/"` and `"_2F"`) into one on-disk `runs/` directory
and let `"."`/`".."` escape the run root, so `record`, `response`, and retention-driven `deleteRun`
could mix or destroy unrelated run evidence. The maintainer approved `toRunDirectoryName`: iterate
the run ID by UTF-16 code unit, emit `[a-z0-9-]` literally, and escape every other code unit as `_`
plus four lowercase hex digits, giving an injective codec whose output stays inside `[a-z0-9_-]`.
There is no migration, old-directory fallback, or `runId` added to stored rows; existing `runs/`
directories for IDs containing an uppercase letter, `_`, `.`, or an escaped character become
unreachable by path (the bounded in-memory snapshot still serves those runs), while lowercase
`[a-z0-9-]` IDs keep their existing directory name.

The SPA recipe producers expose explicit v1 at history, matrix, negative and quick copy actions.
Manual draft synchronization, recipe preview, and action effects have distinct owners. Browser
clipboard availability and permission failures are values from one app I/O boundary; each controller
owns its lifetime fencing and UI publication. Recipe JSON schemas use finite recursive definitions
and references so serialization preserves nested validation through control and OpenAPI consumers.

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
- Produces: `BlackBoxRallarDeliveryObservation { handleId; state: ALDeliveryState; submitted: boolean; confirmedHopPeerIds; unconfirmedHopPeerIds; attempts: number; reason: string | undefined; backpressured: boolean; enqueued: boolean; }`
  (the two peer lists renamed per D9 across the contract, the adapter decoder, the recipe result type,
  the schema capability prose, the corpus, and the doc; `attempts = lifecycle.evidence.attempts.length`;
  `submitted = attempts.some((attempt) => attempt.submissionAttempted)`;
  `backpressured = attempts.some((attempt) => attempt.unroutableReason is 'rate-limited' or 'circuit-open')`,
  `enqueued = lifecycle.evidence.admittedDurable === true`);
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

The recipe-side send vocabulary becomes a projection of the same evidence rather than a second
account of it: a `messages.rtc` send and an `rtc.stream` frame report `queued` from the lifecycle
state, `enqueued` from `admittedDurable`, and `backpressured` from an `unroutableReason` of
`rate-limited` or `circuit-open` — never from `no-route`, which is an absent peer, not a full one.
`failOnBackpressure` and `maxBackpressureCount` keep the semantics they have on main and become
observable for the first time, because the page runtime's own status could only say `sent` or
`no-peers`.

- [ ] **Step 1: Failing tests.** Move the ledger cases to the dedicated browser-runtime delivery
      suite and exercise the actual session registry and production sender. Prove send → observe
      `queued` → cancel `cancelled` → receipts with hop lists; observe timeout message unchanged; the
      unknown handle reads `unobservable`; the storage counters during an observe over a `pending`
      admission stay flat (no poll). Capture the canonical command deadline once, use the earlier
      timeout/absolute deadline with a 5,000 ms default and clamp elapsed time to zero; TTL remains
      a message policy, not the admission wait budget. Update the adapter suite's `DELIVERY_OBSERVATION` fixture to the new
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

Closure found during Task 11 (2026-09-21): the Playwright live-RTC evidence helper
`tests/playwright/rallar-black-box/live-rtc-control-client.ts` and its summaries in
`live-rtc-performance-evidence.ts` still parsed the pre-S1 serialized send result
(`message.status`, `message.entries`, `message.message.id.msgId`) after this task made the
`messages.rtc` send diagnostics a `BlackBoxRallarDeliveryObservation`; every live run recorded
`missing`/`false` and the NACK probe threw at `message-identity`. The summaries now project the
observation (`state`, `submitted`, `enqueued`, `backpressured`, `attempts`, hop counts, raw
settlement `reason`, `messageIdPresent` from `handleId`); the retired classifiers and the coupled
fixtures were removed in the same commits. Raw evidence stays opaque JSON to `shared-rtc-bench`,
so no persisted artifact format changed.

### Task 10: The S1 conformance scenarios

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts`
  (`:20-29`, `:61-63`, `:131-160`, the builders), `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts`,
  `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json` (regenerated by
  `apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`)
- Test: `packages/tests/shared-test/alm-conformance-recipe-validation.test.ts:22-26`,
  `packages/tests/shared-test/alm-conformance-recipes.test.ts:139-176`,
  `packages/tests/shared-test/alm-conformance-deadline-expiry.test.ts`,
  `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts:1017-1021`

**Interfaces:** no new command kind, registry, journal, persisted row, or public send option.
The foundation adds the WS-only `fault.inject` action `not-ready` to retain actual AL work before
native submission; existing WS drop/delay and RTC drop semantics remain unchanged. The scripted
owner implements a separate WS submission-readiness capability using its existing fault map and
observations. The sparse diagnostics construction input opts into that capability and normalizes
absence to pass-through. The independent shared default queue-service factory likewise accepts sparse
construction input and supplies pass-through; normalized dependencies and the browser downstream
inputs require the capability. The browser path normalizes once. Existing frame-fault implementations
remain valid.

The existing scripted fault lifetime also accepts `remaining: 'until-cleared'`. The same fault map
owns it without decrement; numeric counts retain their existing behavior. The existing same-ID
numeric-zero replacement, clear, or document destruction releases the hold. Lifecycle specimens
explicitly release on success, and the existing runtime failure/cancel/reset/close cleanup clears the
owner. This expresses a causal native-write hold without a retry-count assumption or a new timeout.

Local pairs and hosted completion use one pure ALM assessment to join actual generated message IDs
from full command results with exact received envelopes. Ordinary state/payload assertions remain
recipe-owned. Local roots obey normal finite retention and missing evidence fails closed; pending
hosted distributed ownership protects roots through retention and snapshot/restore, then releases
them after assessment. No new evidence registry or consumption protocol is introduced.

The hosted combined recipe uses one RTC-ready connection per role with the existing topic-only
`messageSelector` for `room.alm-conformance`. The canonical typed subscription owner honors this
selector on both actual WS and RTC message ports, preserving raw message IDs. Explicit send carrier
selection remains authoritative. Repeated per-scenario connects are removed only from the combined
composition, preventing subscription replacement while the other role completes absence windows.
Standalone scenario setup, room/auth identity, and all existing budgets remain unchanged.

The existing `ALQosInputProvider` travels through explicit browser session construction into both
carrier owners. Only the black-box root supplies the pure conformance policy; ordinary facade
construction supplies no provider. The policy selects latest-wins only for a room-targeted outbound
payload with `marker: 'delivery-lifecycle'` and `specimen: 'supersedence'`. Its key includes the
sender, application, workspace, room, and message type. Ordinary payloads retain default policy.

Observation matches current or terminal state, never historical state. External recipes use the
canonical admitted/progress state sets and explicitly assert the actual terminal result. Controlled
owned-boundary tests establish intermediate transitions; command success alone is not terminal proof.

- `delivery-lifecycle` (`smoke`, all three carriers): send with `ack: 'receiver'`, observe admitted
  progress, then assert RTC `acknowledged` with non-empty `confirmedHopPeerIds`, or WS
  `transport-accepted` with submitted evidence and empty receipt lists (D11: WS has no receipt in
  S1). Cancellation and deadline specimens also request receiver ack so WS transport acceptance
  does not terminate observation. Cancel retained work and assert `cancelled`; separately distinguish
  cancellation after submission from retraction. Hold the old supersedence specimen with WS
  not-ready or RTC drop, admit the marked replacement, assert old `superseded`, release the fault,
  and prove only the replacement reaches the receiver. Extend `deadline-expiry` to assert sender
  `expired` after the existing receiver-absence window and actual TTL.
- `delivery-reload` (`full`, all three carriers): establish original durable pending work and receiver
  absence before reload. An external coordinator must issue the existing top-level `agent.reload`
  between recipe segments, prove page identity changed, preserve session/storage identity, reconnect,
  assert the old handle `unobservable`, and receive the original message without another business
  send. Nested `agent.reload` in `recipe.run` does not establish this proof. Real top-level reload
  orchestration for both local pair execution and the hosted combined recipe remains the next
  bounded dependency; the foundation does not implement or complete it. The coordinator is now in
  the lane. The full family on `7bf4842c` passed reload on all three carriers.

Budgets: retain the existing `CONFORMANCE_DEADLINE_MS` evidence windows, per-command timeouts,
18-second deadline evidence window, 2.5-second post-expiry absence proof, and carrier harness limits.
These are not a total scenario wall-time cap: cold connection/readiness has its own existing budget.
Smoke gains only lifecycle; full gains lifecycle and reload. Record measured durations in Task 12.

Foundation validation exercises the real normalizer, admission store, worker, lifecycle projection,
and native transport ports. Full touched-file standards closure applies recursively. Subsequent
scenario/orchestration integration retains the following acceptance steps:

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

- Delete: `packages/shared/alm/delivery/to-al-outbound-enqueue-status.ts` (moved there from the outbound directory in Task 3's fix round, ruling R7)
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

- [x] **Step 1: Failing tests.** Re-type the listed suites onto verdicts; add a case per exhaustive
      switch that a `deferred` verdict is retryable for signaling and `queued-outbox` for the router.
      Command: the listed suites.
      Expected: FAIL until Step 2.
- [x] **Step 2: Delete the union** and every derivation; re-type the two switches and the three
      consumers; update the diagnostic-contract doc's admission shape.
      Command: `npx tsc -p packages/shared/tsconfig.json --noEmit`; `npx tsc -p packages/shared-server/tsconfig.json --noEmit`;
      `npx tsc -p packages/shared-web/tsconfig.json --noEmit`; `cd apps/api-v1 && deno task check` and
      the same in `apps/rallar-black-box-control-server` and `apps/relic-hunter-server-v1`
      (`RallarServerWsPublishResult` reaches `relic-game-service.ts` through `shared-server/mod.ts`);
      `npm run test:deno`; `rg -n "ALOutboundEnqueueStatus|pending-admission" packages apps --glob '!**/node_modules/**'`
      returns only the admission-store internals that name the retained-conflict row (the `pending`
      verdict's storage), never a public or consumer surface.
      Expected: green, grep as stated.
- [x] **Step 3: Commit.**

Closure found during Task 11 (2026-09-21): `readDequeuedAdmissionOutcome` short-circuited only
`expired`, `superseded`, and `skipped`. The deleted status converter also mapped `deferred` and
`refused`/`unauthorized` onto that skipped bucket, which completed the row without calling
`afterDequeueAdmission`. Those two verdicts fell through and published. The server WS queue is the
only caller that publishes from that callback; the browser RTC overlay and the client queue pass
`undefined`. `isDiscardedDequeuedAdmission` restores the skip, and
`al-outbound-dequeue-work.test.ts` pins that a `not-yet-in-sync`, `unauthorized`, or `planner-drop`
dequeue completes the row and does not publish it.

### Task 12: Measurement, budgets, docs, final gates, and the PR

**Files:** `packages/shared/alm/outbound/README.md` (`:153-176` settlement section, `:223-226`),
`docs/rallar-api-reference.md` (`:629-667`), `.agents/skills/building-rallar-apps/references/app-scaffolding.md`
(`:173-210`, whose `RallarMessageSendStatus` import never existed), `examples/room-message-channel/README.md`
(`:28`, `:39`), `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` (Task 0's pin),
`packages/tests/shared/alm/al-storage-snapshot.test.ts`, the two bundle files if a budget moved.

- [x] **Step 1: The zero-new-operation proof.** Re-run Task 0's pin unchanged; re-run
      `al-storage-snapshot.test.ts` and record the standard-workload snapshot is byte-identical to
      `main`'s. Command: `npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts packages/tests/shared/alm/al-storage-snapshot.test.ts`
      Re-run on `3e3fa2dc` (2026-09-21): 13 tests passed. One default send still spends 10
      `al-admission` and 15 `al-work` operations. The expected byte constants are unchanged from
      `main`. Measured outbound bytes were 1,813,462 / 69,763 / 1,743,586 / 101,572 (total 3,728,383
      against pin 3,728,380) and inbound 61,510 / 1,764,355 (total 1,825,865 against pin 1,825,867),
      inside the test's identity-digit band. `AL_ADMISSION_SCHEMA_ID` is unchanged from `main`.
- [x] **Step 2: Docs.** The outbound README's settlement section says what the owner emits and
      where; `:223-226` no longer calls the handle roadmap work; the API reference's sample consumes the
      handle (`await roomChat.send(...)` then `wait`), the skill example's broken import is replaced by the
      handle, the example README follows. `npm run test:repo-governance` after the skill edit.
      Re-run on `99901400`: `npm run test:repo-governance -- --testTimeout=120000` passed, 27 files and
      428 tests. The default 5s timeout is too short for the git-fixture files in this environment.
- [x] **Step 3: Bundle figures.** `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`;
      `npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`. A
      crossed ceiling is raised to the next whole KiB with the measured figure in both files and the PR
      body.
      Re-run on `3e3fa2dc`: the headless boundary test passed under the 270 KiB ceiling. `browser/rallar.ts`
      brotli was 211.9 KiB against a 212.0 KiB budget, and the shared-web budget check passed.
- [ ] **Step 4: The full local list on the final tree.** `npm run test:unit`; `npm run typecheck`;
      the three Deno checks; `npm run test:deno`; `npx dprint check`;
      `npm run check:repo-style:changed -- origin/main HEAD`; `node scripts/check-tests-typecheck.mjs`;
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`; `npm run build`;
      `npm run test:ci`; `npm run test:rallar:full-stack:memory:alm`. Report which passed, failed, or
      were skipped, and why.
      Partial on `efd94bbb`, so this step stays open. Passed: `npm run typecheck`; `node scripts/check-tests-typecheck.mjs`;
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`; the three `deno task check`
      commands; `npm run test:deno` (api-v1 561, control server 174, relic 5 passed / 12 steps, shared-test RTC 146,
      0 failed). `npm run check:repo-style:changed -- origin/main HEAD` passed on `3e3fa2dc`; later commits are plan
      text. `npx dprint check` fails only on untouched `scripts/hetzner/controller/15-logs.sh`, which is not in the
      pull request diff. `npm run test:unit -- --testTimeout=120000` was 11,920 passed, 12 skipped, and 1 failed:
      `distributed-recipe-workflow.test.ts` could not spawn `ruby`. After Ruby 3.2 was installed, that test passed.
      `npm run build` exited 0. `npm run test:e2e` exited 0: 199 passed, 12 skipped, 6.3 minutes.
      `npm run test:full-stack:memory` exited 0: 7 passed in 24.7s. The four `test:ci` legs therefore passed
      separately; `npm run test:ci` was not re-issued as one process. The full three-carrier ALM lane
      (`RALLAR_BLACK_BOX_ALM_SCOPE=full`) exited 1: 0 passed, 3 failed, all normal. WS 12.33 ms/op over 19
      commits failed `delivery-lifecycle` at `receive-replacement` (wait timeout) and `delivery-reload`.
      RTC 27.56 ms/op over 17 commits and fallback 22 ms/op over 9 commits failed `delivery-reload`.
      `ordering-resync` did not fail. A later WS-only full run, after the sender waits for the replacement
      to be submitted before the recipe ends, passed `delivery-lifecycle` (`observe-transport-accepted-4`
      1045 ms, `receive-replacement` 63 ms) and failed only `delivery-reload`. Reload acceptance stays the
      open Task 10 item, so this step stays open.
      No budget or assertion was changed.
      Reload-only re-run after the original states an explicit survival TTL (absence window plus 60s;
      77s at the 18s deadline). The send command timeout stays 10s. The browser's omitted TTL is 30s,
      and the previous WS artifact showed the fresh runtime's next attempt landing after that, so the
      row expired unsent. `RALLAR_BLACK_BOX_ALM_SCOPE=full` with every other scenario skipped passed
      all three carriers: WS `receive-original` 8301 ms, RTC 17888 ms, fallback 20621 ms. The full
      family was not re-run as one process, so this step stays open.
      Full family on `0c66f5d9` exited 1: 0 passed, 3 failed, all normal. Reload passed on every
      carrier. WS 15.11 ms/op over 17 commits failed `delivery-lifecycle`: `observe-transport-accepted-4`
      aborted at 3255 ms and the sender runtime closed while the replacement was still retrying, so
      `receive-replacement` waited out 27069 ms. RTC 18.22 ms/op over 9 commits and fallback 7.89 ms/op
      over 7 commits passed lifecycle and reload, then failed `ordering-resync` at sender connect:
      the restored reconnect stores `username: ''`, and the next connect reads that blank as a
      different identity. Carrier acceptance now uses the 10s non-expiring send budget, and a blank
      restored username is the live session.
      Full family on `f6a07c5e` exited 1: 1 passed, 2 failed, 9.5 minutes, all normal. RTC passed
      (16.67 ms/op over 6 commits), including lifecycle, reload, and ordering-resync. WS failed again
      at `observe-transport-accepted-4` after the full 10111 ms. The release command stored
      `remaining: 0` and reported injected, then one outbound row rescheduled about every 100 ms
      until the sender closed. The 10s budget did not reach `transport-accepted`. Fallback connect
      succeeded, and `ordering-resync` then failed its absence proof: 3
      `alm.conformance.rtc-with-ws-fallback.ordering-resync` messages observed against count 2.
      The WS retry reason was not in the observation.
      Full family on `7bf4842c` exited 0: 3 passed in 9.2 minutes. WS was 6.17 ms/op over 18 commits,
      RTC 15.11 ms/op over 9 commits, and fallback 30.33 ms/op over 9 commits. Lifecycle, reload, and
      ordering-resync passed on every carrier that runs them. The replacement had stayed not-ready
      because a heartbeat that only extended session leases was stored as a duplicate, so the joined
      room snapshot expired at its 60-second memory TTL and later sends did not refresh it. Those
      lease advances now replace the stored snapshot. A separate WS-only full run on the same commit
      also exited 0 (2.5 minutes, 11.89 ms/op over 17 commits). The rest of this step's local list
      was not re-run on this commit, so the step stays open. No budget or assertion was changed.
      Local list on `56e51bf9`, after the lease fix, the observe-id narrowing, and the regenerated
      two-agent Hetzner catalog. Passed: `npm run typecheck`; `npm run build`; the three `deno task check`
      commands; `npm run test:deno` (api-v1 561, control server 174, relic 5 passed / 12 steps, shared-test
      RTC 146, 0 failed); `npm run test:e2e` (199 passed in 6.4 minutes); `npm run test:full-stack:memory`
      (7 passed in 24.4 seconds); `npm run check:repo-style:changed -- origin/main HEAD`;
      `node scripts/check-tests-typecheck.mjs`; `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`
      (exit 0, advisory candidates only). `npx dprint check` still fails only on untouched
      `scripts/hetzner/controller/15-logs.sh`, which is not in the pull request diff.
      `npm run test:ci` as one process exited 1 in the unit leg: 11,869 passed, 12 skipped, 55 failed.
      Fifty-four were `Test timed out in 5000ms` in git-fixture files. One was real: the checked-in
      `18-alm-conformance-2-agent.json` lagged the generator. After regenerating that file, those 14
      files passed with `--testTimeout=120000` (237 tests). The three-carrier ALM lane result above
      is from `7bf4842c`; later commits are the type narrowing, the manifest, and this note.
      This step stays open because `test:ci` was not one green process at the default timeout and
      `dprint check` still names the untouched shell script. No budget or assertion was changed.
- [x] **Step 5: Postgres lanes.** `npm run db:test:up`, then `npm run test:integration:postgres`
      (the settlement sink over the PostgreSQL backend) and, because the server WS router's publish
      result changed, `npm run test:api-v1:black-box:postgres:medium-scale`. Never weaken their
      constants or assertions.
      Docker was not available here. PostgreSQL 16.15 was installed locally with the compose
      credentials (`app`/`app`/`appdb` on localhost:5432), and `db:migrate` applied all 24 migrations.
      `npm run test:optional:postgres` then passed: 21 files / 69 tests, plus presence expiry 10 tests.
      Medium-scale passed: `api-v1-state-medium-scale-churn` exit 0, 2757 success, 0 failure, 193126 ms.
      No constant or assertion was changed.
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
