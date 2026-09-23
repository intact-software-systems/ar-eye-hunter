# ALM S2a Delivery Ahead of Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop charging a caller-observed page delivery for the `send-control` effects in the same
inbound batch. Today each ACK, NACK and repair is a full outbound AL IndexedDB commit inside the
receiver's serial batch, and an ACK row sorts ahead of its own dispatch row. After this slice the
diagnostics split a delivery's wait into its reservation and intra-batch halves, the batch runs page
deliveries first, one lever removes the cost term Task 0 measures, a replacement's admission settles
its predecessor `superseded`, and the lifecycle recipes stop polling `acknowledged` across pages —
so `delivery-lifecycle` and `delivery-reload` run green hosted against a same-regime baseline.

**Architecture:** `packages/shared/alm/` keeps its owners. `ALWorkHandler`
(`packages/shared/alm/work/al-work-handler.ts:146-464`) gains three diagnostic fields and no
behaviour. The inbound selector (`inbound/read-al-inbound-work-selection.ts`) keeps the effect kind
its eligibility read already decodes (`:175`) and sorts the claim list it already builds (`:288`).
The outbound runtime states a new `superseded` settlement (`delivery/al-delivery-lifecycle.ts:79-130`)
from the commit that writes the supersedence replacement row
(`outbound/compute-al-outbound-dispatch.ts:262-284`). The observation snapshot decodes
`claim-settled`. No persisted shape moves; `AL_ADMISSION_SCHEMA_ID` stays `rallar-alm-2026-09-f2c`.

**Tech Stack:** TypeScript across Node, Deno and browser; Vitest with `fake-indexeddb`; Playwright; dprint.

**Spec:** [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md),
section "Release 3, S2a: delivery ahead of control" (decisions D18, D19, D27, D28, D31); the evidence
is [playground/alm/alm-s2-hosted-lifecycle-diagnosis.md](../playground/alm/alm-s2-hosted-lifecycle-diagnosis.md)
(§3, §6, §7) with its tools under `playground/alm/tools/`; the shapes are
[alm-s2-design-proposal.md](../playground/alm/alm-s2-design-proposal.md) §2.1 and §5; the binding
answers are `.superpowers/s2-decisions.md` items 1a, 1b, 2, 10, 11 and 14. S2a starts from merged
`main` `5fbf9a165` (F2c) and precedes S2b and S2c (D18).

**Shape labels.** This plan uses the proposal's labels, which the decisions file answers: **A**
dispatch-first ordering, **C** one outbound commit per batch for its control sends, **D** RTT probes
off the durable AL commit path. The roadmap's Change 2 calls RTT-off "C" and a wake-on-admission
lever "D"; that lever is neither here, and Task 0's decision rule routes it to the maintainer.

## Global Constraints

- Decision D8: search `packages/**` before writing anything; ask before an internal library; no new
  third-party dependency.
- No retained legacy: every replaced path is removed in the commit that replaces it, including its
  tests; obsolete coupled tests are rewritten in the same commit.
- No migration and no old-format fallback (D3, D17). S2a adds no persisted shape and does not move
  `AL_ADMISSION_SCHEMA_ID`; a step that would change a stored row stops and asks.
- Touched-file standards closure: every touched human-authored file is reviewed and remediated in
  full; a support file changed by that remediation enters closure recursively.
- No duplicated logic: a private reader that already exists is widened, never re-implemented.
- Canonical verbs (`readXxx`, `computeXxx`, `validateXxx`, `resolveXxx`, `toXxx`); `handle`,
  `process`, `execute`, `util`, `helper`, `data` do not appear in the touched files.
- Expected failure is an `Either` value or a typed outcome; `assertXxx` is reserved for programmer
  invariants. A conflict stays a value: `'conflict'` at every admission-store caller,
  `ALAdmissionBackendConflictError` only across the backend boundary that already throws it.
- Required fields by default in every contract this slice extends; at most three positional
  parameters; `interface` for object contracts and `type` for unions; one canonical name per type.
- No new `file.cognitive-load` pin on an ALM file and no new disposition entry.
- **Never weaken a harness budget or a lane constant to make a run pass.** The five harness
  constants stay: `CONNECT_READINESS_TIMEOUT_MS` 30 000 (`create-alm-conformance-recipes.ts:122`),
  `CONFORMANCE_DEADLINE_MS` 18 000 and the receiver window derived from it
  (`full-stack-alm-conformance.spec.ts:63`), `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000 (`:125`),
  `EXPIRY_TTL_MS` 7 500 (`:137`), and the 3 000 ms observe class (`:131-132,894-898`). The regime
  thresholds 30 and 35 ms per operation are constants, not knobs.
- **No new timer, queue, coalescing window or registry.** The reorder is a sort of the list the batch
  already builds. Shape B (a separate delivery lane or rotation) was not chosen (D19) and is not
  built under any name.
- **Instrumentation is batched into existing payloads, never relayed per claim or per round.** The
  new fields ride on `effect-drain`, `claim-settled` and `rotation-alive`; no event kind is added.
  The relay is a measured per-operation cost in the Playwright lane: one event per round doubled it
  once (8.2 → 20.9 ms/op, `al-inbound-message-runtime.ts:206-215`), a per-round relay again in F2b.
- New shared files go under `packages/shared/alm/delivery/`; this plan needs none — every addition
  widens an existing file.
- Bundle ceilings: 213 KiB brotli facade (`shared-web-browser-bundle-boundaries.test.ts:42-46`,
  measured 212.299) and 271 KiB headless (`headless-bundle-boundary.test.ts:60-62`, measured
  270.020); a crossed ceiling is raised to the next whole KiB with the measured figure recorded.
- The ALM lane stays the Release Gate's non-blocking observation job; its return to `test:ci` is the
  maintainer's decision.
- **S2a merges only after the hosted one-variable confirmation (D18):** Task 0's hosted read, taken
  on the Task 0 commit itself, before Task 1 changes the order.
- Every commit keeps focused Vitest, `npx dprint check <files>` and the package typecheck green;
  before pushing: `npm run test:unit`, the three Deno checks, `npm run test:deno`,
  `npx dprint check`, `npm run check:repo-style:changed -- origin/main HEAD`,
  `node scripts/check-tests-typecheck.mjs`,
  `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`,
  `npm run test:rallar:full-stack:memory:alm`.
- `packages/shared/alm/inbound/README.md` and `packages/shared/alm/outbound/README.md` are updated in
  the same PR and never claim behaviour the code does not have.

## The measured starting point

Twelve hosted cells on three heads (`6f6006cfe`, `f33dd8118`, `f870feaf4`, `8fc704552`), read with
`playground/alm/tools/lifecycle-latency.mjs`. The failing step is a monotone function of the
receiver's `send-control` claim median across all twelve, without exception (diagnosis §2.6).

| Evidence                                                 | Figure                                                                 | Source                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| Receiver `send-control` claim median                     | green 689–1 187 ms; red 1 508–18 115 ms                                | diagnosis §2.6, §4.1                            |
| Receiver `dispatch-local` claim cost                     | 0–501 ms in every cell                                                 | diagnosis §4.7                                  |
| Receiver inbound drain median                            | green 2.2–3.4 s; red 5.9–22.8 s                                        | diagnosis §4.2                                  |
| Receiver drains in the observation window                | green 5–7; the three total-loss cells 2                                | diagnosis §3.A, §4.2                            |
| Sender commit → receiver page                            | green 2.3–6.4 s; red 8.5 s to never                                    | diagnosis §2.6, §4.4                            |
| `f33dd8118 / rtc`: `queueWaitMs` vs admission → dispatch | 2 670 ms vs 8 800 ms — 5.9 s spent inside the batch ahead of the claim | diagnosis §2.2                                  |
| Receiver `typeId=rtt` outbound commit                    | green 551–631 ms; red 1 874–5 813 ms; 6–7 per window                   | diagnosis §4.8                                  |
| IndexedDB per operation                                  | green 12.9–29.8 ms; red 20.8–43.0 ms                                   | diagnosis §4.5                                  |
| Hosted control `observe-acknowledged-1`                  | resolved at 10 004 ms against a 10 000 ms budget                       | diagnosis §2.4, §4.6                            |
| `observe-superseded-3`                                   | 3 000 ms budget spent waiting for a rescheduled outbound attempt       | diagnosis §3.C                                  |
| One inbound message, admit through deliver               | 8 `al-admission` operations (6 admission + 2 drain)                    | `al-indexeddb-operation-counts.test.ts:259-264` |
| One drained `dispatch-local` row                         | 2 `al-admission` operations                                            | `al-indexeddb-operation-counts.test.ts:244-250` |
| One default send                                         | 10 `al-admission` and 15 `al-work` operations                          | `al-indexeddb-operation-counts.test.ts:196-234` |
| One batch of completed claims                            | 1 `work-release` operation                                             | `al-indexeddb-operation-counts.test.ts:284-288` |
| An idle rotation, empty queue or one deferred row        | relays nothing but `rotation-alive`                                    | `al-indexeddb-operation-counts.test.ts:265-282` |

No repository test or cell file can say today which half of a delivery's wait dominates:
`queueWaitMs` is `batchStartedAtMs − dueAtMs` (`al-inbound-message-runtime.ts:391-394`,
`al-work-handler.ts:471-477`) and the intra-batch half is recorded nowhere. Task 0 is what makes the
reading possible, and Task 0's hosted run is the confirmation D18 requires before merge.

## The drain today

| Piece                      | File                                                                                                                                  | What it does                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page order                 | `packages/shared/queuebox/in-memory-queue-work-index.ts:20-62`, `indexed-db-queue-box-store.ts:126-151`                               | A work page is read in key order within `[typeId, status]`.                                                                                                                                                                                      |
| Effect ids                 | `packages/shared/alm/inbound/al-inbound-effect-intent.ts:102,164,175-179`, `al-inbound-work-entry.ts:56-62`                           | `dispatch:<sender>:<msgId>` and `ack:<msgId>:<peer>:<status>` become the key's context segment, so for every acknowledged message the ACK row sorts before its own dispatch row.                                                                 |
| Eligibility and claim list | `read-al-inbound-work-selection.ts:156-204` (kind decoded at `:175`, then discarded), `:274-298` (list built at `:288`)               | Decodes every due row, keeps no kind, and hands the batch `[...unleasedReservations, ...port.claim(...)]` in page order.                                                                                                                         |
| Serial run                 | `packages/shared/alm/work/al-work-handler.ts:350-368` (loop `:358-366`)                                                               | Runs each claim to its outcome before the next.                                                                                                                                                                                                  |
| Cadence                    | `al-work-handler.ts:205-214,305-313`, `al-inbound-message-runtime.ts:357-361`, `packages/shared/services/InboxOutboxEngine.ts:12`     | A commit during a batch runs one follow-up batch at that batch's end; otherwise the engine's 3 000 ms idle ceiling. The batch duration is the cadence.                                                                                           |
| `send-control` claim       | `al-inbound-admitted-delivery.ts:182-184` → `web-rtc-rx-streamer-service.ts:125-127` → `web-rtc-overlay-multicast-manager.ts:197-220` | One full outbound admission commit per ACK, NACK or repair, inside the inbound batch.                                                                                                                                                            |
| The commit lock            | `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts:347-419` (name at `:389`)                                             | `rallar:al-outbound-commit:${senderId}` carries no namespace, so the page's WS runtime (RTT heartbeats, `initialise-browser-middleware.ts:453-470`) and its RTC runtime (control sends) queue on one Web Lock.                                   |
| `superseded`               | `compute-al-outbound-dispatch.ts:203-206`, `al-outbound-message-effects.ts:179-190`                                                   | Stated only when the drain next attempts the old send, although the replacement's own commit already writes `set-supersedence-replacement` for it (`compute-al-outbound-dispatch.ts:277-283`, `compute-al-supersedence-observation.ts:120-136`). |

---

### Task 0: The confirming instrumentation and the hosted read

Per D18 and D19. No behaviour changes in this task; its hosted read decides Task 2.

**Files:**

- Modify: `packages/shared/alm/work/al-work-handler.ts:11-26,69-87,370-385`,
  `packages/shared/alm/inbound/read-al-inbound-work-selection.ts:41-57,78-83,156-204,274-298`,
  `packages/shared/alm/inbound/al-inbound-work-entry.ts:56-62` (one inverse beside
  `toALInboundWorkKey`), `packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts:29-106`,
  `packages/shared/alm/inbound/al-inbound-message-runtime.ts:228-273,368-396,428-435`,
  `packages/shared/alm/outbound/al-outbound-message-runtime.ts:497-511` (`unreservedDue: []`),
  `packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts:9-12,55-86,113-130`,
  `packages/shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts:46-68,253-310`,
  `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md:233-302`,
  `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md:63-82`,
  `playground/alm/tools/lifecycle-trace.mjs:40-73`
- Test (under `packages/tests/`): `shared/alm/inbound-admission-diagnostics.test.ts`,
  `shared/alm/inbound-runtime-test-fixture.ts:153-182`, `shared/alm/work/al-work-test-entries.ts:55-66`,
  `shared/alm/work/al-work-handler.test.ts:195-230,258-272` (1 186 lines; two literals gain three
  fields, nothing else), `shared/alm/inbound/al-inbound-work-selection.test.ts:85-112`,
  `shared-test/alm-observation-regime.test.ts`

**Interfaces:**

- Produces:

  ```ts
  // packages/shared/alm/work/al-work-handler.ts
  /** A due row the selection saw and did not hand the batch: held back by eligibility, or left unreserved by the port. */
  export interface ALWorkUnreservedDue {
      readonly key: Key;
      readonly dueAtMs: number;
  }

  // packages/shared/alm/inbound/al-inbound-work-entry.ts
  /** The effect id a work key was minted from: the inverse of `toALInboundWorkKey`'s context segment. */
  export function toALInboundWorkEffectId(key: Key): string;

  // packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts
  export interface ALInboundDeferredEffect {
      readonly effectId: string;
      readonly dueAtMs: number;
  }
  ```

- `ALWorkReadySelection` gains `readonly unreservedDue: readonly ALWorkUnreservedDue[]` (empty for
  an owner that reserves without observing a page — the outbound owner and
  `toTestALWorkReadySelection`). `ALWorkBatchDiagnostics` gains `readonly startedAtMs: number` (the
  instant `runClaim` receives as `batchStartedAtMs`), `readonly claimedKeys: readonly Key[]` (run
  order) and `readonly unreservedDue: readonly ALWorkUnreservedDue[]`.
- `effect-drain` gains `startedAtMs: number`, `claimedEffectIds: readonly string[]` (run order) and
  `deferred: readonly ALInboundDeferredEffect[]`; `claim-settled` gains `effectId: string`,
  `subjectMsgId: string | null`, `dueAtMs`, `batchStartedAtMs` and `startedAtMs` (numbers);
  `rotation-alive` gains `deferredRoundCount: number` and
  `latestDeferred: readonly ALInboundDeferredEffect[]`. `ALInboundClaimIdentity` gains
  `readonly subjectMsgId: string | null` — the message the effect acts on: a control's acknowledged,
  nacked or repaired message (`ackedMsgId` or `msgId`, `al-contracts/al-control.ts:35-64`, read
  through `parseALControlMessage`, `:106-117`), a retained or delivered message's own id, and `null`
  for `release-buffered`. `toALInboundClaimIdentity` (`:94-106`) is widened in place.
- `alm-observation-snapshot.ts`: `ALMObservationInboundClaim` — `atEpochMs`, `role`, `workerId`,
  `payloadKind: string`, and the four numbers `durationMs`, `dueAtMs`, `batchStartedAtMs`,
  `startedAtMs`, all required — and one required array on `ALMObservationSnapshot`,
  `inboundClaims: readonly ALMObservationInboundClaim[]`.
- `compute-alm-observation-regime.ts`:

  ```ts
  export interface ALMObservationInboundClaimWaits {
      /** Median `batchStartedAtMs − dueAtMs` over this role's `dispatch-local` claims: waiting for a round to reserve the row. */
      readonly reservationWaitMedianMs: number;
      /** Median `startedAtMs − batchStartedAtMs` over the same claims: waiting behind earlier claims of the same batch. */
      readonly intraBatchWaitMedianMs: number;
      readonly dispatchClaimCount: number;
      /** Median `durationMs` over this role's `send-control` claims. */
      readonly sendControlClaimMedianMs: number;
      readonly sendControlClaimCount: number;
  }
  ```

  The `measured` arm of `ALMObservationInboundDirection` gains `claimWaits: ALMObservationInboundClaimWaits`.
- `inbound-runtime-test-fixture.ts`: `InboundTestMessageInput` gains
  `readonly acknowledged?: boolean` ("Absent leaves the message unacknowledged, so its admission
  writes no `send-control` row"), adding `ack: { algo: 'hop' }` to the QoS beside the supersedence
  option (`:161-182`).
- Consumes: `resolveALInboundWorkDueAtMs` (`al-inbound-work-entry.ts:152-156`) and the private
  `computeMedian` / `toTwoDecimals` (`compute-alm-observation-regime.ts:312-324`), widened in place.

**Why the witness rides on existing payloads.** The diagnosis asks for "one event per inbound round
that finds the row still unreserved" (§6). A round that finds a due row it cannot reserve is exactly
the idle deferred-row round `al-indexeddb-operation-counts.test.ts:265-282` pins to relay nothing,
because one event per round is the cost that failed the RTC cell. So the witness is batched: a round
that ran claims lists its deferred rows on its own `effect-drain`; an empty round folds them into the
next `rotation-alive`, which already stands for 64 rounds. Read together:

| What the receiver's snapshot shows after the submission's `admission-outcome`                        | Meaning                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A `claim-settled` naming the dispatch effect, with `batchStartedAtMs` after the admission            | A round reserved it; the two wait halves are on that event                |
| The dispatch effect id in an `effect-drain.deferred` or `rotation-alive.latestDeferred`              | Rounds ran and held it back (eligibility), or the port left it unreserved |
| `claim-settled` events of another effect with a `batchStartedAtMs` after the admission, and no drain | A batch started and was still running at teardown (the in-flight batch)   |
| None of the three, and no `rotation-alive` after the admission                                       | No round ran at all — the rotation was blocked or stopped                 |

- [ ] **Step 1: The handler reports the batch's start, its run order and what it left behind (RED
      first).** Add to `inbound-admission-diagnostics.test.ts` the test below before any
      production change; it fails to compile, then fails its assertions, until Step 3 lands:

      ```ts
      it.each(['memory', 'indexeddb'] as const)(
          'splits a delivery wait into its reservation and intra-batch halves over %s',
          async (kind) => {
              const { runtime, diagnostics, delivered } = createRuntime({ kind });
              const message = createInboundTestMessage({ msgId: 'split-wait', acknowledged: true });

              await runtime.ready();
              await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });
              await expect.poll(() => delivered).toEqual(['dispatched']);
              await expect.poll(() => claimsOf(diagnostics).length).toBeGreaterThanOrEqual(2);
              const dispatch = claimsOf(diagnostics).find((claim) => claim.payloadKind === 'dispatch-local')!;
              const control = claimsOf(diagnostics).find((claim) => claim.payloadKind === 'send-control')!;
              const drain = drainsOf(diagnostics).find((event) => event.startedAtMs === dispatch.batchStartedAtMs)!;
              expect(dispatch.effectId).toBe(`dispatch:${INBOUND_TEST_SENDER_PEER_ID}:${message.id.msgId}`);
              expect(dispatch.subjectMsgId).toBe(message.id.msgId);
              expect(control.subjectMsgId).toBe(message.id.msgId);
              expect(control.msgId).not.toBe(message.id.msgId);
              expect(dispatch.dueAtMs).toBeLessThanOrEqual(dispatch.batchStartedAtMs);
              expect(dispatch.startedAtMs).toBeGreaterThanOrEqual(dispatch.batchStartedAtMs);
              expect(dispatch.queueWaitMs).toBe(Math.max(0, dispatch.batchStartedAtMs - dispatch.dueAtMs));
              // Today the ACK row sorts before its own dispatch row; Task 1 flips this pin.
              expect(drain.claimedEffectIds).toEqual([control.effectId, dispatch.effectId]);
              expect(drain.deferred).toEqual([]);
          }
      );
      ```

      Add `drainsOf` beside the file's `claimsOf` (`:77-79`). Then, in `al-work-handler.ts`, add
      `ALWorkUnreservedDue`, the new `ALWorkReadySelection` field and the three
      `ALWorkBatchDiagnostics` fields, and make `reportBatch` (`:370-385`) pass `startedAtMs`,
      `claimedKeys: selection.claims.map((claim) => claim.entry.key)` and
      `unreservedDue: selection.unreservedDue`. `selectOutboundWork`
      (`al-outbound-message-runtime.ts:498-511`) and `toTestALWorkReadySelection`
      (`al-work-test-entries.ts:55-66`) return `unreservedDue: []`; the selection literal at
      `al-work-handler.test.ts:195-202` gains `unreservedDue: []` and the two batch literals
      (`:214-228`, `:258-272`) gain `startedAtMs: PHASE_BATCH_START_MS`, `claimedKeys` and
      `unreservedDue: []`.
      Command: `npx tsc -p packages/shared/tsconfig.json --noEmit && npx vitest run packages/tests/shared/alm/work`
- [ ] **Step 2: The selector records what it deferred.** `readALInboundPageEligibility` is 49
      lines today (`:156-204`), so the closure rule splits it before it grows: extract the `try`
      body (`:170-189`) into

      ```ts
      /** What one row's eligibility read decided, before the page folds it into its lists. */
      type ALInboundRowEligibility =
          | Readonly<{ kind: 'not-due'; readyAtMs: number; }>
          | Readonly<{ kind: 'claimable'; effect: ALPersistedInboundEffect; observed: ALInboundDeliveryObservation | undefined; }>
          | Readonly<{ kind: 'deferred'; effect: ALPersistedInboundEffect; }>;

      async function readALInboundRowEligibility(
          entry: ResourceEntry,
          input: ALInboundWorkSelectionReadInput,
          delivery: ALInboundAdmittedDelivery
      ): Promise<ALInboundRowEligibility>;
      ```

      and fold its answer in the loop, keeping the corruption `catch` (`:191-201`) where it is. A
      `deferred` answer pushes `{ key: entry.key, dueAtMs: resolveALInboundWorkDueAtMs(entry) }` onto
      a new `deferred: readonly ALWorkUnreservedDue[]` on `ALInboundPageEligibility` (`:78-83`) and
      `ALInboundWorkSelection` (`:41-57`). `readALInboundClaimedSelection` (`:274-298`) returns
      `unreservedDue: [...selection.deferred, ...toUnreservedClaimableDue(selection, claimedKeys)]`,
      where the new private `toUnreservedClaimableDue` maps every claimable entry the port did not
      reserve through the same `resolveALInboundWorkDueAtMs`. A row reserved by a live lease is not
      due (`resolveALInboundWorkReadyAt`, `al-inbound-work-entry.ts:135-150`), so a batch's own rows
      never read as deferred. Extend `al-inbound-work-selection.test.ts:85-112` with one case: a
      page whose only row `readReadiness` defers reports it in `unreservedDue` with its due time and
      claims nothing.
      Command: `npx vitest run packages/tests/shared/alm/inbound/al-inbound-work-selection.test.ts`
- [ ] **Step 3: The inbound runtime relays the split.** Add `toALInboundWorkEffectId` beside
      `toALInboundWorkKey` (`al-inbound-work-entry.ts:56-62`) as
      `decodeURIComponent(key.contextId)`. Widen `toALInboundClaimIdentity`
      (`al-inbound-runtime-diagnostics.ts:94-106`) with `subjectMsgId`, and add the fields and
      `ALInboundDeferredEffect` above. In `al-inbound-message-runtime.ts`: `recordWorkBatch`
      (`:228-247`) passes `startedAtMs`, `claimedEffectIds: event.claimedKeys.map(toALInboundWorkEffectId)`
      and `deferred: toALInboundDeferredEffects(event.unreservedDue)` (a new pure function beside it,
      oldest first); `recordEmptyRotationRound` (`:255-273`) adds a `deferredRoundCount` and a
      `latestDeferred` beside its three existing accumulators, reset with them; `runInboundClaim`
      (`:368-380`) passes its `startedAtMs` into `ALInboundClaimSettlement` (`:428-435`, one new
      required field) and `recordClaimSettled` (`:382-396`) emits `effectId: settled.effect.effectId`,
      `dueAtMs`, `batchStartedAtMs` and `startedAtMs`, computing `queueWaitMs` from the same `dueAtMs`
      so the two can never disagree. Every function stays under 40 lines.
      Command: `npx vitest run packages/tests/shared/alm/inbound-admission-diagnostics.test.ts`
      Expected: Step 1's test passes over both backends with the control-first run order.
- [ ] **Step 4: The deferred witness, and the relay pin that must not move.** Over both backends, a
      runtime with `canDispatchMessage: () => false` admits one message and `runRotationUntilAlive`
      (`:82-92`); the first `rotation-alive` reports `deferredRoundCount > 0` and the dispatch effect
      id in `latestDeferred`. Then `al-indexeddb-operation-counts.test.ts` runs unchanged: the
      deferred-row idle rotation (`:347-376`) still relays only `rotation-alive`, and the 6 + 2,
      10 / 15 and one-release pins hold — in-memory fields on existing events, no storage read.
- [ ] **Step 5: The observation snapshot decodes `claim-settled` (RED first).** In
      `alm-observation-regime.test.ts`, add a `toInboundClaimEvent(atEpochMs, agentId, claim)` builder
      beside `toInboundDrainEvent` (`:90-113`) and a test that feeds the receiver three
      `dispatch-local` claims with reservation waits 100 / 200 / 300 ms and intra-batch waits
      4 000 / 5 000 / 6 000 ms, plus two `send-control` claims of 3 000 and 5 000 ms, and asserts
      `claimWaits` `{ reservationWaitMedianMs: 200, intraBatchWaitMedianMs: 5000,
      dispatchClaimCount: 3, sendControlClaimMedianMs: 4000, sendControlClaimCount: 2 }` for the
      receiver and all zeros for the sender. Then add `CLAIM_SETTLED_DIAGNOSTIC_KIND`,
      `toInboundClaim` and the `inboundClaims` array to `alm-observation-snapshot.ts` on the same
      `toTopicDiagnostics` path (`:113-129`), a `claim-settled` event missing any of the four new
      numbers being skipped rather than reported (the file's rule, `:95-99`); and
      `computeInboundClaimWaits` to `compute-alm-observation-regime.ts`, called from
      `toInboundDirection` (`:271-284`), with `computeInboundDirections` (`:258-269`) also counting
      `inboundClaims` before it returns `[]`. The two hosted fixtures still classify exactly as
      before and report `inbound: []`.
      Command: `npx vitest run packages/tests/shared-test/alm-observation-regime.test.ts`
- [ ] **Step 6: The contract, the artifact document and the session tool.** In
      `runtime-diagnostic-contract.md` extend the `effect-drain` (`:233-259`), `claim-settled`
      (`:260-286`) and `rotation-alive` (`:287-294`) bullets with each new field, say that
      `claim-settled.queueWaitMs` is now `batchStartedAtMs − dueAtMs` of the same event, that
      `subjectMsgId` is the join key from an ACK to the delivery it acknowledges (a `send-control`
      effect id is suffixed with the control envelope's own id, `prepare-al-inbound-commit-bundle.ts:74-76`),
      and add the four-row discrimination table above to "The kinds together discriminate"
      (`:296-302`). In `alm-observation-artifact.md` add a `claimWaits` bullet under the `inbound` entry of "The
      regime file" (`:63-82`), beside `pendingShare` and `phases`. In `playground/alm/tools/lifecycle-trace.mjs` the `claim-settled` branch
      (`:65-73`) filters by `typeId`, which is `null` for every `dispatch-local` claim by contract
      (`al-inbound-runtime-diagnostics.ts:53-57`) and so hides every page dispatch; key it instead on
      the set of `msgId`s the lifecycle `bb.sent` and `admission-outcome` events named, matching
      `msgId` or `subjectMsgId`.
      Command: `npx dprint check packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md`
- [ ] **Step 7: Commit and push the instrumentation alone.** `npx vitest run packages/tests/shared/alm packages/tests/shared-test`,
      `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`,
      `npx dprint check <touched files>`, `git commit -am 'feat(alm): split the inbound delivery wait into its reservation and intra-batch halves'`,
      then push `claude/alm-s2a-delivery-ahead-of-control`. Nothing else is pushed until this
      commit's `alm-conformance-lane-<sha>` artifact has uploaded, so its cells measure the drain
      as merged `main` runs it.
- [ ] **Step 8: The hosted read (the D18 confirmation).** Download the artifact
      (`gh run download <run-id> -n alm-conformance-lane-<sha>`; run `gh` unsandboxed, a sandboxed
      `gh` fails TLS here). Record per cell `regime`, `perOperation.medianMs` and the receiver's
      `claimWaits`. Read red cells; if every cell is green, rerun up to twice, and if none reds read
      the cell with the highest receiver `sendControlClaimMedianMs`; an `unclassified` cell is not
      evidence. On the receiver role of the `rtc` cell (fallback as the second witness):
      **(a)** `intraBatchWaitMedianMs ≥ 2 × reservationWaitMedianMs` confirms intra-batch
      serialization, the primary hypothesis — continue with Task 1, and Step 9 chooses C or D;
      **(b)** `reservationWaitMedianMs ≥ 2 × intraBatchWaitMedianMs`, or the dispatch effect listed
      deferred with no `claim-settled` for it, means round scheduling or eligibility dominates
      (diagnosis §6 alternative 2) — Task 1 still lands (D19 is binding and harmless), but neither C
      nor D addresses that term, so stop and route the reading to the maintainer: a wake-on-admission
      change or shape B is a new decision; **(c)** neither term reaches twice the other — both
      matter; continue with Task 1 and Step 9 decides.
- [ ] **Step 9: The RTT one-variable probe (diagnosis §6, alternative 1).** From the Task 0 commit,
      push a throwaway branch `claude/alm-s2a-probe-rtt-off` whose single change makes
      `registerBrowserRttEgress`'s `onHeartbeat` (`initialise-browser-middleware.ts:457-469`) return
      `Promise.resolve()` without enqueueing — a product-configuration variable, so a diagnostic run,
      never merged; delete the branch after the read. If the receiver's `sendControlClaimMedianMs`
      falls below **1 200 ms** with RTT off (the green band's top is 1 187 ms, diagnosis §2.5, §4.1),
      the RTT commits are the lock hog: **Task 2D**. If it stays at or above 1 200 ms, the cost is the
      one-commit-per-control itself: **Task 2C**. A probe cell in a different regime from Step 8's is
      not a verdict: rerun it once. Record both readings, heads and run ids in Task 2's first commit
      message and in the PR body.

### Task 1: Dispatch-first ordering inside the batch (shape A)

Per D19. A pure ordering of the claim list the selection already builds; no new read, no stored
shape, no scheduling object.

**Files:**

- Modify: `packages/shared/alm/inbound/read-al-inbound-work-selection.ts:41-57,78-83,156-204,274-298`
- Test: `packages/tests/shared/alm/inbound/al-inbound-work-selection.test.ts` (259 lines),
  `packages/tests/shared/alm/inbound-runtime-test-fixture.ts:101-151`,
  `packages/tests/shared/alm/inbound-admission-diagnostics.test.ts` (Task 0 Step 1's order pin)

**Interfaces:**

- Produces, `read-al-inbound-work-selection.ts`:

  ```ts
  /**
   * The batch's run order: page deliveries first, then admission replays and rows whose kind the
   * page never decoded, then control sends and forwards. Stable within each rank, so page order
   * still decides among equals.
   */
  export function computeALInboundClaimOrder(
      claims: readonly ALWorkClaim[],
      effectKinds: ReadonlyMap<ResourceEntryKeyString, ALInboundDurableEffect['kind']>
  ): readonly ALWorkClaim[];
  ```

  `ALInboundPageEligibility` and `ALInboundWorkSelection` gain
  `effectKinds: ReadonlyMap<ResourceEntryKeyString, ALInboundDurableEffect['kind']>`, recorded from
  the effect `readALInboundRowEligibility` already decoded (Task 0 Step 2) — `admit-message` rows
  included.
- Produces, `inbound-runtime-test-fixture.ts`:
  `export type InboundTestEffectCall = 'dispatched' | 'control-sent';` and on `InboundTestRuntime`
  `readonly sequence: readonly InboundTestEffectCall[]` — one entry per port call in run order, pushed
  by the fixture's `dispatchInboxEntry` and `sendControlMessage` (`:141-145`).

- [ ] **Step 1: The delivery runs first (RED).** Add to `al-inbound-work-selection.test.ts`:

      ```ts
      describe('ALInboundWorkSelector claim order', () => {
          it.each(['memory', 'indexeddb'] as const)(
              'dispatches an acknowledged message before it sends the acknowledgement over %s',
              async (storage) => {
                  const fixture = createInboundTestRuntime({
                      stores: createInboundTestStores({
                          namespace: 'claim-order',
                          storage,
                          observer: createPassThroughIndexedDbOperationObserver()
                      }),
                      effectWorkerId: 'al-inbound:claim-order'
                  });
                  await fixture.runtime.ready();

                  await fixture.runtime.admitIncomingMessage(
                      createInboundTestMessage({ msgId: 'claim-order', acknowledged: true }),
                      INBOUND_TEST_SOURCE
                  );

                  // One commit, one batch: both rows are on the page that batch reads, and today
                  // the `ack:` key sorts ahead of the `dispatch:` key.
                  await expect.poll(() => fixture.sequence).toEqual(['dispatched', 'control-sent']);
              }
          );
      });
      ```

      Command: `npx vitest run packages/tests/shared/alm/inbound/al-inbound-work-selection.test.ts`
      Expected: RED on both backends, `['control-sent', 'dispatched']`. If a backend already
      dispatches first, record it and keep the other as the RED pin — the page order is the
      queue's, and this slice does not change it.
- [ ] **Step 2: The ranks, pinned purely.** Add a second test in the same `describe`: seven claims —
      one per `ALInboundDurableEffect['kind']` and one whose key is absent from `effectKinds` — fed as
      `forward-message`, `send-control`, unknown, `admit-control`, `admit-message`,
      `release-buffered`, `dispatch-local`, come back as `release-buffered`, `dispatch-local`,
      unknown, `admit-control`, `admit-message`, `forward-message`, `send-control` (stable in rank). Implement `computeALInboundClaimOrder` as
      `[...claims].sort((left, right) => rank(left) - rank(right))` over a private
      `toALInboundClaimRank(kind: ALInboundDurableEffect['kind'] | undefined): 0 | 1 | 2` whose
      `switch` lists all six kinds and `undefined` with no `default`, so a seventh kind must choose
      its rank.
- [ ] **Step 3: Order the list the batch already builds.** Record `effectKinds` in the eligibility
      fold, and in `readALInboundClaimedSelection` (`:274-298`) replace
      `claims: [...selection.unleasedReservations, ...claims]` with
      `claims: computeALInboundClaimOrder([...selection.unleasedReservations, ...claims], selection.effectKinds)`.
      The unleased reservations are corrupt rows whose kind never decoded, so they rank with the
      unknown row. `earliestDueAtMs` and the observations are keyed by row, not position, and do not
      move. Flip Task 0 Step 1's pin to
      `expect(drain.claimedEffectIds).toEqual([dispatch.effectId, control.effectId])` in this commit.
      Commands: `npx vitest run packages/tests/shared/alm/inbound packages/tests/shared/alm/inbound-admission-diagnostics.test.ts`
      Expected: Step 1 GREEN on both backends.
- [ ] **Step 4: The pins that must not move.** Run them unchanged and name them in the commit
      message: `al-indexeddb-operation-counts.test.ts` — 6 + 2 `al-admission` operations for one
      message admitted and delivered (`:259-264`), 2 for one drained `dispatch-local` row
      (`:244-250`), 10 `al-admission` / 15 `al-work` for one default send (`:196-234`), one
      `work-release` per batch (`:284-288`) and the idle relay pin (`:265-282`);
      `al-inbound-admission-transactions.test.ts` — `COMMITTING_ADMISSION_ATTEMPT` and
      `RETAIN_THEN_REPLAY`. The sort reads a map the eligibility read already filled, so it costs no
      operation and opens no transaction.
      Commands: `npx vitest run packages/tests/shared/alm`,
      `npx dprint check <touched files>`,
      `git commit -am 'feat(alm): run page deliveries ahead of control sends inside an inbound batch'`

### Task 2: The cost lever Task 0 selected

Exactly one of 2C and 2D lands, per Task 0 Step 9; the PR body records the other as not chosen.

#### Task 2C: One outbound commit per batch for that batch's control sends

Chosen when RTT-off leaves the `send-control` median at or above 1 200 ms. The larger lever: it
widens the outbound admission to commit several bundles under one sender-version fence, so report
its file count to the maintainer before starting if it exceeds the slice's medium size.

**Files:**

- Modify: `packages/shared/alm/inbound/al-inbound-message-runtime.ts:82-103,403-425`,
  `al-inbound-admitted-delivery.ts:20-30,182-184`, `read-al-inbound-work-selection.ts:99-115,221-239`,
  `packages/shared/alm/outbound/admission/al-outbound-admission-store.ts:397-530`,
  `packages/shared/alm/outbound/al-outbound-dispatch-admission.ts:100-184,347-419`,
  `packages/shared/alm/outbound/al-outbound-message-runtime.ts:430-460`,
  `packages/shared/multicast/web-rtc-overlay-multicast-manager.ts:197-220` (922 lines),
  `packages/shared/services/web-rtc-rx-streamer-service.ts:125-127`,
  `packages/shared/services/ws-queue-box-client-service.ts:236-238,449-465`,
  `packages/shared/services/ws-queue-box-server/ws-queue-box-server-service.ts:232,351`
- Test: the 22 files that pass `sendControlMessage` today
  (`grep -rln sendControlMessage packages apps tests`), rewritten;
  `packages/tests/shared/alm/outbound/al-outbound-admission-transactions.test.ts`,
  `packages/tests/shared/alm/outbound/al-outbound-admission-fences.test.ts`,
  `packages/tests/shared/alm/inbound/al-inbound-work-selection.test.ts`

**Interfaces:**

- `ALInboundMessageRuntime.Dependencies.sendControlMessage` is replaced by
  `readonly sendControlMessages: (msgs: readonly ALMessage[]) => Promise<void>` — no retained
  single-message form.
- `ALInboundWorkSelector` gains `getClaimedControlSends(): readonly ALInboundClaimedControlSend[]`
  — a fresh array per selection, emptied by `restartScan`, exactly like the delivery observations
  (`:225-237`) — and the runtime holds `private controlRound: ALInboundControlSendRound | undefined`:

  ```ts
  /** One `send-control` row the current selection reserved, with the envelope its eligibility read decoded. */
  export interface ALInboundClaimedControlSend {
      readonly effectId: string;
      readonly msg: ALMessage;
  }

  /** The one grouped send a batch's control claims share, keyed by the selection's own array. */
  interface ALInboundControlSendRound {
      readonly sends: readonly ALInboundClaimedControlSend[];
      readonly sent: Promise<void>;
  }
  ```

- Outbound, each `Promise<readonly ALOutboundEnqueueResult[]>` except the first two:
  `ALOutboundAdmissionStore.commitBundles(bundles: readonly ALOutboundCommitBundle<TPrepared>[]): Promise<'committed' | 'conflict' | 'expired'>`,
  `ALOutboundDispatchAdmission.commitAll(dispatches: readonly ALOutboundDispatchAdmission.Input<TPrepared>[]): Promise<readonly ALOutboundDispatchAdmission.Result<TPrepared>[]>`,
  `ALOutboundMessageRuntime.enqueueAllIfAbsent(msgs: readonly ALMessage[])`,
  `WebRtcOverlayMulticastManager.enqueueAllIfAbsent(msgs: readonly ALMessage[])`,
  `WsQueueBoxClientService.enqueueOutboxAllIfAbsent(msgs: readonly ALMessage[])`.

- [ ] **Step 1: One readwrite for two control sends (RED).** In
      `al-outbound-admission-transactions.test.ts`, over IndexedDB with `recordIndexedDbTransactions`,
      enqueue two ACK envelopes from one sender through `enqueueAllIfAbsent` and assert one
      `readwrite` for the pair and two `admitted` verdicts; over memory, the same verdicts. RED at the
      type level; then `commitBundles`: every bundle names the same `senderId` and `expectedVersion`
      (a mismatch is a programmer error, `assertALOutboundBundleGroup`); one `backend.write` re-reads
      the sender version once (`:509-512`), runs each bundle's existing pending, effect, observation
      and identity fences (`:513-529`), writes each bundle's effects and state, and the version `+1`
      once (`:474`). Per-row compare-and-set is untouched.
- [ ] **Step 2: A group conflict falls back, as a value.** `commitAll` takes one sender-queue slot
      and one Web Lock for the group (`:347-419`), reads and computes each dispatch with its own
      `ALOutboundCommitPhases` (one `commit-phases` event per message, as today), and on
      `'conflict'` or a validation issue in any member runs `commit` per dispatch, sequentially — a
      fresh read, compute and conflict handling exactly as a single send gets today. Test in
      `al-outbound-admission-fences.test.ts`: a group whose sender version moved between its reads
      and its write falls back and both messages end `admitted`.
- [ ] **Step 3: The inbound batch sends its controls together (RED).** In
      `al-inbound-work-selection.test.ts`, over memory and IndexedDB, commit two acknowledged
      messages' bundles straight into the admission store (the `readDrainedInboundRotation` pattern,
      `al-indexeddb-operation-counts.test.ts:389-407`, so no commit wakes a batch), run one
      `queueEngine.executeOnce()`, and assert `sendControlMessages` was called once with both
      envelopes. Implement: a `send-control` claim whose effect id is in `getClaimedControlSends()`
      awaits `controlRound.sent` when `controlRound.sends` is that same array, and otherwise starts
      a round over the whole array; a claim not in the array (the scan restarted mid-batch) sends
      alone. Keyed by array identity, never by time, so a retried effect in a later batch never
      joins a finished round. `ALInboundAdmittedDelivery.deliver`'s `send-control` case
      (`:182-184`) throws `NonRetryableException`, as its two admission cases do: the runtime owns it.
- [ ] **Step 4: The three transports.** RTC: `web-rtc-rx-streamer-service.ts:125-127` calls
      `multicast.enqueueAllIfAbsent`, which applies its circuit breaker and rate limiter once per
      group (named in the PR body). WS client: `enqueueOutboxAllIfAbsent`. WS server: its existing
      per-message send (`:351`) in order — the server is not the measured cost.
- [ ] **Step 5: Verify and commit.** The default-send (10 / 15) and inbound pins stay; a batch of
      two ACKs is measured and recorded in the commit message, not pre-declared.
      Commands: `npx vitest run packages/tests/shared packages/tests/shared-web`,
      `npm run test:deno`, `npx dprint check <touched files>`,
      `git commit -am 'feat(alm): commit the control sends of one inbound batch in one outbound admission'`

#### Task 2D: RTT probes off the durable AL commit path

Chosen when RTT-off brings the `send-control` median below 1 200 ms. An RTT heartbeat is
latest-value telemetry with a 15 s TTL (`initialise-browser-middleware.ts:88`) whose route already
carries its version (`:106-123`); a lost one is replaced by the next. Today each is a durable WS
outbound admission (`:453-470` → `ws-queue-box-client-service.ts:449-465`) holding the same
`rallar:al-outbound-commit:${sessionId}` lock the page's RTC control sends need.

**Files:**

- Modify: `packages/shared/services/ws-queue-box-client-service.ts:449-465,572-574`,
  `packages/shared-web/browser/connection/initialise-browser-middleware.ts:453-470`
- Test: `packages/tests/shared-web/connection/browser-middleware-rtt.test.ts` (33 lines),
  `packages/tests/shared/webrtc-rtt-lifecycle.test.ts`, the WS client suite under
  `packages/tests/shared/services/`

**Interfaces:**

- Produces, on `WsQueueBoxClientService`, `sendLive(message: ALMessage): 'sent' | 'socket-closed'`
  — one message straight to an open socket, no admission, work row or retry; only for latest-value
  telemetry a newer message replaces; a closed socket drops it. It sends `QueueBoxUtilities.toResourceEntryFromMsg(message, WsQueueBoxClientService.OUTBOX_ENQUEUE_TYPE).resource`,
  the bytes the outbox path sends today (`:213-222,541-544`), so the server's RTT topic
  (`packages/shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts:25-40`)
  receives an identical frame.

- [ ] **Step 1: A heartbeat costs no admission (RED).** In `browser-middleware-rtt.test.ts`, drive
      `registerBrowserRttEgress`'s heartbeat against a WS client over a counting IndexedDB observer
      and assert zero `al-admission` operations and one socket write; today it spends a full
      admission.
- [ ] **Step 2: `sendLive`, and the egress uses it.** Implement it on the client with
      `isSocketOpen` (`:572-574`); `registerBrowserRttEgress` calls it and drops the enqueue, the
      verdict branch and the `qboxEngine.wake()`. Tests: closed socket → `'socket-closed'` and no
      write; open socket → the exact outbox resource string.
- [ ] **Step 3: Verify and commit.** `npx vitest run packages/tests/shared-web/connection packages/tests/shared/webrtc-rtt-lifecycle.test.ts packages/tests/shared/services`,
      the server RTT topic suite under `packages/tests/shared-server/rallar-system/rtc-rtt/`,
      `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`,
      `git commit -am 'feat(rtc): send RTT heartbeats live instead of through the durable outbound admission'`

### Task 3: `superseded` settles at the replacement's admission

Per D27. The durable fact is already in the replacement's commit (`set-supersedence-replacement`,
`compute-al-outbound-dispatch.ts:277-283`); only the in-memory settlement waits for the drain. It is
stated synchronously from the commit's own result, before `commitDispatchPlan` returns, so no queue
or timer is added (the S1 rule, `packages/shared/alm/outbound/README.md:183-185`).

**Files:**

- Modify (under `packages/shared/alm/`): `delivery/al-delivery-lifecycle.ts:79-130`,
  `delivery/compute-al-delivery-lifecycle.ts:24-38`, `outbound/compute-al-outbound-dispatch.ts` (one
  function after `:262-284`), `outbound/al-outbound-message-runtime.ts:476-486`
- Test (under `packages/tests/`): `shared/alm/outbound-delivery-settlements.test.ts` (656 lines),
  `shared/alm/delivery/compute-al-delivery-lifecycle.test.ts`,
  `shared-web/messages/browser-rallar-delivery-registry.test.ts`, and
  `shared-web/shared-web-public-api-snapshots.test.ts` if the snapshot lists the union

**Interfaces:**

- Produces, `al-delivery-lifecycle.ts`, one arm of `ALDeliverySettlement` beside `expired`:

  ```ts
  /** A newer message's admission replaced this one; stated from the replacement's commit, never by an attempt. */
  | Readonly<{
      kind: 'superseded';
      msgId: string;
      carrier: ALDeliveryCarrier;
      atMs: number;
      replacementMsgId: string;
      detail: string;
  }>
  ```

  `ALOutboundSettlementFact` derives it with no edit (`al-outbound-message-runtime.ts:207-213`).
- Produces, `compute-al-outbound-dispatch.ts`:
  `export function toALOutboundSupersededMsgIds<TPrepared>(bundle: ALOutboundCommitBundle<TPrepared>): readonly string[]`
  — the predecessors the bundle's supersedence write marks replaced; empty for an untracked message.
- Unchanged: the attempt-time check (`al-outbound-message-effects.ts:179-190`) and the dequeue-time
  early result (`compute-al-outbound-dispatch.ts:203-206`) keep their role for attempts already in
  flight; their `attempt-settled superseded` now lands on a terminal lifecycle as evidence
  (`compute-al-delivery-lifecycle.ts:64-84`).

- [ ] **Step 1: The predecessor settles without a drain (RED).** Add to
      `outbound-delivery-settlements.test.ts`:

      ```ts
      it.each(BACKEND_KINDS)('states the old message superseded when its replacement commits over %s', async (kind) => {
          const settlements: ALDeliverySettlement[] = [];
          const stores = createStores(kind);
          const held = holdOutboundClaims(stores);
          const runtime = createDefaultOutboundTestRuntime({
              stores,
              settlements: (settlement) => settlements.push(settlement),
              planOutgoingMessage: (msg) => ({
                  ...planSend()(msg),
                  supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'lifecycle-slot' }
              }),
              sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
          });
          const old = createOutboundMessage('msg-superseded-old');
          const replacement = createOutboundMessage('msg-superseded-replacement');

          await enqueueOutboundOrThrow(runtime, old);
          await enqueueOutboundOrThrow(runtime, replacement);

          // No claim has run: the drain is held, so only the replacement's commit can have said it.
          expect(settlements.filter((settlement) => settlement.msgId === old.id.msgId)).toEqual([
              expect.objectContaining({ kind: 'superseded', replacementMsgId: replacement.id.msgId })
          ]);
          await held.release();
      });
      ```

      Command: `npx vitest run packages/tests/shared/alm/outbound-delivery-settlements.test.ts`
      Expected: RED on both backends (no settlement for the old message at all).
- [ ] **Step 2: The vocabulary and the reducer.** Add the arm; add
      `case 'superseded': return toReasonedLifecycle(previous, 'superseded', settlement.detail);` to
      the switch (`compute-al-delivery-lifecycle.ts:24-38`). Tests in
      `compute-al-delivery-lifecycle.test.ts`: a `queued` lifecycle reaches `superseded` with the
      detail as its reason; a later `attempt-settled superseded` on it only adds evidence and
      increments `lateSettlementCount`; a `superseded` on an `acknowledged` lifecycle stays
      `acknowledged`.
- [ ] **Step 3: The runtime states it from the commit.** Implement
      `toALOutboundSupersededMsgIds` as the `msgId` of every `set-supersedence-replacement`
      mutation in `bundle.mutations`. In `commitDispatchPlan` (`al-outbound-message-runtime.ts:476-486`),
      when `result.committed` and the computed DTO carries a bundle and a message, call a new private
      `emitSupersededSettlements(computed)` that states
      `{ kind: 'superseded', msgId, replacementMsgId: computed.msg.id.msgId, detail: 'A newer message replaced this one at its admission.' }`
      for each id, through the existing guarded `emitSettlement` (`:703-713`). It runs on every
      commit path — enqueue, pending replay and dequeue — because the commit is the decision point.
      Step 1 turns GREEN; after `held.release()` a drained attempt of the old message states its
      `attempt-settled superseded`, and the test asserts the lifecycle a registry would compute from
      both stays `superseded`.
- [ ] **Step 4: The handle, end to end.** In `browser-rallar-delivery-registry.test.ts` a handle
      waiting on `['superseded']` resolves on the recorded `superseded` settlement with no attempt
      settlement at all. Run the public API snapshot and bundle checks; record the facade and
      headless figures.
      Commands: `npx vitest run packages/tests/shared/alm packages/tests/shared-web/messages packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`,
      `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`,
      `git commit -am 'feat(alm): settle a superseded send at the admission of its replacement'`

### Task 4: The lifecycle recipes observe receipts on the receiver

Per D28. The receiver's `receive-submission` and `receive-replacement` waits are the local receipt:
each wait result carries the delivered envelope's `msgId`
(`assess-alm-conformance-identity.ts:114-137` reads `event.payload.data.msgId`), and that `msgId` is
the correlation key — not `typeId`, which `claim-settled` reports as `null` for `dispatch-local`
(diagnosis §7). The sender stops waiting on the cross-page round trip and reads its receipts only
after the scenario, where the whole run has elapsed.

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts:350-356,450-518,578-592`,
  `packages/shared-test/rallar-bb-test/conformance/alm/assess-alm-conformance-identity.ts:33-71`,
  `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json` (regenerated, never
  hand-edited)
- Test (under `packages/tests/`): `shared-test/alm-lifecycle-recipes.test.ts:69-78`,
  `shared-test/alm-identity-assessment.test.ts`, `shared-test/alm-conformance-recipes.test.ts`,
  `shared-test/alm-conformance-recipe-validation.test.ts`,
  `rallar-black-box/hetzner-distributed-manifests.test.ts`

**Interfaces:**

- Produces, `create-alm-conformance-recipes.ts`: a private
  `toSubmissionReceiptCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[]`
  holding `receipts-1`, `assert-confirmed-1`, `assert-unconfirmed-1` and the two
  `toSubmittedCancellationCommands` assertions, unchanged in id, operator and expected value, and
  appended as the last group of `toDeliveryLifecycleSenderCommands` (`:350-356`).
- Produces, `assess-alm-conformance-identity.ts`: a private
  `assessAcknowledgedIdentity(input: AcknowledgedIdentityInput): void` over
  `interface AcknowledgedIdentityInput { readonly send: RallarBlackBoxTestMessagesSendCommand; readonly sender: RecordedAlmConformanceParticipant; readonly issues: string[]; }`
  that, for a non-`ws` submission, finds the sender's `messages.receipts` command on the send's
  `handleId` and requires a non-empty `confirmedHopPeerIds` and an empty `unconfirmedHopPeerIds`,
  after `assessReceivedIdentity` (`:107-137`) has joined the same `msgId` to the receiver's envelope.

- [ ] **Step 1: No recipe polls `acknowledged` (RED).** Add to `alm-lifecycle-recipes.test.ts`, over
      the three carriers: no `messages.observe` in the `delivery-lifecycle` sender lists
      `acknowledged` in its `state`, and `receipts-1` comes after the last `supersede-release-`
      command. Update `expectReplacementSubmittedAfterRelease` (`:69-78`) to
      `observe-transport-accepted-4` on every carrier.
      Command: `npx vitest run packages/tests/shared-test/alm-lifecycle-recipes.test.ts`
      Expected: RED for `rtc` and `rtc-with-ws-fallback`.
- [ ] **Step 2: The recipe edits.** `toSubmissionSpecimenCommands` (`:450-496`): the observed state is
      `transport-accepted` on every carrier — the handle wait resolves on it or on any terminal
      state, including `acknowledged` (`browser-rallar-delivery-registry.ts:367-372`) — and
      `assert-submitted-state-1` becomes `matches` `^(transport-accepted|acknowledged)$` for the two
      RTC carriers and stays `equals` `transport-accepted` for `ws`; the receipts and cancellation
      group moves into `toSubmissionReceiptCommands`. `toReplacementSubmittedCommands` (`:578-592`)
      observes `transport-accepted` on every carrier. The observe budget is unchanged: both states are
      in the 10 000 ms class (`:894-898`); `observe-superseded-3` keeps its 3 000 ms, which Task 3
      makes a local, immediate state. `cancel-1` still expects `^acknowledged$` on RTC, now read
      after the whole scenario rather than 10 s after the send.
- [ ] **Step 3: Correlate afterwards.** Add `assessAcknowledgedIdentity`, called for the submission
      beside `assessReceivedIdentity` (`:58-63`). Tests in `alm-identity-assessment.test.ts`: the
      generated rtc evidence with a filled receipts result passes; the same evidence with an empty
      `confirmedHopPeerIds` is rejected with the send's command id in the issue; `ws` is not asked
      for a confirmed hop.
- [ ] **Step 4: The generated manifests.**
      `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`, then the same
      with `--check`; `npx vitest run packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/shared-test`.
      Commit: `git commit -am 'test(alm): observe lifecycle receipts on the receiver and correlate them afterwards'`

### Task 5: The navigation maps and the local lane

**Files:** modify `packages/shared/alm/inbound/README.md:148-196` and
`packages/shared/alm/outbound/README.md:111-123,162-208`. **Interfaces:** none — documentation and
the local lane run.

- [ ] **Step 1: The inbound map.** In "Selection, failure, and cleanup", after the observation
      paragraph (`:156-164`): the batch runs its claims in rank order — `dispatch-local` and
      `release-buffered`, then admission replays and undecoded rows, then `send-control` and
      `forward-message` — because page order is key order and an ACK's key sorts before its own
      dispatch; the sort reads kinds the eligibility read already decoded and costs no operation.
      Under 2C, one batch's control sends commit together. In the diagnostics paragraph
      (`:185-194`), the new fields and that the deferred witness rides on existing events.
- [ ] **Step 2: The outbound map.** In "Transport attempt settlement" (`:162-208`): a replacement's
      commit states `superseded` for each predecessor it marks replaced, before the admission
      returns, and the attempt-time and dequeue-time checks only add evidence to that terminal
      state. Under 2D, RTT heartbeats leave through `sendLive` and never hold the commit lock
      (`:111-123`); under 2C, `commitBundles`' single sender-version fence.
- [ ] **Step 3: The local lane, three carriers.** `npm run test:rallar:full-stack:memory:alm`.
      Expected: three cells pass and each `test-results/alm-observation/<carrier>-smoke.json` has a
      receiver `claimWaits` with a non-zero `dispatchClaimCount`; record per cell the per-operation
      median and the three `claimWaits` medians for the PR body. An empty `claimWaits` means
      `claim-settled` is not reaching the snapshot — diagnose before pushing; Task 6 reads it.
- [ ] **Step 4: Commit.** `npx dprint check packages/shared/alm/inbound/README.md packages/shared/alm/outbound/README.md`,
      `git commit -am 'docs(alm): delivery-first inbound drain and superseded at admission'`

### Task 6: Re-observe hosted under the regime rule, the PR, and the gates

**Files:** none in production; the lane's artifacts and the pull request.

- [ ] **Step 1: Push, then classify before judging.** The Release Gate's non-blocking
      `alm-conformance-observation` job (`.github/workflows/release-gate.yml:191-243`) uploads
      `alm-conformance-lane-<sha>`. Read `regime` in every `alm-observation/<carrier>-smoke.json`;
      the rtc cell's regime is the runner's verdict. A red counts only against a green baseline of
      the same regime, and `unclassified` is no evidence
      (`packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md:87-105`).
- [ ] **Step 2: The full scope, for `delivery-reload` (ruling R-S2a-2, 2026-09-23).** The Release Gate
      runs the smoke scope only (`full-stack-alm-conformance.spec.ts:53,212`) and `delivery-reload` is
      tagged full (`create-alm-conformance-recipes.ts:192-193`). Give the observation job a scope input
      instead of a throwaway branch: in `.github/workflows/release-gate.yml` add the reusable-workflow
      input `alm_scope` (`type: string`, `required: false`, `default: 'smoke'`, description "ALM
      conformance scope the observation job runs: smoke or full") beside `changed_repo_style_base`
      (`:5-14`), and set `RALLAR_BLACK_BOX_ALM_SCOPE: ${{ inputs.alm_scope }}` in the
      `alm-conformance-observation` job's `env` (`:196-197`); in `.github/workflows/branch-release-gate.yml`
      pass `alm_scope: ${{ vars.RALLAR_BLACK_BOX_ALM_SCOPE || 'smoke' }}` in the `with:` block (`:108-113`).
      The main-push deploy path keeps the default. The maintainer sets the repository variable
      `RALLAR_BLACK_BOX_ALM_SCOPE` to `full` for S2a's read and clears it afterwards; the PR body records
      which run carried the full read. If the full family is cut off by the job's `timeout-minutes: 30`
      (`:194`), raise that one figure to the measured next multiple of ten and record it — it is a job
      ceiling, not a harness budget. Command: `npm run test:repo-governance` after the workflow edit.
      Read the full-scope artifact under the same regime rule as Step 1.
- [ ] **Step 3: The acceptance (D31).** `delivery-lifecycle` (smoke and full) and `delivery-reload`
      (full) green on all three carriers in a regime with a same-regime green baseline. Record per
      cell `regime`, `perOperation.medianMs`, and the receiver's `sendControlClaimMedianMs` and
      `intraBatchWaitMedianMs` beside Task 0's reading and the diagnosis' bands (`send-control`
      689–1 187 ms green; the 5.9 s intra-batch wait of `f33dd8118 / rtc`). Under shape A the
      `send-control` median may stay red while the delivery arrives — that is the point (proposal
      §5). F2c's inbound release median (525–908 ms) and pending share (6–11 %) stay unregressed. A
      red with no same-regime green baseline is not a verdict: rerun once; if it reds again, write the
      diagnosis as a session record and route it to the maintainer rather than tuning a budget or a
      threshold. Two iterations before the maintainer is asked again.
- [ ] **Step 4: The PR body.** Goal, Changes, Acceptance, Validation, Risk and rollback, Follow-up,
      in the F2b shape. Acceptance names the Task 0 reading and the RTT probe (heads, run ids,
      medians) as the D18 confirmation, the lever chosen and the one excluded, the claim-order pin,
      the synchronous `superseded`, the recipe change and the unchanged operation-count pins. Risk
      and rollback: no schema-id move and no persisted shape; a revert restores page order and the
      drain-time `superseded`; under 2D a heartbeat is lost while the socket is closed; under 2C the
      RTC rate limiter counts one token per control group. Both bundle figures against their
      budgets. `npm run pr:delivery -- status` decides the next action; `ready` and auto-merge are
      not used.
- [ ] **Step 5: The full local list on the final tree.** `npm run test:unit`; `npm run typecheck`;
      `deno task check` in `apps/api-v1`, `apps/rallar-black-box-control-server` and
      `apps/relic-hunter-server-v1`; `npm run test:deno` (not optional: Task 3 widens a shared
      settlement type and `deno task check` reads `src/main.ts` only); `npx dprint check`;
      `npm run check:repo-style:changed -- origin/main HEAD`; `node scripts/check-tests-typecheck.mjs`;
      `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`;
      `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`;
      `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`;
      `npm run build`; `npm run test:ci`. Report which passed, failed or were skipped, and why. Only
      if 2C landed: `npm run db:test:up` and `npm run test:api-v1:black-box:postgres:medium-scale`,
      since 2C touches the WS server service's control path; never weaken its constants, matrix or
      assertions.
- [ ] **Step 6: Branch Release Gate** green on the final commit before review (any later change
      invalidates it); after merge, **Run Hetzner Supported Distributed Manifests** on `main`.

---

## Not in this slice

- **S2b, one identity** (D20) and **S2c, receipted audiences** (D21–D26, D29). S2a touches no key
  layout, and Task 4 correlates hop receipts without making them logical.
- **Shape B and a wake-on-admission change:** a second scheduling owner or a new wake path is a
  maintainer decision; Task 0 Step 8 routes a round-scheduling reading there instead of building it.
- **Harness budgets, lane constants and regime thresholds**, **the lane's return to `test:ci`**, and
  **any RTT redesign beyond 2D** (cadence, degree limit, a server RTT store, RTT over RTC).
- **The restart-clears-observations hazard:** an admission landing mid-batch calls `restartScan`,
  which drops the running batch's delivery observations (`read-al-inbound-work-selection.ts:234-237`),
  so its later dispatch claims re-read their surfaces. Correct but costly; recorded for S2b.

## Self-review

- Spec coverage, per the roadmap's "Release 3, S2a" Changes: (1) the confirming instrumentation,
  batched, with one hosted `rtc` read → Task 0 Steps 1–8; (2) dispatch-first ordering, with C or D
  per Task 0 → Tasks 1 and 2, chosen by Task 0 Steps 8–9 under the proposal's labels (see "Shape
  labels"); (3) `superseded` at the replacement's admission (D27) → Task 3; (4) receipts observed on
  the receiver and correlated afterwards (D28), the analysis' `typeId` filter removed → Task 4 and
  Task 0 Step 6.
- Acceptance coverage: D31 → Task 6 Steps 1–3, `delivery-reload`'s full scope in Step 2; the
  `send-control` median and dispatch latency from the inbound block → Task 0 Step 5, Task 6 Step 3;
  no budget changed → Global Constraints and Task 4 Step 2; no timer, queue or registry → Task 1's
  sort, 2C's array-identity round, Task 3's synchronous emission; no cognitive-load pin → Task 6
  Step 5; D18 before merge → Task 0 Steps 7–9.
- Type consistency: `ALWorkUnreservedDue`, `toALInboundWorkEffectId`, `ALInboundDeferredEffect`,
  `ALMObservationInboundClaim`, `ALMObservationInboundClaimWaits`, `readALInboundRowEligibility`
  and the fixture's `acknowledged` are defined in Task 0 before Tasks 1 and 5 use them;
  `computeALInboundClaimOrder` and `InboundTestEffectCall` in Task 1 before 2C relies on the order;
  the `superseded` settlement arm in Task 3 before Task 4 relies on `observe-superseded-3` resolving
  locally. No type is introduced twice and no alias renames one.
- File size: every added function is under 40 lines, and Task 0 Step 2 splits the 49-line
  `readALInboundPageEligibility` rather than growing it. Near the 1 200-line backstop:
  `al-work-handler.test.ts` (1 186; two literals gain three fields, no test added),
  `al-inbound-effect-worker-lifecycle.test.ts` (1 156; untouched — Task 1's test lives in the
  259-line selection suite) and `create-alm-conformance-recipes.ts` (1 064; Task 4 moves commands
  and adds one short function).
- Placeholder scan: every step names files with line ranges, the symbol, the test code or exact
  edit, and the command. The one branch point, 2C or 2D, is decided by a numeric rule (Task 0
  Step 9), and both branches are written out.
