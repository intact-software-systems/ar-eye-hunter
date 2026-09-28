# ALM S3b Fallback Within the Deadline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** written under §9's recommended answers Q1–Q12
([alm-s3-design-proposal.md](../playground/alm/alm-s3-design-proposal.md) "S3b execution questions and
decisions"), all of which the maintainer took on 2026-09-27 (commit `c07e786b8`: D56 "As applied",
D63–D66; draft PR #604). The plan's own choices C1–C9 below are ruled as R-S3b-0 in "Rulings during
execution" (all accepted, C7 recorded as the Q12 deviation).

**Goal:** Every receipt end of a browser send settles, and an `rtc-with-ws-fallback` message whose
admitted RTC leg hits a declared retryable outcome is handed to WS once, inside its unchanged
deadline, with the hand-over visible on the handle and in the conformance lane.

**Architecture:** One list of declared retryable outcomes and the `not-ready` bound live in
`packages/shared/alm/delivery/`. The outbound owner states two new facts — a terminal
`receipt-exhausted` (its row deleted in the same commit) and an evidence-only
`not-yet-in-sync-exhausted` — and gains a settlement-free `handOver(msgId)`. The browser dispatch
registers every admitted RTC leg of an `rtc-with-ws-fallback` send as a fallback candidate with the
delivery registry, whose `record` consults one `BrowserMessageFallbackController`: on a retryable fact
it records a `carrier-fallback` evidence row, hands the RTC work over and lets the dispatch admit the
same envelope on WS with `canFallback: false`. The reducer ignores receipt facts of the carrier a
handle left. The harness projects each attempt's carrier, and three scenarios prove the path on the
fallback cell.

**Tech Stack:** TypeScript across Node, Deno and browser; Vitest; Playwright; dprint; the Hetzner
manifest generator.

**Spec:** [playground/alm/alm-s3-design-proposal.md](../playground/alm/alm-s3-design-proposal.md) §1.2,
§2.2, §3, §4 (decision 5 = D56, and D52–D55 it builds on), §7, §8, §9;
[playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md) (D2, D3, D8, D15,
D17, D20, D42, D43, D51, D56, D57, "Admission outcomes", "Deadline", the S3 bullet, matrix rows F1, F4);
the S3a plan's "Carried to S3b / S3c" and R-S3a-4; decisions D63–D66 (the S3b rulings). S3b starts
from `main` `461b54cfe` (S3a, #597) plus the questions commit `ed176b797` and the decisions commit
`c07e786b8`. The code survey behind §9 is the session scratchpad
`s3b-code-survey.md`; every line number below was re-read on `ed176b797`.

## Global Constraints

The S3a constraints apply unchanged (D8 search-first, no legacy, touched-file closure, canonical verbs,
values not exceptions, required fields, the size tiers, the non-blocking lane, the push-time gate list,
maintainer-reviewed landing), with S3b's values:

- **No migration.** Reset-on-mismatch is the only lever (D3, D17). `AL_ADMISSION_SCHEMA_ID` stays
  `'rallar-alm-2026-09-s2c-ii'` (`packages/shared/alm/open-indexed-db-admission-database.ts:16`): under
  Q6, Q7 and Q9's recommended answers S3b persists no new field — `receipt-exhausted` deletes the
  pending-ACK row instead of marking it, the WS hop receipt waits for S3c, and no fallback candidate is
  persisted. **Bump rule:** a task that adds a field to any persisted shape (captured policy with its
  `ackTracking`, pending-ACK snapshot, sent snapshot, control or retry rows) bumps the id to
  `'rallar-alm-2026-10-s3b'` in the same commit and names the PostgreSQL rows in flight at deploy in the
  PR body (the server's admission rows share the strict decoders and have no schema reset).
- **No new third-party dependency** (D8).
- **No new timer, queue or registry beyond the dispatch's candidate table.** The fallback candidates
  live in one `Map` inside `BrowserMessageFallbackController`, owned by the delivery registry, released
  when the handle's lifecycle ends or the fallback fires once. The hand-over reuses the send controls'
  existing set pattern; nothing schedules anything.
- **Harness budgets fixed:** `CONNECT_READINESS_TIMEOUT_MS` 30 000, `CONFORMANCE_DEADLINE_MS`
  (`ALM_CONFORMANCE_DEADLINE_MS`) 18 000, `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500,
  regimes 30/35 ms. A scenario may derive a local budget from them (Task 5's
  `RECEIPT_EXHAUSTION_OBSERVE_MS`), never change one.
- **Bundle ceilings:** facade `browser/rallar.ts` 222 KiB (recorded 221.8 at `e417fe749`), headless 284
  KiB (recorded 283.62 at `e417fe749`), raised only by the next-whole-KiB rule (maintainer ruling
  2026-09-05) with the measured figure recorded in the test comment, the measure script and the task
  commit. A crossed ceiling is raised in the task that crosses it — Tasks 1 and 2 included — by the Task
  3 Step 8 rule with that run's figure, never deferred to a later commit (R-S3b-2); Task 3 re-measures.
- **`rallar.realtime` untouched** (D15). `ALDeliverySettlement` grows additively (`receipt-exhausted`,
  `not-yet-in-sync-exhausted`, `carrier-fallback`); `ALDeliveryEvidence` gains one field.
- **D53, D57, D58, D59 are S3c's.** No unicast fallback, no WS unicast receipt, no `server` target, no
  server settlement sink, no capacity verdict in S3b. `validateRoomFallbackInput` keeps refusing
  non-room fallback targets.
- **The server keeps its behaviour except where the shared owner changed.** `ALOutboundRepairAdmission`
  runs in the WS server's PostgreSQL-backed owner too: after Task 1 a server receipt that runs out of
  retries deletes its pending-ACK row at exhaustion instead of keeping it to the message expiry, and
  states `receipt-exhausted` into the server's `undefined` sink (nothing observes it until S3c). No
  `packages/shared/services/ws-queue-box-server/**` file changes, but that delete is a new PostgreSQL
  mutation through the shared owner, so the medium-scale gate runs once after Task 1 (R-S3b-15).
- Files at cognitive-load warn or review that S3b touches take call lines only; new behaviour goes into
  new files beside them: `qrtc-data-channel.ts` (121, untouched), `web-rtc-overlay-multicast-manager.ts`
  (86), `ws-queue-box-server-service.ts` (82, untouched), `ws-queue-box-client-service.ts` (50,
  untouched), `web-rtc-rx-streamer-service.ts` (49). `packages/shared/alm/outbound` already holds 21 direct
  files: new outbound files go under `control/`. `packages/shared-test/rallar-bb-test/conformance/alm`
  holds exactly 20 direct `.ts` files and `layout.directory-density` fires above 20: Task 5 adds no file
  there (R-S3b-3).
- **Per-task validation** (every task, before its commit; a task names the extra gates it needs):
  - the focused Vitest files the task names (`npx vitest run <files>`), then `npm run test:unit`
    (both Vitest roots) before the push;
  - `npm run typecheck` (includes `npm run typecheck:tests` = `node scripts/check-tests-typecheck.mjs`);
  - `npm run check:repo-style:changed -- origin/main HEAD`;
  - `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`;
  - `npx dprint check <every touched file>` (never a glob — `npx dprint fmt <files>` only on the touched
    files);
  - `cd apps/api-v1 && deno task check`, `cd apps/rallar-black-box-control-server && deno task check`
    and `npm run test:deno` whenever `packages/shared`, `packages/shared-server` or
    `packages/shared-test` changed;
  - for any `packages/shared-web` or `packages/shared` change reaching the browser:
    `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
    and `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`;
  - the smoke lane `RALLAR_BLACK_BOX_ALM_SCOPE=smoke npm run -s test:rallar:full-stack:memory:alm`
    (loopback ports: run unsandboxed; verify the summary line, not the exit code);
  - `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check` whenever a
    conformance recipe changes, and `npx vitest run packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts`;
  - `npm run test:repo-governance` when docs under `docs/`, `examples/` or `.agents/` change;
  - the medium-scale PostgreSQL gate `npm run test:api-v1:black-box:postgres:medium-scale` (unsandboxed,
    the Postgres container `ar-eye-hunter-postgres` up) runs ONCE after Task 1, because Task 1 makes the
    shared repair owner delete the WS server's pending-ACK row at exhaustion; its summary line goes into
    Task 1's commit body and the PR body (R-S3b-15). Otherwise Q11's file trigger stands: it reruns only
    if a `packages/shared/services/ws-queue-box-server/**` file changes; none is planned, and Task 6
    records the empty `git diff --name-only origin/main...HEAD -- packages/shared/services/ws-queue-box-server`.
- Every task ends with a commit, pushed to `claude/alm-s3b-fallback-within-deadline` (never `main`).
- Acceptance follows D51: the local full lanes on normal pages plus the both-normal hosted smoke; the
  hosted full read is attempted at most twice and reported, never a blocker.
- PRs land through the maintainer's review: no `pr:delivery -- ready`, no auto-merge.

## Pre-execution rulings

Each question in one line with the answer this plan is written under — §9's recommendation, which the
maintainer took on 2026-09-27 (the decision it became is in brackets). The controller records R-S3b-0
before Task 1: these twelve as settled, and its ruling on C1–C9.

1. **Q1** — post-admission fallback for `rtc-with-ws-fallback` only (RTC → WS); `ws-then-rtc` keeps
   admission-time fallback alone [D65].
2. **Q2** — the dispatch registers a candidate (the RTC admission's returned envelope, the middleware
   context, the epoch) and one hook on the registry's `record` consults it; released at the lifecycle's
   end or when the fallback fires once [D56 as applied].
3. **Q3** — a settlement-free `handOver(msgId)` on the outbound runtime and send controls (abort the live
   attempt, complete later effects silently, delete the RTC pending-ACK row); the reducer ignores the left
   carrier's acknowledgements; WS re-admission with `canFallback: false`, same msgId and `expiresAtMs`;
   a `carrier-fallback` evidence row `{ from: 'rtc', to: 'ws', reason }` [D66].
4. **Q4** — consecutive `not-ready` counted per message in the registry hook across its send-prepared
   rows, reset by `sent` or an acknowledgement; `AL_FALLBACK_NOT_READY_ATTEMPTS = 3` [D65].
5. **Q5** — `unroutable/rate-limited` joins the admission-time fallback verdicts [D65].
6. **Q6** — `receipt-exhausted` is terminal, carries confirmed/unconfirmed peers, and deletes the
   pending-ACK row in the same commit; no persisted marker, no schema bump [D63].
7. **Q7** — the WS `hop`/`subtree` receipt is deferred to S3c behind D57; S3b keeps R-S3a-4's downgrade
   evidence [D66].
8. **Q8** — the WS server's narrowing of its current room to the frozen set is accepted and recorded on
   D56 as applied [D66].
9. **Q9** — no fallback for a durable RTC message resumed after a reload; stated as a limitation [D64].
10. **Q10** — the five existing fallback cells keep their expectations; only their evidence moves, named
    in the PR body; re-read in Task 5 [§9].
11. **Q11** — the medium-scale gate runs only if a `ws-queue-box-server/**` file changes (none planned) [§9];
    R-S3b-15 adds one run after Task 1 for the shared owner's new server-side delete.
12. **Q12** — no new RTC fault kind; `messages.observe` gains `attemptCarriers`; three scenarios on the
    two-agent `rtc-with-ws-fallback` cell; manifest 18 regenerated [§9].

### Choices this plan makes inside those answers

Each is recorded with the pre-execution rulings; the cost says what a reviewer gives up by accepting it.

- **C1 — `receipt-exhausted` reads `failed`.** Q6 makes it terminal without naming the state. `failed`
  is the state `attempts-exhausted` already ends in, needs no new public `ALDeliveryState`, and the
  evidence keeps who confirmed (the roadmap's "exhausted retries never erase confirmed progress"). Cost:
  `failed` covers two kinds of exhaustion; `evidence.reason` tells them apart.
- **C2 — the six non-settling receipt ends (survey §1.5) are closed as follows.** (1) budget exhaustion
  → `receipt-exhausted` (Task 1); (2) completion at a re-plan dispatch → the acknowledgement that
  completed it (Task 1); (3) orphaned-receipt cleanup → no code: its message is gone because its
  deadline passed, so the read-time deadline already reads `expired`; (4) a terminal NACK
  (`expired`/`unauthorized`/`stale`) → the incomplete acknowledgement it already states, then
  `receipt-exhausted` (Task 1) — beyond D64's list (exhaustion, completion at a re-plan dispatch, the
  timeout of 0), accepted by R-S3b-0; (5) the WS server's `timed-out` receipt → no code: its deadline is
  `min(message expiry, now + 30 min)` (`WS_QUEUE_BOX_SERVER_RECEIPT_WINDOW_MS` = `DEFAULT_AL_EPHEMERAL_TTL_MS`),
  so it arrives at the browser message's own deadline, which the read-time deadline already settles
  `expired`; (6) a `qos.ack` timeout of 0 or an empty non-`receiver` expected set → the admission reports
  `trackedReceiptAlgo: 'none'` (Task 1). Cost: ends 3 and 5 settle as `expired`, not `failed`.
- **C3 — the left carrier's receipt facts are ignored, not only its acknowledgements** (D66 names
  acknowledgements). After a
  `carrier-fallback` evidence row, an `acknowledgement`, `receipt-exhausted` or `relay-rejected` of the
  carrier the handle left moves nothing: each speaks for the leg that no longer owns the receipt.
  Attempt rows still land as evidence. Cost: a late RTC `resync-required` refusal after a hand-over is
  invisible on the handle.
- **C4 — `not-yet-in-sync-exhausted` is its own evidence-free settlement.** It is a fallback trigger; on a
  plain `rtc` send the receipt budget still ends the message, so the reducer returns the lifecycle
  unchanged. Cost: one settlement kind with no reducer effect.
- **C5 — the controller is owned by the registry and the candidate carries the dispatch's re-admission.**
  The registry constructs one `BrowserMessageFallbackController` beside its entries (as the outbound
  runtime owns its `ALOutboundSendControls`), so no composition root or test construction of the
  registry changes; the dispatch registers each candidate through `registry.watchFallback(...)` with a
  `readmit` continuation over its own `writeLeg`, so the dispatch stays the one place that admits.
- **C6 — a hand-over's row delete tolerates a conflict.** The hand-over already makes every later effect of
  the message complete silently, so an undeleted RTC row is inert until its TTL; its late ACKs are
  ignored by C3. Cost: an inert row in the volatile pair until the message expiry.
- **C7 — `no-fallback-after-deadline` uses the RTC receipt budget, not a short TTL (Q12 deviation).** A
  TTL that ends before the third `not-ready` would have to be under ~100 ms (three 50 ms resubmissions),
  shorter than admission itself. The scenario instead holds the receiver's RTC ACK with the 7 500 ms
  `EXPIRY_TTL_MS`, which ends before the ≈8 000 ms RTC receipt budget (2 000 ms timeout × 4 windows); the
  final `ack-timeout` expires with the message, no `receipt-exhausted` is ever stated, and no WS copy
  arrives. The controller's own deadline guard is pinned by Task 3's unit test.
- **C8 — `ALDeliveryCarrierFallback` and `ALDeliveryFallbackReason` are re-exported** from `rallar.ts`,
  `rallar-core.ts` and `rallar-messages.ts`, beside `ALDeliveryRelayRejection`, because they type a field
  of the public `ALDeliveryEvidence`. Cost: two public type names.
- **C9 — `fallback-within-deadline` runs in the smoke scope**; `receipt-exhausted-fallback` (≈9 s) and
  `no-fallback-after-deadline` (≈8 s) run in the full scope.

### Carried into S3b

- **The `hop`-mode completion-at-dispatch that deletes a row without a settlement** (S2c-ii carry, S3a
  "Carried to S3b"): closed by Task 1 for `hop` and `receiver` alike (RTC `replace` retries run under
  both, `web-rtc-overlay-missing-recipient-repair.ts:191-193`).
- **R-S3a-4's typed rejection letter** ("the roadmap's 'typed rejection' letter is deferred to S3b
  where every receipt end settles"): Task 1's `receipt-exhausted` and C2.
- **D56** in full, with Q5's admission-time `rate-limited` (Task 2).

### Carried to S3c / later

- **The WS `hop`/`subtree` receipt** (R-S3a-4, Q7): behind D57's learned server id; S3b keeps the
  downgrade evidence.
- **Post-admission fallback for `ws-then-rtc`** (Q1) and for a resumed durable message (Q9).
- **Unicast fallback, the WS unicast receipt, the `server` target, the server settlement sink** (D53,
  D57, D58): a server-side `receipt-exhausted` is stated into `undefined` until S3c.
- **Leavers read unconfirmed on the WS leg** (Q8's alternative): the WS server narrows its current room
  to the frozen set.
- Not carried by S3b (proposal §8): heartbeat frames reaching admission — noted because they add noise to
  any fallback diagnosis in the observation artifact.

---

## File structure

**Receipt ends (Task 1):**

- Create `packages/shared/alm/outbound/control/to-al-outbound-receipt-exhausted-fact.ts` — the
  `receipt-exhausted` fact from a receipt row.
- Create `packages/shared/alm/outbound/control/to-al-outbound-dispatch-completion-receipt.ts` — the
  acknowledgement a re-plan states when it completes and deletes a row.
- Modify `packages/shared/alm/delivery/al-delivery-lifecycle.ts:79-165` (two settlement kinds),
  `packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts:16-56` (their transitions),
  `packages/shared/alm/outbound/al-outbound-repair-admission.ts:36-49,147-237,294-320`,
  `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts:456-475`,
  `packages/shared/alm/outbound/transition-al-outbound-pending-ack.ts:41-76`,
  `packages/shared/alm/outbound/compute-al-outbound-dispatch.ts:98-100,123-129,322-341,359-366`,
  `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts:345-347`,
  `packages/shared/alm/outbound/compute-al-outbound-control-admission.ts:107-128`,
  `packages/shared/alm/outbound/control/al-outbound-control-admission.ts:136-141`.

**Retryable outcomes and the hand-over (Task 2):**

- Create `packages/shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts` — the declared lists,
  `AL_FALLBACK_NOT_READY_ATTEMPTS`, the admission-time predicate and the post-admission trigger.
- Modify `al-delivery-lifecycle.ts` (`carrier-fallback`, `ALDeliveryCarrierFallback`,
  `ALDeliveryFallbackReason`, `carrierFallback` evidence), `compute-al-delivery-lifecycle.ts` (the
  evidence row and the left-carrier rule), `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts:169-179,203-212`,
  `packages/shared/alm/outbound/lane/al-outbound-send-controls.ts:3-39`,
  `al-outbound-store-lane.ts:165-167,264-270,303-306`, `al-outbound-repair-admission.ts` (`endReceipt`),
  `packages/shared/alm/outbound/al-outbound-message-runtime.ts:32,347,405-421`,
  `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts:212-214`,
  `packages/shared/services/web-rtc-rx-streamer-service.ts:444-446`.
- Modify `packages/shared/alm/inbound/admission/compute-al-inbound-duplicate-changes.ts:1-80` and
  `packages/shared/alm/inbound/README.md:198` — a duplicate on the other carrier than its first
  admission, with no relay row, is acknowledged again over its arrival carrier (R-S3b-1).

**The fallback controller (Task 3):**

- Create `packages/shared-web/browser/messages/browser-message-fallback-controller.ts`.
- Modify `packages/shared-web/browser/messages/browser-rallar-delivery-registry.ts:67-121,176-185`,
  `browser-rallar-message-dispatch.ts:60-121`, `packages/shared-web/browser/rallar.ts:273-280`,
  `packages/shared-web/browser/rallar-core.ts:118-125`, `packages/shared-web/browser/rallar-messages.ts:35-42`,
  `packages/tests/shared-web/api-middleware-test-double.ts:165-190`, the public API snapshot, the
  bundle ceilings (`packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts:39-56`,
  `packages/shared-web/scripts/measure-browser-bundles.mjs:30-45`,
  `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts:61-77`).

**Harness evidence (Task 4):** `attemptCarriers` through the page projection, the operation contract,
the result value, the decoder, the capability prose and every observation fixture.

**Scenarios (Task 5):** three scenario files, the hand-over assertions beside `toResultAssertion` (no new
file in `conformance/alm`, R-S3b-3), one fault builder for the held and the dropped faults, the shared
fallback-cell constant, the registries, the pinned lists, the manifest description and manifest 18.

**Docs (Task 6):** the two ALM READMEs, the product description, the roadmap, the harness schema doc.

---

### Task 1: Every receipt end settles

**Files:**

- Create: `packages/shared/alm/outbound/control/to-al-outbound-receipt-exhausted-fact.ts`,
  `packages/shared/alm/outbound/control/to-al-outbound-dispatch-completion-receipt.ts`
- Modify: as "Receipt ends" above.
- Test: create `packages/tests/shared/alm/delivery/al-delivery-receipt-ends.test.ts`,
  `packages/tests/shared/alm/outbound/al-outbound-receipt-exhaustion.test.ts`,
  `packages/tests/shared/alm/outbound/to-al-outbound-dispatch-completion-receipt.test.ts`,
  `packages/tests/shared/alm/outbound/al-outbound-tracked-receipt-algo.test.ts`; modify
  `packages/tests/shared/alm/al-outbound-control-admission.test.ts` (two cases),
  `packages/tests/shared/alm/al-outbound-message-expiry.test.ts:224-236` (the new dependency).

**Interfaces:**

- Produces on `ALDeliverySettlement`:
  - `{ kind: 'receipt-exhausted'; msgId: string; carrier: ALDeliveryCarrier; atMs: number; mode: ALReceiptMode; confirmedPeerIds: readonly string[]; unconfirmedPeerIds: readonly string[]; detail: string; }` — terminal, reduced to `failed`.
  - `{ kind: 'not-yet-in-sync-exhausted'; msgId: string; carrier: ALDeliveryCarrier; atMs: number; detail: string; }` — reduced to an unchanged copy.
- Produces `toALOutboundReceiptExhaustedFact(receipt: Pick<ALOutboundPendingAckSnapshot, 'msgId' | 'mode' | 'expectedPeerIds' | 'ackedPeerIds'>, detail: string): ALOutboundSettlementFact`.
- Produces `type ALOutboundDispatchCompletionRead<TPrepared> = Pick<ALOutboundMessageReadDto<TPrepared>, 'msg' | 'plan' | 'pendingAck' | 'acks' | 'nowMs'>`
  and `toALOutboundDispatchCompletionReceipt<TPrepared>(read: ALOutboundDispatchCompletionRead<TPrepared>): ALOutboundSettlementFact | undefined`.
- Produces in `transition-al-outbound-pending-ack.ts`: `isALOutboundAckTrackingWritable(tracking: ALOutboundAckTrackingPlan): boolean`
  and `toALOutboundTrackedReceipt(input: TrackALOutboundPendingAckSnapshotInput): ALOutboundPendingAckSnapshot`.
- Produces `ALOutboundRepairAdmission.Dependencies.settlements: ALOutboundSettlementEmitter` (required) and
  `ALOutboundCommitSettlementsInput.read: ALOutboundDispatchCompletionRead<TPrepared>` in place of `plan`.
- Renames `toALOutboundControlSettlement` → `toALOutboundControlSettlements(candidate): readonly ALOutboundSettlementFact[]`.
- Task 2 consumes both settlement kinds in `resolveALDeliveryFallbackTrigger`; Task 3's controller replaces
  a `receipt-exhausted` of a watched RTC leg by its `carrier-fallback`.

- [ ] **Step 1: RED — the reducer.** Create `packages/tests/shared/alm/delivery/al-delivery-receipt-ends.test.ts`:

```ts
import type { ALReceiptMode } from '@shared/al-contracts/al-policy.ts';
import {
    createInitialALDeliveryLifecycle,
    isALDeliveryTerminal,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALDeliveryLifecycle } from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

const MSG_ID = 'msg-1';
const AT_MS = 2_000;
const EXHAUSTED_DETAIL = 'The receipt ran out of retries after 3 of 3.';

function createAdmittedLifecycle(): ALDeliveryLifecycle {
    const opened = createInitialALDeliveryLifecycle({
        msgId: MSG_ID,
        typeId: 'room.command.v1',
        ackMode: 'receiver',
        receiptAlgo: 'receiver',
        expiresAtMs: 30_000,
        submittedAtMs: 1_000
    });
    return computeALDeliveryLifecycle(opened, {
        kind: 'admission',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
        trackedReceiptAlgo: 'receiver'
    });
}

function toReceiptExhausted(
    mode: ALReceiptMode,
    confirmedPeerIds: readonly string[],
    unconfirmedPeerIds: readonly string[]
): Extract<ALDeliverySettlement, Readonly<{ kind: 'receipt-exhausted'; }>> {
    return {
        kind: 'receipt-exhausted',
        msgId: MSG_ID,
        carrier: 'rtc',
        atMs: AT_MS,
        mode,
        confirmedPeerIds,
        unconfirmedPeerIds,
        detail: EXHAUSTED_DETAIL
    };
}

describe('receipt ends (D56, R-S3a-4)', () => {
    it('ends a receiver receipt that ran out of retries failed, keeping who confirmed and who did not', () => {
        const next = computeALDeliveryLifecycle(
            createAdmittedLifecycle(),
            toReceiptExhausted('receiver', ['b'], ['c'])
        );

        expect(next.state).toBe('failed');
        expect(isALDeliveryTerminal(next)).toBe(true);
        expect(next.evidence).toMatchObject({
            reason: EXHAUSTED_DETAIL,
            receiptMode: 'receiver',
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: ['c'],
            // Under `receiver` the row names recipients; the hop view stays what the last receipt stated.
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: []
        });
    });

    it('states the peer lists of a hop receipt as its hop lists too', () => {
        const next = computeALDeliveryLifecycle(
            createAdmittedLifecycle(),
            toReceiptExhausted('hop', ['relay-1'], ['relay-2'])
        );

        expect(next.evidence).toMatchObject({
            receiptMode: 'hop',
            confirmedHopPeerIds: ['relay-1'],
            unconfirmedHopPeerIds: ['relay-2'],
            expectedRecipientPeerIds: ['relay-1', 'relay-2'],
            confirmedRecipientPeerIds: ['relay-1'],
            unconfirmedRecipientPeerIds: ['relay-2']
        });
    });

    it('never reopens an acknowledged handle with a late exhaustion', () => {
        const acknowledged = computeALDeliveryLifecycle(createAdmittedLifecycle(), {
            kind: 'acknowledgement',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: AT_MS,
            mode: 'receiver',
            confirmedHopPeerIds: ['b'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['b'],
            confirmedRecipientPeerIds: ['b'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });

        const late = computeALDeliveryLifecycle(
            acknowledged,
            toReceiptExhausted('receiver', [], ['b'])
        );

        expect(late).toMatchObject({ state: 'acknowledged', lateSettlementCount: 1 });
        expect(late.evidence.confirmedRecipientPeerIds).toEqual(['b']);
    });

    it('records a not-yet-in-sync exhaustion as a fact that ends nothing on its own', () => {
        const admitted = createAdmittedLifecycle();

        const next = computeALDeliveryLifecycle(admitted, {
            kind: 'not-yet-in-sync-exhausted',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: AT_MS,
            detail: 'The not-yet-in-sync retry budget of 3 ran out.'
        });

        expect(next).toEqual(admitted);
        expect(next).not.toBe(admitted);
    });
});
```

- [ ] **Step 2: RED — the budget exhaustion.** Create `packages/tests/shared/alm/outbound/al-outbound-receipt-exhaustion.test.ts`:

```ts
import { createTestALOutboundWorkPort } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import type { ALOutboundSettlementFact } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundRepairAdmission } from '@shared/alm/outbound/al-outbound-repair-admission.ts';
import { RetryableConflictError } from '@shared/resilience/TryWith.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

interface ExhaustionFixture {
    readonly stores: OutboundTestStores;
    readonly message: ALMessage;
    readonly repair: ALOutboundRepairAdmission<OutboundTestPayload>;
    readonly facts: ALOutboundSettlementFact[];
}

type ReceiptRow = Omit<ALOutboundPendingAckSnapshot, 'msgId'>;

/** A `hop` receipt on two next hops, one confirmed, whose current window already closed. */
const SPENT_RECEIPT: ReceiptRow = {
    mode: 'hop',
    expectedPeerIds: ['peer-1', 'peer-2'],
    ackedPeerIds: ['peer-1'],
    timeoutMs: 2_000,
    maxAttempts: 3,
    attempts: 3,
    deadlineAtMs: 900
};

async function createExhaustionFixture(receipt: ReceiptRow): Promise<ExhaustionFixture> {
    const stores = createDefaultOutboundTestStores();
    const message = createOutboundMessage('receipt-exhaustion');
    const bundle = await computeOutboundTestAdmission(stores.admissionStore, message);
    await stores.admissionStore.commitBundle({
        ...bundle,
        mutations: [...bundle.mutations, {
            kind: 'set-pending-ack',
            originPeerId: message.id.senderId,
            snapshot: { msgId: message.id.msgId, ...receipt },
            expireAtTimestamp: message.constraints!.expiresAtMs!
        }]
    });
    const facts: ALOutboundSettlementFact[] = [];
    const clock = { nowMs: Date.now };
    const repair = new ALOutboundRepairAdmission({
        admissionStore: stores.admissionStore,
        controlAdmission: stores.admissionStore.createControlAdmission({
            port: createTestALOutboundWorkPort({ ...stores, nowMs: Date.now }),
            clock,
            settlements: (fact) => facts.push(fact),
            carrier: 'rtc'
        }),
        clock,
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: []
        }),
        planRepairMessage: undefined,
        diagnostics: undefined,
        settlements: (fact) => facts.push(fact)
    });
    return { stores, message, repair, facts };
}

async function readReceipt(
    fixture: ExhaustionFixture
): Promise<ALOutboundPendingAckSnapshot | undefined> {
    return await fixture.stores.admissionStore.readPendingAck({
        originPeerId: fixture.message.id.senderId,
        msgId: fixture.message.id.msgId
    });
}

describe('the receipt budget runs out (Q6)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('states receipt-exhausted once and deletes the row in the commit that states it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const fixture = await createExhaustionFixture(SPENT_RECEIPT);

        await fixture.repair.retryPendingAck(fixture.message.id.msgId);
        await fixture.repair.retryPendingAck(fixture.message.id.msgId);

        expect(fixture.facts).toEqual([{
            kind: 'receipt-exhausted',
            msgId: fixture.message.id.msgId,
            mode: 'hop',
            confirmedPeerIds: ['peer-1'],
            unconfirmedPeerIds: ['peer-2'],
            detail: 'The receipt ran out of retries after 3 of 3.'
        }]);
        expect(await readReceipt(fixture)).toBeUndefined();
    });

    it('states nothing and keeps the row when the exhaustion commit conflicts, so the retried work settles it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const fixture = await createExhaustionFixture(SPENT_RECEIPT);
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');

        await expect(fixture.repair.retryPendingAck(fixture.message.id.msgId)).rejects
            .toBeInstanceOf(RetryableConflictError);

        expect(fixture.facts).toEqual([]);
        expect(await readReceipt(fixture)).toBeDefined();
    });

    it('ends a receipt without retries at its first closed window', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const fixture = await createExhaustionFixture({
            ...SPENT_RECEIPT,
            maxAttempts: 0,
            attempts: 0
        });

        await fixture.repair.retryPendingAck(fixture.message.id.msgId);

        expect(fixture.facts.map((fact) => fact.kind)).toEqual(['receipt-exhausted']);
    });

    it('keeps retrying inside the budget and states nothing', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const fixture = await createExhaustionFixture({ ...SPENT_RECEIPT, attempts: 1 });

        await fixture.repair.retryPendingAck(fixture.message.id.msgId);

        expect(fixture.facts).toEqual([]);
        expect((await readReceipt(fixture))?.attempts).toBe(2);
    });
});
```

- [ ] **Step 3: RED — the not-yet-in-sync budget and the terminal NACK.** In
      `packages/tests/shared/alm/al-outbound-control-admission.test.ts`, add `onTestFinished` to the
      `vitest` import, add the imports

```ts
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { ALOutboundControlAdmission } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
```

    and append inside `describe('outbound control admission identity', …)`:

```ts
it('states the not-yet-in-sync exhaustion when its retry budget is spent (D56)', async () => {
    const { admissionStore, workQueue } = createFixture();
    await seedDirectObligation(admissionStore, {
        enabled: true,
        maxAttempts: 2,
        retryDelayMs: 5_000
    });
    const settlements: ALDeliverySettlement[] = [];
    const runtime = createOutboundTestRuntimeFor<ALOutboundTransportMessage>({
        stores: { admissionStore, workQueue },
        carrier: 'rtc',
        settlements: (settlement) => settlements.push(settlement),
        decodePreparedMessage: decodeALOutboundTransportMessage,
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: []
        }),
        sendPreparedMessage: async () => ({ status: 'sent' as const, submissionAttempted: true })
    });
    await runtime.ready();
    const exhausted = vi.spyOn(ALOutboundControlAdmission.prototype, 'scheduleNotYetInSyncRetry')
        .mockResolvedValue({ status: 'exhausted' });
    onTestFinished(() => exhausted.mockRestore());

    expect(await runtime.acceptControlMessage(notYetInSyncNack(), 'peer')).toEqual({
        kind: 'committed'
    });

    expect(settlements.filter((settlement) => settlement.kind === 'not-yet-in-sync-exhausted'))
        .toEqual([{
            kind: 'not-yet-in-sync-exhausted',
            msgId: 'message',
            carrier: 'rtc',
            atMs: expect.any(Number),
            detail: 'The not-yet-in-sync retry budget of 2 ran out.'
        }]);
});

it('ends a receipt a hop refused for good: its acknowledgement, then receipt-exhausted', async () => {
    const facts: ALOutboundSettlementFact[] = [];
    const { admissionStore, control } = createFixture(facts);
    await seedDirectObligation(admissionStore);
    const stale = newALNackControlMessage(
        { v: 2, msgId: 'control-stale', senderId: 'receiver', ts: 1 },
        {
            fromPeerId: 'receiver',
            toPeerId: 'sender',
            msgId: 'message',
            reason: 'stale',
            observedAtEpochMs: 1
        }
    );

    expect(await control.admit(stale, 'peer')).toEqual({ kind: 'committed' });

    expect(await admissionStore.readPendingAck({ originPeerId: 'sender', msgId: 'message' }))
        .toBeUndefined();
    expect(facts.map((fact) => fact.kind)).toEqual(['acknowledgement', 'receipt-exhausted']);
    expect(facts[1]).toEqual({
        kind: 'receipt-exhausted',
        msgId: 'message',
        mode: 'hop',
        confirmedPeerIds: [],
        unconfirmedPeerIds: ['receiver'],
        detail: 'Hop receiver refused the message: stale.'
    });
});
```

- [ ] **Step 4: RED — completion at dispatch and the tracked receipt.** Create
      `packages/tests/shared/alm/outbound/to-al-outbound-dispatch-completion-receipt.test.ts`:

```ts
import type { ALAckPayload } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundCommitSettlements } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import {
    toALOutboundDispatchCompletionReceipt,
    type ALOutboundDispatchCompletionRead
} from '@shared/alm/outbound/control/to-al-outbound-dispatch-completion-receipt.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import { createOutboundMessage } from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

const MESSAGE = createOutboundMessage('completion-at-dispatch');
const MSG_ID = MESSAGE.id.msgId;

/** A `hop` row on two next hops; `peer-2` has since left, so the retry's plan replaces the set with `peer-1`. */
const HOP_ROW: ALOutboundPendingAckSnapshot = {
    msgId: MSG_ID,
    mode: 'hop',
    expectedPeerIds: ['peer-1', 'peer-2'],
    ackedPeerIds: ['peer-1'],
    timeoutMs: 2_000,
    maxAttempts: 3,
    attempts: 1,
    deadlineAtMs: 5_000
};
const HOP_REPLACING: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 2_000,
    maxAttempts: 3,
    expectedPeerIds: ['peer-1'],
    expectedPeerIdsUpdate: 'replace',
    nextHopPeerIds: ['peer-1'],
    mode: 'hop'
};

function toRead(
    ackTracking: ALOutboundAckTrackingPlan,
    pendingAck: ALOutboundPendingAckSnapshot | undefined,
    acks: readonly ALAckPayload[] = []
): ALOutboundDispatchCompletionRead<OutboundTestPayload> {
    return {
        msg: MESSAGE,
        plan: {
            msg: MESSAGE,
            dropReasonCode: undefined,
            persist: false,
            preparedMessages: [],
            ackTracking
        },
        pendingAck,
        acks,
        nowMs: 3_000
    };
}

describe('the receipt a re-plan completes at dispatch (S2c-ii carry)', () => {
    it('states the acknowledgement that completed a hop row the re-plan deletes', () => {
        expect(toALOutboundDispatchCompletionReceipt(toRead(HOP_REPLACING, HOP_ROW))).toEqual({
            kind: 'acknowledgement',
            msgId: MSG_ID,
            mode: 'hop',
            confirmedHopPeerIds: ['peer-1'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['peer-1'],
            confirmedRecipientPeerIds: ['peer-1'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });

    it('states it under receiver too, where the re-plan replaced the logical audience', () => {
        const receiverRow: ALOutboundPendingAckSnapshot = {
            ...HOP_ROW,
            mode: 'receiver',
            expectedPeerIds: ['b', 'c'],
            ackedPeerIds: ['b']
        };
        const replacing: ALOutboundAckTrackingPlan = {
            ...HOP_REPLACING,
            mode: 'receiver',
            expectedPeerIds: ['b'],
            nextHopPeerIds: ['relay-1']
        };

        expect(toALOutboundDispatchCompletionReceipt(toRead(replacing, receiverRow))).toMatchObject(
            {
                mode: 'receiver',
                confirmedRecipientPeerIds: ['b'],
                unconfirmedRecipientPeerIds: [],
                confirmedHopPeerIds: [],
                unconfirmedHopPeerIds: ['relay-1'],
                complete: true
            }
        );
    });

    it('states nothing when no row existed or the re-planned row is still incomplete', () => {
        expect(toALOutboundDispatchCompletionReceipt(toRead(HOP_REPLACING, undefined)))
            .toBeUndefined();
        expect(
            toALOutboundDispatchCompletionReceipt(
                toRead({ ...HOP_REPLACING, expectedPeerIds: ['peer-1', 'peer-2'] }, HOP_ROW)
            )
        ).toBeUndefined();
    });

    it('is stated by the commit of the repair dispatch that deletes the row', () => {
        const facts = toALOutboundCommitSettlements({
            bundle: {
                senderId: MESSAGE.id.senderId,
                expectedVersion: 1,
                mutations: [
                    {
                        kind: 'delete-pending-ack',
                        originPeerId: MESSAGE.id.senderId,
                        msgId: MSG_ID
                    },
                    { kind: 'delete-repair-attempt', msgId: MSG_ID }
                ],
                durableEffects: []
            },
            msg: MESSAGE,
            read: toRead(HOP_REPLACING, HOP_ROW),
            intent: 'repair'
        });

        expect(facts).toEqual([
            expect.objectContaining({ kind: 'acknowledgement', msgId: MSG_ID, complete: true })
        ]);
    });

    it('is not stated by a commit that leaves the row, even when the plan completes it', () => {
        const facts = toALOutboundCommitSettlements({
            bundle: {
                senderId: MESSAGE.id.senderId,
                expectedVersion: 1,
                mutations: [{ kind: 'delete-repair-attempt', msgId: MSG_ID }],
                durableEffects: []
            },
            msg: MESSAGE,
            read: toRead(HOP_REPLACING, HOP_ROW),
            intent: 'repair'
        });

        expect(facts).toEqual([]);
    });
});
```

    and create `packages/tests/shared/alm/outbound/al-outbound-tracked-receipt-algo.test.ts`:

```ts
import type { ALAckAlgo } from '@shared/al-contracts/al-policy.ts';
import type { ALOutboundAckTrackingPlan } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { computeALOutboundDispatch } from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import {
    createDefaultOutboundTestStores,
    createOutboundCanonicalEntry,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';

const HOP: ALOutboundAckTrackingPlan = {
    enabled: true,
    timeoutMs: 2_000,
    maxAttempts: 3,
    expectedPeerIds: ['peer-1'],
    nextHopPeerIds: ['peer-1'],
    mode: 'hop'
};

async function computeTrackedReceiptAlgo(
    ackTracking: ALOutboundAckTrackingPlan
): Promise<ALAckAlgo> {
    const { admissionStore } = createDefaultOutboundTestStores();
    const message = createOutboundMessage('tracked-receipt-algo');
    const read = await admissionStore.readOutgoingMessage({
        msg: message,
        planner: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: false,
            preparedMessages: [{ message: 'frame' }],
            ackTracking
        }),
        observedCanonicalEntry: undefined,
        intent: 'enqueue'
    });
    return computeALOutboundDispatch({
        read,
        outboxEntry: createOutboundCanonicalEntry(admissionStore, read.msg),
        dispatchAtMs: Date.now(),
        intent: 'enqueue',
        phase: 'immediate',
        options: {}
    }).trackedReceiptAlgo;
}

describe('the receipt an admission reports it tracks (every receipt end settles)', () => {
    it('reports the mode of a receipt its commit writes a row for', async () => {
        expect(await computeTrackedReceiptAlgo(HOP)).toBe('hop');
    });

    it.each([
        ['a qos.ack timeout of 0', { ...HOP, timeoutMs: 0 }],
        ['a hop receipt that expects nobody', { ...HOP, expectedPeerIds: [], nextHopPeerIds: [] }],
        ['a receiver receipt with named recipients and a timeout of 0', {
            ...HOP,
            mode: 'receiver' as const,
            timeoutMs: 0
        }]
    ])('reports none for %s, which no row tracks', async (_label, tracking) => {
        expect(await computeTrackedReceiptAlgo(tracking)).toBe('none');
    });

    it('keeps receiver for an empty expected set: the WS server receipt or the empty frozen audience settles it', async () => {
        expect(
            await computeTrackedReceiptAlgo({
                ...HOP,
                mode: 'receiver',
                expectedPeerIds: [],
                nextHopPeerIds: []
            })
        )
            .toBe('receiver');
    });
});
```

- [ ] **Step 5: Run the RED tests.**

Run: `npx vitest run packages/tests/shared/alm/delivery/al-delivery-receipt-ends.test.ts packages/tests/shared/alm/outbound/al-outbound-receipt-exhaustion.test.ts packages/tests/shared/alm/outbound/to-al-outbound-dispatch-completion-receipt.test.ts packages/tests/shared/alm/outbound/al-outbound-tracked-receipt-algo.test.ts packages/tests/shared/alm/al-outbound-control-admission.test.ts`
Expected: FAIL — `to-al-outbound-dispatch-completion-receipt.ts` does not resolve; the reducer returns
`undefined` for the two new kinds; the exhaustion cases see no fact and a kept row; the NYIS and stale-NACK
cases see no new fact; the tracked-receipt cases read `hop`/`receiver` where `none` is expected.

- [ ] **Step 6: Implement the settlement kinds and their transitions.** In
      `packages/shared/alm/delivery/al-delivery-lifecycle.ts`, insert after the `acknowledgement` variant
      of `ALDeliverySettlement` (after `:139`):

```ts
/**
 * A receipt ended before every expected peer confirmed: its retry budget ran out, or a hop refused the
 * message for good. Terminal. The peer lists are the receipt row's own -- next hops under `hop` and
 * `subtree`, logical recipients under `receiver` -- so the confirmed progress stays in evidence.
 */
| Readonly<{
    kind: 'receipt-exhausted';
    msgId: string;
    carrier: ALDeliveryCarrier;
    atMs: number;
    mode: ALReceiptMode;
    confirmedPeerIds: readonly string[];
    unconfirmedPeerIds: readonly string[];
    detail: string;
}>
/** The `not-yet-in-sync` retry budget ran out: a fallback trigger (D56); the receipt budget still ends the message. */
| Readonly<{
    kind: 'not-yet-in-sync-exhausted';
    msgId: string;
    carrier: ALDeliveryCarrier;
    atMs: number;
    detail: string;
}>
```

    In `packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts` add beside the other extracts
    (after `:20`):

```ts
type ALDeliveryReceiptExhaustedSettlement = Extract<
    ALDeliverySettlement,
    Readonly<{ kind: 'receipt-exhausted'; }>
>;
```

    add two cases to the `switch` of `computeALDeliveryLifecycle`, before `case 'attempts-exhausted':`:

```ts
case 'receipt-exhausted':
    return toReceiptExhaustedLifecycle(previous, settlement);
case 'not-yet-in-sync-exhausted':
    return { ...previous };
```

    and add after `toRelayRejectedLifecycle`:

```ts
/** The receipt ended unconfirmed: terminal `failed`, and the peers it did confirm stay in evidence. */
function toReceiptExhaustedLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryReceiptExhaustedSettlement
): ALDeliveryLifecycle {
    const failed = toReasonedLifecycle(previous, 'failed', settlement.detail);
    const hopReceipt = settlement.mode !== 'receiver';
    return {
        ...failed,
        evidence: {
            ...failed.evidence,
            receiptMode: settlement.mode,
            confirmedHopPeerIds: hopReceipt
                ? [...settlement.confirmedPeerIds]
                : failed.evidence.confirmedHopPeerIds,
            unconfirmedHopPeerIds: hopReceipt
                ? [...settlement.unconfirmedPeerIds]
                : failed.evidence.unconfirmedHopPeerIds,
            expectedRecipientPeerIds: [
                ...settlement.confirmedPeerIds,
                ...settlement.unconfirmedPeerIds
            ],
            confirmedRecipientPeerIds: [...settlement.confirmedPeerIds],
            unconfirmedRecipientPeerIds: [...settlement.unconfirmedPeerIds]
        }
    };
}
```

    A late `receipt-exhausted` on a terminal lifecycle falls through `toTerminalLifecycle`'s last line
    and only counts (`:110`), which Step 1's third case pins.

- [ ] **Step 7: Implement the receipt helpers.** In
      `packages/shared/alm/outbound/transition-al-outbound-pending-ack.ts` replace
      `trackALOutboundPendingAckSnapshot` (`:41-76`) with:

```ts
/** Whether a dispatch writes a receipt row for this tracking: somebody to expect, and a window to wait in. */
export function isALOutboundAckTrackingWritable(tracking: ALOutboundAckTrackingPlan): boolean {
    return tracking.enabled && tracking.expectedPeerIds.length > 0 && tracking.timeoutMs > 0;
}

/** The receipt row a dispatch's tracking leaves, complete or not. */
export function toALOutboundTrackedReceipt(
    input: TrackALOutboundPendingAckSnapshotInput
): ALOutboundPendingAckSnapshot {
    const { mode } = input.tracking;
    const replace = input.tracking.expectedPeerIdsUpdate === 'replace';
    const expectedPeerIds = new Set(replace ? [] : input.current?.expectedPeerIds);
    const ackedPeerIds = new Set(replace ? [] : input.current?.ackedPeerIds);
    for (const peerId of input.tracking.expectedPeerIds) {
        expectedPeerIds.add(peerId);
    }
    for (const ack of input.acks) {
        const peerId = toALOutboundAckedPeerId(mode, ack);
        if (peerId !== undefined && (expectedPeerIds.size === 0 || expectedPeerIds.has(peerId))) {
            ackedPeerIds.add(peerId);
        }
    }
    if (replace && input.current) {
        for (const peerId of input.current.ackedPeerIds) {
            if (expectedPeerIds.has(peerId)) {
                ackedPeerIds.add(peerId);
            }
        }
    }
    return {
        msgId: input.msgId,
        mode,
        expectedPeerIds: [...expectedPeerIds],
        ackedPeerIds: [...ackedPeerIds],
        timeoutMs: input.tracking.timeoutMs,
        maxAttempts: input.tracking.maxAttempts,
        attempts: input.current?.attempts ?? 0,
        deadlineAtMs: input.nowMs + input.tracking.timeoutMs
    };
}

export function trackALOutboundPendingAckSnapshot(
    input: TrackALOutboundPendingAckSnapshotInput
): ALOutboundPendingAckSnapshot | undefined {
    const pending = toALOutboundTrackedReceipt(input);
    return isALOutboundReceiptComplete(pending) ? undefined : pending;
}
```

    Create `packages/shared/alm/outbound/control/to-al-outbound-receipt-exhausted-fact.ts`:

```ts
import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';

/** A receipt that ended unconfirmed, in its row's own peer terms: next hops, or logical recipients under `receiver`. */
export function toALOutboundReceiptExhaustedFact(
    receipt: Pick<
        ALOutboundPendingAckSnapshot,
        'msgId' | 'mode' | 'expectedPeerIds' | 'ackedPeerIds'
    >,
    detail: string
): ALOutboundSettlementFact {
    return {
        kind: 'receipt-exhausted',
        msgId: receipt.msgId,
        mode: receipt.mode,
        confirmedPeerIds: receipt.expectedPeerIds.filter((peerId) =>
            receipt.ackedPeerIds.includes(peerId)
        ),
        unconfirmedPeerIds: receipt.expectedPeerIds.filter((peerId) =>
            !receipt.ackedPeerIds.includes(peerId)
        ),
        detail
    };
}
```

    Create `packages/shared/alm/outbound/control/to-al-outbound-dispatch-completion-receipt.ts`:

```ts
import type { ALOutboundMessageReadDto } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import {
    isALOutboundAckTrackingWritable,
    isALOutboundReceiptComplete,
    toALOutboundAcknowledgementFact,
    toALOutboundCompletedHopPeerIds,
    toALOutboundTrackedReceipt
} from '../transition-al-outbound-pending-ack.ts';

/** What one dispatch read holds about the receipt its plan may complete. */
export type ALOutboundDispatchCompletionRead<TPrepared> = Pick<
    ALOutboundMessageReadDto<TPrepared>,
    'msg' | 'plan' | 'pendingAck' | 'acks' | 'nowMs'
>;

/**
 * The acknowledgement a re-plan states when its tracking completes the receipt row the dispatch then
 * deletes -- an RTC `replace` retry drops a peer that left, under `hop` and `receiver` alike -- so that
 * receipt end settles instead of vanishing.
 */
export function toALOutboundDispatchCompletionReceipt<TPrepared>(
    read: ALOutboundDispatchCompletionRead<TPrepared>
): ALOutboundSettlementFact | undefined {
    const tracking = read.plan.ackTracking;
    if (
        read.pendingAck === undefined || tracking === undefined ||
        !isALOutboundAckTrackingWritable(tracking)
    ) {
        return undefined;
    }
    const receipt = toALOutboundTrackedReceipt({
        msgId: read.msg.id.msgId,
        current: read.pendingAck,
        acks: read.acks,
        tracking,
        nowMs: read.nowMs
    });
    if (!isALOutboundReceiptComplete(receipt)) {
        return undefined;
    }
    return toALOutboundAcknowledgementFact({
        receipt,
        hops: {
            nextHopPeerIds: tracking.nextHopPeerIds,
            completedHopPeerIds: toALOutboundCompletedHopPeerIds(read.acks)
        },
        complete: true
    });
}
```

- [ ] **Step 8: Implement the owner's two exhaustions.** In
      `packages/shared/alm/outbound/al-outbound-repair-admission.ts`:
  - add `ALOutboundSettlementEmitter` to the type import from `./al-outbound-message-runtime.ts`, and
    `import { toALOutboundReceiptExhaustedFact } from './control/to-al-outbound-receipt-exhausted-fact.ts';`;
  - add to `Dependencies` (after `diagnostics`, `:48`):

```ts
/** The lane's guarded emitter: where a receipt and a not-yet-in-sync budget state that they ran out. */
readonly settlements: ALOutboundSettlementEmitter;
```

- replace the `exhausted` branch of `scheduleNotYetInSyncRetry` (`:171-174`) with:

```ts
if (result.status === 'exhausted') {
    this.dependencies.settlements({
        kind: 'not-yet-in-sync-exhausted',
        msgId,
        detail: `The not-yet-in-sync retry budget of ${retry.maxAttempts} ran out.`
    });
}
```

- replace the budget branch of `retryPendingAck` (`:197-200`) with:

```ts
if (pending.attempts >= pending.maxAttempts) {
    await this.commitReceiptExhausted(msg, pending, read.clientRecord?.version);
    return;
}
```

- replace the body of `commitOrphanedReceiptCleanup` after its `if (!clientRecord)` guard with:

```ts
const status = await this.admissionStore.commitBundle(
    toEndReceiptBundle(clientRecord.senderId, msgId, clientRecord.version)
);
if (status === 'conflict') {
    throw new RetryableConflictError('Expired outbound acknowledgement cleanup commit conflict');
}
```

- replace the `commitBundle({...})` argument of `commitClearPendingAck` with
  `toEndReceiptBundle(msg.id.senderId, pending.msgId, expectedVersion)`;
- add after `commitClearPendingAck`:

```ts
/**
 * The budget ran out: the row goes in the commit whose success states the terminal fact, so the fact
 * is stated once across replays and reloads, and a late ACK finds no row to complete (Q6).
 */
private async commitReceiptExhausted(
    msg: ALMessage,
    pending: ALOutboundPendingAckSnapshot,
    expectedVersion: number | undefined
): Promise<void> {
    const status = await this.admissionStore.commitBundle(
        toEndReceiptBundle(msg.id.senderId, pending.msgId, expectedVersion)
    );
    if (status === 'conflict') {
        throw new RetryableConflictError('Outbound receipt exhaustion commit conflict');
    }
    if (status === 'committed') {
        this.dependencies.settlements(toALOutboundReceiptExhaustedFact(
            pending,
            `The receipt ran out of retries after ${pending.attempts} of ${pending.maxAttempts}.`
        ));
    }
}
```

- add at the end of the file:

```ts
/** The commit that ends one receipt: its pending-ACK row and its repair-attempt row, under the sender's fence. */
function toEndReceiptBundle<TPrepared>(
    senderId: string,
    msgId: string,
    expectedVersion: number | undefined
): ALOutboundCommitBundle<TPrepared> {
    return {
        senderId,
        expectedVersion,
        mutations: [
            { kind: 'delete-pending-ack', originPeerId: senderId, msgId },
            { kind: 'delete-repair-attempt', msgId }
        ],
        durableEffects: []
    };
}
```

    In `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts` add `settlements` to the object
    `createALOutboundLaneRepairAdmission` passes (`:462-474`), after `diagnostics: runtime.diagnostics`:
    `settlements`. In `packages/tests/shared/alm/al-outbound-message-expiry.test.ts` add
    `settlements: () => {}` to the `new ALOutboundRepairAdmission({...})` object (after
    `diagnostics: undefined`, `:236`).

- [ ] **Step 9: Implement the dispatch and control ends.** In
      `packages/shared/alm/outbound/compute-al-outbound-dispatch.ts`:
  - extend the import from `./transition-al-outbound-pending-ack.ts` with `isALOutboundAckTrackingWritable`,
    and add
    `import { toALOutboundDispatchCompletionReceipt, type ALOutboundDispatchCompletionRead } from './control/to-al-outbound-dispatch-completion-receipt.ts';`;
  - replace `toALOutboundTrackedReceiptAlgo` (`:123-129`) with:

```ts
/**
 * The receipt an admission tracks: the mode of the receipt row its commit writes, `none` when it writes
 * none (R-S3a-4, and a `qos.ack` timeout of 0). A `receiver` receipt that expects nobody yet is the
 * exception: the WS server's `admitted` receipt creates its row, and an empty frozen audience completes
 * it at admission.
 */
function toALOutboundTrackedReceiptAlgo(
    ackTracking: ALOutboundAckTrackingPlan | null | undefined
): ALAckAlgo {
    if (ackTracking?.enabled !== true) {
        return 'none';
    }
    if (ackTracking.mode === 'receiver' && ackTracking.expectedPeerIds.length === 0) {
        return 'receiver';
    }
    return isALOutboundAckTrackingWritable(ackTracking) ? ackTracking.mode : 'none';
}
```

- in `computeAckTrackingWrites` (`:363-366`) replace the guard with:

```ts
const tracking = read.plan.ackTracking;
if (tracking === undefined || !isALOutboundAckTrackingWritable(tracking)) {
    return { mutations: [], durableEffects: [] };
}
```

- replace `ALOutboundCommitSettlementsInput` and `toALOutboundCommitSettlements` (`:322-341`) with:

```ts
export interface ALOutboundCommitSettlementsInput<TPrepared> {
    readonly bundle: ALOutboundCommitBundle<TPrepared>;
    readonly msg: ALMessage;
    readonly read: ALOutboundDispatchCompletionRead<TPrepared>;
    readonly intent: ALOutboundComputeIntent;
}

/**
 * What a committed dispatch states at once: each message it superseded, a receipt nobody is left to
 * confirm, and the receipt its re-plan completed -- only when this commit deletes that row, since a
 * dispatch with no prepared copy writes no receipt mutation at all.
 */
export function toALOutboundCommitSettlements<TPrepared>(
    input: ALOutboundCommitSettlementsInput<TPrepared>
): readonly ALOutboundSettlementFact[] {
    const superseded = toALOutboundSupersededMsgIds(input.bundle).map((
        msgId
    ): ALOutboundSettlementFact => ({
        kind: 'superseded',
        msgId,
        replacementMsgId: input.msg.id.msgId,
        detail: 'A newer message replaced this one at its admission.'
    }));
    const emptyAudience = input.intent === 'enqueue'
        ? toALOutboundEmptyAudienceReceipt(input.read.plan)
        : undefined;
    const deletesReceipt = input.bundle.mutations.some((mutation) =>
        mutation.kind === 'delete-pending-ack'
    );
    const completion = deletesReceipt
        ? toALOutboundDispatchCompletionReceipt(input.read)
        : undefined;
    return [
        ...superseded,
        ...(emptyAudience === undefined ? [] : [emptyAudience]),
        ...(completion === undefined ? [] : [completion])
    ];
}
```

    In `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts:346` pass
    `{ bundle, msg, read: input.read, intent: input.intent }`.

    In `packages/shared/alm/outbound/compute-al-outbound-control-admission.ts` add
    `import { toALOutboundReceiptExhaustedFact } from './control/to-al-outbound-receipt-exhausted-fact.ts';`
    and replace `toALOutboundControlSettlement` (`:107-128`) with:

```ts
/**
 * The delivery facts a committed control states: the `resync-required` refusal of the message by a relay
 * (D50), or the receipt the control moved -- followed by `receipt-exhausted` when a hop refused the
 * message for good and so ended a receipt it still owed. A control that changed no receipt states nothing.
 */
export function toALOutboundControlSettlements(
    candidate: ALControlAdmissionCandidate
): readonly ALOutboundSettlementFact[] {
    const { read, history } = candidate;
    if (read.parsed.type === 'nack' && read.parsed.payload.reason === 'resync-required') {
        return [toRelayRejectedFact(read, read.parsed.payload)];
    }
    const snapshot = resolveAcceptedReceipt(candidate);
    if (snapshot === undefined) {
        return [];
    }
    const acknowledgement = toALOutboundAcknowledgementFact({
        receipt: snapshot,
        hops: {
            nextHopPeerIds: read.sent?.policy.ackTracking?.nextHopPeerIds ?? [],
            completedHopPeerIds: toALOutboundCompletedHopPeerIds(
                history.kind === 'acks' ? history.values : []
            )
        },
        complete: isALOutboundReceiptComplete(snapshot)
    });
    const refused = toRefusedReceiptFact(read, snapshot);
    return refused === undefined ? [acknowledgement] : [acknowledgement, refused];
}

/** An `expired`, `unauthorized` or `stale` NACK removed a receipt its hop will never confirm. */
function toRefusedReceiptFact(
    read: ALControlAdmissionRead,
    receipt: ALOutboundPendingAckSnapshot
): ALOutboundSettlementFact | undefined {
    if (
        read.parsed.type !== 'nack' || !isTerminalNack(read.parsed.payload) ||
        isALOutboundReceiptComplete(receipt)
    ) {
        return undefined;
    }
    const nack = read.parsed.payload;
    return toALOutboundReceiptExhaustedFact(
        receipt,
        `Hop ${nack.fromPeerId} refused the message: ${nack.reason}.`
    );
}
```

    In `packages/shared/alm/outbound/control/al-outbound-control-admission.ts` rename the import
    (`:49`) and replace `:137-140` with:

```ts
for (const settlement of toALOutboundControlSettlements(computed)) {
    this.settlements(settlement);
}
```

- [ ] **Step 10: GREEN.** Run the Step 5 command. Expected: PASS. Then
      `npx vitest run packages/tests/shared/alm packages/tests/shared/services packages/tests/shared/multicast packages/tests/shared-web/messages packages/tests/shared-server/rallar-system/middleware`
      — an existing pin that encoded "exhaustion states nothing" or "a terminal NACK states one
      acknowledgement" moves to the new facts; name each moved pin with its file and old/new figure in the
      commit body, and stop for a ruling if one encodes something else. Then the per-task validation list
      (the `deno task check`s and `npm run test:deno` apply: `packages/shared` changed; the bundle checks
      apply: the reducer and the outbound owner ship in the facade and the headless bundle, and a crossed
      ceiling is raised in this task's commit by the Task 3 Step 8 rule, with this run's figure (R-S3b-2)).
      The changed-style report (`npm run check:repo-style:changed -- origin/main HEAD`) must show
      no new cognitive-load finding on `compute-al-delivery-lifecycle.ts` (load 37 before) or
      `compute-al-outbound-control-admission.ts` (39 before); if either reaches the warn tier of 50, move
      the new transition into a sibling file under the same directory and keep a call line.
      Then, once (R-S3b-15: the shared repair owner now deletes the WS server's PostgreSQL pending-ACK row
      at exhaustion), with the Postgres container `ar-eye-hunter-postgres` up (check `docker ps`;
      if it stopped, `docker start ar-eye-hunter-postgres`), run unsandboxed
      `npm run test:api-v1:black-box:postgres:medium-scale` and record its summary line in the commit body
      and later in the PR body; a red run stops the task for a ruling.

- [ ] **Step 11: Commit and push.** Also `git add` every moved-pin file named in the commit body and,
      when a ceiling was raised, `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`,
      `packages/shared-web/scripts/measure-browser-bundles.mjs` and
      `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`.

```bash
git add packages/shared/alm packages/tests/shared/alm
git commit -m "feat(alm): every receipt end settles -- receipt-exhausted, the not-yet-in-sync exhaustion, completion at dispatch and the untracked receipt"
git push
```

---

### Task 2: The declared retryable outcomes and the settlement-free hand-over

**Files:**

- Create: `packages/shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts`
- Modify: as "Retryable outcomes and the hand-over" above.
- Test: create `packages/tests/shared/alm/delivery/resolve-al-delivery-fallback-trigger.test.ts`,
  `packages/tests/shared/alm/delivery/al-delivery-carrier-fallback.test.ts`,
  `packages/tests/shared/alm/outbound/al-outbound-hand-over.test.ts`,
  `packages/tests/shared/alm/inbound/compute-al-inbound-duplicate-changes.test.ts` (Steps 11–15; no
  duplicate-changes test file exists yet); modify
  `packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts:176-195`.

**Interfaces:**

- Consumes Task 1's `receipt-exhausted` and `not-yet-in-sync-exhausted` settlements and
  `ALOutboundRepairAdmission`'s `toEndReceiptBundle`.
- Produces in `al-delivery-lifecycle.ts`:
  - `export type ALDeliveryFallbackReason = 'not-ready' | 'not-yet-in-sync-exhausted' | 'receipt-exhausted';`
  - `export interface ALDeliveryCarrierFallback { readonly from: ALDeliveryCarrier; readonly to: ALDeliveryCarrier; readonly reason: ALDeliveryFallbackReason; readonly atMs: number; readonly detail: string; }`
  - `ALDeliveryEvidence.carrierFallback: ALDeliveryCarrierFallback | undefined` (required field)
  - the settlement `{ kind: 'carrier-fallback'; msgId: string; carrier: ALDeliveryCarrier; atMs: number; to: ALDeliveryCarrier; reason: ALDeliveryFallbackReason; detail: string; }` (`carrier` is the one the message left).
- Produces in `resolve-al-delivery-fallback-trigger.ts`: `AL_FALLBACK_NOT_READY_ATTEMPTS = 3`,
  `AL_DELIVERY_FALLBACK_UNROUTABLE_REASONS`, `AL_DELIVERY_FALLBACK_REFUSAL_REASONS`,
  `AL_DELIVERY_FALLBACK_REASONS`, `isALDeliveryAdmissionFallbackVerdict(verdict: ALDeliveryAdmissionVerdict): boolean`,
  `interface ResolveALDeliveryFallbackTriggerInput { settlement: ALDeliverySettlement; leg: ALDeliveryCarrier; notReadyRun: number; }`,
  `type ALDeliveryFallbackTrigger = { kind: 'continue'; notReadyRun: number } | { kind: 'fall-back'; reason: ALDeliveryFallbackReason; detail: string }`,
  `resolveALDeliveryFallbackTrigger(input): ALDeliveryFallbackTrigger`.
- Produces `ALOutboundSendControls.handOver(msgId: string): ALOutboundHandOverOutcome` (`'handed-over' | 'already-ended'`),
  `ALOutboundSendControls.isEnded(msgId: string): boolean` (replaces `isCancelled`),
  `ALOutboundStoreLane.endReceipt(msgId: string): Promise<void>`, `ALOutboundRepairAdmission.endReceipt(msgId: string): Promise<void>`,
  `ALOutboundMessageRuntime.handOver(msgId: string): Promise<void>`,
  `WebRtcOverlayMulticastManager.handOver(msgId: string): Promise<void>`,
  `WebRtcRxStreamerService.handOverOutbox(msgId: string): Promise<void>`.
- Produces in `compute-al-inbound-duplicate-changes.ts` (R-S3b-1, Steps 11–15): a `duplicate` admitted
  on a carrier other than the one its message-owner row records (`toALDeliveryCarrier(read.observations.messageOwner.source)`),
  with no relay row (`pendingAck === undefined`), emits one `send-ack` of this peer's own ACK
  (`logicalRecipient: self`, `delivered` or `subtree-complete`) to `plan.ack.toPeerId` on the arrival
  carrier, whether or not the copy names this peer as its next hop; a relay row keeps D25's answers.
- Task 3 consumes `resolveALDeliveryFallbackTrigger`, the `carrier-fallback` settlement and
  `rtcRxStreamer.handOverOutbox`; Task 5's `receipt-exhausted-fallback` consumes R-S3b-1's WS re-ACK for
  its `acknowledged` pin; Task 4 needs nothing from here.

- [ ] **Step 1: RED — the trigger.** Create `packages/tests/shared/alm/delivery/resolve-al-delivery-fallback-trigger.test.ts`:

```ts
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryAttemptOutcome,
    ALDeliveryCarrier,
    ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    AL_DELIVERY_FALLBACK_REASONS,
    AL_FALLBACK_NOT_READY_ATTEMPTS,
    isALDeliveryAdmissionFallbackVerdict,
    resolveALDeliveryFallbackTrigger,
    type ALDeliveryFallbackTrigger
} from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

const MSG_ID = 'msg-1';

function toAttempt(
    outcome: ALDeliveryAttemptOutcome,
    attemptId: string,
    carrier: ALDeliveryCarrier = 'rtc'
): ALDeliverySettlement {
    return {
        kind: 'attempt-settled',
        msgId: MSG_ID,
        carrier,
        atMs: 1,
        attemptId,
        outcome,
        submissionAttempted: outcome === 'sent',
        detail: undefined,
        willRetry: outcome === 'not-ready'
    };
}

/** Folds settlements through the trigger the way the registry hook does, stopping at the first hand-over. */
function toTrigger(settlements: readonly ALDeliverySettlement[]): ALDeliveryFallbackTrigger {
    let trigger: ALDeliveryFallbackTrigger = { kind: 'continue', notReadyRun: 0 };
    for (const settlement of settlements) {
        if (trigger.kind === 'fall-back') {
            return trigger;
        }
        trigger = resolveALDeliveryFallbackTrigger({
            settlement,
            leg: 'rtc',
            notReadyRun: trigger.notReadyRun
        });
    }
    return trigger;
}

const RTC_ACKNOWLEDGEMENT: ALDeliverySettlement = {
    kind: 'acknowledgement',
    msgId: MSG_ID,
    carrier: 'rtc',
    atMs: 1,
    mode: 'receiver',
    confirmedHopPeerIds: [],
    unconfirmedHopPeerIds: ['relay-1'],
    expectedRecipientPeerIds: ['b'],
    confirmedRecipientPeerIds: [],
    unconfirmedRecipientPeerIds: ['b'],
    complete: false
};

describe('the declared retryable outcomes (D56)', () => {
    it('declares the not-ready bound and the three post-admission reasons', () => {
        expect(AL_FALLBACK_NOT_READY_ATTEMPTS).toBe(3);
        expect(AL_DELIVERY_FALLBACK_REASONS).toEqual([
            'not-ready',
            'not-yet-in-sync-exhausted',
            'receipt-exhausted'
        ]);
    });

    it.each(
        [
            [{ kind: 'unroutable', reason: 'no-route', detail: 'no route' }, true],
            [{ kind: 'unroutable', reason: 'circuit-open', detail: 'open' }, true],
            [{ kind: 'unroutable', reason: 'rate-limited', detail: 'limited' }, true],
            [{ kind: 'refused', reason: 'unsupported', detail: 'receiver over rtc' }, true],
            [{ kind: 'refused', reason: 'unauthorized', detail: 'denied' }, false],
            [{ kind: 'admitted', durable: false, queuedAttempts: 1 }, false],
            [{ kind: 'expired', detail: 'late' }, false]
        ] satisfies ReadonlyArray<readonly [ALDeliveryAdmissionVerdict, boolean]>
    )('hands %o to the fallback carrier at admission: %s', (verdict, expected) => {
        expect(isALDeliveryAdmissionFallbackVerdict(verdict)).toBe(expected);
    });

    it('hands the RTC leg over on its third consecutive not-ready attempt, across its send-prepared rows', () => {
        expect(toTrigger([toAttempt('not-ready', 'send-a'), toAttempt('not-ready', 'send-b')]))
            .toEqual({ kind: 'continue', notReadyRun: 2 });
        expect(
            toTrigger([
                toAttempt('not-ready', 'send-a'),
                toAttempt('not-ready', 'send-b'),
                toAttempt('not-ready', 'send-a')
            ])
        )
            .toEqual({
                kind: 'fall-back',
                reason: 'not-ready',
                detail: '3 consecutive RTC attempts settled not-ready.'
            });
    });

    it('restarts the count on a sent attempt or an acknowledgement', () => {
        expect(
            toTrigger([
                toAttempt('not-ready', 'a'),
                toAttempt('not-ready', 'a'),
                toAttempt('sent', 'b'),
                toAttempt('not-ready', 'a')
            ])
        )
            .toEqual({ kind: 'continue', notReadyRun: 1 });
        expect(
            toTrigger([
                toAttempt('not-ready', 'a'),
                toAttempt('not-ready', 'a'),
                RTC_ACKNOWLEDGEMENT,
                toAttempt('not-ready', 'a')
            ])
        )
            .toEqual({ kind: 'continue', notReadyRun: 1 });
    });

    it('keeps the count across settlements that say nothing about whether the leg carries', () => {
        const started: ALDeliverySettlement = {
            kind: 'attempt-started',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: 1,
            attemptId: 'a'
        };
        expect(
            toTrigger([
                toAttempt('not-ready', 'a'),
                started,
                toAttempt('cancelled', 'b'),
                toAttempt('not-ready', 'a')
            ])
        )
            .toEqual({ kind: 'continue', notReadyRun: 2 });
    });

    it('hands over at once on a spent receipt or not-yet-in-sync budget', () => {
        expect(toTrigger([{
            kind: 'receipt-exhausted',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: 1,
            mode: 'receiver',
            confirmedPeerIds: [],
            unconfirmedPeerIds: ['b'],
            detail: 'The receipt ran out of retries after 3 of 3.'
        }])).toEqual({
            kind: 'fall-back',
            reason: 'receipt-exhausted',
            detail: 'The receipt ran out of retries after 3 of 3.'
        });
        expect(toTrigger([{
            kind: 'not-yet-in-sync-exhausted',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: 1,
            detail: 'The not-yet-in-sync retry budget of 3 ran out.'
        }])).toEqual({
            kind: 'fall-back',
            reason: 'not-yet-in-sync-exhausted',
            detail: 'The not-yet-in-sync retry budget of 3 ran out.'
        });
    });

    it('moves nothing on a settlement of another carrier', () => {
        expect(
            toTrigger([
                toAttempt('not-ready', 'a', 'ws'),
                toAttempt('not-ready', 'a', 'ws'),
                toAttempt('not-ready', 'a', 'ws')
            ])
        )
            .toEqual({ kind: 'continue', notReadyRun: 0 });
    });
});
```

- [ ] **Step 2: RED — the reducer's hand-over rules.** Create `packages/tests/shared/alm/delivery/al-delivery-carrier-fallback.test.ts`:

```ts
import {
    createInitialALDeliveryLifecycle,
    type ALDeliveryCarrier,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALDeliveryLifecycle } from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

const MSG_ID = 'msg-1';
const EXHAUSTED_DETAIL = 'The receipt ran out of retries after 3 of 3.';

function reduce(settlements: readonly ALDeliverySettlement[]): ALDeliveryLifecycle {
    const opened = createInitialALDeliveryLifecycle({
        msgId: MSG_ID,
        typeId: 'room.command.v1',
        ackMode: 'receiver',
        receiptAlgo: 'receiver',
        expiresAtMs: 30_000,
        submittedAtMs: 1_000
    });
    return settlements.reduce(computeALDeliveryLifecycle, opened);
}

function toAdmission(carrier: ALDeliveryCarrier): ALDeliverySettlement {
    return {
        kind: 'admission',
        msgId: MSG_ID,
        carrier,
        atMs: 2_000,
        verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
        trackedReceiptAlgo: 'receiver'
    };
}

function toReceipt(
    carrier: ALDeliveryCarrier,
    confirmed: readonly string[],
    complete: boolean
): ALDeliverySettlement {
    return {
        kind: 'acknowledgement',
        msgId: MSG_ID,
        carrier,
        atMs: 4_000,
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: ['b', 'c'],
        confirmedRecipientPeerIds: confirmed,
        unconfirmedRecipientPeerIds: ['b', 'c'].filter((peerId) => !confirmed.includes(peerId)),
        complete
    };
}

function toExhausted(carrier: ALDeliveryCarrier): ALDeliverySettlement {
    return {
        kind: 'receipt-exhausted',
        msgId: MSG_ID,
        carrier,
        atMs: 4_500,
        mode: 'receiver',
        confirmedPeerIds: [],
        unconfirmedPeerIds: ['b', 'c'],
        detail: EXHAUSTED_DETAIL
    };
}

const HAND_OVER: ALDeliverySettlement = {
    kind: 'carrier-fallback',
    msgId: MSG_ID,
    carrier: 'rtc',
    atMs: 3_000,
    to: 'ws',
    reason: 'receipt-exhausted',
    detail: EXHAUSTED_DETAIL
};

describe('a hand-over to the fallback carrier (D56, Q3)', () => {
    it('starts with no hand-over', () => {
        expect(reduce([]).evidence.carrierFallback).toBeUndefined();
    });

    it('records the hand-over as evidence and leaves the state to the carrier that took the message', () => {
        const handedOver = reduce([toAdmission('rtc'), HAND_OVER]);

        expect(handedOver.state).toBe('queued');
        expect(handedOver.evidence.carrierFallback).toEqual({
            from: 'rtc',
            to: 'ws',
            reason: 'receipt-exhausted',
            atMs: 3_000,
            detail: EXHAUSTED_DETAIL
        });
    });

    it('lets no receipt fact of the carrier the handle left move it, even after the WS receipt', () => {
        const acknowledged = reduce([
            toAdmission('rtc'),
            HAND_OVER,
            toAdmission('ws'),
            toReceipt('ws', ['b', 'c'], true)
        ]);
        expect(acknowledged.state).toBe('acknowledged');

        const late = [
            toReceipt('rtc', [], false),
            toExhausted('rtc'),
            {
                kind: 'relay-rejected',
                msgId: MSG_ID,
                carrier: 'rtc',
                atMs: 5_000,
                relayRejection: { relay: 'peer', peerId: 'relay-1', reason: 'resync-required' },
                detail: 'Hop relay-1 refused the message: resync-required.'
            } satisfies ALDeliverySettlement
        ].reduce(computeALDeliveryLifecycle, acknowledged);

        expect(late.evidence).toEqual(acknowledged.evidence);
        expect(late.lateSettlementCount).toBe(acknowledged.lateSettlementCount);
    });

    it('keeps the RTC receipt facts of a handle that never handed over', () => {
        expect(reduce([toAdmission('rtc'), toExhausted('rtc')]).state).toBe('failed');
    });

    it('still records the attempt rows of the carrier the handle left', () => {
        const next = reduce([toAdmission('rtc'), HAND_OVER, {
            kind: 'attempt-settled',
            msgId: MSG_ID,
            carrier: 'rtc',
            atMs: 3_100,
            attemptId: 'send-a',
            outcome: 'cancelled',
            submissionAttempted: false,
            detail: 'The message was cancelled before its carrier ran.',
            willRetry: false
        }]);

        expect(next.evidence.attempts).toMatchObject([{ carrier: 'rtc', outcome: 'cancelled' }]);
    });
});
```

- [ ] **Step 3: RED — the hand-over.** Create `packages/tests/shared/alm/outbound/al-outbound-hand-over.test.ts`:

```ts
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { ALOutboundSendControls } from '@shared/alm/outbound/lane/al-outbound-send-controls.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    holdOutboundClaims,
    runOutboundWorkTask,
    trackOutboundTestAcks
} from '../outbound-runtime-test-fixture.ts';

function createHandOverFixture() {
    const stores = createDefaultOutboundTestStores();
    const settlements: ALDeliverySettlement[] = [];
    const sent: string[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        carrier: 'rtc',
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [{ message: msg.id.msgId }],
            ackTracking: trackOutboundTestAcks(['peer-1'])
        }),
        sendPreparedMessage: async (prepared) => {
            sent.push(JSON.stringify(prepared));
            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
    return { stores, settlements, sent, runtime };
}

describe('the settlement-free hand-over (D56, Q3)', () => {
    it('ends the receipt row and every later effect of the message, and states no cancellation', async () => {
        const fixture = createHandOverFixture();
        const claims = holdOutboundClaims(fixture.stores);
        const message = createOutboundMessage('hand-over');
        const receipt = { originPeerId: message.id.senderId, msgId: message.id.msgId };
        expect((await fixture.runtime.enqueueIfAbsent(message)).verdict.kind).toBe('admitted');
        expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toBeDefined();

        await fixture.runtime.handOver(message.id.msgId);
        await claims.release();
        await runOutboundWorkTask(fixture.runtime);

        expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toBeUndefined();
        expect(fixture.sent).toEqual([]);
        const kinds = fixture.settlements.map((settlement) => settlement.kind);
        expect(kinds).not.toContain('cancelled');
        expect(kinds).not.toContain('attempt-started');
    });

    it('is idempotent, and a later cancel still states its own settlement', async () => {
        const fixture = createHandOverFixture();
        const claims = holdOutboundClaims(fixture.stores);
        const message = createOutboundMessage('hand-over-twice');
        await fixture.runtime.enqueueIfAbsent(message);

        await fixture.runtime.handOver(message.id.msgId);
        await fixture.runtime.handOver(message.id.msgId);
        await claims.release();

        expect(fixture.runtime.cancel(message.id.msgId)).toBe('cancelled');
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'cancelled'))
            .toHaveLength(1);
    });
});

describe('ALOutboundSendControls.handOver', () => {
    it('aborts the live attempt and ends the message without cancelling it', () => {
        const controls = new ALOutboundSendControls();
        const signal = controls.acquire('msg-1');

        expect(controls.handOver('msg-1')).toBe('handed-over');
        expect(signal.aborted).toBe(true);
        expect(controls.isEnded('msg-1')).toBe(true);
        expect(controls.handOver('msg-1')).toBe('already-ended');
        expect(controls.cancel('msg-1')).toBe('cancelled');
    });

    it('leaves a cancelled message as it is', () => {
        const controls = new ALOutboundSendControls();
        controls.cancel('msg-1');

        expect(controls.handOver('msg-1')).toBe('already-ended');
    });
});
```

- [ ] **Step 4: RED — `rate-limited` falls back at admission.** In
      `packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts` delete the row
      `['rate-limited', 'failed', { kind: 'unroutable', reason: 'rate-limited', detail: 'rate-limited' }],`
      from the `'does not try another carrier after %s'` table (`:182`) and add after that `it.each`:

```ts
it.each(
    [
        ['rtc-with-ws-fallback', ['rtc', 'ws'], 'queued'],
        ['rtc', ['rtc'], 'failed']
    ] as const
)(
    'hands a rate-limited RTC admission to WS at once on %s (D56, Q5)',
    async (strategy, carriers, state) => {
        const fixture = createChannel({
            firstVerdict: { kind: 'unroutable', reason: 'rate-limited', detail: 'rate-limited' }
        });
        const handle = await fixture.channel.send({ action: 'ready' }, { strategy });

        expect((await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe(
            state
        );
        expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(carriers);
        expect(handle.lifecycle().evidence.attempts[0]).toMatchObject({
            carrier: 'rtc',
            outcome: 'unroutable',
            unroutableReason: 'rate-limited'
        });
    }
);
```

- [ ] **Step 5: Run the RED tests.**

Run: `npx vitest run packages/tests/shared/alm/delivery/resolve-al-delivery-fallback-trigger.test.ts packages/tests/shared/alm/delivery/al-delivery-carrier-fallback.test.ts packages/tests/shared/alm/outbound/al-outbound-hand-over.test.ts packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts`
Expected: FAIL — the trigger module is missing, `carrier-fallback` reduces to `undefined`,
`handOver` is not a function, and the rate-limited fallback leg is never admitted.

- [ ] **Step 6: Implement the vocabulary and the reducer rules.** In
      `packages/shared/alm/delivery/al-delivery-lifecycle.ts`, add after `ALDeliveryRefusalReason` (`:56`):

```ts
/** Why a message an RTC leg had admitted was handed to WS (D56); `rate-limited` hands over at admission instead. */
export type ALDeliveryFallbackReason =
    | 'not-ready'
    | 'not-yet-in-sync-exhausted'
    | 'receipt-exhausted';
```

    add to `ALDeliverySettlement`, after the `carrier-refused` variant (`:97`):

```ts
/** The strategy handed a message its first carrier admitted to the fallback carrier (D56): evidence, never an end. */
| Readonly<{
    kind: 'carrier-fallback';
    msgId: string;
    /** The carrier the message left. */
    carrier: ALDeliveryCarrier;
    atMs: number;
    to: ALDeliveryCarrier;
    reason: ALDeliveryFallbackReason;
    detail: string;
}>
```

    add after `ALDeliveryReceiptDowngrade` (`:212`):

```ts
/** The one hand-over of an admitted message to its fallback carrier; after it the left carrier's receipt facts move nothing. */
export interface ALDeliveryCarrierFallback {
    readonly from: ALDeliveryCarrier;
    readonly to: ALDeliveryCarrier;
    readonly reason: ALDeliveryFallbackReason;
    readonly atMs: number;
    readonly detail: string;
}
```

    add to `ALDeliveryEvidence`, after `receiptDowngrade`:

```ts
/** Undefined unless the strategy handed the admitted message to its fallback carrier (D56). */
readonly carrierFallback: ALDeliveryCarrierFallback | undefined;
```

    and `carrierFallback: undefined,` after `receiptDowngrade: undefined,` in `createInitialALDeliveryLifecycle`.

    In `packages/shared/alm/delivery/compute-al-delivery-lifecycle.ts` add the extract
    `type ALDeliveryCarrierFallbackSettlement = Extract<ALDeliverySettlement, Readonly<{ kind: 'carrier-fallback'; }>>;`,
    make the first lines of `computeALDeliveryLifecycle`:

```ts
if (isLeftCarrierReceipt(previous, settlement)) {
    return { ...previous };
}
if (isALDeliveryTerminal(previous)) {
    return toTerminalLifecycle(previous, settlement);
}
```

    add a case before `case 'attempt-started':`:

```ts
case 'carrier-fallback':
    return toCarrierFallbackLifecycle(previous, settlement);
```

    and add after `toReceiptExhaustedLifecycle`:

```ts
/** After a hand-over only the carrier that took the message may move its receipt; the left one speaks for its own leg. */
function isLeftCarrierReceipt(
    lifecycle: ALDeliveryLifecycle,
    settlement: ALDeliverySettlement
): boolean {
    return lifecycle.evidence.carrierFallback?.from === settlement.carrier &&
        (settlement.kind === 'acknowledgement' || settlement.kind === 'receipt-exhausted' ||
            settlement.kind === 'relay-rejected');
}

function toCarrierFallbackLifecycle(
    previous: ALDeliveryLifecycle,
    settlement: ALDeliveryCarrierFallbackSettlement
): ALDeliveryLifecycle {
    const { carrier: from, to, reason, atMs, detail } = settlement;
    return {
        ...previous,
        evidence: { ...previous.evidence, carrierFallback: { from, to, reason, atMs, detail } }
    };
}
```

- [ ] **Step 7: Implement the declared list and the trigger.** Create
      `packages/shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts`:

```ts
import type {
    ALDeliveryAdmissionVerdict,
    ALDeliveryAttemptOutcome,
    ALDeliveryCarrier,
    ALDeliveryFallbackReason,
    ALDeliveryRefusalReason,
    ALDeliverySettlement,
    ALDeliveryUnroutableReason
} from './al-delivery-lifecycle.ts';

/** Consecutive `not-ready` settlements of one message's RTC attempts, across its send-prepared rows, that hand it to WS (D56). */
export const AL_FALLBACK_NOT_READY_ATTEMPTS = 3;

/** The unroutable admission verdicts a fallback strategy hands to its other carrier at once: every one (D56 adds `rate-limited`). */
export const AL_DELIVERY_FALLBACK_UNROUTABLE_REASONS: readonly ALDeliveryUnroutableReason[] = [
    'no-route',
    'circuit-open',
    'rate-limited'
];

/** The refusals that do the same: a carrier that cannot honour the ack algorithm keeps the algorithm, not the carrier (D42). */
export const AL_DELIVERY_FALLBACK_REFUSAL_REASONS: readonly ALDeliveryRefusalReason[] = [
    'unsupported'
];

/** What ends an admitted RTC leg and hands the message to WS inside its deadline (D56). */
export const AL_DELIVERY_FALLBACK_REASONS: readonly ALDeliveryFallbackReason[] = [
    'not-ready',
    'not-yet-in-sync-exhausted',
    'receipt-exhausted'
];

export interface ResolveALDeliveryFallbackTriggerInput {
    readonly settlement: ALDeliverySettlement;
    /** The carrier of the watched leg: a settlement of any other carrier moves nothing. */
    readonly leg: ALDeliveryCarrier;
    /** Consecutive `not-ready` attempts counted before this settlement. */
    readonly notReadyRun: number;
}

export type ALDeliveryFallbackTrigger =
    | Readonly<{ kind: 'continue'; notReadyRun: number; }>
    | Readonly<{ kind: 'fall-back'; reason: ALDeliveryFallbackReason; detail: string; }>;

export function isALDeliveryAdmissionFallbackVerdict(verdict: ALDeliveryAdmissionVerdict): boolean {
    switch (verdict.kind) {
        case 'unroutable':
            return AL_DELIVERY_FALLBACK_UNROUTABLE_REASONS.includes(verdict.reason);
        case 'refused':
            return AL_DELIVERY_FALLBACK_REFUSAL_REASONS.includes(verdict.reason);
        default:
            return false;
    }
}

/** A `sent` attempt or an acknowledgement proves the leg carries, so it restarts the `not-ready` count. */
export function resolveALDeliveryFallbackTrigger(
    input: ResolveALDeliveryFallbackTriggerInput
): ALDeliveryFallbackTrigger {
    const { settlement, notReadyRun } = input;
    if (settlement.carrier !== input.leg) {
        return { kind: 'continue', notReadyRun };
    }
    switch (settlement.kind) {
        case 'attempt-settled':
            return toAttemptTrigger(settlement.outcome, notReadyRun);
        case 'acknowledgement':
            return { kind: 'continue', notReadyRun: 0 };
        case 'not-yet-in-sync-exhausted':
        case 'receipt-exhausted':
            return { kind: 'fall-back', reason: settlement.kind, detail: settlement.detail };
        default:
            return { kind: 'continue', notReadyRun };
    }
}

function toAttemptTrigger(
    outcome: ALDeliveryAttemptOutcome,
    notReadyRun: number
): ALDeliveryFallbackTrigger {
    if (outcome === 'sent') {
        return { kind: 'continue', notReadyRun: 0 };
    }
    if (outcome !== 'not-ready') {
        return { kind: 'continue', notReadyRun };
    }
    const run = notReadyRun + 1;
    return run >= AL_FALLBACK_NOT_READY_ATTEMPTS
        ? {
            kind: 'fall-back',
            reason: 'not-ready',
            detail: `${run} consecutive RTC attempts settled not-ready.`
        }
        : { kind: 'continue', notReadyRun: run };
}
```

    In `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts` add
    `import { isALDeliveryAdmissionFallbackVerdict } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';`,
    delete `isFallbackVerdict` (`:203-212`), and make `computeFallbackDisposition` (`:169-179`):

```ts
/** A verdict the declared list hands to the fallback carrier at admission (D42, D56), inside the deadline. */
export function computeFallbackDisposition(
    verdict: ALDeliveryAdmissionVerdict,
    expiresAtMs: number | undefined,
    nowMs: number
): BrowserFallbackDisposition {
    if (!isALDeliveryAdmissionFallbackVerdict(verdict)) {
        return 'stop';
    }
    return expiresAtMs !== undefined && expiresAtMs <= nowMs ? 'expired' : 'retry';
}
```

- [ ] **Step 8: Implement the hand-over.** In `packages/shared/alm/outbound/lane/al-outbound-send-controls.ts`
      add after `ALOutboundCancelOutcome` (`:4`):

```ts
/** What a `handOver` call decided: only the first call for a message not already ended hands it over. */
export type ALOutboundHandOverOutcome = 'handed-over' | 'already-ended';
```

    add the field after `cancelledMsgIds` (`:19`):

```ts
/** Held for the owner's lifetime, as cancellations are: another carrier's owner took these messages (D56). */
private readonly handedOverMsgIds = new Set<string>();
```

    and replace `isCancelled` (`:37-39`) with:

```ts
    /**
     * Remembers the id for the owner's lifetime and aborts a live attempt, as `cancel` does, but the caller
     * states nothing: the message is not cancelled, another carrier took it (D56).
     */
    handOver(msgId: string): ALOutboundHandOverOutcome {
        if (this.isEnded(msgId)) {
            return 'already-ended';
        }
        this.handedOverMsgIds.add(msgId);
        this.liveMessageSendControllers.get(msgId)?.controller.abort();
        return 'handed-over';
    }

    /** A cancelled or handed-over message: every later effect of it completes without sending. */
    isEnded(msgId: string): boolean {
        return this.cancelledMsgIds.has(msgId) || this.handedOverMsgIds.has(msgId);
    }
```

    In `packages/shared/alm/outbound/al-outbound-repair-admission.ts` add after `retryPendingAck`:

```ts
/**
 * Ends this owner's receipt of a message another carrier now owns (D56): both rows go in one commit and
 * nothing is stated -- the message is not cancelled. A conflict leaves an inert row: the hand-over
 * completes every later effect of the message silently, so nothing retries it before it expires.
 */
async endReceipt(msgId: string): Promise<void> {
    const read = await this.admissionStore.readRepairMessage(msgId, this.dependencies.planOutgoingMessage);
    if (read.pendingAck === undefined || read.clientRecord === undefined) {
        return;
    }
    await this.admissionStore.commitBundle(
        toEndReceiptBundle(read.clientRecord.senderId, msgId, read.clientRecord.version)
    );
}
```

    In `packages/shared/alm/outbound/lane/al-outbound-store-lane.ts`: in `runDurableEffect` replace the
    comment's first line with `// Before anything else: a cancelled or handed-over message's remaining work completes silently, of any kind --`
    and `this.isCancelledEffect(effect)` with `this.isEndedEffect(effect)` (`:264-268`); rename the method
    (`:303-306`) to `isEndedEffect` calling `this.input.sendControls.isEnded(msgId)`; add after
    `acceptReceipt` (`:165-167`):

```ts
/** A hand-over ends this lane's receipt of the message and states nothing (D56). */
async endReceipt(msgId: string): Promise<void> {
    await this.repairAdmission.endReceipt(msgId);
}
```

    In `packages/shared/alm/outbound/al-outbound-message-runtime.ts` make the type re-export (`:32`)
    `export type { ALOutboundCancelOutcome, ALOutboundHandOverOutcome } from './lane/al-outbound-send-controls.ts';`,
    change the class doc bullet (`:347`)
    to `` * - `cancel(msgId)` and `handOver(msgId)` are runtime-wide: one set of send controls serves both lanes. ``
    and add after `cancel` (`:415-421`):

```ts
/**
 * Hands one message to another carrier's owner (D56): aborts its live attempt, completes every later
 * effect of it silently and ends its receipt row, and states no settlement -- the message is not
 * cancelled. Idempotent; a message already cancelled or handed over is left as it is.
 */
async handOver(msgId: string): Promise<void> {
    if (this.sendControls.handOver(msgId) === 'already-ended') {
        return;
    }
    await this.ready();
    if (this.disposed) {
        return;
    }
    await (await this.readLaneForMessage(msgId)).endReceipt(msgId);
}
```

    In `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts` add after `cancel` (`:212-214`):

```ts
async handOver(msgId: string): Promise<void> {
    await this.outboundRuntime.handOver(msgId);
}
```

    In `packages/shared/services/web-rtc-rx-streamer-service.ts` add after `cancelOutbox` (`:444-446`):

```ts
async handOverOutbox(msgId: string): Promise<void> {
    await this.multicast.handOver(msgId);
}
```

- [ ] **Step 9: GREEN.** Run the Step 5 command. Expected: PASS. Then
      `npx vitest run packages/tests/shared/alm packages/tests/shared/multicast packages/tests/shared-web/messages packages/tests/shared-test/rallar-browser-runtime`
      and the per-task validation list (Deno checks and `npm run test:deno`: `packages/shared` changed;
      the bundle checks: the reducer ships in the browser — a crossed ceiling is raised in this task's
      commit by the Task 3 Step 8 rule, with this run's figure (R-S3b-2); Task 3 Step 8 re-measures).
      The changed-style report (`npm run check:repo-style:changed -- origin/main HEAD`) must show no new
      cognitive-load finding on `compute-al-delivery-lifecycle.ts` (its load after Task 1); if it reaches
      the warn tier of 50, move the new transition into a sibling file under the same directory and keep
      a call line. It must also show no new finding on `web-rtc-rx-streamer-service.ts` (49 before): if
      the `handOverOutbox` pass-through
      takes it to 50, drop that method and have Task 3's controller call
      `candidate.context.middleware.webRtcOverlayMulticastManager.handOver(msgId)` instead —
      `RallarBrowserMiddleware` already exposes that manager (`rallar-connection-facade.ts:43`); first
      confirm it is the rx-streamer's own `multicast` instance, and record the reroute in the commit body.

- [ ] **Step 10: Commit and push.** Also `git add` every moved-pin file named in the commit body (such as
      those under `packages/tests/shared-test/rallar-browser-runtime`) and, when a ceiling was raised, the
      three bundle files Task 1 Step 11 names.

```bash
git add packages/shared/alm packages/shared/multicast/web-rtc-overlay-multicast-manager.ts packages/shared/services/web-rtc-rx-streamer-service.ts packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts packages/tests/shared/alm packages/tests/shared-web/messages/browser-message-fallback-identity.test.ts
git commit -m "feat(alm): the declared retryable outcomes, rate-limited falls back at admission, and a settlement-free RTC hand-over (D56)"
git push
```

- [ ] **Step 11: RED — a duplicate on the other carrier is acknowledged again (R-S3b-1).** D56's WS leg
      completes only when the server's `receiver` receipt hears the receiver's WS ACK, but the tree
      answers a duplicate only when it is a retried copy addressed to this peer
      (`compute-al-inbound-duplicate-changes.ts:52-55`); the WS copy is the planner's envelope, so a
      receiver whose RTC ACK was held never acknowledges it. Create
      `packages/tests/shared/alm/inbound/compute-al-inbound-duplicate-changes.test.ts`:

```ts
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage, type ALAckStatus } from '@shared/al-contracts/al-control.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALInboundAdmission } from '@shared/alm/inbound/admission/compute-al-inbound-admission.ts';
import type {
    ALInboundAdmissionStore,
    ALInboundCommitBundle
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { computeALInboundPlanningObservations } from '@shared/alm/inbound/al-inbound-planner-snapshot.ts';
import { readALInboundEffectFacts } from '@shared/alm/inbound/prepare-al-inbound-commit-bundle.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    createInboundTestMessage,
    INBOUND_TEST_EFFECT_PREPARATION,
    INBOUND_TEST_SENDER_PEER_ID,
    planInboundTestMessage
} from '../inbound-runtime-test-fixture.ts';

const SOURCES: Readonly<Record<ALDeliveryCarrier, ALInboundMessageRuntime.Source>> = {
    rtc: { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID },
    ws: { kind: 'ws-client', peerId: INBOUND_TEST_SENDER_PEER_ID }
};

interface RepeatedAck {
    /** The runtime that claims the `send-control` row. */
    readonly rowCarrier: ALDeliveryCarrier;
    /** The carrier the ACK names for itself. */
    readonly carrier: ALDeliveryCarrier;
    readonly toPeerId: string;
    readonly ackedMsgId: string;
    readonly status: ALAckStatus;
}

/** The bundle one arrival computes over the store's current rows, read as the real admission reads it. */
async function computeArrival(
    store: ALInboundAdmissionStore,
    msg: ALMessage,
    carrier: ALDeliveryCarrier
): Promise<ALInboundCommitBundle> {
    const source = SOURCES[carrier];
    const nowMs = Date.now();
    const read = await store.readIncomingMessage({
        msg,
        source,
        nowMs,
        prePlan: planInboundTestMessage(msg, source, { nowMs })
    });
    const plan = planInboundTestMessage(msg, source, computeALInboundPlanningObservations(read));
    const facts = readALInboundEffectFacts(nowMs, INBOUND_TEST_EFFECT_PREPARATION);
    return computeALInboundAdmission({
        read,
        plan,
        facts,
        canForward: false,
        recordedParentPresent: true
    });
}

/** Commits the first copy's admission, then computes what the second copy's would commit. */
async function computeSecondArrival(
    msg: ALMessage,
    first: ALDeliveryCarrier,
    second: ALDeliveryCarrier
): Promise<ALInboundCommitBundle> {
    const { admissionStore } = createDefaultInMemoryALInboundRuntimeStores();
    expect(await admissionStore.commitBundle(await computeArrival(admissionStore, msg, first)))
        .toBe('committed');
    return await computeArrival(admissionStore, msg, second);
}

function toRepeatedAcks(bundle: ALInboundCommitBundle): readonly RepeatedAck[] {
    return bundle.durableEffects.flatMap((effect): RepeatedAck[] => {
        if (effect.payload.kind !== 'send-control') {
            return [];
        }
        const control = decodeALControlMessage(effect.payload.msg).right;
        return control?.type === 'ack'
            ? [{
                rowCarrier: effect.carrier,
                carrier: control.payload.carrier,
                toPeerId: control.payload.toPeerId,
                ackedMsgId: control.payload.ackedMsgId,
                status: control.payload.status
            }]
            : [];
    });
}

describe('a duplicate on the other carrier than its first admission (D56, R-S3b-1)', () => {
    it.each([['rtc', 'ws'], ['ws', 'rtc']] as const)(
        'first admitted over %s, a copy over %s sends the own ACK again on the arrival carrier',
        async (first, second) => {
            const msg = createInboundTestMessage({ msgId: 'handed-over', acknowledged: true });

            expect(toRepeatedAcks(await computeSecondArrival(msg, first, second))).toEqual([{
                rowCarrier: second,
                carrier: second,
                toPeerId: INBOUND_TEST_SENDER_PEER_ID,
                ackedMsgId: 'handed-over',
                status: 'delivered'
            }]);
        }
    );

    it('keeps a copy on the first carrier that names no next hop unanswered, as before', async () => {
        const msg = createInboundTestMessage({ msgId: 'same-carrier', acknowledged: true });

        expect(toRepeatedAcks(await computeSecondArrival(msg, 'rtc', 'rtc'))).toEqual([]);
    });

    it('answers nothing for a message that asked for no acknowledgement', async () => {
        const msg = createInboundTestMessage({ msgId: 'unacknowledged' });

        expect(toRepeatedAcks(await computeSecondArrival(msg, 'rtc', 'ws'))).toEqual([]);
    });
});
```

- [ ] **Step 12: Run the RED test.**

Run: `npx vitest run packages/tests/shared/alm/inbound/compute-al-inbound-duplicate-changes.test.ts`
Expected: FAIL — both cross-carrier cases read `[]` where one repeated ACK is expected (the fixture's
unicast names no next hop, so the tree's `nextHopPeerIds === [self]` guard returns nothing); the
same-carrier and unacknowledged cases pass and stay as regression guards.

- [ ] **Step 13: Implement the cross-carrier re-ACK.** In
      `packages/shared/alm/inbound/admission/compute-al-inbound-duplicate-changes.ts` add
      `import type { ALMessage } from '../../../al-contracts/al-contract.ts';` as the first import, and
      replace the doc comment and the head of `computeALInboundDuplicateChanges` (`:34-63`, through the
      `pendingAck === undefined` branch) with:

```ts
/**
 * A copy of a message this peer already admitted. It is never delivered again. A retried copy addressed to
 * this peer (D25): a peer with no relay row sends its own ACK again. A relay answers its parent in full:
 * every ACK it already relayed again, since any of them may be the one the origin lost, then its terminal
 * ACK when its subtree completed, or the copy onward to the child hops it still waits on. A sibling sender
 * gets the terminal ACK of this peer at once, so its own row completes whatever the visited exclusion
 * missed (R-S2c-ii-8c). The origin, or any sender once the recorded parent left, becomes the parent of
 * the row, and is answered in full (R-S2c-ii-12); a former parent still present then gets the sibling
 * answer (R-S2c-ii-14). A copy on the other carrier than the first admission -- the envelope a sender
 * re-admitted there after a hand-over (D56) -- gets the own ACK of a peer with no relay row again over the
 * carrier it came in on, whatever its next hops: the first ACK went out on the carrier the sender left
 * (R-S3b-1).
 */
export function computeALInboundDuplicateChanges(
    read: ALInboundMessageReadDto,
    input: ComputeALInboundDuplicateChangesInput
): ALInboundDuplicateChanges {
    const { plan, pendingAck } = read;
    const toPeerId = plan.ack.toPeerId;
    if (plan.dropReasonCode !== 'duplicate' || plan.ack.algo === 'none' || toPeerId === undefined) {
        return NO_DUPLICATE_CHANGES;
    }
    const addressedToSelf = isAddressedToSelf(read.msg, input.selfPeerId);
    if (pendingAck === undefined) {
        return addressedToSelf || isCrossCarrierCopy(read)
            ? { mutations: [], effects: [toOwnRepeatedAck(read, toPeerId, input.selfPeerId)] }
            : NO_DUPLICATE_CHANGES;
    }
    if (!addressedToSelf) {
        return NO_DUPLICATE_CHANGES;
    }
```

    and add before `toFormerParentRelease` (`:82`):

```ts
/** A retried hop copy names this peer as its one next hop (D25). */
function isAddressedToSelf(msg: ALMessage, selfPeerId: string): boolean {
    const nextHopPeerIds = msg.forwarding?.nextHopPeerIds ?? [];
    return nextHopPeerIds.length === 1 && nextHopPeerIds[0] === selfPeerId;
}

/**
 * The message-owner row keeps the first admission's source, so a copy on the other carrier is told apart
 * from a retried copy on the same one. An owner row that already expired answers nothing, as before.
 */
function isCrossCarrierCopy(read: ALInboundMessageReadDto): boolean {
    const owner = read.observations.messageOwner;
    return owner !== undefined &&
        toALDeliveryCarrier(owner.source) !== toALDeliveryCarrier(read.source);
}

function toOwnRepeatedAck(
    read: ALInboundMessageReadDto,
    toPeerId: string,
    selfPeerId: string
): ALInboundEffectIntent {
    return toRepeatedAck(read, {
        toPeerId,
        logicalRecipient: { kind: 'self' },
        status: toOwnAckStatus(read, selfPeerId)
    });
}
```

    `toRepeatedAck` already stamps `carrier: toALDeliveryCarrier(read.source)`, so the row is claimed by
    the arrival carrier's runtime and the ACK travels on it. In `packages/shared/alm/inbound/README.md`,
    after the bullet "a peer with no relay row sends its own ACK again." (`:198`), add:

```md
A copy on the other carrier than the message's first admission is answered as well, whatever next hops it
names: a sender that hands a message from RTC to WS (D56) admits the same envelope there, and this peer's
first ACK went out on the carrier the sender left. A peer with no relay row, whose message-owner row
records the other carrier, sends its own ACK again over the carrier the copy came in on (R-S3b-1); a relay
row keeps the answers above.
```

- [ ] **Step 14: GREEN.** Run the Step 12 command. Expected: PASS. Then
      `npx vitest run packages/tests/shared/alm packages/tests/shared/multicast packages/tests/shared/services packages/tests/shared-web/messages`
      — an existing pin that encoded "a duplicate on the other carrier states no ACK" moves to one
      repeated ACK; name each moved pin with its file and old/new figure in the commit body, and stop for
      a ruling if one encodes something else. Then the per-task validation list (Deno checks and
      `npm run test:deno`: `packages/shared` changed; the bundle checks: the inbound owner ships in the
      browser, and a crossed ceiling is raised in this commit by the Task 3 Step 8 rule, with this run's
      figure, R-S3b-2). The changed-style report must show no new finding on
      `compute-al-inbound-duplicate-changes.ts`; if it reaches the warn tier of 50, move
      `isCrossCarrierCopy` and `toOwnRepeatedAck` into a sibling file under `inbound/admission/` and keep
      the call line.

- [ ] **Step 15: Commit and push.** Also `git add` every moved-pin file named in the commit body and,
      when a ceiling was raised, the three bundle files Task 1 Step 11 names.

```bash
git add packages/shared/alm/inbound/admission/compute-al-inbound-duplicate-changes.ts packages/shared/alm/inbound/README.md packages/tests/shared/alm/inbound/compute-al-inbound-duplicate-changes.test.ts
git commit -m "feat(alm): a duplicate on the other carrier than its first admission is acknowledged again over its arrival carrier (R-S3b-1)"
git push
```

---

### Task 3: The fallback controller

**Files:**

- Create: `packages/shared-web/browser/messages/browser-message-fallback-controller.ts`
- Modify: as "The fallback controller" above.
- Test: create `packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts`; modify
  `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts:34-39,284-289,543-548`.

**Interfaces:**

- Consumes Task 2's `resolveALDeliveryFallbackTrigger`, the `carrier-fallback` settlement and
  `WebRtcRxStreamerService.handOverOutbox`; Task 1's `receipt-exhausted`.
- Produces `interface BrowserMessageFallbackCandidate { readonly message: ALMessage; readonly context: ApiMiddleware; readonly readmit: () => Promise<void>; }`,
  `class BrowserMessageFallbackController` with `watch(candidate): void`, `release(msgId: string): void`,
  `observe(settlement: ALDeliverySettlement): readonly ALDeliverySettlement[]`.
- Produces `BrowserRallarDeliveryRegistry.watchFallback(candidate: BrowserMessageFallbackCandidate): void`.
- Produces the public type exports `ALDeliveryCarrierFallback` and `ALDeliveryFallbackReason` from
  `rallar.ts`, `rallar-core.ts`, `rallar-messages.ts`.
- Task 4's `attemptCarriers` and Task 5's scenarios observe what this task does.

- [ ] **Step 1: RED — the controller through the dispatch and the registry.** In
      `packages/tests/shared-web/api-middleware-test-double.ts` add
      `handOverOutbox: vi.fn(async () => undefined),` after `enqueueOutboxIfAbsent` in
      `createRtcRxStreamerDouble` (`:169-174`). Create
      `packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts`:

```ts
import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import {
    AL_DELIVERY_ADMITTED_STATES,
    type ALDeliveryCarrier,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const FROZEN_AUDIENCE = { recipientPeerIds: ['peer-1'], snapshotVersion: 4 };
const EXHAUSTED_DETAIL = 'The receipt ran out of retries after 3 of 3.';

interface FallbackAdmission {
    readonly carrier: ALDeliveryCarrier;
    readonly message: ALMessage;
}

interface FallbackFixture {
    readonly admissions: FallbackAdmission[];
    readonly handedOver: string[];
    settle(settlement: ALDeliverySettlement): void;
    send(firstCarrier: ALDeliveryCarrier, ttlMs: number): Promise<RallarMessageHandle>;
}

/** The production dispatch, registry and session owner over carrier doubles that admit everything. */
function createFallbackFixture(): FallbackFixture {
    const admissions: FallbackAdmission[] = [];
    const handedOver: string[] = [];
    const admit = async (
        carrier: ALDeliveryCarrier,
        message: ALMessage
    ): Promise<ALOutboundEnqueueResult> => {
        // The RTC admission freezes the room, as the overlay planner does; WS takes the envelope it is handed.
        const admitted = carrier === 'rtc'
            ? toALFrozenMulticastMessage(message, FROZEN_AUDIENCE)
            : message;
        admissions.push({ carrier, message: admitted });
        return {
            verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 },
            message: admitted,
            entries: [],
            trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(admitted)
        };
    };
    const context = createDefaultApiMiddlewareTestDouble({
        middleware: {
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: (message) => admit('rtc', message),
                handOverOutbox: async (msgId) => {
                    handedOver.push(msgId);
                }
            },
            webSocketQueueBox: { enqueueOutboxIfAbsent: (message) => admit('ws', message) }
        }
    });
    const deliveries = new BrowserRallarDeliveryRegistry({
        nowMs: Date.now,
        retainTerminalMs: 60_000,
        maxEntries: 512,
        cancel: () => {}
    });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(deliveries, {
        deliverySettlements: feed,
        readMiddleware: () => context
    });
    sessionDeliveries.beginSession(context.session);
    const epoch = feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
    const dispatch = new BrowserRallarMessageDispatch({
        deliveries,
        sessionDeliveries,
        nowMs: Date.now
    });
    return {
        admissions,
        handedOver,
        settle: (settlement) => epoch.settlements[settlement.carrier](settlement),
        send: async (firstCarrier, ttlMs) => {
            const message = newALMulticastMessage(
                context.session.sessionId,
                { topicId: 'room.command', resourceId: crypto.randomUUID(), contextId: 'room-1' },
                ROOM,
                'room.command.v1',
                { action: 'ready' },
                { reliability: 'at-least-once', ack: 'receiver', ttlMs }
            );
            const handle = deliveries.open(message, firstCarrier);
            dispatch.send({
                context,
                carrier: firstCarrier,
                message,
                canFallback: true,
                payloadIssues: []
            });
            await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });
            return handle;
        }
    };
}

function toNotReady(
    msgId: string,
    attemptId: string
): Extract<ALDeliverySettlement, Readonly<{ kind: 'attempt-settled'; }>> {
    return {
        kind: 'attempt-settled',
        msgId,
        carrier: 'rtc',
        atMs: Date.now(),
        attemptId,
        outcome: 'not-ready',
        submissionAttempted: false,
        detail: 'The RTC frame was dropped.',
        willRetry: true
    };
}

function toExhausted(msgId: string, carrier: ALDeliveryCarrier): ALDeliverySettlement {
    return {
        kind: 'receipt-exhausted',
        msgId,
        carrier,
        atMs: Date.now(),
        mode: 'receiver',
        confirmedPeerIds: [],
        unconfirmedPeerIds: ['peer-1'],
        detail: EXHAUSTED_DETAIL
    };
}

function toReceipt(
    msgId: string,
    carrier: ALDeliveryCarrier,
    confirmed: readonly string[]
): ALDeliverySettlement {
    return {
        kind: 'acknowledgement',
        msgId,
        carrier,
        atMs: Date.now(),
        mode: 'receiver',
        confirmedHopPeerIds: [],
        unconfirmedHopPeerIds: [],
        expectedRecipientPeerIds: ['peer-1'],
        confirmedRecipientPeerIds: confirmed,
        unconfirmedRecipientPeerIds: ['peer-1'].filter((peerId) => !confirmed.includes(peerId)),
        complete: confirmed.length === 1
    };
}

/** The WS admission's own settlement follows its carrier call in a later microtask; one task turn lands it. */
async function waitForCarriers(
    fixture: FallbackFixture,
    carriers: readonly ALDeliveryCarrier[]
): Promise<void> {
    await vi.waitFor(() =>
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(carriers)
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('post-admission fallback within the deadline (D56)', () => {
    it('hands the RTC leg to WS on the third consecutive not-ready attempt, with the frozen envelope and its deadline', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);

        fixture.settle(toNotReady(handle.msgId, 'send-a'));
        fixture.settle(toNotReady(handle.msgId, 'send-b'));
        expect(fixture.handedOver).toEqual([]);
        fixture.settle(toNotReady(handle.msgId, 'send-a'));

        await waitForCarriers(fixture, ['rtc', 'ws']);
        expect(fixture.handedOver).toEqual([handle.msgId]);
        // Same msgId, frozen audience and `expiresAtMs`: the WS leg is the envelope the RTC admission returned.
        expect(fixture.admissions[1]!.message).toEqual(fixture.admissions[0]!.message);
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({
            from: 'rtc',
            to: 'ws',
            reason: 'not-ready'
        });
        expect(handle.lifecycle().state).toBe('queued');
    });

    it('restarts the count when an RTC attempt is sent', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);

        fixture.settle(toNotReady(handle.msgId, 'send-a'));
        fixture.settle(toNotReady(handle.msgId, 'send-a'));
        fixture.settle({
            ...toNotReady(handle.msgId, 'send-b'),
            outcome: 'sent',
            submissionAttempted: true,
            willRetry: false
        });
        fixture.settle(toNotReady(handle.msgId, 'send-a'));
        fixture.settle(toNotReady(handle.msgId, 'send-a'));

        expect(fixture.handedOver).toEqual([]);
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['rtc']);
    });

    it('hands over a receipt that ran out on RTC instead of failing the handle', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);

        fixture.settle(toExhausted(handle.msgId, 'rtc'));

        await waitForCarriers(fixture, ['rtc', 'ws']);
        expect(handle.lifecycle().state).not.toBe('failed');
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({
            reason: 'receipt-exhausted',
            detail: EXHAUSTED_DETAIL
        });
    });

    it('hands over a spent not-yet-in-sync budget', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);

        fixture.settle({
            kind: 'not-yet-in-sync-exhausted',
            msgId: handle.msgId,
            carrier: 'rtc',
            atMs: Date.now(),
            detail: 'The not-yet-in-sync retry budget of 3 ran out.'
        });

        await waitForCarriers(fixture, ['rtc', 'ws']);
        expect(handle.lifecycle().evidence.carrierFallback).toMatchObject({
            reason: 'not-yet-in-sync-exhausted'
        });
    });

    it('falls back once, and a late RTC receipt moves nothing once WS owns the receipt', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 30_000);
        fixture.settle(toExhausted(handle.msgId, 'rtc'));
        await waitForCarriers(fixture, ['rtc', 'ws']);

        fixture.settle(toReceipt(handle.msgId, 'ws', ['peer-1']));
        const acknowledged = handle.lifecycle();
        fixture.settle(toReceipt(handle.msgId, 'rtc', []));
        fixture.settle(toExhausted(handle.msgId, 'rtc'));

        expect(acknowledged.state).toBe('acknowledged');
        expect(handle.lifecycle().evidence).toEqual(acknowledged.evidence);
        expect(fixture.handedOver).toEqual([handle.msgId]);
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['rtc', 'ws']);
    });

    it('stays on RTC once the deadline passed: the receipt end is the message end', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('rtc', 50);
        await new Promise((resolve) => setTimeout(resolve, 60));

        fixture.settle(toExhausted(handle.msgId, 'rtc'));

        expect(handle.lifecycle().state).toBe('failed');
        expect(fixture.handedOver).toEqual([]);
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['rtc']);
    });

    it('never watches the WS-first leg of ws-then-rtc (Q1)', async () => {
        const fixture = createFallbackFixture();
        const handle = await fixture.send('ws', 30_000);

        fixture.settle(toExhausted(handle.msgId, 'ws'));

        expect(handle.lifecycle().state).toBe('failed');
        expect(fixture.admissions.map((admission) => admission.carrier)).toEqual(['ws']);
    });
});
```

- [ ] **Step 2: Run the RED test.**

Run: `npx vitest run packages/tests/shared-web/messages/browser-message-fallback-controller.test.ts`
Expected: FAIL — no WS admission follows a trigger, the receipt-exhausted case reads `failed`, and
`carrierFallback` stays undefined.

- [ ] **Step 3: Implement the controller.** Create
      `packages/shared-web/browser/messages/browser-message-fallback-controller.ts`:

```ts
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { resolveALDeliveryFallbackTrigger } from '@shared/alm/delivery/resolve-al-delivery-fallback-trigger.ts';

/**
 * The admitted RTC leg of an `rtc-with-ws-fallback` send: what a hand-over needs, and the dispatch's own
 * admission of the same envelope on WS, so the dispatch stays the one place that admits (Q2).
 */
export interface BrowserMessageFallbackCandidate {
    /** The envelope the RTC admission returned: its frozen audience and its deadline travel to WS unchanged. */
    readonly message: ALMessage;
    /** The middleware whose RTC owner hands the message over. */
    readonly context: ApiMiddleware;
    /** Admits `message` on WS with `canFallback: false` in the epoch the first leg captured; never rejects. */
    readonly readmit: () => Promise<void>;
}

/** One watched RTC leg and the consecutive `not-ready` attempts counted on it so far. */
interface BrowserMessageFallbackWatch {
    readonly candidate: BrowserMessageFallbackCandidate;
    notReadyRun: number;
}

export namespace BrowserMessageFallbackController {
    export interface Input {
        readonly nowMs: () => number;
    }
}

/**
 * Post-admission fallback for `rtc-with-ws-fallback` (D56). The registry hands it every settlement it
 * records; on a declared retryable outcome of a watched RTC leg inside the unchanged deadline it hands the
 * message to WS once: the RTC owner ends its own work without a `cancelled`, and the dispatch admits the
 * same envelope on WS. A durable message resumed after a reload has no handle, so it is never watched (Q9).
 */
export class BrowserMessageFallbackController {
    private readonly input: BrowserMessageFallbackController.Input;
    private readonly watches = new Map<string, BrowserMessageFallbackWatch>();

    constructor(input: BrowserMessageFallbackController.Input) {
        this.input = input;
    }

    /** The first registration of a msgId wins: a fallback re-sends the same envelope. */
    watch(candidate: BrowserMessageFallbackCandidate): void {
        const msgId = candidate.message.id.msgId;
        if (!this.watches.has(msgId)) {
            this.watches.set(msgId, { candidate, notReadyRun: 0 });
        }
    }

    release(msgId: string): void {
        this.watches.delete(msgId);
    }

    /**
     * What the registry records for this settlement: the settlement itself, or, when it ends a watched RTC
     * leg inside the deadline, the `carrier-fallback` beside it -- instead of it for a `receipt-exhausted`,
     * which would otherwise end a message the WS leg now owns.
     */
    observe(settlement: ALDeliverySettlement): readonly ALDeliverySettlement[] {
        const watch = this.watches.get(settlement.msgId);
        if (watch === undefined) {
            return [settlement];
        }
        const trigger = resolveALDeliveryFallbackTrigger({
            settlement,
            leg: 'rtc',
            notReadyRun: watch.notReadyRun
        });
        if (trigger.kind === 'continue') {
            watch.notReadyRun = trigger.notReadyRun;
            return [settlement];
        }
        this.watches.delete(settlement.msgId);
        const atMs = this.input.nowMs();
        if (isPastDeadline(watch.candidate.message, atMs)) {
            return [settlement];
        }
        void this.writeFallback(watch.candidate);
        const fallback: ALDeliverySettlement = {
            kind: 'carrier-fallback',
            msgId: settlement.msgId,
            carrier: 'rtc',
            atMs,
            to: 'ws',
            reason: trigger.reason,
            detail: trigger.detail
        };
        return settlement.kind === 'receipt-exhausted' ? [fallback] : [settlement, fallback];
    }

    /** A hand-over that fails leaves the WS leg to try anyway: the RTC owner is gone or disposed. */
    private async writeFallback(candidate: BrowserMessageFallbackCandidate): Promise<void> {
        const msgId = candidate.message.id.msgId;
        await candidate.context.middleware.rtcRxStreamer.handOverOutbox(msgId).catch(
            (error: unknown) => {
                console.error(
                    `AL RTC hand-over of ${msgId} failed; admitting it on WS anyway`,
                    error
                );
            }
        );
        await candidate.readmit();
    }
}

function isPastDeadline(message: ALMessage, nowMs: number): boolean {
    const expiresAtMs = message.constraints?.expiresAtMs;
    return expiresAtMs !== undefined && expiresAtMs <= nowMs;
}
```

    No settlement can reach the registry from the hand-over before `observe` returns: `handOverOutbox`
    is async and the aborted attempt settles through its transport promise.

- [ ] **Step 4: Wire the registry.** In `packages/shared-web/browser/messages/browser-rallar-delivery-registry.ts`
      import `BrowserMessageFallbackController` and `type BrowserMessageFallbackCandidate` from
      `./browser-message-fallback-controller.ts`; add the field and construct it in the constructor
      (`:69-75`):

```ts
    private readonly fallback: BrowserMessageFallbackController;

    constructor(input: BrowserRallarDeliveryRegistry.Input) {
        this.input = input;
        this.fallback = new BrowserMessageFallbackController({ nowMs: input.nowMs });
    }
```

    add after `updateDeadline`:

```ts
/** The dispatch hands the admitted RTC leg of an `rtc-with-ws-fallback` send to the one fallback owner (D56). */
watchFallback(candidate: BrowserMessageFallbackCandidate): void {
    const observation = this.entries.get(candidate.message.id.msgId)?.observation;
    if (observation !== undefined && !isALDeliveryTerminal(observation.lifecycle)) {
        this.fallback.watch(candidate);
    }
}
```

    replace the body of `record` after its `entry === undefined` guard (`:116-120`) with:

```ts
for (const recorded of this.fallback.observe(settlement)) {
    entry.observation.carrier = recorded.carrier;
    this.publishLifecycle(
        entry.observation,
        computeALDeliveryLifecycle(entry.observation.lifecycle, recorded)
    );
}
```

    and in `publishLifecycle` (`:179-181`) release the candidate when the lifecycle first ends:

```ts
if (observation.terminalAtMs === undefined && isALDeliveryTerminal(next)) {
    observation.terminalAtMs = this.input.nowMs();
    this.fallback.release(observation.msgId);
}
```

- [ ] **Step 5: Wire the dispatch.** In `packages/shared-web/browser/messages/browser-rallar-message-dispatch.ts`
      replace `send` (`:60-78`) with:

```ts
    send(delivery: BrowserRallarMessageDispatch.Delivery): void {
        const epoch = this.input.sessionDeliveries.capture(delivery.context);
        if (!epoch) {
            this.input.deliveries.release(delivery.message.id.msgId);
            return;
        }
        void this.writeLeg(delivery, epoch);
    }

    /** One carrier leg, whose failure is stated as its admission and never thrown. */
    private async writeLeg(
        delivery: BrowserRallarMessageDispatch.Delivery,
        lifetime: BrowserDeliverySettlements.Epoch
    ): Promise<void> {
        await this.writeCapturedMessage(delivery, lifetime).catch((caught) => {
            if (lifetime.isOpen()) {
                lifetime.settlements[delivery.carrier]({
                    kind: 'admission',
                    msgId: delivery.message.id.msgId,
                    carrier: delivery.carrier,
                    atMs: this.input.nowMs(),
                    verdict: { kind: 'failed', detail: toError(caught).message },
                    trackedReceiptAlgo: 'none'
                });
            }
        });
    }
```

    in `writeCapturedMessage` call `this.watchFallbackLeg(delivery, result, lifetime);` on the line before
    `sink(toCarrierAdmissionSettlement(admission, this.input.nowMs()));` (`:106`), and add after it:

```ts
/** An admitted RTC leg of `rtc-with-ws-fallback` may still hand over after admission (D56); `ws-then-rtc` does not (Q1). */
private watchFallbackLeg(
    delivery: BrowserRallarMessageDispatch.Delivery,
    result: CapturedMessageAdmission,
    lifetime: BrowserDeliverySettlements.Epoch
): void {
    if (!delivery.canFallback || delivery.carrier !== 'rtc' || !isCarrierOwnedVerdict(result.verdict)) {
        return;
    }
    const wsLeg: BrowserRallarMessageDispatch.Delivery = {
        ...delivery,
        carrier: 'ws',
        message: result.message,
        canFallback: false
    };
    this.input.deliveries.watchFallback({
        message: result.message,
        context: delivery.context,
        readmit: () => this.writeLeg(wsLeg, lifetime)
    });
}
```

    and the module function beside `toUnadmittedAdmission`:

```ts
/** The carrier owns the message now: admitted, already held, or retained for its own replay. */
function isCarrierOwnedVerdict(verdict: ALDeliveryAdmissionVerdict): boolean {
    return verdict.kind === 'admitted' || verdict.kind === 'duplicate' ||
        verdict.kind === 'pending';
}
```

- [ ] **Step 6: GREEN.** Run the Step 2 command. Expected: PASS. Then
      `npx vitest run packages/tests/shared-web/messages packages/tests/shared-web/connection packages/tests/shared-web/director packages/tests/shared-test/rallar-browser-runtime`.

- [ ] **Step 7: The public types and the snapshot.** In `packages/shared-web/browser/rallar.ts` (`:273-280`),
      `rallar-core.ts` (`:118-125`) and `rallar-messages.ts` (`:35-42`) make the type export block:

```ts
export type {
    ALDeliveryAttempt,
    ALDeliveryCarrierFallback,
    ALDeliveryEvidence,
    ALDeliveryFallbackReason,
    ALDeliveryLifecycle,
    ALDeliveryReceiptEvidence,
    ALDeliveryRelayRejection,
    ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
```

    and in `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` insert
    `'ALDeliveryCarrierFallback',` after `'ALDeliveryAttempt',` and `'ALDeliveryFallbackReason',` after
    `'ALDeliveryEvidence',` in the three `types` lists (`:34-39`, `:284-289`, `:543-548`).

- [ ] **Step 8: Measure the bundles.** Run
      `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
      and `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`. This re-measures on top of
      any ceiling Task 1 or Task 2 already raised (R-S3b-2). For each budgeted entry whose measured brotli
      size crossed its ceiling (the facade `222`, the headless `284`, or any other entry in
      `budgetedEntries`), raise the ceiling to the next whole KiB above the measured figure in the test and
      in `packages/shared-web/scripts/measure-browser-bundles.mjs` for every crossed entry (the script
      mirrors every budgeted entry, `:40-90`), and extend the entry's comment with one sentence carrying the
      measured figure from this run, for the facade:
      `S3b's post-admission fallback (the declared retryable outcomes, the receipt ends and the fallback controller) measures <measured> KiB here; the next whole-KiB ceiling is <ceiling>.`
      and for the headless test the same sentence with its own measured figure. Record every measured
      figure (crossed or not) in the commit body.

- [ ] **Step 9: Validate.** The per-task validation list, with the bundle checks and the smoke lane
      (the smoke lane still has no post-admission trigger; it proves nothing regressed, verify the
      summary line).

- [ ] **Step 10: Commit and push.** Also `git add` every moved-pin file named in the commit body (such as
      those under `packages/tests/shared-test/rallar-browser-runtime`).

```bash
git add packages/shared-web packages/tests/shared-web packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts
git commit -m "feat(alm): the fallback controller -- an admitted RTC leg hands over to WS once within its deadline (D56)"
git push
```

---

### Task 4: Harness evidence — each attempt's carrier

**Files:**

- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/black-box-rallar-delivery-ledger.ts:58-59`,
  `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts:361-375`,
  `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-result-values.ts:40-49`,
  `packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts:56-67,125-146,260-269`,
  `packages/shared-test/rallar-bb-test/alm/rallar-black-box-alm-command-capabilities.ts:40,93`.
- Test: modify `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts:26,78-93,140-156`,
  `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts:85-100,484-500,890-899`,
  `packages/tests/shared-test/alm-lifecycle-recipes.test.ts:102-117`,
  `packages/tests/rallar-black-box/live-rtc-control-client.test.ts:210,321,431,497,692,756`,
  `apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts:394-409`.

**Interfaces:**

- Consumes the lifecycle's existing `ALDeliveryAttempt.carrier` (Task 3 makes both carriers appear on one handle).
- Produces `readonly attemptCarriers: readonly ALDeliveryCarrier[]` — the carrier of every settled attempt,
  index-aligned with `attemptOutcomes` — on `BlackBoxRallarDeliveryObservation` and
  `RallarBlackBoxTestMessagesObserveResultValue`; `decodeAlmDeliveryResultValue` refuses an unknown carrier
  or a list whose length differs from `attemptOutcomes`.
- Task 5 asserts on `attemptCarriers` with the `contains` operator.

- [ ] **Step 1: RED — the page projection.** In `packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts`
      extend the lifecycle import (`:26`) to `import { AL_DELIVERY_STATES, type ALDeliveryAdmissionVerdict, type ALDeliveryCarrier } from '@shared/alm/delivery/al-delivery-lifecycle.ts';`,
      add `attemptCarriers: [],` after `attemptOutcomes: [],` in `unknownObservation` (`:82`) and in the
      `queued` expectation (`:146`), and add after the test that ends at `:231`:

```ts
it('projects the carrier of every settled attempt beside its outcome, in attempt order (D56)', async () => {
    const runtime = await loadRuntime();
    const delivery = openDelivery({ kind: 'admitted', durable: false, queuedAttempts: 1 });
    facade.behavior.typedSend.mockResolvedValue(delivery.handle);
    await runtime.connect(connection);
    await runtime.sendMessage(send);
    const settleAttempt = (
        carrier: ALDeliveryCarrier,
        attemptId: string,
        outcome: 'not-ready' | 'sent'
    ) => {
        delivery.registry.record({
            kind: 'attempt-started',
            msgId: delivery.msgId,
            carrier,
            atMs: Date.now(),
            attemptId
        });
        delivery.registry.record({
            kind: 'attempt-settled',
            msgId: delivery.msgId,
            carrier,
            atMs: Date.now(),
            attemptId,
            outcome,
            submissionAttempted: outcome === 'sent',
            detail: undefined,
            willRetry: outcome === 'not-ready'
        });
    };

    settleAttempt('rtc', 'rtc-attempt', 'not-ready');
    settleAttempt('ws', 'ws-attempt', 'sent');

    expect(await runtime.readReceipts(query)).toMatchObject({
        attempts: 2,
        attemptOutcomes: ['not-ready', 'sent'],
        attemptCarriers: ['rtc', 'ws']
    });
});
```

- [ ] **Step 2: RED — the decoder.** In `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`
      add `attemptCarriers: ['rtc', 'ws'],` after `attemptOutcomes: ['refused', 'sent'],` in
      `DELIVERY_OBSERVATION` (`:97`) and in the decoded expectation (`:497`), and add two rows to the
      malformed-field table (`:890-899`):

```ts
{ field: 'attemptCarriers', value: ['server', 'ws'] },
{ field: 'attemptCarriers', value: ['ws'] },
```

- [ ] **Step 3: Run the RED tests.**

Run: `npx vitest run packages/tests/shared-test/rallar-browser-runtime/delivery.test.ts packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`
Expected: FAIL — the projection has no `attemptCarriers`, and the decoder neither returns nor checks it.

- [ ] **Step 4: Implement the projection and the contract.** In the ledger (`:59`) add after
      `attemptOutcomes`:

```ts
attemptCarriers: attempts.flatMap((attempt) => attempt.outcome === undefined ? [] : [attempt.carrier]),
```

    In `black-box-rallar-operation-contracts.ts` and in `rallar-black-box-alm-result-values.ts` add after
    `attemptOutcomes`:

```ts
/** The carrier of every settled attempt, index-aligned with `attemptOutcomes`: a hand-over reads `rtc` then `ws` (D56). */
readonly attemptCarriers: readonly ALDeliveryCarrier[];
```

    (both files already import `ALDeliveryCarrier`).

- [ ] **Step 5: Implement the decoder.** In `packages/shared-test/rallar-bb-test/alm/decode-alm-runtime-result.ts`
      make `decodeAlmDeliveryResultValue` (`:125-146`):

```ts
export function decodeAlmDeliveryResultValue(
    value: unknown
): RallarBlackBoxTestMessagesObserveResultValue {
    const record = decodeAlmRuntimeRecord(value);
    const path = 'delivery observation';
    const attemptOutcomes = requireAlmAttemptOutcomesField(record, path);
    return {
        handleId: requireAlmStringField(record, path, 'handleId'),
        state: requireAlmDeliveryState(record, path, 'state'),
        submitted: requireAlmBooleanField(record, path, 'submitted'),
        enqueued: requireAlmBooleanField(record, path, 'enqueued'),
        receiptMode: readAlmReceiptModeField(record, path),
        relayRejection: readAlmRelayRejectionField(record, path),
        confirmedHopPeerIds: requireAlmStringListField(record, path, 'confirmedHopPeerIds'),
        unconfirmedHopPeerIds: requireAlmStringListField(record, path, 'unconfirmedHopPeerIds'),
        expectedRecipientPeerIds: requireAlmStringListField(
            record,
            path,
            'expectedRecipientPeerIds'
        ),
        confirmedRecipientPeerIds: requireAlmStringListField(
            record,
            path,
            'confirmedRecipientPeerIds'
        ),
        unconfirmedRecipientPeerIds: requireAlmStringListField(
            record,
            path,
            'unconfirmedRecipientPeerIds'
        ),
        attempts: requireAlmNumberField(record, path, 'attempts'),
        attemptOutcomes,
        attemptCarriers: requireAlmAttemptCarriersField(record, path, attemptOutcomes.length),
        reason: readAlmOptionalStringField(record, path, 'reason')
    };
}
```

    and add after `requireAlmAttemptOutcomesField` (`:260-269`):

```ts
/**
 * One carrier leg per settled attempt, index-aligned with `attemptOutcomes`; the legs are the schema's own
 * `messagesCarrierLeg` list, which `requireAlmCarrierLegField` already decodes against.
 */
function requireAlmAttemptCarriersField(
    record: RallarBlackBoxTestRecord,
    path: string,
    settledAttempts: number
): readonly ALDeliveryCarrier[] {
    const values = requireAlmStringListField(record, path, 'attemptCarriers');
    const carriers = values.flatMap((value) =>
        RALLAR_BLACK_BOX_COMMAND_FIELD_VALUES.messagesCarrierLeg.filter((carrier) =>
            carrier === value
        )
    );
    if (values.length !== settledAttempts || carriers.length !== values.length) {
        throw toAlmInvalidRuntimeResultError(`${path}.attemptCarriers`);
    }
    return carriers;
}
```

    In `rallar-black-box-alm-command-capabilities.ts` make the `messages.observe` prose (`:40`)
    `'The in-page handle projects admission, carrier attempts with their attemptOutcomes and attemptCarriers, a relayRejection, and the ' +`
    and the `messages.receipts` prose (`:93`)
    `'unconfirmedRecipientPeerIds, attempts, attemptOutcomes, attemptCarriers, relayRejection, submission facts and reason. ' +`.

- [ ] **Step 6: Every observation fixture.** Add the field where an observation literal is built:
  - `packages/tests/shared-test/alm-lifecycle-recipes.test.ts:114`: `attemptCarriers: [],` after `attemptOutcomes: [],`;
  - `packages/tests/rallar-black-box/live-rtc-control-client.test.ts:210,321,431,497,692,756`: `attemptCarriers: [],`
    after each `attemptOutcomes: [],`;
  - `apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts:406`: after `attemptOutcomes: ['sent'],`
    add `attemptCarriers: [send?.carrier === 'ws' ? 'ws' : 'rtc'],`.

    Then `git grep -n "attemptOutcomes" -- packages apps ':!apps/rallar-black-box/manifests'` must show an
    `attemptCarriers` beside every observation literal; a literal the grep finds and this list does not
    name gets the same one-line edit.

- [ ] **Step 7: GREEN.** Run the Step 3 command. Expected: PASS. Then
      `npx vitest run packages/tests/shared-test packages/tests/rallar-black-box`,
      `cd apps/rallar-black-box-control-server && deno task test` (or `npm run test:deno`), and the
      per-task validation list (the headless bundle test applies: the decoder ships in the agent bundle;
      a crossed ceiling is raised by the Task 3 Step 8 rule with this run's figure).

- [ ] **Step 8: Commit and push.**

```bash
git add packages/shared-test packages/tests apps/rallar-black-box-control-server/test/control-alm-evidence.test.ts
git commit -m "test(alm): messages.observe projects each settled attempt's carrier beside its outcome"
git push
```

---

### Task 5: The three scenarios and the five fallback cells

**Files:**

- Create: `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/fallback-within-deadline.ts`,
  `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/receipt-exhausted-fallback.ts`,
  `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/no-fallback-after-deadline.ts`
- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts:1`,
  `alm-conformance-fault-commands.ts:12-27` (one private builder for both fault commands),
  `alm-conformance-message-commands.ts:43-45,56-63,91-100,203-214` (`toHandedOverAssertions` beside
  `toResultAssertion`: `conformance/alm` already holds 20 direct `.ts` files and `layout.directory-density`
  fires above 20, R-S3b-3), `scenarios/cross-carrier-duplicate.ts:10,26,33` (the shared fallback-cell
  constant), `alm-conformance-scenario-definition.ts:18-29`, `create-alm-conformance-recipes.ts:30-40,72-84`,
  `apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts:57-59`, and the regenerated
  `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json` (the only manifest that
  embeds the two-agent family; 19–22 are unaffected).
- Test: create `packages/tests/shared-test/alm-conformance-fallback-scenarios.test.ts`; modify
  `packages/tests/shared-test/alm-conformance-recipes.test.ts:139-151,309-322`,
  `packages/tests/shared-test/alm-conformance-recipe-validation.test.ts:48-64`.

**Interfaces:**

- Consumes Task 4's `attemptCarriers` and Tasks 1–3's behaviour, including Task 2's cross-carrier re-ACK
  (R-S3b-1, Steps 11–15), which `receipt-exhausted-fallback`'s `acknowledged` pin needs.
- Produces `ALM_CONFORMANCE_FALLBACK_CARRIERS: readonly AlmConformanceCarrier[]` (`['rtc-with-ws-fallback']`),
  `toRtcDropFaultCommand(step: AlmConformanceStepInput, name: string, remaining: 'until-cleared' | 0): RallarBlackBoxTestCommand`,
  `toHandedOverAssertions(sender: AlmConformanceStepInput, resultName: string): readonly RallarBlackBoxTestCommand[]`
  (in `alm-conformance-message-commands.ts`, R-S3b-3),
  an optional `budgetMs` on the observe input (absent: the state's own budget) and `'contains'` on the
  result-assertion operator.
- Produces `AlmConformanceScenarioId` members `'fallback-within-deadline' | 'receipt-exhausted-fallback' | 'no-fallback-after-deadline'`,
  registered after `...notYetInSync` and before `...receiptedAudience`.

- [ ] **Step 1: RED — the scenarios.** Create `packages/tests/shared-test/alm-conformance-fallback-scenarios.test.ts`:

```ts
import {
    describe,
    expect,
    it
} from 'vitest';

import {
    EXPIRY_TTL_MS,
    MESSAGE_CONTROL_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS
} from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts';
import {
    createAlmConformanceRecipes,
    type AlmConformanceScenario
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { toRtcAckTrackingPlan } from '@shared/multicast/to-rtc-ack-tracking-plan.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const FALLBACK_SCENARIO_KEYS = [
    'fallback-within-deadline',
    'receipt-exhausted-fallback',
    'no-fallback-after-deadline'
];

function scenarioOf(key: string): AlmConformanceScenario {
    const scenario = createAlmConformanceRecipes(toConformanceInput('rtc-with-ws-fallback'))
        .find((candidate) => candidate.scenarioKey === key);
    if (scenario === undefined) {
        throw new Error(`rtc-with-ws-fallback must run ${key}.`);
    }
    return scenario;
}

/** The scenario's own commands: after the connect, without the storage reading and the closing stats. */
function bodyOf(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestCommand[] {
    return recipe.commands
        .slice(recipe.commands.findIndex((command) => command.kind === 'rtc.connect') + 1, -1)
        .filter((command) => command.kind !== 'storage.counters');
}

function shapeOf(command: RallarBlackBoxTestCommand): string {
    switch (command.kind) {
        case 'fault.inject':
            return `fault.inject:${command.carrier}:${String(command.remaining)}`;
        case 'wait':
            return `wait:${command.match.kind}${command.absent === true ? ':absent' : ''}`;
        case 'messages.received':
            return `received:${command.count}${command.absent === true ? ':absent' : ''}`;
        default:
            return command.kind;
    }
}

function assertionsOf(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return bodyOf(recipe).flatMap((command) =>
        command.kind === 'assert'
            ? [`${command.source.split('.value.')[1]} ${command.operator} ${
                String(command.expected)
            }`]
            : []
    );
}

describe('the fallback-within-the-deadline family (D56)', () => {
    it('runs on the fallback cell only, two agents each', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const keys = createAlmConformanceRecipes(toConformanceInput(carrier))
                .map((scenario) => scenario.scenarioKey)
                .filter((key) => FALLBACK_SCENARIO_KEYS.includes(key));
            expect(keys, carrier).toEqual(
                carrier === 'rtc-with-ws-fallback' ? FALLBACK_SCENARIO_KEYS : []
            );
        }
        for (const key of FALLBACK_SCENARIO_KEYS) {
            expect(scenarioOf(key).roles, key).toEqual(['sender', 'receiver']);
        }
        expect(scenarioOf('fallback-within-deadline').tags).toEqual(['smoke', 'full']);
        expect(scenarioOf('receipt-exhausted-fallback').tags).toEqual(['full']);
        expect(scenarioOf('no-fallback-after-deadline').tags).toEqual(['full']);
    });

    it('drops the sender RTC leg until WS delivers it, and proves both carriers on the handle', () => {
        const scenario = scenarioOf('fallback-within-deadline');

        expect(bodyOf(scenario.sender).map(shapeOf)).toEqual([
            'fault.inject:rtc:until-cleared',
            'messages.send',
            'messages.observe',
            'assert',
            'messages.observe',
            'assert',
            'assert',
            'assert',
            'fault.inject:rtc:0'
        ]);
        expect(assertionsOf(scenario.sender)).toEqual([
            'state matches ^(accepted|queued|transport-accepted|acknowledged)$',
            'state equals acknowledged',
            'attemptCarriers contains rtc',
            'attemptCarriers contains ws'
        ]);
        expect(bodyOf(scenario.receiver).map(shapeOf)).toEqual([
            'received:1',
            'received:2:absent',
            'wait:diagnostic'
        ]);
        const arrival = bodyOf(scenario.receiver).at(-1);
        expect(arrival?.kind === 'wait' ? arrival.match.contains : undefined)
            .toContain('"carrier":"ws","outcome":"committed","reason":"admitted"');
    });

    it('holds the receiver RTC ACK until the receipt runs out and WS acknowledges the duplicate', () => {
        const scenario = scenarioOf('receipt-exhausted-fallback');

        expect(bodyOf(scenario.sender).map(shapeOf)).toEqual([
            'messages.send',
            'messages.observe',
            'assert',
            'messages.observe',
            'assert',
            'assert',
            'assert'
        ]);
        const observe = bodyOf(scenario.sender)[3];
        expect(observe?.kind === 'messages.observe' ? observe.timeoutMs : undefined)
            .toBe(NON_EXPIRING_SEND_TIMEOUT_MS + MESSAGE_CONTROL_TIMEOUT_MS);
        expect(bodyOf(scenario.receiver).map(shapeOf)).toEqual([
            'fault.inject:rtc:until-cleared',
            'received:1',
            'received:2:absent',
            'wait:diagnostic',
            'fault.inject:rtc:0'
        ]);
    });

    it('lets an expiring send end before the RTC receipt budget, with no WS copy (C7)', () => {
        const scenario = scenarioOf('no-fallback-after-deadline');

        expect(bodyOf(scenario.sender).map(shapeOf))
            .toEqual(['messages.send', 'messages.observe', 'assert', 'messages.observe', 'assert']);
        expect(assertionsOf(scenario.sender).at(-1)).toBe('state equals expired');
        expect(bodyOf(scenario.receiver).map(shapeOf))
            .toEqual([
                'fault.inject:rtc:until-cleared',
                'received:1',
                'wait:diagnostic:absent',
                'fault.inject:rtc:0'
            ]);
    });

    it('keeps the expiring lifetime under the default RTC receipt budget, so no receipt end precedes the deadline', () => {
        const message = newALMulticastMessage(
            'sender',
            {
                topicId: 'room.alm-conformance',
                resourceId: 'receipt-budget',
                contextId: 'room-alm'
            },
            { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' },
            'alm.conformance',
            {},
            { reliability: 'at-least-once', ack: 'receiver', ttlMs: EXPIRY_TTL_MS }
        );

        const tracking = toRtcAckTrackingPlan(normalizeALQosPolicy(message).effective, [
            'receiver'
        ]);
        if (tracking === undefined) {
            throw new Error('A receiver-acknowledged send must track an RTC receipt.');
        }

        // The last window the RTC owner writes closes after the first timeout and every retry.
        expect(EXPIRY_TTL_MS).toBeLessThan(tracking.timeoutMs * (tracking.maxAttempts + 1));
    });
});
```

- [ ] **Step 2: Run the RED test.**

Run: `npx vitest run packages/tests/shared-test/alm-conformance-fallback-scenarios.test.ts`
Expected: FAIL — `rtc-with-ws-fallback must run fallback-within-deadline.` (the last case passes).

- [ ] **Step 3: The shared pieces.** In `alm-conformance-carriers.ts` add:

```ts
/** The only cell with a second carrier to hand an admitted message to (D56). */
export const ALM_CONFORMANCE_FALLBACK_CARRIERS: readonly AlmConformanceCarrier[] = [
    'rtc-with-ws-fallback'
];
```

    In `scenarios/cross-carrier-duplicate.ts` delete the private `FALLBACK_CARRIERS` (`:25-26`, with its
    comment), replace the type import of `AlmConformanceCarrier` (`:10`, used only there) with
    `import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../alm-conformance-carriers.ts';` and make its
    `carriers:` (`:33`) `ALM_CONFORMANCE_FALLBACK_CARRIERS`.

    In `alm-conformance-fault-commands.ts` add `RallarBlackBoxTestFaultInjectCommand` to the contracts type
    import (`:1`) and replace `toHeldFaultCommands` (`:12-27`) with the held faults and the RTC drop, both
    built by one private builder:

```ts
interface AlmConformanceFaultCommandInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    /** Prefixes the scenario's type id: one fault id per carrier and purpose. */
    readonly faultName: string;
    readonly carrier: AlmConformanceFaultCarrier;
    readonly action: 'drop' | 'not-ready';
    readonly remaining: 'until-cleared' | 0;
}

export function toHeldFaultCommands(
    step: AlmConformanceStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): readonly RallarBlackBoxTestCommand[] {
    return toFaultCarriers(step.input.carrier).map((carrier) =>
        toFaultCommand({
            step,
            name: `${name}-${carrier}`,
            faultName: `hold-${carrier}`,
            carrier,
            action: carrier === 'ws' ? 'not-ready' : 'drop',
            remaining
        })
    );
}

/**
 * Drops every RTC frame of the scenario's type this page sends: each attempt settles `not-ready` and its
 * owner resubmits it 50 ms later, so a hold yields the consecutive run D56 hands to WS.
 */
export function toRtcDropFaultCommand(
    step: AlmConformanceStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): RallarBlackBoxTestCommand {
    return toFaultCommand({
        step,
        name,
        faultName: 'drop-rtc',
        carrier: 'rtc',
        action: 'drop',
        remaining
    });
}

function toFaultCommand(
    input: AlmConformanceFaultCommandInput
): RallarBlackBoxTestFaultInjectCommand {
    const typeId = toScenarioTypeId(input.step);
    return {
        kind: 'fault.inject',
        commandId: toCommandId(input.step, input.name),
        faultId: `${input.faultName}-${typeId}`,
        carrier: input.carrier,
        match: { typeId },
        action: input.action,
        remaining: input.remaining,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, input.step.input.deadlineMs)
    };
}
```

    The held faults keep their command and fault ids (`<name>-<carrier>`, `hold-<carrier>-<typeId>`), so
    no recipe pin moves.

    In `alm-conformance-message-commands.ts`: add to `AlmConformanceObserveInput` (`:43-45`)

```ts
/** Absent: the state's own budget; a scenario whose wait outlasts a carrier's retry budget names its own. */
readonly budgetMs?: number;
```

    make the `timeoutMs` of `toObserveCommand` (`:98`)
    `timeoutMs: toBudgetMs(observe.budgetMs ?? toObserveBudgetMs(observe.state), observe.input.deadlineMs)`,
    and widen the operator of `AlmConformanceResultAssertionInput` (`:61`) to
    `readonly operator: 'equals' | 'matches' | 'gt' | 'contains';`.

    and add after `toResultAssertion` (`:203-214`), in the same file (R-S3b-3):

```ts
/**
 * The handle reached its receipt after a hand-over: acknowledged, with a settled attempt on each carrier
 * (D56). Which copy the receiver delivered is the receiver's own evidence.
 */
export function toHandedOverAssertions(
    sender: AlmConformanceStepInput,
    resultName: string
): readonly RallarBlackBoxTestCommand[] {
    return [
        toResultAssertion({
            step: sender,
            name: 'assert-acknowledged-1',
            resultName,
            field: 'state',
            operator: 'equals',
            expected: 'acknowledged'
        }),
        ...(['rtc', 'ws'] as const).map((carrier) =>
            toResultAssertion({
                step: sender,
                name: `assert-${carrier}-attempt-1`,
                resultName,
                field: 'attemptCarriers',
                operator: 'contains',
                expected: carrier
            })
        )
    ];
}
```

- [ ] **Step 4: The scenarios.** Create `scenarios/fallback-within-deadline.ts`:

```ts
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    ASSERT_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    toBudgetMs
} from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../alm-conformance-carriers.ts';
import { toRtcDropFaultCommand } from '../alm-conformance-fault-commands.ts';
import {
    toAdmissionCommands,
    toHandedOverAssertions,
    toObserveCommand,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import {
    toAdmissionOutcomeWait,
    toSingleArrivalReceiverCommands
} from '../alm-conformance-receiver-commands.ts';
import {
    SMOKE_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/**
 * D56: the sender drops its own RTC frames of the send for the whole scenario, so every RTC attempt settles
 * `not-ready`; the third hands the admitted message to WS inside its 30 s deadline, and the receiver
 * delivers the one copy WS carries.
 */
export const fallbackWithinDeadline: AlmConformanceScenarioDefinition = {
    scenarioId: 'fallback-within-deadline',
    scenarioKey: 'fallback-within-deadline',
    tags: SMOKE_TAGS,
    carriers: ALM_CONFORMANCE_FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toFallbackWithinDeadlineSenderCommands,
    toRecipientCommands: toFallbackWithinDeadlineReceiverCommands
};

function toFallbackWithinDeadlineSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toRtcDropFaultCommand(sender, 'hold-rtc', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: {
                ack: 'receiver',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'acknowledged' }),
        ...toHandedOverAssertions(sender, 'observe-acknowledged-1'),
        toRtcDropFaultCommand(sender, 'release-rtc', 0)
    ];
}

/** After the absence window the arrival's own diagnostic is already buffered, so a short budget reads its carrier. */
function toFallbackWithinDeadlineReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toSingleArrivalReceiverCommands(receiver),
        toAdmissionOutcomeWait(receiver, {
            name: 'ws-arrival',
            contains: '"carrier":"ws","outcome":"committed","reason":"admitted"',
            timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
        })
    ];
}
```

    Create `scenarios/receipt-exhausted-fallback.ts`:

```ts
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import {
    ASSERT_TIMEOUT_MS,
    MESSAGE_CONTROL_TIMEOUT_MS,
    NON_EXPIRING_SEND_TIMEOUT_MS,
    NON_EXPIRING_TTL_MS,
    toBudgetMs
} from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toHandedOverAssertions,
    toObserveCommand,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toAckHoldFaultCommand } from '../alm-conformance-receipt-commands.ts';
import {
    toAdmissionOutcomeWait,
    toSingleArrivalReceiverCommands
} from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/**
 * The RTC receipt budget alone runs ≈8 s from admission (a 2 000 ms ACK timeout, then three retries); the WS
 * copy and its server receipt follow it, so the acknowledged wait outlasts the state's own 10 s budget.
 */
const RECEIPT_EXHAUSTION_OBSERVE_MS = NON_EXPIRING_SEND_TIMEOUT_MS + MESSAGE_CONTROL_TIMEOUT_MS;

/**
 * D56 and Q6: the receiver withholds its RTC ACKs, so the RTC receipt runs out of retries. That
 * `receipt-exhausted` hands the message to WS instead of failing it; the receiver refuses the WS copy as a
 * duplicate and, since its first admission was on RTC, sends its own ACK again over WS (R-S3b-1), and the
 * handle reads `acknowledged`.
 */
export const receiptExhaustedFallback: AlmConformanceScenarioDefinition = {
    scenarioId: 'receipt-exhausted-fallback',
    scenarioKey: 'receipt-exhausted-fallback',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toReceiptExhaustedFallbackSenderCommands,
    toRecipientCommands: toReceiptExhaustedFallbackReceiverCommands
};

function toReceiptExhaustedFallbackSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: {
                ack: 'receiver',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({
            ...sender,
            index: 1,
            state: 'acknowledged',
            budgetMs: RECEIPT_EXHAUSTION_OBSERVE_MS
        }),
        ...toHandedOverAssertions(sender, 'observe-acknowledged-1')
    ];
}

/** The duplicate's outcome is buffered by the end of the absence window; the hold is released last. */
function toReceiptExhaustedFallbackReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toAckHoldFaultCommand(receiver, 'hold-ack', 'until-cleared'),
        ...toSingleArrivalReceiverCommands(receiver),
        toAdmissionOutcomeWait(receiver, {
            name: 'ws-duplicate',
            contains: '"carrier":"ws","outcome":"not-handled","reason":"duplicate"',
            timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
        }),
        toAckHoldFaultCommand(receiver, 'release-ack', 0)
    ];
}
```

    Create `scenarios/no-fallback-after-deadline.ts`:

```ts
import type { RallarBlackBoxTestCommand } from '../../../rallar-black-box-test-contracts.ts';

import { EXPIRY_TTL_MS, RESPONSE_MARGIN_MS } from '../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_FALLBACK_CARRIERS } from '../alm-conformance-carriers.ts';
import {
    toAdmissionCommands,
    toObserveCommand,
    toResultAssertion,
    toSendCommand
} from '../alm-conformance-message-commands.ts';
import { toAckHoldFaultCommand } from '../alm-conformance-receipt-commands.ts';
import { toAdmissionOutcomeWait, toReceivedCommand } from '../alm-conformance-receiver-commands.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../alm-conformance-scenario-definition.ts';

/**
 * D56's deadline: the receiver withholds its RTC ACKs and the send lives 7 500 ms, less than the ≈8 000 ms
 * RTC receipt budget. The last `ack-timeout` expires with the message, so no `receipt-exhausted` is ever
 * stated: the handle reads `expired`, and no WS copy reaches the receiver (C7).
 */
export const noFallbackAfterDeadline: AlmConformanceScenarioDefinition = {
    scenarioId: 'no-fallback-after-deadline',
    scenarioKey: 'no-fallback-after-deadline',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_FALLBACK_CARRIERS,
    roles: ['sender', 'receiver'],
    toSenderCommands: toNoFallbackAfterDeadlineSenderCommands,
    toRecipientCommands: toNoFallbackAfterDeadlineReceiverCommands
};

function toNoFallbackAfterDeadlineSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: { ack: 'receiver', ttlMs: EXPIRY_TTL_MS }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'expired' }),
        toResultAssertion({
            step: sender,
            name: 'assert-expired-1',
            resultName: 'observe-expired-1',
            field: 'state',
            operator: 'equals',
            expected: 'expired'
        })
    ];
}

/** The RTC copy arrives; no WS copy arrives for the rest of the window, which outlasts the deadline. */
function toNoFallbackAfterDeadlineReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toAckHoldFaultCommand(receiver, 'hold-ack', 'until-cleared'),
        toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false }),
        {
            ...toAdmissionOutcomeWait(receiver, {
                name: 'no-ws-copy',
                contains: '"carrier":"ws"',
                timeoutMs: receiver.input.deadlineMs - RESPONSE_MARGIN_MS
            }),
            absent: true as const
        },
        toAckHoldFaultCommand(receiver, 'release-ack', 0)
    ];
}
```

- [ ] **Step 5: Register them.** In `alm-conformance-scenario-definition.ts:18-29` make the union:

```ts
export type AlmConformanceScenarioId =
    | 'bounded-rejection'
    | 'cross-carrier-duplicate'
    | 'deadline-expiry'
    | 'delivery-baseline'
    | 'delivery-lifecycle'
    | 'delivery-reload'
    | 'durable-opt-in'
    | 'fallback-within-deadline'
    | 'no-fallback-after-deadline'
    | 'not-yet-in-sync'
    | 'ordering-resync'
    | 'receipt-exhausted-fallback'
    | 'receipted-audience'
    | 'volatile-default';
```

    In `create-alm-conformance-recipes.ts` import the three definitions (`:30-40`, alphabetical among the
    scenario imports) and make `ALM_CONFORMANCE_SCENARIOS` (`:72-84`, keeping its doc comment at `:68-71`):

```ts
const ALM_CONFORMANCE_SCENARIOS: readonly AlmConformanceScenarioDefinition[] = [
    volatileDefault,
    boundedRejection,
    deadlineExpiry,
    deliveryBaseline,
    deliveryLifecycle,
    durableOptIn,
    deliveryReload,
    orderingResync,
    ...crossCarrierDuplicate,
    ...notYetInSync,
    fallbackWithinDeadline,
    receiptExhaustedFallback,
    noFallbackAfterDeadline,
    ...receiptedAudience
];
```

    In `hetzner-alm-manifest-entries.ts:57-59` make the description:

```ts
description: 'ALM conformance family (the volatile default, bounded rejection, deadline expiry, delivery ' +
    'baseline, lifecycle, the durable opt-in, durable reload, ordering resync, the cross-carrier duplicate, ' +
    'not-yet-in-sync, and fallback within the deadline: a dropped RTC leg, a spent RTC receipt, and no ' +
    'fallback after the deadline) across ws, rtc, and rtc-with-ws-fallback carriers.',
```

- [ ] **Step 6: The pinned lists.** In `packages/tests/shared-test/alm-conformance-recipes.test.ts` add
      `'fallback-within-deadline', 'receipt-exhausted-fallback', 'no-fallback-after-deadline'` after
      `'not-yet-in-sync-expires'` in `SCENARIO_KEYS_BY_CARRIER['rtc-with-ws-fallback']` (`:150`), and
      `'receipt-exhausted-fallback', 'no-fallback-after-deadline'` after the second `'not-yet-in-sync'` of
      the fallback non-smoke list (`:319`). In `alm-conformance-recipe-validation.test.ts` add
      `'fallback-within-deadline', 'receipt-exhausted-fallback', 'no-fallback-after-deadline',` after the
      second `'not-yet-in-sync',` of `CARRIER_SCENARIO_IDS['rtc-with-ws-fallback']` (`:61`), and the
      line `* The fallback family (D56) needs the fallback cell.` to its doc comment (`:20-23`).

- [ ] **Step 7: Regenerate manifest 18.** Run (unsandboxed: the generator writes JSON)
      `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`, then
      `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`.
      `git status --short apps/rallar-black-box/manifests` must list only
      `18-alm-conformance-2-agent.json`.

- [ ] **Step 8: GREEN.** Run the Step 2 command, then
      `npx vitest run packages/tests/shared-test packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/rallar-black-box/hetzner-alm-manifest-entries.test.ts`.
      Expected: PASS.

- [ ] **Step 9: The lanes and the five fallback cells (Q10).** Run unsandboxed and read the summary line of
      each:
  - `RALLAR_BLACK_BOX_ALM_SCOPE=smoke npm run -s test:rallar:full-stack:memory:alm` — `fallback-within-deadline`
    green on the fallback cell, every other smoke cell as before;
  - `RALLAR_BLACK_BOX_ALM_SCOPE=full RALLAR_BLACK_BOX_ALM_CARRIERS=rtc-with-ws-fallback npm run -s test:rallar:full-stack:memory:alm`
    (two- and three-agent families);
  - `RALLAR_BLACK_BOX_ALM_SCOPE=full npm run -s test:rallar:full-stack:memory:alm` once on all carriers.

    Then read, from the fallback cell's observation artifact and page diagnostics, the five existing cells
    that reach a new trigger through their RTC holds, and write one row per cell into the commit body:
    cell, expectation held (yes/no), evidence that moved (arrival carrier, attempt carriers,
    `carrierFallback.reason`), figure. The cells: `deadline-expiry` (RTC and WS `drop` ×100: the third
    RTC `not-ready` hands over to a WS leg still dropped; expected `expired` holds);
    `not-yet-in-sync-delivered-after-refresh` (the ≈150 ms NYIS budget hands over; the named red at
    `received-1` may turn green through WS — record it, it stays withheld on Hetzner);
    `not-yet-in-sync-expires` (the WS leg must honour the `{ absolute: 999999 }` snapshot floor for the
    receiver's absence to hold); `delivery-lifecycle` `cancel-hold`/`supersede-hold` and `delivery-reload`
    `reload-hold` (RTC `drop` and WS `not-ready` held: the hand-over moves the held message to the WS hold;
    a reload resumes the WS durable lane and, since hand-overs are not persisted, the RTC durable rows too
    — receivers dedup); `frozen-audience-membership` (three-agent; 7 500 ms against the ≈8 000 ms
    budget — it must not hand over). **Stop rule:** an expectation that no longer holds is not edited —
    stop, record the evidence and bring the cell to the controller for a ruling (for
    `not-yet-in-sync-expires` the options are the WS leg enforcing the floor, a product change, or
    restricting that variant to the `rtc` cell); the harness budgets are never widened.

- [ ] **Step 10: Commit and push.**

```bash
git add packages/shared-test/rallar-bb-test/conformance packages/tests/shared-test apps/rallar-black-box/src/hetzner/hetzner-alm-manifest-entries.ts apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json
git commit -m "test(alm): fallback within the deadline -- a dropped RTC leg, a spent RTC receipt and no fallback after the deadline on the fallback cell (D56)"
git push
```

---

### Task 6: Docs, the reads, the PR

**Files:** `packages/shared/alm/outbound/README.md` (a new section before "## Atomic IndexedDB work
storage", `:491`, and one sentence in "Transport attempt settlement", `:472-479`),
`packages/shared/alm/inbound/README.md` (after the operation-count paragraph of "The memory and IndexedDB lanes", `:92-97`;
Task 2 Step 13 already added the R-S3b-1 paragraph to the duplicate answers),
`playground/alm/alm-complete-product-description.md` (`:271-282` "Transport selection and parity",
`:335-366` "At-least-once"), `playground/alm/alm-improvement-plan.md` (the D56 row `:83`, the S3 bullet
`:797-833`, matrix rows F1 `:937` and F4 `:940`, the revision history), `playground/alm/alm-s3-design-proposal.md`
(§2.2 `:188-203`, an "As applied (S3b)" note), `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`
(`:306-340`, the observation fields and the fallback family). Line numbers are on `c07e786b8`; re-read each
anchor before editing.

- [ ] **Step 1: The outbound README.** Insert before `## Atomic IndexedDB work storage`:

```md
## Receipt ends and the hand-over

Every receipt this owner tracks ends in a settlement (S3b, D63, D64):

- **Budget exhaustion.** When the last `ack-timeout` window closes with the budget spent
  (`attempts >= maxAttempts`), [`ALOutboundRepairAdmission`](./al-outbound-repair-admission.ts) deletes
  the pending-ACK and repair-attempt rows in one commit and, once it lands, states `receipt-exhausted`
  with the row's confirmed and unconfirmed peers (next hops under `hop`/`subtree`, logical recipients
  under `receiver`). The handle reads `failed` and keeps who confirmed. The row is gone, so the fact is
  stated once across replays and reloads and a late ACK completes nothing. With the defaults (a 2 000 ms
  ACK timeout, three receipt retries) the budget ends about 8 s after admission.
- **A hop that refuses for good.** An admitted `expired`, `unauthorized` or `stale` NACK removes the row;
  the commit states the incomplete acknowledgement, then `receipt-exhausted`. `resync-required` keeps its
  `relay-rejected` (D50).
- **Completion at a re-plan.** A retry whose plan replaces the expected set (the RTC missing-recipient
  repair, under `hop` and `receiver`) and so completes the row deletes it and states the acknowledgement
  that completed it.
- **A receipt no row tracks.** An admission whose plan writes no row — a `qos.ack` timeout of 0, or a
  `hop`/`subtree` receipt that expects nobody — reports `trackedReceiptAlgo: 'none'`, so the handle ends
  at `transport-accepted` with the downgrade in evidence (R-S3a-4). A `receiver` receipt with an empty
  expected set keeps `receiver`: the WS server's `admitted` receipt creates its row, and an empty frozen
  audience completes it at admission.
- **Ends the deadline settles.** A receipt whose message is gone (the orphaned cleanup) and the WS
  server's `timed-out` receipt both arrive at the message deadline, which the handle already reads as
  `expired`.
- **The `not-yet-in-sync` budget.** When its retry schedule is spent the owner states
  `not-yet-in-sync-exhausted`. It ends nothing on its own — the receipt budget still ends the message —
  and is one of the declared retryable outcomes below.

**The hand-over (D66).** `ALOutboundMessageRuntime.handOver(msgId)` gives a message to another carrier's
owner: it remembers the id for the owner's lifetime, aborts the live attempt (which still settles its own
`attempt-settled`), completes every later effect of the message silently and deletes the receipt rows in
one commit, and states no settlement — the message is not cancelled. A conflict on that delete leaves an
inert row that nothing retries before it expires. RTC reaches it through
`WebRtcRxStreamerService.handOverOutbox` → `WebRtcOverlayMulticastManager.handOver`. The hand-over is held
in memory like a cancellation: a durable RTC message resumed after a reload is not handed over (D64).

**The declared retryable outcomes (D65)** live in
[`resolve-al-delivery-fallback-trigger.ts`](../delivery/resolve-al-delivery-fallback-trigger.ts). At
admission every `unroutable` reason (`no-route`, `circuit-open`, `rate-limited`) and `refused/unsupported`
hands the send to the fallback carrier at once. After admission `AL_FALLBACK_NOT_READY_ATTEMPTS` (3)
consecutive `not-ready` RTC attempts across the message's send-prepared rows (reset by a `sent` attempt
or an acknowledgement), `not-yet-in-sync-exhausted` and `receipt-exhausted` hand an admitted
`rtc-with-ws-fallback` message to WS inside its unchanged deadline. The browser's
[`BrowserMessageFallbackController`](../../../shared-web/browser/messages/browser-message-fallback-controller.ts)
takes that decision from the delivery registry's `record`; this owner only hands over.
```

    and in "Transport attempt settlement", after the sentence that ends "not part of this settlement
    path." (`:479`), add: "`handOver(msgId)` aborts the same signal and states nothing at all; see
    [Receipt ends and the hand-over](#receipt-ends-and-the-hand-over)."

- [ ] **Step 2: The inbound README.** In "The memory and IndexedDB lanes", after the paragraph that
      pins the operation counts (it ends "spends only probes (`work-page`, `work-probe`, R-S3a-11).", `:97`), add:

```md
A message handed from RTC to WS (D66) reaches a receiver twice when its RTC copy was delivered but not
receipted: the WS copy meets the first admission in the shared session store, is refused
`not-handled`/`duplicate`, and, since the message-owner row records the RTC admission, the receiver sends
its own ACK again over WS (R-S3b-1, see the duplicate answers above) — the receipt the WS leg needs.
The WS server narrows its current room to the frozen audience, so a session that left after the RTC
freeze is absent from the WS receipt rather than read unconfirmed.
```

- [ ] **Step 3: The product description.** In "Transport selection and parity" replace the bullet
      "A transport switch preserves expiry, ordering, supersedence, correlation, and trace identity."
      with "A transport switch preserves expiry, correlation, and trace identity; ordering and
      supersedence tracks are per carrier runtime, so a message handed to another carrier leaves its
      track on the first." and replace the paragraph that starts "**PARTIAL — one fallback lifecycle:**"
      (`:276-281`) with:

```md
**CURRENT — one fallback lifecycle (S3b):** the browser sender reuses one envelope, identity, and
deadline for the fallback carrier. At admission it falls back on every `unroutable` reason (`no-route`,
`circuit-open`, `rate-limited`) and on `refused/unsupported`. After admission an `rtc-with-ws-fallback`
message whose RTC leg settles `not-ready` three times in a row, spends its `not-yet-in-sync` budget or runs
out of receipt retries is handed to WS once, inside its unchanged deadline: the RTC owner ends its work
without a `cancelled`, the same envelope is admitted on WS, and the handle records a `carrier-fallback`
evidence row; receipts of the left carrier no longer move the handle (D56, D63–D66). One inbound store
per session is shared by both carriers (D20, D54), so the second copy meets its first admission. Limits:
`ws-then-rtc` falls back at admission only, and a durable RTC message resumed after a reload has no handle
and never hands over (D64).
```

    In "At-least-once", after the paragraph that ends "Late receipts are no-ops once their obligation is
    terminal.", add: "A receipt whose retry budget runs out, or that a hop refuses for good, ends the
    message `failed` with a `receipt-exhausted` settlement that keeps the confirmed and unconfirmed
    recipients; on `rtc-with-ws-fallback` inside the deadline it hands the message to WS instead (D63)."

- [ ] **Step 4: The roadmap and the proposal.** In `alm-improvement-plan.md`:
  - extend the D56 row's "**As applied (S3b, 2026-09-27):** D65 and D66." with " Delivered by PR #604:
    the trigger set and the hand-over as decided; the negative lane scenario ends inside the RTC
    receipt budget rather than before the third `not-ready` (C7), and the left carrier's
    `receipt-exhausted` and `relay-rejected` are ignored beside its acknowledgements (C3)." — dropping
    either clause a R-S3b-0 ruling removed, and keeping the row's column width (re-pad the table cell);
  - F1 (`:937`) state: "Partial: the default typed send is receipted and volatile (S3a, PR #597); every
    receipt end settles and `receipt-exhausted` hands `rtc-with-ws-fallback` to WS (S3b, PR #604); the WS
    `hop` receipt is S3c's behind D57.";
  - F4 (`:940`) state: "Resolved for `rtc-with-ws-fallback` (S3b, PR #604): the declared retryable
    outcomes hand an admitted RTC leg to WS within the deadline; `ws-then-rtc` and resumed durable
    messages keep admission-time fallback.";
  - in the S3 bullet, after the S3a sentence, add "S3b delivered by PR #604 (branch
    `claude/alm-s3b-fallback-within-deadline`): every receipt end settles, the declared retryable
    outcomes, the settlement-free hand-over and the fallback controller, with the fallback family on the
    `rtc-with-ws-fallback` cell; its rulings R-S3b-0 onward are in its plan.";
  - revision history: "- 2026-09-DD: S3b delivered by PR #604 (branch `claude/alm-s3b-fallback-within-deadline`):
    D56's as-applied note completed, matrix rows F1 and F4 moved." with the date of the commit.

    In `alm-s3-design-proposal.md` §2.2 add after its last bullet: "**As applied (S3b, PR #604):**
    no RTC fault kind was added (the `drop` fault's `not-ready` run is D65's trigger); the harness shows
    each attempt's carrier as `attemptCarriers`; `no-fallback-after-deadline` expires inside the RTC
    receipt budget (C7); `receipt-exhausted` reads `failed` when no fallback carrier remains (C1)."

- [ ] **Step 5: The harness schema doc.** In `schema-and-capabilities.md`, in the observation paragraph
      (`:323-340`) add `attemptCarriers` after `attemptOutcomes` in the field list and the sentence
      "`attemptCarriers` names the carrier of each of those settled rows, index for index, so a hand-over
      reads `rtc` rows then a `ws` row." After the `not-yet-in-sync` paragraph add:

```md
The fallback family runs over `rtc-with-ws-fallback` only (D56, D63–D66), two agents each.
`fallback-within-deadline` (smoke) arms an RTC `drop` fault on the sender's own frames of the send until
the scenario ends; the third consecutive `not-ready` attempt hands the message to WS, the sender observes
`acknowledged` with `attemptCarriers` containing `rtc` and `ws`, and the receiver delivers it once and
waits for its `admission-outcome` `committed`/`admitted` on carrier `ws`. `receipt-exhausted-fallback`
(full) holds the receiver's RTC ACKs; the RTC receipt runs out of retries after about 8 s and hands the
message over, the receiver refuses the WS copy as `not-handled`/`duplicate` and, its first admission
having been on RTC, sends its own ACK again over WS (R-S3b-1), and the sender observes `acknowledged`
within a 15 s budget. `no-fallback-after-deadline` (full) holds the
receiver's RTC ACKs on a 7.5 s send, which expires before the RTC receipt budget ends: the sender
observes `expired`, and no `admission-outcome` on carrier `ws` reaches the receiver for the whole window.
```

- [ ] **Step 6: Validate the docs.** `npx dprint check <the six edited files>`,
      `npm run test:repo-governance`, `npm run check:repo-style:changed -- origin/main HEAD`. Commit and
      push:

```bash
git add packages/shared/alm/outbound/README.md packages/shared/alm/inbound/README.md playground/alm packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md
git commit -m "docs(alm): S3b -- every receipt end settles, the declared retryable outcomes and the hand-over"
git push
```

- [ ] **Step 7: The push-time gate list.** On the final tree, record passed / failed / skipped for each:
  - `npm run test:unit` (both Vitest roots; grep the summary line, not the exit code);
  - `npm run test:deno`; `cd apps/api-v1 && deno task check`; `cd apps/rallar-black-box-control-server && deno task check`;
    `cd apps/relic-hunter-server-v1 && deno task check`;
  - `npm run typecheck`; `npm run build`;
  - `npm run check:repo-style:changed -- origin/main HEAD`; `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`
    (commit any registry fix before re-running: the checker reads the head revision);
  - `npm run test:repo-governance`;
  - the public API and both bundle tests, `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`;
  - `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`;
  - unsandboxed: `npm run test:e2e`, `npm run test:full-stack:memory`, the ALM smoke lane, and the full
    lane two- and three-agent on every carrier on normal pages;
  - the medium-scale gate: its one run after Task 1 (R-S3b-15) is recorded from Task 1's commit body;
    beyond it, `git diff --name-only origin/main...HEAD -- packages/shared/services/ws-queue-box-server`
    prints nothing, so a rerun of `npm run test:api-v1:black-box:postgres:medium-scale` is skipped under
    Q11 — record the empty diff; if it prints a file, run the gate against a freshly migrated database.

- [ ] **Step 8: The PR and the hosted reads.** Update draft PR #604 (it holds the questions and decisions
      commits) with `gh pr edit 604 --body-file <file>` (unsandboxed; the sandbox fails `gh` on TLS),
      title "ALM S3b: fallback within the deadline". Body sections, in the S3a shape:
      the decisions applied (D56 as applied, D63–D66, Q1–Q12) and the R-S3b rulings with C1–C9 as ruled;
      the six receipt ends and how each settles (C2); the hand-over and the fallback controller; the
      harness evidence (`attemptCarriers`); the three scenarios; the five re-read cells' table from Task
      5 Step 9; the moved pins by kind (the `rate-limited` fallback row, Task 1 Step 10's list, the
      recipe pins, manifest 18); the bundle figures from Tasks 1 and 2 (R-S3b-2), Task 3 Step 8 and Task 4
      Step 7; the medium-scale gate's summary line from Task 1 (R-S3b-15); the cross-carrier re-ACK
      (R-S3b-1) and what it adds to `cross-carrier-duplicate`'s evidence; the schema id
      unchanged and what a deploy discards (nothing persisted changes shape; a server receipt that runs
      out of retries now deletes its row at exhaustion instead of at the message expiry); the gate list
      from Step 7; the carried lists; and, last, the line
      `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Hosted: dispatch the Hetzner
      smoke from the PR branch (`gh workflow run hetzner-distributed-recipe.yml --ref claude/alm-s3b-fallback-within-deadline -f ref=claude/alm-s3b-fallback-within-deadline`,
      never from `main`) on both-normal runners, and the hosted full read with
      `RALLAR_BLACK_BOX_ALM_SCOPE=full` at most twice (D51), reported under the two-regime rule and
      never a blocker; poll with foreground `gh run list`. Wait for the Branch Release Gate on the final
      commit. Do not run `pr:delivery -- ready` or enable auto-merge: the maintainer lands the PR.

## Rulings during execution

- **R-S3b-0 (pre-execution, 2026-09-27).** Q1–Q12 stand as settled (D56 as applied, D63–D66). C1–C9 are
  accepted as written: C1 (`receipt-exhausted` reads `failed`, `evidence.reason` tells the two exhaustions
  apart — no new public state), C2 including its case 4 (a terminal NACK ends the receipt, so it settles
  `receipt-exhausted`; "every receipt end settles" is the rule, D64's list is not exhaustive), C3 (the left
  carrier's receipt facts — acknowledgement, `receipt-exhausted`, `relay-rejected` — move nothing; attempt
  rows still land), C4, C5 (the registry owns the controller; the dispatch's `readmit` keeps it the one
  admitter), C6, C7 (the Q12 deviation: `no-fallback-after-deadline` holds the receiver's RTC ACK under
  `EXPIRY_TTL_MS` 7 500 < the ≈8 000 ms receipt budget; a sub-100 ms TTL cannot be timed), C8, C9. Cost if
  wrong: C1 hides a distinct state behind `failed` (a consumer must read `evidence.reason`); C2 case 4
  makes an `unauthorized` NACK terminal for the whole message where a caller might have wanted the other
  recipients' receipts to run on — the evidence keeps them.

- **R-S3b-1 (pre-flight finding 1).** A duplicate admitted on a carrier other than its first admission's,
  with no relay row, re-sends the peer's own ACK over the arrival carrier (Task 2 Steps 11–15:
  `compute-al-inbound-duplicate-changes.ts`, its unit test, the inbound README); `receipt-exhausted-fallback`
  keeps its `acknowledged` pin and the Task 6 doc sentences say so. Why: D56's WS leg needs the receiver's
  WS ACK for the server's `receiver` receipt to complete, and §2.2's "receivers dedup the second copy"
  presumes that ACK; the tree answered only a retried copy addressed to this peer. Cost if wrong: one extra
  ACK per cross-carrier duplicate, and `cross-carrier-duplicate` may gain an acknowledgement it never
  asserted (evidence only).
- **R-S3b-2 (finding 2).** A crossed bundle ceiling is raised in the task that crosses it (Tasks 1 and 2
  too), by the Task 3 Step 8 rule, with that run's figure; Task 3 re-measures. Why: every push runs the
  Branch Release Gate, and a deferral would push a knowingly red bundle test. Cost if wrong: up to three
  ceiling commits instead of one.
- **R-S3b-3 (finding 3).** `toHandedOverAssertions` lives in `alm-conformance-message-commands.ts` beside
  `toResultAssertion`; no new file in `conformance/alm`. Why: that directory holds exactly 20 direct files
  and `layout.directory-density` fires above 20. Cost if wrong: one more export in an existing file.
- **R-S3b-4..14, R-S3b-16 (findings 4–14, 16).** The scan's smallest edits, applied verbatim: the
  controller's namespace immediately before its class (4); the completion-at-dispatch acknowledgement
  stated only by a commit that carries the `delete-pending-ack` mutation, with a negative case (5); the
  anchors `delivery.test.ts:231`, `alm-conformance-recipes.test.ts:319` and
  `create-alm-conformance-recipes.ts:72-84` keeping its doc comment (6, 7); `ALOutboundHandOverOutcome`
  in the `:32` re-export (8); every moved-pin file in the commit (9); this section's text and C2 without
  its conditional (10); `messagesCarrierLeg` for the attempt carriers, one shared fallback-cell constant,
  one fault builder (11); the measure script raised for every crossed entry (12); a changed-style check on
  the rx-streamer with the multicast-manager reroute (13); the warn-tier guard on Task 2's lifecycle growth
  (14); the receipt window derived from `toRtcAckTrackingPlan` (16). Why: each keeps the plan consistent
  with the tree and the style gates. Cost if wrong: none beyond the edit.
- **R-S3b-15 (finding 15).** The medium-scale PostgreSQL gate runs once after Task 1 and its summary line
  is recorded in Task 1's commit body and the PR body; Q11's file trigger otherwise stands. Why: Task 1's
  shared repair owner deletes a server-side pending-ACK row at exhaustion, a mutation-path change CLAUDE.md
  gates, although no `ws-queue-box-server/**` file changes. Cost if wrong: about 3 minutes.
- **R-S3b-17 (Task 1 NEEDS_CONTEXT finding).** Thirteen existing test pins encode the pre-D63 behaviour and
  move to the D63 shape: (a) `ack-after-retries-exhausted` (the acknowledgement-under-hold fixture, 8 tests
  over both hold files) is replaced by the D63 case — an ACK after the budget is a no-op (row gone), the
  handle reads `failed` with the exhaustion detail in `evidence.reason` (prose, per C1) and the
  confirmed/unconfirmed peers; (b) `expectExpiredPastTheDeadline` (4 tests) pins `failed` at exhaustion
  (≈8 s) and that the state is still `failed` past the 30 s deadline (a terminal handle never reopens,
  R-S3a-8); (c) `web-rtc-overlay-frozen-audience.test.ts:46-71` advances 6 s (inside the ≈8 s budget) so it
  still reads the frozen audience on the live row, plus one assertion that at 10 s the row is gone. Why:
  D63 is the maintainer's decision, the old pins describe the behaviour it replaced; every moved pin is
  named in the PR body. Cost if wrong: a late ACK inside the remaining deadline is lost (D63's stated
  cost).
- **R-S3b-18 (Task 5 finding).** On the fallback cell, `delivery-reload`'s original now arrives over ws
  (the hand-over lands 1.7 s into the hold; the WS copy is admitted 2.1 s after the reload): the identity
  check accepts `rtc` or `ws` on that cell only, every other cell keeps its single pinned transport. Why:
  this is an evidence move under Q10/R-S3b-0, not an expectation change — the old handle is unobservable
  after the reload, so the assessor cannot see which leg the hand-over used. Cost if wrong: the assessor
  would need hand-over evidence it cannot read today to pin the transport exactly.
- **R-S3b-19 (Task 5 finding).** `full-stack-alm-conformance.spec.ts`'s `CARRIER_TEST_TIMEOUT_MS` moves
  360 000 → 480 000 ms by its own "next whole minute above the widest cell" rule: the fallback family now
  measures 7.0, 7.0 and 7.1 minutes (up from 4.8–5.3 minutes on `rtc-with-ws-fallback` before the new
  scenarios). Why: this is the Playwright test's own ceiling, not one of the four fixed recipe budgets
  (30 000 / 18 000 / 10 000 / 7 500 ms), which stay untouched; the first run at 360 000 ms failed with
  "Test timeout of 360000ms exceeded". Cost if wrong: hosted manifest 18 is now ≈80 s longer for its
  fallback carrier against its 300 s terminal timeout, which Task 6's hosted read checks.
- **R-S3b-20 (Task 6 hosted finding).** `durable-opt-in`'s `received-1` gets a scenario-derived budget of
  the deadline plus 2 × `NON_EXPIRING_SEND_TIMEOUT_MS` (38 s, window 37 s) through an optional
  `durablePathBudgetMs` on `toReceivedCommand` (Task 6b); `delivery-reload` keeps its waits, which open
  after its absence window and ride a 60 s reload margin. Why: the diagnosis read harness timing — the one
  27 s positive wait opens at receiver connect and must cover the sender's remaining prologue, the durable
  admission commit, the outbound drain and the receiver's durable admission, 23–35 s on the slow regime.
  No fixed constant changes; the structural alternative (the receiver window opens after the sender's
  prologue, as D62's barrier does hosted) is carried. Cost if wrong: a real durable-path regression up to
  10 s slower passes this wait.
- **R-S3b-21 (final review I1).** A cross-carrier copy arriving at a peer that holds a relay row also sends
  the peer's own `{ kind: 'self' }` ACK over the arrival carrier; the relay's forwarded ACKs stay on the
  first carrier (`compute-al-inbound-duplicate-changes.ts`, its `it.each` rows, the inbound README). Why:
  D56's `receipt-exhausted` path must work for every frozen member, not two peers — after the hand-over the
  WS `receiver` receipt counts a WS ACK from every member, and a relay never sent one, so a relayed room
  read `expired`. Cost if wrong: one extra own ACK per relayed cross-carrier copy.

Later rulings follow as R-S3b-n with why and the cost if wrong.

## Self-review

- **Spec coverage.** §2.2 "declared retryable outcomes, one list in `packages/shared/alm/delivery/`" →
  Task 2 Step 7 (`not-ready` ×3, `rate-limited`, the `not-yet-in-sync` budget, `receipt-exhausted`); "which
  first becomes a settlement … so every receipt end settles (also closing the `hop`-mode
  delete-without-settlement path)" → Task 1 and C2 (all six ends named). "A fallback controller on the
  registry … cancels the RTC runtime's owned work, re-admits the same envelope (same msgId, frozen
  audience, unchanged `expiresAtMs`) on WS with `canFallback: false`, and records a `carrier-fallback`
  evidence row" → Tasks 2 (hand-over, evidence, left-carrier rule) and 3 (controller, re-admission,
  deadline guard); "receivers dedup the second copy" → Task 2 Steps 11–15 (the cross-carrier re-ACK,
  R-S3b-1), Task 5's `receipt-exhausted-fallback` and the inbound README; "non-room targets stay refused" → Global Constraints (D53 is S3c's). §2.2 harness: each
  attempt's carrier → Task 4; the three scenarios → Task 5 (the RTC fault kind dropped per Q12; the
  negative scenario's mechanism per C7). §9 Q1 → Task 3 Step 5 (`carrier === 'rtc'`) and its Q1 test;
  Q2 → Task 3 Steps 4–5; Q3 → Task 2 Steps 6 and 8, Task 3; Q4 → Task 2 Step 7; Q5 → Task 2 Steps 4 and 7;
  Q6 → Task 1 Step 8; Q7 → Carried to S3c; Q8 → the inbound README and D56 as applied; Q9 → the controller
  doc, the READMEs and the product description; Q10 → Task 5 Step 9 and the PR body; Q11 → Global
  Constraints, Task 1 Step 10 (the one run under R-S3b-15) and Task 6 Step 7; Q12 → Tasks 4 and 5. §8's carry (the completion-at-dispatch delete) →
  Task 1. D63–D66, which landed while the plan was written, add nothing beyond Q1–Q12.
- **Placeholder scan.** Every code step shows the code. The values only a run gives are named as such:
  the bundle figures (Tasks 1 and 2, Task 3 Step 8, Task 4 Step 7), the medium-scale summary line (Task 1
  Step 10), the moved pins (Task 1 Step 10, Task 2 Steps 9 and 14), the five cells'
  table (Task 5 Step 9) and the revision-history date. Mechanical fixture edits (Task 4 Step 6) name
  every file and line and end with a grep that proves completeness.
- **Type consistency.** `receipt-exhausted` and `not-yet-in-sync-exhausted` (Task 1) are what
  `resolveALDeliveryFallbackTrigger` (Task 2) reads; `ALDeliveryFallbackReason` (Task 2) types both the
  trigger's `reason` and the `carrier-fallback` settlement Task 3's controller builds;
  `toEndReceiptBundle` (Task 1) is reused by `endReceipt` (Task 2); `handOverOutbox` (Task 2) is what the
  controller (Task 3) calls and the middleware double (Task 3 Step 1) stubs;
  `BrowserMessageFallbackCandidate` (Task 3 Step 3) is what `watchFallback` (Step 4) and the dispatch
  (Step 5) exchange; `attemptCarriers` (Task 4) is what `toHandedOverAssertions` (Task 5) asserts;
  `toObserveCommand`'s `budgetMs` and the `contains` operator (Task 5 Step 3) are what the scenarios use.
