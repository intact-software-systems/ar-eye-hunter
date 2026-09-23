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
  thresholds 30 and 35 ms per operation, and Task 8's page thresholds 20 and 50 ms per probe, are
  constants, not knobs.
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
  `packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts:29-106`,
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
  // packages/shared/alm/work/al-work-handler.ts gains no new exported type here (R-S2a-3): only
  // `ALWorkBatchDiagnostics.startedAtMs` below. Run order and deferred rows are inbound-owned.

  // No inverse of `toALInboundWorkKey` is added (R-S2a-3): queue-key context segments hash parts
  // longer than 35 chars, so the inverse cannot exist. Effect ids are recorded at source instead --
  // `runInboundClaim`'s own decoded `effect.effectId` in run order, and `ALInboundDeferredEffect`
  // below from the selector -- never decoded back out of a `Key`.

  // packages/shared/alm/inbound/al-inbound-runtime-diagnostics.ts
  export interface ALInboundDeferredEffect {
      readonly effectId: string;
      readonly dueAtMs: number;
  }
  ```

- `ALWorkBatchDiagnostics` gains only `readonly startedAtMs: number` (the instant `runClaim` receives
  as `batchStartedAtMs`) — no `claimedKeys` or `unreservedDue` field lands on the generic
  `ALWorkReadySelection`/`ALWorkBatchDiagnostics` types (R-S2a-3). Run order and deferred rows stay
  inbound-owned: `runInboundClaim` records each claim's own `effect.effectId` at source into a
  private `batchRunOrder`, and the inbound selector's `getUnreservedDue()` returns
  `ALInboundDeferredEffect { effectId, dueAtMs }` directly — both keyed by effect id, never by `Key`.
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
      /**
       * Median `batchStartedAtMs − dueAtMs` over this role's `dispatch-local` claims: from due to the
       * run loop of the batch that ran the claim — the wait for a round, plus that batch's selection
       * and reservation (R-S2a-4).
       */
      readonly reservationWaitMedianMs: number;
      /** Median `startedAtMs − batchStartedAtMs` over the same claims: the serialization behind earlier claims of the run loop (R-S2a-4). */
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

- [x] **Step 1: The handler reports the batch's start, its run order and what it left behind (RED
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

      Add `drainsOf` beside the file's `claimsOf` (`:77-79`). Then, in `al-work-handler.ts`, add only
      the one `ALWorkBatchDiagnostics.startedAtMs` field, and make `reportBatch` (`:370-385`) pass
      `startedAtMs`. No `ALWorkUnreservedDue` type and no `claimedKeys`/`unreservedDue` field land on
      the generic `ALWorkReadySelection`/`ALWorkBatchDiagnostics` types (R-S2a-3):
      `selectOutboundWork` (`al-outbound-message-runtime.ts:498-511`) and `toTestALWorkReadySelection`
      (`al-work-test-entries.ts:55-66`) are unchanged; the two batch literals in
      `al-work-handler.test.ts` (`:214-228`, `:258-272`) gain only `startedAtMs: PHASE_BATCH_START_MS`.
      Command: `npx tsc -p packages/shared/tsconfig.json --noEmit && npx vitest run packages/tests/shared/alm/work`
- [x] **Step 2: The selector records what it deferred.** `readALInboundPageEligibility` is 49
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
      `deferred` answer pushes `{ effectId: row.effect.effectId, dueAtMs: resolveALInboundWorkDueAtMs(entry) }`
      onto a new `deferred: readonly ALInboundDeferredEffect[]` on `ALInboundPageEligibility` (`:78-83`)
      and `ALInboundWorkSelection` (`:41-57`) (R-S2a-3: keyed by effect id, not by `Key`).
      `readALInboundClaimedSelection` (`:274-298`) returns
      `unreservedDue: [...selection.deferred, ...toUnreservedClaimableDue(selection, claimedKeys)]`,
      where the new private `toUnreservedClaimableDue` maps every claimable entry the port did not
      reserve through the same `resolveALInboundWorkDueAtMs`. A row reserved by a live lease is not
      due (`resolveALInboundWorkReadyAt`, `al-inbound-work-entry.ts:135-150`), so a batch's own rows
      never read as deferred. Extend `al-inbound-work-selection.test.ts:85-112` with one case: a
      page whose only row `readReadiness` defers reports it in `unreservedDue` with its due time and
      claims nothing.
      Command: `npx vitest run packages/tests/shared/alm/inbound/al-inbound-work-selection.test.ts`
- [x] **Step 3: The inbound runtime relays the split.** No inverse of `toALInboundWorkKey` is added
      (R-S2a-3). Widen `toALInboundClaimIdentity`
      (`al-inbound-runtime-diagnostics.ts:94-106`) with `subjectMsgId`, and add the fields and
      `ALInboundDeferredEffect` above. In `al-inbound-message-runtime.ts`: a new private
      `recordClaimStarted(batchStartedAtMs, effectId)`, called from `runInboundClaim`, keeps
      `batchRunOrder: { batchStartedAtMs, effectIds: string[] } | undefined`, starting a fresh array
      whenever `batchStartedAtMs` changes and appending the effect id `decodeALInboundWorkEntry`
      already decoded — effect ids recorded at source, never decoded back out of a `Key` (R-S2a-3).
      `recordWorkBatch` (`:228-247`) passes `startedAtMs`, `claimedEffectIds` read from
      `batchRunOrder` when its `batchStartedAtMs` matches the event's (else `[]`), and `deferred`
      from the selector's own `getUnreservedDue()` through `toOldestFirstALInboundDeferredEffects`
      (oldest first) — not a field on `ALWorkBatchDiagnostics`; `recordEmptyRotationRound` (`:255-273`)
      also reads `getUnreservedDue()` and adds a `deferredRoundCount` and a
      `latestDeferred` beside its three existing accumulators, reset with them; `runInboundClaim`
      (`:368-380`) passes its `startedAtMs` into `ALInboundClaimSettlement` (`:428-435`, one new
      required field) and `recordClaimSettled` (`:382-396`) emits `effectId: settled.effect.effectId`,
      `dueAtMs`, `batchStartedAtMs` and `startedAtMs`, computing `queueWaitMs` from the same `dueAtMs`
      so the two can never disagree. Every function stays under 40 lines.
      Command: `npx vitest run packages/tests/shared/alm/inbound-admission-diagnostics.test.ts`
      Expected: Step 1's test passes over both backends with the control-first run order.
- [x] **Step 4: The deferred witness, and the relay pin that must not move.** Over both backends, a
      runtime with `canDispatchMessage: () => false` admits one message and `runRotationUntilAlive`
      (`:82-92`); the first `rotation-alive` reports `deferredRoundCount > 0` and the dispatch effect
      id in `latestDeferred`. Then `al-indexeddb-operation-counts.test.ts` runs unchanged: the
      deferred-row idle rotation (`:347-376`) still relays only `rotation-alive`, and the 6 + 2,
      10 / 15 and one-release pins hold — in-memory fields on existing events, no storage read.
- [x] **Step 5: The observation snapshot decodes `claim-settled` (RED first).** In
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
- [x] **Step 6: The contract, the artifact document and the session tool.** In
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
- [x] **Step 7: Commit and push the instrumentation alone.** `npx vitest run packages/tests/shared/alm packages/tests/shared-test`,
      `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`,
      `npx dprint check <touched files>`, `git commit -am 'feat(alm): split the inbound delivery wait into its reservation and intra-batch halves'`,
      then push `claude/alm-s2a-delivery-ahead-of-control`. Nothing else is pushed until this
      commit's `alm-conformance-lane-<sha>` artifact has uploaded, so its cells measure the drain
      as merged `main` runs it.
- [x] **Step 8: The hosted read (the D18 confirmation).** Download the artifact
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
- [x] **Step 9: The RTT one-variable probe (diagnosis §6, alternative 1).** From the Task 0 commit,
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

- [x] **Step 1: The delivery runs first (RED).** Add to `al-inbound-work-selection.test.ts`:

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
- [x] **Step 2: The ranks, pinned purely.** Add a second test in the same `describe`: seven claims —
      one per `ALInboundDurableEffect['kind']` and one whose key is absent from `effectKinds` — fed as
      `forward-message`, `send-control`, unknown, `admit-control`, `admit-message`,
      `release-buffered`, `dispatch-local`, come back as `release-buffered`, `dispatch-local`,
      unknown, `admit-control`, `admit-message`, `forward-message`, `send-control` (stable in rank). Implement `computeALInboundClaimOrder` as
      `[...claims].sort((left, right) => rank(left) - rank(right))` over a private
      `toALInboundClaimRank(kind: ALInboundDurableEffect['kind'] | undefined): 0 | 1 | 2` whose
      `switch` lists all six kinds and `undefined` with no `default`, so a seventh kind must choose
      its rank.
- [x] **Step 3: Order the list the batch already builds.** Record `effectKinds` in the eligibility
      fold, and in `readALInboundClaimedSelection` (`:274-298`) replace
      `claims: [...selection.unleasedReservations, ...claims]` with
      `claims: computeALInboundClaimOrder([...selection.unleasedReservations, ...claims], selection.effectKinds)`.
      The unleased reservations are corrupt rows whose kind never decoded, so they rank with the
      unknown row. `earliestDueAtMs` and the observations are keyed by row, not position, and do not
      move. Flip Task 0 Step 1's pin to
      `expect(drain.claimedEffectIds).toEqual([dispatch.effectId, control.effectId])` in this commit.
      Commands: `npx vitest run packages/tests/shared/alm/inbound packages/tests/shared/alm/inbound-admission-diagnostics.test.ts`
      Expected: Step 1 GREEN on both backends.
- [x] **Step 4: The pins that must not move.** Run them unchanged and name them in the commit
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

**Read on 2026-09-23.** Step 8 on the Task 0 commit alone (`c6ded1707`, probe PR #585, run
35843670606): receiver `reservationWaitMedianMs` 7 302 / 6 223 / 7 795 ms against `intraBatchWaitMedianMs`
645 / 105 / 124 ms (ws / rtc / fallback), `sendControlClaimMedianMs` 2 734 / 1 875 / 1 748 ms — rule (b).
Step 9 with RTT heartbeats off (probe PR #586, run 35843674446): every cell passed in the normal regime
(20.11 / 13.83 / 20.94 ms/op), receiver `sendControlClaimMedianMs` 778 / 796 / 730 ms (below 1 200) and
reservation 1 904 / 1 729 / 2 008 ms — the RTT commits on the shared outbound lock are the hog, so the
lever is **2D**. The maintainer (2026-09-23) chose 2D plus wake-on-admission on the condition that the wake
builds on existing functionality with no new abstraction or layer. Reading the code for that condition
(ruling R-S2a-6): the wake already exists — a committed ingress admission calls `commitWork()`
(`al-inbound-message-runtime.ts:335`), which runs `restartScan()` and `ALWorkHandler.committed()` →
`queueEngine.wake()` (`al-work-handler.ts:218-220`), and a wake landing during a batch is drained by one
follow-up batch at that batch's end (`:168`). The reservation term is therefore the running batch's
remaining duration, inflated by RTT-contended `send-control` claims; 2D shortens it, and preempting a
running batch would be shape B. **Task 2 = 2D plus one pin** (Step 0 below) that the existing wake is
reached from the ingress path and lands in the follow-up batch. Task 2C is recorded, not executed,
unless Task 6 Step 3's re-read rule selects it (maintainer ruling, 2026-09-23).

2D landed per Task 0 Step 9. 2C lands only if Task 6 Step 3's re-read rule selects it; otherwise the PR
body records it as not chosen.

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

- [x] **Step 0: The existing wake is reached from ingress (pin).** In the inbound diagnostics or work
      suite, over a real memory runtime with a batch held mid-run (the Task 3 test's held-queue seam),
      admit one message through `admitIncomingMessage`; assert `queueEngine.wake()` was called once by
      the admission (`ALWorkHandler.committed()` → `queueEngine.wake()`) and that the dispatch effect
      runs in the follow-up batch the running batch schedules at its end, not a later round. No
      production change: the pin proves R-S2a-6. If the pin is RED on any ingress path, stop and report.
      Command: `npx vitest run packages/tests/shared/alm/inbound packages/tests/shared/alm/work`
- [x] **Step 1: A heartbeat costs no admission (RED).** In `browser-middleware-rtt.test.ts`, drive
      `registerBrowserRttEgress`'s heartbeat against a WS client over a counting IndexedDB observer
      and assert zero `al-admission` operations and one socket write; today it spends a full
      admission.
- [x] **Step 2: `sendLive`, and the egress uses it.** Implement it on the client with
      `isSocketOpen` (`:572-574`); `registerBrowserRttEgress` calls it and drops the enqueue, the
      verdict branch and the `qboxEngine.wake()`. Tests: closed socket → `'socket-closed'` and no
      write; open socket → the exact outbox resource string.
- [x] **Step 3: Verify and commit.** `npx vitest run packages/tests/shared-web/connection packages/tests/shared/webrtc-rtt-lifecycle.test.ts packages/tests/shared/services`,
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
  function after `:262-284`), `outbound/al-outbound-dispatch-admission.ts` (the new
  `emitSupersededSettlements`, R-S2a-5), `outbound/al-outbound-message-runtime.ts` (wires the
  `settlements` dependency, no `commitDispatchPlan` edit)
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

- [x] **Step 1: The predecessor settles without a drain (RED).** Add to
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
- [x] **Step 2: The vocabulary and the reducer.** Add the arm; add
      `case 'superseded': return toReasonedLifecycle(previous, 'superseded', settlement.detail);` to
      the switch (`compute-al-delivery-lifecycle.ts:24-38`). Tests in
      `compute-al-delivery-lifecycle.test.ts`: a `queued` lifecycle reaches `superseded` with the
      detail as its reason; a later `attempt-settled superseded` on it only adds evidence and
      increments `lateSettlementCount`; a `superseded` on an `acknowledged` lifecycle stays
      `acknowledged`.
- [x] **Step 3: The admission states it from the commit.** Implement
      `toALOutboundSupersededMsgIds` as the `msgId` of every `set-supersedence-replacement`
      mutation in `bundle.mutations` whose `observed` is `undefined`, guarded by a genuine
      `set-supersedence-latest` transition (`expected?.latestMsgId !== value.latestMsgId`) — so a
      re-commit of the replacement row emits nothing (R-S2a-5). The emission does not live in the
      runtime's `commitDispatchPlan`: a new private `emitSupersededSettlements(result)` on
      `ALOutboundDispatchAdmission` (`al-outbound-dispatch-admission.ts`) runs in `commitDispatchOnce`
      after `toCommitResult`, on a committed result, and states
      `{ kind: 'superseded', msgId, replacementMsgId: msg.id.msgId, detail: 'A newer message replaced this one at its admission.' }`
      for each id, through the `settlements` dependency the runtime wires to its own guarded
      `emitSettlement` (`:703-713`). It runs on every commit path — enqueue, pending replay and
      dequeue — because the commit is the decision point.
      Step 1 turns GREEN; after `held.release()` a drained attempt of the old message states its
      `attempt-settled superseded`, and the test asserts the lifecycle a registry would compute from
      both stays `superseded`.
- [x] **Step 4: The handle, end to end.** In `browser-rallar-delivery-registry.test.ts` a handle
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

- [x] **Step 1: No recipe polls `acknowledged` (RED).** Add to `alm-lifecycle-recipes.test.ts`, over
      the three carriers: no `messages.observe` in the `delivery-lifecycle` sender lists
      `acknowledged` in its `state`, and `receipts-1` comes after the last `supersede-release-`
      command. Update `expectReplacementSubmittedAfterRelease` (`:69-78`) to
      `observe-transport-accepted-4` on every carrier.
      Command: `npx vitest run packages/tests/shared-test/alm-lifecycle-recipes.test.ts`
      Expected: RED for `rtc` and `rtc-with-ws-fallback`.
- [x] **Step 2: The recipe edits.** `toSubmissionSpecimenCommands` (`:450-496`): the observed state is
      `transport-accepted` on every carrier — the handle wait resolves on it or on any terminal
      state, including `acknowledged` (`browser-rallar-delivery-registry.ts:367-372`) — and
      `assert-submitted-state-1` becomes `matches` `^(transport-accepted|acknowledged)$` for the two
      RTC carriers and stays `equals` `transport-accepted` for `ws`; the receipts and cancellation
      group moves into `toSubmissionReceiptCommands`. `toReplacementSubmittedCommands` (`:578-592`)
      observes `transport-accepted` on every carrier. The observe budget is unchanged: both states are
      in the 10 000 ms class (`:894-898`); `observe-superseded-3` keeps its 3 000 ms, which Task 3
      makes a local, immediate state. `cancel-1` still expects `^acknowledged$` on RTC, now read
      after the whole scenario rather than 10 s after the send.
- [x] **Step 3: Correlate afterwards.** Add `assessAcknowledgedIdentity`, called for the submission
      beside `assessReceivedIdentity` (`:58-63`). Tests in `alm-identity-assessment.test.ts`: the
      generated rtc evidence with a filled receipts result passes; the same evidence with an empty
      `confirmedHopPeerIds` is rejected with the send's command id in the issue; `ws` is not asked
      for a confirmed hop.
- [x] **Step 4: The generated manifests.**
      `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`, then the same
      with `--check`; `npx vitest run packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/shared-test`.
      Commit: `git commit -am 'test(alm): observe lifecycle receipts on the receiver and correlate them afterwards'`

### Task 5: The navigation maps and the local lane

**Files:** modify `packages/shared/alm/inbound/README.md:148-196` and
`packages/shared/alm/outbound/README.md:111-123,162-208`. **Interfaces:** none — documentation and
the local lane run.

- [x] **Step 1: The inbound map.** In "Selection, failure, and cleanup", after the observation
      paragraph (`:156-164`): the batch runs its claims in rank order — `dispatch-local` and
      `release-buffered`, then admission replays and undecoded rows, then `send-control` and
      `forward-message` — because page order is key order and an ACK's key sorts before its own
      dispatch; the sort reads kinds the eligibility read already decoded and costs no operation.
      Under 2C, one batch's control sends commit together. In the diagnostics paragraph
      (`:185-194`), the new fields and that the deferred witness rides on existing events.
- [x] **Step 2: The outbound map.** In "Transport attempt settlement" (`:162-208`): a replacement's
      commit states `superseded` for each predecessor it marks replaced, before the admission
      returns, and the attempt-time and dequeue-time checks only add evidence to that terminal
      state. Under 2D, RTT heartbeats leave through `sendLive` and never hold the commit lock
      (`:111-123`); under 2C, `commitBundles`' single sender-version fence.
- [x] **Step 3: The local lane, three carriers.** `npm run test:rallar:full-stack:memory:alm`.
      Expected: three cells pass and each `test-results/alm-observation/<carrier>-smoke.json` has a
      receiver `claimWaits` with a non-zero `dispatchClaimCount`; record per cell the per-operation
      median and the three `claimWaits` medians for the PR body. An empty `claimWaits` means
      `claim-settled` is not reaching the snapshot — diagnose before pushing; Task 6 reads it.
- [x] **Step 4: Commit.** `npx dprint check packages/shared/alm/inbound/README.md packages/shared/alm/outbound/README.md`,
      `git commit -am 'docs(alm): delivery-first inbound drain and superseded at admission'`

### Task 7: The ACK admitted under a hold

Per the maintainer's re-plan (2026-09-23) after the full-scope read of `7add928af`
(`.superpowers/s2a-full-read-diagnosis.md` §3 and §5). The rtc and fallback reds are one failure: the
submission's ACK leaves the receiver while the sender's `cancel-hold` is armed, the sender records no
`admission-outcome` for it, and the handle expires at the browser's 30 s default TTL
(`packages/shared-web/browser/messages/browser-rallar-message-sender.ts:87`), so `receipts-1` reads
`expired` with no confirmed hop. Task 4 exposed it by no longer waiting for `acknowledged` before the
hold is armed. The hold filters **outgoing** frames only: the port decides sends
(`packages/shared/transport-faults/transport-fault-port.ts:97-117`), RTC consults it only on the send
path (`packages/shared/webrtc/qrtc-data-channel.ts:315-318,370-390`) and WS only before an outbox
submission (`packages/shared/services/ws-queue-box-client-service.ts:552-554`). An inbound frame
reaches `dispatchDataChannelMessage` (`qrtc-data-channel.ts:515-532`) or `acceptIncomingMessage`
(`ws-queue-box-client-service.ts:428-443`) with no port call. The lane's hold matches the scenario
`typeId` only (`create-alm-conformance-recipes.ts:690-704`), and the submission shares that typeId
with the held cancellation specimen. The artifacts could not name the mechanism. This task names it
with one deterministic variable and fixes it at the site it names.

**Where the ACK's admission can stop.** `admitIncomingMessage` records the `admission-outcome` only
after `admitDecodedMessage` returns (`packages/shared/alm/inbound/al-inbound-message-runtime.ts:206-207`).
A control's return first waits on the inbound control admission (`:359-360`) and then on the
outbound owner (`:372-374`). On RTC that is `web-rtc-rx-streamer-service.ts:128-130` →
`web-rtc-overlay-multicast-manager.ts:368-374`, and on WS it is `ws-queue-box-client-service.ts:239-241`.
Both reach `ALOutboundMessageRuntime.acceptControlMessage` (`al-outbound-message-runtime.ts:463-475`),
then `ALOutboundRepairAdmission.acceptControlMessage` (`al-outbound-repair-admission.ts:58-68`) and
`ALOutboundControlAdmission.admit` (`control/al-outbound-control-admission.ts:106-137`). A throw on
that chain skips the event. The RTC channel turns the throw into `console.error('Callback onMessage
failed', …)` (`qrtc-data-channel.ts:576-578`). The recorded outcome is the inbound acceptance. An ACK
for the sender's own message therefore reads `not-handled` / `control` whatever the outbound owner did
(`:369-375`; `al-inbound-runtime-diagnostics.ts:192-195`). The event proves that the inbound half
settled, not that the receipt moved.

| Site                             | Where (under `packages/shared/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | What the witness reads                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| C0 carrier discard               | the RTC `status.dc` guards (`webrtc/qrtc-data-channel.ts:519-521,543-545`); the streamer's peer guard (`services/web-rtc-rx-streamer-service.ts:166-168`); the WS socket-identity guard and the closed client (`services/ws-queue-box-client-service.ts:417-419,431-433`)                                                                                                                                                                                                                                                                                                  | `never-admitted`                                              |
| C1 inbound control throws        | `ALInboundControlAdmission.admit` (`alm/inbound/control/al-inbound-control-admission.ts:70-86`): the provenance throw (`:139-144`), `commitBundle` (`:106`), `retainPendingControl` (`:118-128`)                                                                                                                                                                                                                                                                                                                                                                           | `inbound-threw`                                               |
| C2 outbound control throws       | `ALOutboundControlAdmission.admit`: `readControlAdmission` (`alm/outbound/control/al-outbound-control-admission.ts:279-303`), `readEffects` (`:118-123`), the rethrow of a non-conflict error (`:157-162`), `retainPendingControl` (`:367-377`)                                                                                                                                                                                                                                                                                                                            | `outbound-threw`                                              |
| C3 an await never settles        | `acceptControlMessage`'s `ready()` (`alm/outbound/al-outbound-message-runtime.ts:464`); the write serialization of `InMemoryAdmissionBackend.write` (`alm/al-admission-backend.ts:137-143`) or an IndexedDB readwrite queued behind an open read session (`alm/indexed-db-admission-backend.ts:210-233`)                                                                                                                                                                                                                                                                   | `inbound-unsettled` or `outbound-unsettled`                   |
| C4 answered but not acknowledged | `rejected` by validation; `pending-control` whose replay never commits (the sender-wide fence, `alm/outbound/control/al-outbound-control-admission.ts:323-338`); `committed` over a receipt already gone, cleared after `maxAttempts` of retransmissions the same-typeId hold dropped (`alm/outbound/al-outbound-repair-admission.ts:181-184`) or expired (`alm/outbound/transition-al-outbound-pending-ack.ts:82-87`), so no `acknowledgement` is stated (`transition-al-outbound-pending-ack.ts:66-71`, `alm/outbound/compute-al-outbound-control-admission.ts:119-130`) | `outbound-answered` with the value, handle not `acknowledged` |

**Files:**

- Create: `packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts` (the two sender
  compositions, the witness, the scenario body) and
  `packages/tests/shared-web/messages/acknowledgement-under-transport-hold.test.ts`
- Modify: `packages/tests/shared-web/authoritative-group-fixtures.ts` gains
  `createAcceptedGroupSnapshotFixture(sessionIds)` and
  `createAcceptedOverlayFixture(group, version, nextHopSessionIds)`, moved from the private
  `acceptedGroup` and `overlay` of `packages/tests/shared-web/rtc/initialise-browser-rtc-runtime.test.ts:317-361`,
  which then imports them. No fixture is duplicated.
- Modify at Step 3, only the site Step 2 names: `packages/shared/alm/inbound/control/al-inbound-control-admission.ts:70-86,131-155`,
  `packages/shared/alm/outbound/control/al-outbound-control-admission.ts:106-163,279-303`,
  `packages/shared/alm/al-admission-backend.ts:133-162` or
  `packages/shared/alm/indexed-db-admission-backend.ts:179-233`, with that site's own suite, and
  `packages/shared/alm/outbound/README.md` "Transport attempt settlement" when an outbound path changes.

**Interfaces:**

- Produces, `acknowledgement-under-hold-fixture.ts` (test-only):

  ```ts
  /** One sender page's carrier as the lane composes it, over memory stores, with a scripted hold. */
  export interface HoldSender {
      readonly carrier: 'rtc' | 'ws';
      readonly selfPeerId: string;
      readonly faults: ScriptedTransportFaultPort;
      /** `drop` on RTC, `not-ready` on WS; matches the scenario typeId only, as `toHeldFaultCommands` arms it. */
      readonly hold: ScriptedTransportFault;
      readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
      createMessage(resourceId: string): ALMessage;
      /** Opens the registry handle and admits the message; the caller drains. */
      send(message: ALMessage): Promise<RallarMessageHandle>;
      cancel(msgId: string): void;
      drain(): Promise<void>;
      /** Moves the clock the retry schedule reads; never waits on it. */
      advance(ms: number): Promise<void>;
      /** Runs `ACK_UNDER_HOLD_SETTLE_TURNS` queued turns; a chain still pending afterwards is the C3 reading. */
      settle(): Promise<void>;
      /** Hands the frame to the carrier's own inbound path and does not await its admission. */
      deliver(frame: ALMessage): void;
      /** The typeId of every frame the fault port was asked about. */
      readFaultedTypeIds(): readonly string[];
  }

  /** Where an inbound ACK's admission stopped, read from the two spied hops: a value, never a throw. */
  export type ControlAdmissionStop =
      | Readonly<{ stop: 'never-admitted'; }>
      | Readonly<{ stop: 'inbound-threw'; reason: string; }>
      | Readonly<{ stop: 'inbound-unsettled'; }>
      | Readonly<{ stop: 'not-routed'; }>
      | Readonly<{ stop: 'outbound-threw'; reason: string; }>
      | Readonly<{ stop: 'outbound-unsettled'; }>
      | Readonly<{ stop: 'outbound-answered'; result: ALOutboundControlAdmissionResult; }>;

  export interface ControlAdmissionWitness {
      readonly inbound: MockInstance<ALInboundMessageRuntime['admitIncomingMessage']>;
      readonly outbound: MockInstance<
          ALOutboundMessageRuntime<ALOutboundTransportMessage>['acceptControlMessage']
      >;
  }

  export function openRtcHoldSender(): Promise<HoldSender>;
  export function openWsHoldSender(): Promise<HoldSender>;
  export function watchControlAdmission(): ControlAdmissionWitness;
  export function readControlAdmissionStop(
      witness: ControlAdmissionWitness,
      ack: ALMessage
  ): ControlAdmissionStop;
  export function toReceiverAck(submission: ALMessage, selfPeerId: string): ALMessage;
  export function expectAcknowledgedUnderHold(sender: HoldSender, armed: boolean): Promise<void>;
  ```

- Production: no new type up front. Step 3 changes only the site Step 2 names, and each fix answers
  with a result arm that site already has (`rejected`, `pending-control`). No new outcome enters an
  event or a public contract.

- [x] **Step 1: The ACK is admitted and acknowledged with the hold armed (RED).** Write the fixture
      and the test. Neither imports `setup-browser-indexeddb.ts`. `isIndexedDbALRuntimeStoreSupported()`
      is therefore false, and `configureBrowserALRuntimeStores` composes `InMemoryAdmissionBackend`
      stores (`packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts:118-133`).

      `openRtcHoldSender` composes the sender the way
      `initialise-browser-rtc-runtime.test.ts:142-216` does:

      - `vi.useFakeTimers({ toFake: ['Date'] })`, `configureTestCacheRepositories()` and
        `configureBrowserALRuntimeStores('self', …)`.
      - An accepted group and overlay with next hop `receiver`.
      - `installNativeRtcRuntime()` and `createNativeRtcConnectionFixture(…, faultPort: faults)`, then
        `ensurePeerConnectionStarted('receiver', true)`, `setConnected()` and the channels opened.
      - `initialiseRtcOverlayMulticastManager({ qosProvider: undefined, outboundSettlements: (event) => registry.record(event), … })`.
      - The inbound half that test leaves out: `initialiseRtcRxStreamer({ webRtcOverlayMulticastManager: manager, qboxEngine, clientData: { clientId: 'self', sessionId: 'self', isOnline: true }, inboundDiagnostics: (event) => diagnostics.push(event) })`,
        then `streamer.addPeer(fixture.service.readPeer('receiver')!)`, as
        `initialise-browser-middleware.ts:473` does.

      The RTC `HoldSender` members:

      - `hold` is `{ faultId: 'hold-rtc', carrier: 'rtc', action: 'drop', remaining: 'until-cleared', match: { typeId: 'alm.lifecycle', msgId: undefined, controlType: undefined } }`.
      - `createMessage` is `newALMulticastMessage('self', { topicId: 'room.lifecycle', resourceId, contextId: 'group-1' }, group.group, 'alm.lifecycle', { specimen: resourceId }, { ack: 'receiver', reliability: 'at-least-once', seq })`,
        with `seq` counting up from 1.
      - `advance` is `vi.setSystemTime(Date.now() + ms)`.
      - `deliver` is `void channel.receive(JSON.stringify(frame))` (`native-rtc-connection-fixture.ts:148-150`).
      - `cancel` is `manager.cancel(msgId)`.
      - `readFaultedTypeIds` reads a `vi.spyOn(faults, 'decideSend')`.

      `openWsHoldSender` composes the sender the way `ws-retained-work-fault.test.ts:117-153` does:
      `vi.useFakeTimers()`, `vi.stubGlobal('WebSocket', TestWebSocket)`,
      `new JsonWebSocketClient('ws://test', faults)`, then `createBrowserWebSocketQueueBox({ …, submissionReadinessFaultPort: faults, outboundSettlements: (event) => registry.record(event), inboundDiagnostics: (event) => diagnostics.push(event) })`,
      and finally the native socket opened.

      The WS `HoldSender` members:

      - `hold` is the same shape with `carrier: 'ws'`, `action: 'not-ready'` and typeId `held.message`.
      - `createMessage` is `{ ...newALUnicastMessage(sessionId, { topicId: 'held', contextId: 'room', resourceId }, 'receiver', 'held.message', { resourceId }, { ttlMs: 60_000 }), delivery: { reliability: 'at-least-once', ack: 'receiver' } }`,
        the `:160-165` shape.
      - `advance` is `vi.advanceTimersByTimeAsync(ms)`.
      - `deliver` is `void service.acceptIncomingMessage(frame)`, which is all the socket callback
        does (`ws-queue-box-client-service.ts:411-419`).
      - `cancel` is `service.cancelOutbox(msgId)`.
      - `readFaultedTypeIds` reads a `vi.spyOn(faults, 'decideSubmissionReadiness')`.

      Both carriers share the rest:

      - `settle` runs `ACK_UNDER_HOLD_SETTLE_TURNS = 20` turns. On RTC a turn is
        `new Promise<void>((resolve) => setImmediate(resolve))`, and on WS it is
        `vi.advanceTimersByTimeAsync(0)`. It is a count of turns, not a clock.
      - `drain` is `captureOutboundWorkRunnable(qboxEngine)`.
      - The registry is `new BrowserRallarDeliveryRegistry({ nowMs: Date.now, maxEntries: 10, retainTerminalMs: 60_000, cancel: () => {} })`.
      - Every opener registers its teardown with `onTestFinished`.

      The witness and the scenario body, one variable (`armed`):

      ```ts
      export function watchControlAdmission(): ControlAdmissionWitness {
          return {
              inbound: vi.spyOn(ALInboundMessageRuntime.prototype, 'admitIncomingMessage'),
              outbound: vi.spyOn(ALOutboundMessageRuntime.prototype, 'acceptControlMessage')
          };
      }

      export function readControlAdmissionStop(witness: ControlAdmissionWitness, ack: ALMessage): ControlAdmissionStop {
          const inbound = readSettledCall(witness.inbound.mock, (value) => decodeALMessageValue(value).right?.id.msgId === ack.id.msgId);
          const outbound = readSettledCall(witness.outbound.mock, (msg) => msg.id.msgId === ack.id.msgId);
          if (inbound === undefined) {
              return { stop: 'never-admitted' };
          }
          if (outbound === undefined) {
              return toInboundStop(inbound);
          }
          switch (outbound.type) {
              case 'rejected':
                  return { stop: 'outbound-threw', reason: String(outbound.value) };
              case 'incomplete':
                  return { stop: 'outbound-unsettled' };
              case 'fulfilled':
                  return { stop: 'outbound-answered', result: outbound.value };
          }
      }

      function toInboundStop(inbound: MockSettledResult<unknown>): ControlAdmissionStop {
          switch (inbound.type) {
              case 'rejected':
                  return { stop: 'inbound-threw', reason: String(inbound.value) };
              case 'incomplete':
                  return { stop: 'inbound-unsettled' };
              case 'fulfilled':
                  return { stop: 'not-routed' };
          }
      }

      function readSettledCall<TArgs extends unknown[], TValue>(
          mock: MockContext<(...args: TArgs) => Promise<TValue>>,
          matches: (first: TArgs[0]) => boolean
      ): MockSettledResult<TValue> | undefined {
          const index = mock.calls.findIndex(([first]) => matches(first));
          return index < 0 ? undefined : mock.settledResults[index];
      }

      export function toReceiverAck(submission: ALMessage, selfPeerId: string): ALMessage {
          return newALAckControlMessage(
              { v: 2, msgId: `ack-${submission.id.msgId}`, senderId: 'receiver', ts: Date.now() },
              {
                  ackedMsgId: submission.id.msgId,
                  fromPeerId: 'receiver',
                  toPeerId: selfPeerId,
                  status: 'accepted',
                  observedAtEpochMs: Date.now()
              }
          );
      }

      /** The submission is sent before the hold; a second send of its typeId is held while the ACK arrives. */
      export async function expectAcknowledgedUnderHold(sender: HoldSender, armed: boolean): Promise<void> {
          const witness = watchControlAdmission();
          const submission = sender.createMessage('submission');
          const handle = await sender.send(submission);
          await sender.drain();
          if (armed) {
              sender.faults.inject(sender.hold);
          }
          await sender.send(sender.createMessage('held'));
          await sender.drain();
          await sender.advance(100);
          const ack = toReceiverAck(submission, sender.selfPeerId);
          const retried = sender.drain();
          sender.deliver(ack);
          await retried;
          await sender.settle();
          // One more batch: a conflicted control is retained as `admit-control` work, and its replay is the value path.
          await sender.drain();
          await sender.settle();

          expect(sender.faults.getObservations().length > 0).toBe(armed);
          expect(readControlAdmissionStop(witness, ack)).toMatchObject({ stop: 'outbound-answered' });
          expect(sender.diagnostics).toContainEqual(expect.objectContaining({
              kind: 'admission-outcome',
              msgId: ack.id.msgId,
              typeId: AL_CONTROL_ACK_TYPE_ID,
              reason: 'control'
          }));
          expect(handle.lifecycle().state).toBe('acknowledged');
          expect(sender.readFaultedTypeIds()).not.toContain(AL_CONTROL_ACK_TYPE_ID);
      }
      ```

      The test file:

      ```ts
      describe('an acknowledgement that arrives while a transport hold drops another send', () => {
          afterEach(() => {
              vi.restoreAllMocks();
              vi.unstubAllGlobals();
          });

          it.each([
              ['rtc', false],
              ['rtc', true],
              ['ws', false],
              ['ws', true]
          ] as const)('admits a %s ACK, records it and acknowledges the send (hold armed: %s)', async (carrier, armed) => {
              const sender = carrier === 'rtc' ? await openRtcHoldSender() : await openWsHoldSender();
              await expectAcknowledgedUnderHold(sender, armed);
          });
      });
      ```

      Command: `npx vitest run packages/tests/shared-web/messages/acknowledgement-under-transport-hold.test.ts`
      Expected: both unarmed cases GREEN, which shows the harness is sound. The RED is the armed case
      of one or both carriers. Its first failing assertion is either the observation count, meaning
      the hold never engaged, which is a fixture error to fix before reading anything, or the
      `ControlAdmissionStop` diff that names the site. If both armed cases pass, record that and go
      to Step 2's escalation. Never loosen or reorder an assertion to manufacture a RED.
- [x] **Step 2: Name the site.** Read the armed case's `ControlAdmissionStop` against the site table.

      - `inbound-threw` and `outbound-threw` carry the error, and the `reason` and its stack name the
        throw line.
      - `inbound-unsettled` or `outbound-unsettled` (C3) needs one finer reading. Add, for this read
        only, `vi.spyOn` on `ALInboundControlAdmission.prototype.admit`,
        `ALOutboundControlAdmission.prototype.admit`, `InMemoryAdmissionBackend.prototype.readWithin`
        and `InMemoryAdmissionBackend.prototype.write` (`IndexedDbAdmissionBackend.prototype` under
        E3). The first `incomplete` entry of
        `mock.settledResults`, in call order, names the await. When it is a `write`, the earlier
        `write` still `incomplete` names the tail holder.
      - `outbound-answered` with the handle not `acknowledged` (C4): the `result` says which arm.
        `readPendingAck(submission.id.msgId)` on the carrier's outbound admission store, read before
        `deliver`, says whether the receipt was already gone.
      - `never-admitted` is C0.
      - `not-routed` means `onControlMessage` never reached the outbound owner, because the runtime
        or the manager was disposed (`al-inbound-message-runtime.ts:372`,
        `web-rtc-overlay-multicast-manager.ts:369-371`).

      The assertion that discriminates, and stays in the test after Step 3, is
      `expect(readControlAdmissionStop(witness, ack)).toMatchObject({ stop: 'outbound-answered' })`
      together with the `acknowledged` state.

      **If both armed cases are GREEN, escalate one variable at a time.** Each variable is added to
      the armed and the unarmed case alike. Stop at the first RED.

      - E1, the lane's shared typeId: before `deliver`, `advance` past the submission's
        `ackTracking.timeoutMs` (read from `readPendingAck`) and `drain` until its `ack-timeout` claim
        has run. The retransmission carries the scenario typeId, so the hold drops it as well.
      - E2, the lane's `cancel-2`: `sender.cancel` the held send inside the hold, as
        `toRetainedCancellationCommands` does (`create-alm-conformance-recipes.ts:533-554`).
      - E3, the hosted pages' storage: a sibling
        `acknowledgement-under-transport-hold-indexeddb.test.ts` imports
        `../../setup-browser-indexeddb.ts` first and runs the same `it.each` through
        `expectAcknowledgedUnderHold`. fake-indexeddb completes on queued turns, which the same bounded
        `settle` runs. If the unarmed case does not settle there, raise that file's turn count until
        it does. The unarmed case calibrates the count, never the armed one.

      All armed cases still GREEN after E3 means the ACK is not lost in admission. It is lost before
      `admitIncomingMessage` on the hosted carrier, or in the capture. Record the reading in the PR
      body and under "Rulings during execution", skip Step 3, commit the test as a pin (Step 5), and
      route to the maintainer with the one harness-only addition the diagnosis proposes: sender
      `pageerror`/console capture in the lane. That addition is not built in this task.
- [x] **Step 3: The fix at the named site, as a value.** One row applies, and no other file changes.
      In every row the fault port and both carriers' call sites keep their contract: they decide
      outgoing frames only. `transport-fault-port.ts`, `qrtc-data-channel.ts:370-390` and
      `ws-queue-box-client-service.ts:538-568` are not edited, and the `readFaultedTypeIds` pin stays.

      | Site                                             | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Site suite (under `packages/tests/shared/alm/`)                                                          |
      | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
      | C1 at the provenance throw (`:139-144`)          | `readControlAdmission` returns `Either<string, ALInboundControlAdmissionRead \| undefined>`, and the missing-provenance case is `Either.ofLeft('Retained inbound acknowledgement state has no message provenance')`. `admit` answers a left with its existing `{ kind: 'rejected', reason }` (`:38`). `admitControlMessage` already hands a rejected control to `onControlMessage` (`al-inbound-message-runtime.ts:369-374`), so the outbound owner still receives the ACK.                                                              | `inbound/al-inbound-control-admission.test.ts`: the same surface answers `rejected` and never throws      |
      | C1 or C2 at a backend write                      | When the failure is the write's own transaction failing (not a decoder's `ALAdmissionCorruptionError`, which stays a throw and routes like C0), the backend that raised it answers it at its own boundary as `ALAdmissionBackendConflictError`, the one exception the Global Constraints let cross that boundary (`al-admission-backend.ts:133-162` or `indexed-db-admission-backend.ts:179-208`). The existing value path then carries it. Outbound: `writeControlAdmission` returns `false` (`:157-160`), `admit` retains `admit-control` work (`:135,:367-377`), and the outbound worker replays it (`:166-175`). Inbound: `commitControlAdmission` retains `pending-control` (`:114-115`). | `al-admission-backend.test.ts`, and `al-outbound-control-admission.test.ts` beside `answers pending-control for a backend conflict without an inner retry` (`:395`) |
      | C2 at a read (`:118-123` or `:279-303`)          | The read returns an `Either`, and `admit` answers a left with `{ kind: 'rejected', reason }` (`ALOutboundControlAdmissionResult`, `:55-59`). It never throws.                                                                                                                                                                                                                                                                                                                                  | `al-outbound-control-admission.test.ts`                                                                  |
      | C3 at the write tail                             | The earlier write that holds `writeTail` (`al-admission-backend.ts:137-143`), or an IndexedDB read session left open (`indexed-db-admission-backend.ts:210-233`), awaits non-storage work inside the write. Move that await before its `backend.write`, per the mutation doctrine's read outside the write, so a control write queues behind storage operations only. No queue or timer is added.                                                                                                                            | `al-admission-backend.test.ts`: a write whose predecessor is between storage steps still settles          |
      | C0, C3 at `ready()`, C4, `not-routed`, any other | Stop and route to the maintainer with the reading. Each is a carrier or policy decision, not a control-admission fix: the carrier's discard guards, a bootstrap that never finishes, the sender-wide control fence, or the receipt's exhaustion and retention. The test still commits as a pin at Step 5.                                                                                                                                                                                    | —                                                                                                        |

      Step 1's four cases turn GREEN, and the site suite's new case pins the value. Every added
      function stays under 40 lines.
      Command: `npx vitest run packages/tests/shared-web/messages/acknowledgement-under-transport-hold.test.ts packages/tests/shared/alm`
- [x] **Step 4: Verify.** Run the pins unchanged and name them in the commit message:

      - `al-indexeddb-operation-counts.test.ts`: 10 `al-admission` / 15 `al-work` for one default send
        (`:196-234`), 2 for one drained `dispatch-local` row (`:244-250`), 8 for one message admitted
        and delivered (`:259-264`), the idle relay (`:266-282`) and one `work-release` per batch
        (`:284-288`).
      - Both control admission suites:
        `packages/tests/shared/alm/inbound/al-inbound-control-admission.test.ts` and
        `packages/tests/shared/alm/al-outbound-control-admission.test.ts`, plus
        `outbound-control-version-candidate.test.ts` and `outbound-delivery-settlements.test.ts`.
      - Both carriers' hold and admission suites: `packages/tests/shared-web/websocket`,
        `packages/tests/shared-web/rtc`, `packages/tests/shared/transport-faults`,
        `packages/tests/shared/qrtc-data-channel.test.ts` and
        `packages/tests/shared/websocket/json-web-socket-client-faults.test.ts`.

      Commands:

      - `npx vitest run packages/tests/shared/alm packages/tests/shared-web/messages packages/tests/shared-web/websocket packages/tests/shared-web/rtc packages/tests/shared/transport-faults packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared/websocket/json-web-socket-client-faults.test.ts`
      - `npx tsc -p packages/shared/tsconfig.json --noEmit`
      - `npm run test:deno`, when a shared `packages/shared/alm` type changed
      - `node scripts/check-tests-typecheck.mjs`
      - `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`
      - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
      - `npm run test:rallar:full-stack:memory:alm`: three cells, each recorded as in Task 5 Step 3
      - `npx dprint check <touched files>`
- [x] **Step 5: Commit and push.** Use
      `git commit -am 'fix(alm): admit an acknowledgement that arrives while a transport hold drops another send'`
      when Step 3 landed a fix. On a stop row or the all-GREEN escalation, use
      `git commit -am 'test(alm): pin acknowledgement admission under a transport hold'`, with the
      reading in the body. Then push the S2a branch (`claude/alm-s2-design`, the branch this plan executes on).

### Task 7b: Page-error capture in the lane

Per the maintainer's ruling (2026-09-23) that routed from R-S2a-7 (Task 7 Step 2's all-GREEN
escalation): under the pin's fixed timing, the ACK is admitted and the send reaches `acknowledged` on
both carriers, hold armed or not, over memory and fake-indexeddb stores — not reproducible in
admission or ingress under the pin's interleavings. A slow-storage C3 (an await that never settles) is
not ruled out, and the artifacts hold no console or page evidence at all to say whether the hosted
loss sits there or somewhere else. This task adds that evidence, which can name a throw or a
rejection, not a hang. Harness and docs only; no product change.

**Files:**

- New: `tests/playwright/rallar-black-box/start-page-diagnostics-capture.ts` (attaches from page
  creation), `tests/playwright/rallar-black-box/to-page-diagnostics-file.ts` (relocates the capture's
  absolute timestamps against the cell's reference instant),
  `packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-page-diagnostics.ts` (the raw
  file's decoder).
- Modify: `tests/playwright/rallar-black-box/full-stack-helpers.ts` (`openBrowserControlAgent` takes
  an optional `diagnosticsRole` and returns the capture; `TwoAgentRunParticipant` carries it),
  `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts` (writes the raw file beside
  the cell JSON and snapshot, and folds it into the regime),
  `packages/shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts` (the
  `pageDiagnostics` block), `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md`.
- Test: `packages/tests/shared-test/alm-observation-page-diagnostics.test.ts` (new, the raw decoder),
  `packages/tests/shared-test/alm-observation-regime.test.ts` (the `pageDiagnostics` block on the
  regime).

**The block shape**, `ALMObservationPageDiagnostics` on `ALMObservationRegime`:

```ts
export type ALMObservationPageDiagnostics =
    | Readonly<{
        outcome: 'captured';
        counts: Readonly<{ pageerror: number; consoleError: number; consoleWarning: number; }>;
        dropped: number;
        first: readonly ALMObservationPageDiagnosticRecord[];
    }>
    | Readonly<{ outcome: 'not-captured'; }>;
```

`not-captured` only when the lane supplied no `-page-diagnostics.json` file at all (an artifact from
before this task), never a guess about whether the page raised nothing. `first` is bounded to the
earliest 20 records, sorted across both agent pages; the raw file itself already caps at 200 records
per page and counts the rest as `dropped`.

- [x] **Step 1: Capture from page creation, write the raw file.**
      `startPageDiagnosticsCapture` attaches `page.on('pageerror')` and `page.on('console')` (levels
      `error` and `warning` only) the moment `openBrowserControlAgent` creates the page, before its
      login navigation, so a fault during connect setup is captured too. Each record is
      `{ agentId, role, atEpochMs, kind, message, stack? }`, message and stack truncated to 1 000
      characters, capped at 200 records per page with the rest counted in `droppedCount`.
      `toPageDiagnosticsFile` relocates the two pages' records onto one `atMs` axis, against a
      reference instant the spec chooses: the cell's first control event when the run's snapshot
      decoded, else the earlier page's own creation. The spec writes the result beside the existing
      `<carrier>-<scope>.json` and `<carrier>-<scope>-snapshot.json` as
      `<carrier>-<scope>-page-diagnostics.json`, only when at least one agent page attached a capture.
- [x] **Step 2: Decode the file into the cell JSON (RED first).** RED:
      `packages/tests/shared-test/alm-observation-page-diagnostics.test.ts` against a fixture with a
      few records (one missing its agent id, to prove a malformed record is skipped rather than
      rejecting the file) and the reject-non-object case, plus
      `alm-observation-regime.test.ts` asserting `pageDiagnostics` on `computeALMObservationRegime`
      and `createUnreadableALMObservationRegime` — both `not-captured` absent a file, and `captured`
      with counts, `dropped` and the earliest 20 records when one is supplied — all RED before
      `decodeALMObservationPageDiagnosticsFile` and the `pageDiagnostics` field existed. GREEN after
      `alm-observation-page-diagnostics.ts`'s decoder and `compute-alm-observation-regime.ts`'s
      `computePageDiagnostics`. The spec decodes the file it is about to write through the same
      decoder before folding it into the regime, so the cell JSON reads it through the contract a
      later re-read of the artifact would use.
      Commands: `npx vitest run packages/tests/shared-test/alm-observation-page-diagnostics.test.ts packages/tests/shared-test/alm-observation-regime.test.ts`,
      `npx tsc -p packages/shared-test/tsconfig.json --noEmit`.
- [x] **Step 3: Verify the lane writes it, document, and commit.**
      `npm run test:rallar:full-stack:memory:alm` against a local memory `api-v1`; each cell's
      `-page-diagnostics.json` exists and its cell JSON's `pageDiagnostics.outcome` reads `captured`
      (a healthy local run may carry zero errors of every kind — that is a valid `captured` result,
      not `not-captured`). `alm-observation-artifact.md` documents the new file and the block,
      including that it captures page-level errors only and does not by itself prove where a frame
      was lost. Commit: `test(alm): capture page errors into the observation artifact`.

### Task 8: The page regime in the observation artifact

Per the maintainer's re-plan (2026-09-23). The outbound regime reads the cell's opening 20 s of
`send`-origin admission reads. It scored F's rtc cell `normal` (16.61 ms/op) next to P's
(13.83 ms/op), although F's page queued every storage read 2.5× longer and its constant-shape probe
roughly 50× longer (`.superpowers/s2a-full-read-diagnosis.md` §0.2, §3 "Whole-cell medians overstate
F", §4). Read literally, "both normal" would have blamed the change for a slower page. The outbound
`readiness-probe` is one storage read of a fixed shape
(`packages/shared/alm/work/al-work-handler.ts:100-116`;
`packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md:173-182`). An `age-bound`
probe is that read taken only because the memory aged out (`al-work-handler.ts:252`), so its
duration is the time the read spent queued behind the page's other IndexedDB transactions. The
artifact records none of it today: the snapshot decodes no `readiness-probe`
(`packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts:128-147`).

**Where the constants come from.** The corpus is 24 hosted cells from eight lane runs of the S2
corpus, fetchable again from these hosted lane run ids: `6f6006cfe` (35650940898), `f33dd8118`
(35756050199), `f870feaf4` (35757310189), `8fc704552` (35764211986), `fe718349c` (35838327536),
`c6ded1707` (Task 0, 35843670606), the RTT-off probe (35843674446) and `7add928af` (full,
35862174555). The reading is the median `age-bound` probe `durationMs`, over both roles, from 20 s to
60 s after the run's first event.

| Page | Count | Median band | Cells                                                         |
| ---- | ----- | ----------- | ------------------------------------------------------------- |
| fast | 6     | 1–3 ms      | the RTT-off probe (1 / 3 / 2) and `6f6006cfe` (2 / 1 / 3)     |
| slow | 18    | 66.5–358 ms | every other cell: F 66.5 / 69 / 358, Task 0 113 / 199.5 / 315 |

Samples number 26–43 per cell. The window starts where the outbound regime's opening window ends,
because page start-up contends too. Over the opening 20 s the fast pages read 27.5 / 87 / 77 ms (the
probe) and 6 / 44 / 63 ms (`6f6006cfe`), inside the slow band. The proposed thresholds sit in the
gap: `normal` below 20 ms (about 6× the fast band's top of 3 ms) and `slow` at or above 50 ms (below
the slow band's lowest cell, 66.5 ms). The band between them stays `unclassified`, as the outbound
regime's 30–35 band does. **The two thresholds, the sample minimum and the window end are
maintainer-visible and are listed as such in the PR body.**

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts:4-16,91-101,128-147`
  (plus one decoder after `toInboundClaim`, `:265-291`),
  `packages/shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts:12-26,89-102,125-169`,
  `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md:18-22,42-99,101-126`,
  `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md:173-182`
- Test: `packages/tests/shared-test/alm-observation-regime.test.ts` (662 lines). Its builders sit
  beside `toCommitPhaseEvent` (`:56-77`), the regime cases go in `describe('computeALMObservationRegime')`
  (`:188-512`), the decoder case in `describe('decodeALMObservationSnapshot')` (`:531-662`), and the
  summary pin is `:495-512`.

**Interfaces:**

- Produces, `alm-observation-snapshot.ts`:

  ```ts
  const READINESS_PROBE_DIAGNOSTIC_KIND = 'readiness-probe';

  /** One outbound `readiness-probe`: a fixed-shape storage read, so its duration reads the page's storage queue. */
  export interface ALMObservationReadinessProbe {
      readonly atEpochMs: number;
      readonly role: ALMObservationAgentRole;
      /** `age-bound`, `own-commit`, `batch`, `retained-release`, `external-wake` or `no-memory`, as the topic emits it. */
      readonly cause: string;
      readonly durationMs: number;
  }
  ```

  `ALMObservationSnapshot` gains one required array, `readinessProbes: readonly ALMObservationReadinessProbe[]`.

- Produces, `compute-alm-observation-regime.ts`, the constants beside
  `ALM_OBSERVATION_NORMAL_REGIME_MAX_MS_PER_OPERATION` (`:22-26`) with a JSDoc that carries the corpus
  table above:

  ```ts
  export const ALM_OBSERVATION_NORMAL_PAGE_MAX_PROBE_MS = 20;
  export const ALM_OBSERVATION_SLOW_PAGE_MIN_PROBE_MS = 50;
  export const ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT = 10;
  /** The page window opens where the opening window (`ALM_OBSERVATION_WINDOW_MS`) closes. */
  export const ALM_OBSERVATION_PAGE_WINDOW_END_MS = 60_000;
  export const ALM_OBSERVATION_STORAGE_PROBE_CAUSE = 'age-bound';

  /** The page's storage queue, beside the admission chain `regime` reads; the two together are the runner's verdict. */
  export type ALMObservationPageRegime =
      | Readonly<{
          outcome: 'measured';
          storageProbeMedianMs: number;
          sampleCount: number;
          regime: ALMObservationRegimeName;
      }>
      | Readonly<{ outcome: 'unmeasured'; sampleCount: number; regime: 'unclassified'; }>;
  ```

  `ALMObservationRegime` (`:89-102`) gains the required `pageRegime: ALMObservationPageRegime`. The
  vocabulary is `ALMObservationRegimeName`'s own (`:33`), so no second regime name exists.
- Consumes: the private `computeMedian` and `toTwoDecimals` (`:359-370`), unchanged. The spec that
  writes the file (`tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts:233,248-251`)
  only serialises the regime and is not edited.

- [x] **Step 1: The page regime is classified from the probes (RED first).** In
      `alm-observation-regime.test.ts`, add beside `toCommitPhaseEvent`:

      ```ts
      function toReadinessProbeEvent(
          atEpochMs: number,
          agentId: string,
          probe: Readonly<{ cause: string; durationMs: number; }>
      ): Record<string, unknown> {
          return {
              kind: 'diagnostic',
              atEpochMs,
              agentId,
              payload: {
                  topic: 'rallar.browser.alm.outbound_diagnostics',
                  payload: {
                      data: { kind: 'readiness-probe', workerId: 'al-outbound:worker-1', readyAtMs: 'none', ...probe }
                  }
              }
          };
      }

      /** `count` probes a second apart inside the page window; the anchor commit keeps the run's first event at 1 000. */
      function toPageWindowProbes(durationMs: number, count: number, cause = 'age-bound'): readonly Record<string, unknown>[] {
          return [
              toCommitPhaseEvent(1_000, 12, 'send'),
              ...Array.from({ length: count }, (_unused, index) =>
                  toReadinessProbeEvent(
                      1_000 + ALM_OBSERVATION_WINDOW_MS + 1_000 * (index + 1),
                      index % 2 === 0 ? SENDER_AGENT_ID : RECEIVER_AGENT_ID,
                      { cause, durationMs }
                  ))
          ];
      }
      ```

      Then add these cases:

      - Ten 2 ms probes read `{ outcome: 'measured', storageProbeMedianMs: 2, sampleCount: 10, regime: 'normal' }`.
        Adding five 400 ms `age-bound` probes inside the opening window, five 400 ms `own-commit`
        probes inside the page window, and five 400 ms probes after
        `1_000 + ALM_OBSERVATION_PAGE_WINDOW_END_MS` leaves the reading unchanged.
      - Ten 120 ms probes classify `slow`, and ten 30 ms probes classify `unclassified` with the
        median measured.
      - The edges, in the file's `classifies the two edges of the band` form (`:280-285`): 19.99 is
        `normal`, 20 is `unclassified`, 49.99 is `unclassified` and 50 is `slow`.
      - `ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT - 1` probes read
        `{ outcome: 'unmeasured', sampleCount: 9, regime: 'unclassified' }`.
      - The two hosted fixtures keep their `regime` and read
        `pageRegime: { outcome: 'unmeasured', sampleCount: 0, regime: 'unclassified' }`, because
        their trim dropped every probe.
      - The decoder, in `describe('decodeALMObservationSnapshot')`, decodes a `readiness-probe` per
        agent role, and skips one without a `cause` or a finite `durationMs` rather than rejecting
        the snapshot.
      - The summary pin (`:495-512`) becomes
        `'ALM observation rtc-smoke: regime=slow perOperation=36 ms/op over 7 commits outcome=failed page=unclassified (unmeasured, 0 probes)'`,
        and the ws line ends the same way.

      Command: `npx vitest run packages/tests/shared-test/alm-observation-regime.test.ts`
      Expected: the run fails at the type level first (`pageRegime` and the constants), then on the
      assertions.
- [x] **Step 2: Decode, classify, and read the corpus.** In `alm-observation-snapshot.ts`:

      - Add `readinessProbes: toTopicDiagnostics(diagnostics, OUTBOUND_DIAGNOSTICS_TOPIC).map(toReadinessProbe).filter(isPresent)`
        to the snapshot literal (`:129-147`).
      - Add `toReadinessProbe`, which answers `undefined` unless `kind` is
        `READINESS_PROBE_DIAGNOSTIC_KIND` and both `cause` (`decodeText`) and `durationMs`
        (`decodeFiniteNumber`) decode (the file's skip rule, `:110-114`). Its role comes from
        `resolveALMObservationAgentRole`.

      In `compute-alm-observation-regime.ts`:

      ```ts
      export function computePageRegime(
          snapshot: ALMObservationSnapshot,
          windowStartEpochMs: number
      ): ALMObservationPageRegime {
          const windowEndEpochMs = snapshot.firstEventAtEpochMs + ALM_OBSERVATION_PAGE_WINDOW_END_MS;
          const durations = snapshot.readinessProbes
              .filter((probe) =>
                  probe.cause === ALM_OBSERVATION_STORAGE_PROBE_CAUSE && probe.atEpochMs > windowStartEpochMs &&
                  probe.atEpochMs <= windowEndEpochMs
              )
              .map((probe) => probe.durationMs);
          if (durations.length < ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT) {
              return { outcome: 'unmeasured', sampleCount: durations.length, regime: 'unclassified' };
          }
          const storageProbeMedianMs = toTwoDecimals(computeMedian(durations));
          return {
              outcome: 'measured',
              storageProbeMedianMs,
              sampleCount: durations.length,
              regime: resolvePageRegimeName(storageProbeMedianMs)
          };
      }

      function resolvePageRegimeName(storageProbeMedianMs: number): ALMObservationRegimeName {
          if (storageProbeMedianMs < ALM_OBSERVATION_NORMAL_PAGE_MAX_PROBE_MS) {
              return 'normal';
          }
          return storageProbeMedianMs >= ALM_OBSERVATION_SLOW_PAGE_MIN_PROBE_MS ? 'slow' : 'unclassified';
      }
      ```

      - `computeALMObservationRegime` (`:125-141`) sets
        `pageRegime: computePageRegime(input.snapshot, input.snapshot.firstEventAtEpochMs + ALM_OBSERVATION_WINDOW_MS)`.
      - `createUnreadableALMObservationRegime` (`:144-161`) sets
        `pageRegime: { outcome: 'unmeasured', sampleCount: 0, regime: 'unclassified' }`.
      - `toALMObservationRegimeSummary` (`:163-169`) appends
        ` page=${regime} (${storageProbeMedianMs} ms/probe over ${sampleCount})`, or
        ` page=unclassified (unmeasured, ${sampleCount} probes)`, through a private
        `toPageRegimeSummary`.

      Every function stays under 40 lines. If the changed-style gate reports a worsened finding on
      `compute-alm-observation-regime.ts` (370 lines today), move the page-regime constants,
      `ALMObservationPageRegime`, `computePageRegime` and `resolvePageRegimeName` into a sibling
      `compute-alm-observation-page-regime.ts` in this commit. No pin or disposition is added.

      Then read the corpus with the shipped code, one throwaway script in `$TMPDIR`, never committed:

      ```ts
      // $TMPDIR/read-page-regimes.ts
      import { readFileSync } from 'node:fs';
      import { decodeALMObservationSnapshot } from '/Users/knuthelge/ProjectLocker/github/ar-eye-hunter/.claude/worktrees/alm-s2/packages/shared-test/rallar-bb-test/conformance/alm/alm-observation-snapshot.ts';
      import { computeALMObservationRegime } from '/Users/knuthelge/ProjectLocker/github/ar-eye-hunter/.claude/worktrees/alm-s2/packages/shared-test/rallar-bb-test/conformance/alm/compute-alm-observation-regime.ts';

      for (const file of process.argv.slice(2)) {
          decodeALMObservationSnapshot(JSON.parse(readFileSync(file, 'utf8'))).fold(
              (issues) => console.log(file, issues.join('; ')),
              (snapshot) => {
                  const regime = computeALMObservationRegime({ snapshot, carrier: 'read', scope: 'read', cellOutcome: 'passed' });
                  console.log(file, regime.regime, JSON.stringify(regime.pageRegime));
              }
          );
      }
      ```

      Command: `npx tsx $TMPDIR/read-page-regimes.ts <snapshot files>`, over the `*-snapshot.json`
      artifacts of the eight hosted lane run ids above (`alm-conformance-lane-<sha>`, re-fetched per
      run id rather than from a session scratchpad path, which does not outlive the session). Expected:
      the corpus table above, with six `normal` and eighteen `slow`. Any cell outside its row stops the
      step: report it rather than moving a threshold.
      Command: `npx vitest run packages/tests/shared-test/alm-observation-regime.test.ts`
- [x] **Step 3: The artifact document and "Classify before judging".** In `alm-observation-artifact.md`:

      - The job-log example (`:18-22`) gains the `page=` suffix.
      - "The regime file" (`:42-99`) gains a `pageRegime` bullet. It is the median `durationMs` of the
        outbound `age-bound` `readiness-probe` events, over both roles, from `ALM_OBSERVATION_WINDOW_MS`
        to `ALM_OBSERVATION_PAGE_WINDOW_END_MS` after the run's first event. It is `unmeasured` below
        `ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT` samples. The bullet says why the probe reads the
        page (a fixed-shape read, so its duration is queueing) and why the window skips start-up.
      - "Reading a red" (`:101-126`) is rewritten with the page regime in it.

      The rule text:

      > **Classify before judging.** A run is `normal` only when its `regime` and its
      > `pageRegime.regime` are both `normal`, and `slow` when either is `slow`. The `rtc` cell's two
      > regimes together are the runner's verdict. A red counts only against a green baseline of the
      > same carrier and scope whose two regimes match the red's. A red in a slow page regime,
      > compared against a normal-page baseline, is a measurement of the runner, not a verdict on the
      > change. That holds even when the outbound `regime` of both runs is `normal`: the page regime
      > exists because the outbound regime scored `7add928af`'s page `normal`, whose probe took 141–210 ms, beside the RTT-off probe's page at 2–4 ms. An
      > `unclassified` in either regime leaves the cell unattributed. Re-run it.

      The page constants join the "constants, not tuning knobs" paragraph (`:125-126`), with the
      corpus table. In `runtime-diagnostic-contract.md` the `readiness-probe` bullet (`:173-182`)
      gains one sentence: the observation regime reads its `age-bound` probes as the page regime.
      Command: `npx dprint check packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md`
- [x] **Step 4: Commit and push.** Run
      `npx vitest run packages/tests/shared-test`, `node scripts/check-tests-typecheck.mjs`,
      `npx tsc -p packages/shared-test/tsconfig.json --noEmit`, and `npx dprint check <touched files>`. Then commit with
      `git commit -am 'feat(alm): classify the page regime from the storage probe in the observation artifact'`,
      and push the S2a branch (`claude/alm-s2-design`).

### Task 9: The ACK's control admission survives an expiry-cleanup conflict

Per controller ruling R-S2a-8, under the maintainer's decision to fix the ACK-under-hold defect. The
re-read of hosted run `25708b2e6` with page diagnostics (`.superpowers/s2a-reread-diagnosis.md` §0.1
and §2) names the stop site that Task 7 could not. At 123.906 s the sender page logged `Callback
onMessage failed ALAdmissionBackendConflictError: IndexedDB AL admission expiry cleanup conflicted`.
The stack runs `ALOutboundControlAdmission.admit` → `readControlAdmission` →
`IndexedDbAdmissionBackend.readWithin` → `removeExpiredIndexedDbAdmissionValues`. After a read chain
finishes, `readWithin` evicts every row it read past its expiry. Each removal is guarded by the write
token the chain read (`remove-if-write-token`), and the eviction threw
`ALAdmissionBackendConflictError` when another writer had replaced or removed one of those rows in
between (`indexed-db-admission-backend.ts:415-427`). `admit` does not catch a read's throw. The RTC
data channel's `onMessage` catch logs the error and drops it (`qrtc-data-channel.ts:576-578`), so
no `admission-outcome` is recorded and the send never reaches `acknowledged`. This is site C2 at the
read (`al-outbound-control-admission.ts:279-303`). Task 7's pin stayed GREEN because its ACK read
set held no expired row and no concurrent writer moved one.

The fix goes where the throw starts. An expiry eviction is not the reader's write. The chain has
already treated the expired row as absent. A row that another writer moved has also left the
state this chain evicts. So the conflict belongs to no decision the chain made. The IndexedDB
backend is the only backend whose read raises it: the in-memory backend deletes an expired row
without a guard, and PostgreSQL does not evict on a read.

**Files:**

- Create: `packages/tests/shared-web/messages/acks-read-eviction-race.ts`. This is the seam. It
  plants the submission's `acks` row already expired. It then lands a second chain's read of that row
  between the ACK chain's snapshot and the ACK chain's eviction.
- Modify: `packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts`. `HoldSender`
  gains `outboundAdmissionNamespace`. `HoldEscalation` gains `'expired-row-evicted'`. The file adds
  `ACK_UNDER_CONCURRENT_EVICTION_CASES` and a `runHoldEscalation` branch.
- Modify: `packages/tests/shared-web/messages/acknowledgement-under-transport-hold-indexeddb.test.ts`,
  which gains a sibling `it.each`.
- Modify: `packages/shared/alm/indexed-db-admission-backend.ts`: `removeExpiredIndexedDbAdmissionValues`
  and the comment in `readWithin`.
- Modify: `packages/tests/shared/alm/al-admission-backend.test.ts`. The eviction pin (`:334-397`)
  now expects a value, and it gains a `readWithin` case.
- Modify: `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`. The ceiling
  moves from 271 to 272 under the Global Constraints' next-whole-KiB rule.
- Modify: `packages/shared/alm/inbound/README.md` (the decision-surface section) and
  `packages/shared/alm/outbound/README.md` (the conflict paragraph).

**Interfaces:**

```ts
// packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts
export interface HoldSender {
    // ...
    /** The carrier's outbound admission store namespace, which prefixes every row it keeps. */
    readonly outboundAdmissionNamespace: string;
}
export type HoldEscalation = 'none' | 'ack-timeout' | 'cancel-held' | 'expired-row-evicted';
export const ACK_UNDER_CONCURRENT_EVICTION_CASES; // carrier × armed, escalation 'expired-row-evicted'

// packages/tests/shared-web/messages/acks-read-eviction-race.ts
export async function setNextAcksReadEvictionRaced(namespace: string, msgId: string): Promise<void>;

// packages/shared/alm/indexed-db-admission-backend.ts: no exported signature changes. The module-private
// removeExpiredIndexedDbAdmissionValues(input): Promise<void> no longer throws when its guarded
// write answers "not committed".
```

- [x] **Step 1: RED.** The sibling case runs `expectAcknowledgedUnderHold(sender, armed,
      'expired-row-evicted')` over fake-indexeddb for both carriers, armed and unarmed. The escalation
      first writes `<namespace>:control:acks:<submission msgId>` through a second
      `IndexedDbAdmissionBackend` on the sender's database. The row is `{ kind: 'acks', values: [] }`
      with `expireAtTimestamp` set to `Date.now() - 1`. This is the one key in the ACK's read set
      whose loss cannot change the acknowledgement: `readControlHistory` reads it, and an absent
      history reads as `values: []`. The escalation then arms the seam. Spies on
      `IndexedDbAdmissionReadSession.prototype.read` and `IndexedDbAdmissionBackend.prototype.readWithin`
      find the next chain whose session read that key. After that chain's callback returns and before
      its eviction, the second backend's `read` of the key sees the row expired and evicts it. Both
      chains and both evictions are the backend's own code, and no unit under test is mocked. An
      `onTestFinished` guard fails the case if no chain read the key. Inverting the key match
      confirms this: all four cases fail with `the eviction race never ran`. The assertion is the
      Task 7 body unchanged:
      `expect(readControlAdmissionStop(witness, ack)).toMatchObject({ stop: 'outbound-answered' })`,
      then the ACK's `admission-outcome` and `handle.lifecycle().state === 'acknowledged'`.

      RED, before the fix. All 4 cases fail, the first time and on every run:

      ```
      AssertionError: expected { stop: 'outbound-threw', …(1) } to match object { stop: 'outbound-answered' }
      Callback onMessage failed ALAdmissionBackendConflictError: IndexedDB AL admission expiry cleanup conflicted   (rtc)
      Callback onMessage failed: ALAdmissionBackendConflictError: IndexedDB AL admission expiry cleanup conflicted  (ws)
      ```

      The stop value and the handle, read by a temporary probe that was removed before the commit:
      `{"stop":"outbound-threw","reason":"ALAdmissionBackendConflictError: IndexedDB AL admission expiry
      cleanup conflicted"}`. The handle stays at `transport-accepted`, and the ACK has no
      `admission-outcome`. The result is the same for rtc and ws, armed and unarmed, and it is the
      hosted record's signature. The hold is incidental, as the re-read said.
      Command: `npx vitest run packages/tests/shared-web/messages/acknowledgement-under-transport-hold-indexeddb.test.ts -t 'concurrent chain evicts'`
- [x] **Step 2: The fix at the source, one change.** `removeExpiredIndexedDbAdmissionValues` awaits
      the guarded write and no longer turns its "not committed" answer into
      `ALAdmissionBackendConflictError`. A row that moved is left to the writer that moved it, or to
      the next chain that reads it expired. `readWithin`, `read` and `list` answer from the snapshot
      they read. The `readWithin` comment now reads "by the time its caller is answered the row is
      gone, or another writer has moved it". Every other part stays as it was:
      - Conflict remains a write's typed value. `write` still throws
      `ALAdmissionBackendConflictError` from inside its transaction, and each store still catches it
      at its boundary. So a stale snapshot is still caught by the control admission's own fence
      (`hasCurrentControlFence`, and the per-row fence of the write phase). A caught conflict
      becomes `pending-control`, which is replayed.
      - The F2c fence contract is unchanged.
      - Nothing new was added: no timer, queue, registry, or typed field.
      - `ALOutboundControlAdmission.admit` is not edited.

      One mechanism covers every call site that F2 left uncaught, because every one of them reaches
      the throw through this eviction:
      - `readControlAdmission` (`:287`);
      - the effect read in `admit` (`:118-123`);
      - `readPendingRetry` and `readRetryRecord` through `backend.read`;
      - the inbound `readControlDecisionSurface`;
      - every other `readWithin` decision surface.

      `writeBrowserALRuntimeCleanup` has its own conflict throw. It belongs to the periodic browser
      cleanup, which is not on an admission path, so it is left unchanged.
      Command: `npx vitest run packages/tests/shared-web/messages/acknowledgement-under-transport-hold-indexeddb.test.ts packages/tests/shared-web/messages/acknowledgement-under-transport-hold.test.ts packages/tests/shared/alm/al-admission-backend.test.ts`
- [x] **Step 3: Verify.**
      - The four RED cases are GREEN, and so is the whole Task 7 matrix: both carriers, memory and
      IndexedDB, every escalation. That is 28 tests.
      - The backend's eviction pin was renamed to `answers a %s from its snapshot and leaves a
        concurrently refreshed row to its writer`. It expects `read` → `undefined`, `list` → `[]` and
      `readWithin` → `undefined`, and the refresh stays intact. All three cases fail against the
      unfixed backend.
      - The operation-count pins are unchanged. `al-indexeddb-operation-counts.test.ts` passes 13/13
      (10 `al-admission` / 15 `al-work` per default send, 6 + 2 inbound, release 1, and the idle
      relay relays nothing). The eviction is not observed, so no count moves.
      - The headless bundle measures 271.0087890625 KiB, up from 270.8486328125. The minified bundle
      is 69 bytes smaller, but brotli compresses it less well. The ceiling moves from 271 to 272
      with the figure recorded. The facade measures 213.1 KiB against its 214 ceiling.

      Commands:

      - `npx vitest run packages/tests/shared/alm packages/tests/shared-web/messages packages/tests/shared-web/websocket packages/tests/shared-web/rtc packages/tests/shared-web/al-runtime packages/tests/shared/transport-faults packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared/websocket/json-web-socket-client-faults.test.ts`
      - `npx tsc -p packages/shared/tsconfig.json --noEmit`
      - `node scripts/check-tests-typecheck.mjs`
      - `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`
      - `npm run check:repo-style:changed -- origin/main HEAD`
      - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
      - `npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
      - `npx dprint check <touched files>`
      - `npm run test:rallar:full-stack:memory:alm`, once. The three cells are recorded as in Task 5
        Step 3.

### Task 10: A late acknowledgement inside the deadline acknowledges

Per controller ruling R-S2a-9, under the maintainer's decision of 2026-09-23. The re-read of hosted run
35895320587 at `ce6b1737b` (`.superpowers/s2a-reread-2-diagnosis.md`) shows the sender admitting the
receiver's ACK (`not-handled`/`control`, no throw) 0.3–5.6 s after the receiver sent it. That is
inside the send's 30 s deadline, yet the handle never gains a confirmed hop and reads `expired` at
`receipts-1`. The pending-ACK receipt the ACK completes against lived about 10 s from the admission
read: the row's expiry was the end of its retry schedule, `deadlineAtMs + timeoutMs × (maxAttempts −
attempts + 1)` (2 s + 3 × 2 s at the browser's `at-least-once` defaults). Spending the retry budget
also deleted it (`retryPendingAck` → `commitClearPendingAck`). The ACK arrived at least 3.8 s (rtc)
and 7.1 s (fallback) after that, so `validateALOutboundControlAdmission` refused it with `AL
acknowledgement sender has no pending outbound obligation`. The RTC streamer's `onControlMessage`
discarded that verdict unlogged.

The fix separates "no more retries" from "the obligation ended". The receipt row lives until the
message's own deadline, never shorter than its retry schedule. The `ack-timeout` effect rows keep
the schedule's end. A spent budget stops scheduling and deletes nothing. The ACK therefore finds its
receipt and commits the normal `acknowledgement` settlement, and `expired` at the deadline stays the
terminal state when no ACK comes.

**Files:**

- Modify: `packages/shared/alm/outbound/transition-al-outbound-pending-ack.ts`. The old expiry
  function is renamed `toALOutboundAckRetryScheduleEndTimestamp` and is now the schedule's end.
  `toALOutboundPendingAckExpireAtTimestamp(snapshot, messageExpiresAtMs)` is the receipt row's
  expiry: the later of the schedule's end and the message deadline.
- Modify: `packages/shared/alm/outbound/compute-al-outbound-dispatch.ts` and
  `al-outbound-repair-admission.ts`. Both pass the receipt row's expiry on `set-pending-ack`, with the
  deadline taken from `resolveALMessageExpireAtMs(msg)`. The `ack-timeout` effect keeps the schedule's
  end. In `retryPendingAck`, a spent budget warns and returns instead of calling
  `commitClearPendingAck`.
- Modify: `packages/shared/alm/outbound/compute-al-outbound-control-admission.ts`. A partial receipt's
  expiry uses the sent message's `reference.expiresAtMs`.
- Modify: `packages/shared/alm/outbound/admission/al-outbound-admission-mutations.ts`. The default
  expiry of a `set-pending-ack` that names none is the schedule's end.
- Modify: `packages/shared/alm/outbound/al-outbound-message-runtime.ts` (the diagnostics union, the
  repair admission's wiring), `al-outbound-repair-admission.ts` (the `diagnostics` dependency and
  `emitControlAdmission`), and `packages/tests/shared/alm/al-outbound-message-expiry.test.ts` (the new
  dependency).
- Modify: `packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts`. It gains three
  `HoldEscalation` values, `ACK_AGAINST_RETRY_SCHEDULE_CASES` and `expectExpiredPastTheDeadline`. The
  RTC scenario message carries the browser sender's 30 s `ttlMs`. The stop assertion now names the
  outbound result.
- Modify: `acknowledgement-under-transport-hold-indexeddb.test.ts` and
  `acknowledgement-under-transport-hold.test.ts`, which each gain two `it.each`.
- Modify: `packages/tests/shared/alm/outbound-commit-phase-diagnostics.test.ts`, which gains the
  `control-admission` pin.
- Modify: `packages/shared/alm/outbound/README.md` (the `ack-timeout` row and the obligation's
  lifetime) and `packages/shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md` (the
  `control-admission` kind).

**Interfaces:**

```ts
// packages/shared/alm/outbound/transition-al-outbound-pending-ack.ts
export function toALOutboundAckRetryScheduleEndTimestamp(snapshot: ALOutboundPendingAckSnapshot): number;
export function toALOutboundPendingAckExpireAtTimestamp(
    snapshot: ALOutboundPendingAckSnapshot,
    messageExpiresAtMs: number | undefined
): number;

// packages/shared/alm/outbound/al-outbound-message-runtime.ts: ALOutboundRuntimeDiagnosticsEvent gains
| Readonly<{
    kind: 'control-admission';
    msgId: string; // the control's own id
    typeId: string;
    targetMsgId: string; // the sent message it answers
    outcome: ALOutboundControlAdmissionResult['kind'];
    reason: string; // the rejection's reasons, or 'none'
}>;

// packages/shared/alm/outbound/al-outbound-repair-admission.ts
ALOutboundRepairAdmission.Dependencies.diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;

// packages/tests/shared-web/messages/acknowledgement-under-hold-fixture.ts
export type HoldEscalation = /* ... */ | 'ack-inside-retry-schedule' | 'ack-after-retry-schedule'
    | 'ack-after-retries-exhausted';
export const ACK_AGAINST_RETRY_SCHEDULE_CASES; // carrier × armed × the three
export async function expectExpiredPastTheDeadline(sender: HoldSender): Promise<void>;
```

- [x] **Step 1: RED (advanced clock).** `expectAcknowledgedUnderHold` runs three new lane variables
      on both carriers, armed and unarmed, over memory and fake-indexeddb stores. The schedule's end is
      read from the receipt before any retry (`deadlineAtMs + timeoutMs × (maxAttempts − attempts + 1)`,
      10 s after the admission read at the defaults):
      - `ack-inside-retry-schedule`: the clock stops 1 s before the end. This is today's positive
      case, GREEN before and after the fix.
      - `ack-after-retry-schedule`: the clock moves 2 s past the end with no retry claimed. This is
      the hosted geometry.
      - `ack-after-retries-exhausted`: each `ack-timeout` claim runs, one per timeout, until the budget
      is spent. Then the clock moves 2 s past the end.

      Every case asserts `handle.lifecycle().expiresAtMs > Date.now()` before the ACK is delivered, so
      the ACK is always inside the deadline. The stop assertion names the outbound result:
      `expect(readControlAdmissionStop(witness, ack)).toEqual({ stop: 'outbound-answered', result: {
      kind: expect.stringMatching(/^(committed|pending-control)$/) } })`. After it come the ACK's
      `admission-outcome` and `handle.lifecycle().state === 'acknowledged'`. `pending-control` is
      accepted because in memory an `ack-timeout` claim in the same drain can conflict with the ACK's
      commit, and the replay then acknowledges.

      RED against `ce6b1737b`'s product code: 16 failed and 40 passed. The failures are the two
      "after" variables × rtc/ws × armed/unarmed × memory/IndexedDB. The result is the same on every
      run:

      ```
      AssertionError: expected { stop: 'outbound-answered', …(1) } to deeply equal { stop: 'outbound-answered', …(1) }
          "result": {
      -     "kind": StringMatching /^(committed|pending-control)$/,
      +     "kind": "rejected",
      +     "reason": "AL acknowledgement sender has no pending outbound obligation",
      ```

      With the stop assertion weakened to the Task 7 form, the same cases fail on
      `expected 'transport-accepted' to be 'acknowledged'`: the ACK is admitted inbound, refused
      outbound, and the hop lists stay empty. The `ack-inside-retry-schedule` cases and the whole Task
      7/9 matrix stay GREEN. The negative pin `expectExpiredPastTheDeadline` sends with no ACK, spends
      the budget, and moves past the deadline. It asserts that a late ACK is then `rejected`, that the
      receipt is gone, and that the handle reads `expired` with no confirmed hop. It is GREEN before
      and after the fix.
      Command: `npx vitest run packages/tests/shared-web/messages/acknowledgement-under-transport-hold-indexeddb.test.ts packages/tests/shared-web/messages/acknowledgement-under-transport-hold.test.ts`
- [x] **Step 2: The fix at the source, one mechanism.** The receipt row's expiry becomes
      `max(schedule end, message deadline)`, and a spent retry budget stops scheduling without
      deleting the receipt. The row an ACK completes against is the obligation, and it must outlive
      the retransmission schedule, while the `ack-timeout` rows are what carry that schedule. So
      moving only the row's expiry, and removing only the exhaustion delete, ends retries exactly
      where they ended before and keeps the obligation to the deadline. Both halves are needed:
      restoring only the exhaustion delete turns the four `ack-after-retries-exhausted` IndexedDB
      cases RED again with the same refusal. Every other part stays as it was:
      - No timer, queue, registry, or row kind was added, and no key changed.
      - Conflict stays a value.
      - The settlement is still emitted synchronously in `admit`.
      - The operation-count pins are unchanged, because the row is written under the same key in the
      same transaction with only a later expiry.

      One side effect: a gap NACK or repair control from an expected multicast peer is authorized
      against the receipt until the deadline, where before it was authorized only until the
      schedule's end.
- [x] **Step 3: The diagnostic.** `ALOutboundRepairAdmission.acceptControlMessage` emits a
      `control-admission` event through the outbound diagnostics sink for every control it decodes.
      The event carries the control's `msgId` and `typeId`, the `targetMsgId` it answers, the
      `outcome`, and the rejection's `reason` (or `none`). A throwing sink is caught and logged, as
      `ALOutboundDispatchAdmission.emitDiagnostics` does. There is one event per control frame, the
      same cadence as the inbound `admission-outcome`, and it rides the page's batched diagnostics.
      The contract doc documents it. It is pinned over memory and IndexedDB: a first ACK reads
      `committed`/`none`, and an unexpected peer's ACK reads `rejected`/`AL acknowledgement sender has
      no pending outbound obligation`.
      Command: `npx vitest run packages/tests/shared/alm/outbound-commit-phase-diagnostics.test.ts`
- [x] **Step 4: Verify.**
      - Every RED case is GREEN, and so is the whole Task 7/9 matrix: 56 tests.
      - The broad sweep passes. The 10 failures in three `shared-test` files bind loopback ports and
      pass unsandboxed.
      - `al-indexeddb-operation-counts.test.ts` passes 13/13, unchanged: 10 / 15 per default send, 6
      + 2 inbound, release 1, and the idle relay relays nothing.
      - Bundles: the facade is 213.2 KiB against 214, and headless is 271.083 KiB against 272. No
      ceiling moved.

      Commands:

      - `npx vitest run packages/tests/shared/alm packages/tests/shared-web/messages packages/tests/shared-web/websocket packages/tests/shared-web/rtc packages/tests/shared-web/al-runtime packages/tests/shared/transport-faults packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared/websocket/json-web-socket-client-faults.test.ts packages/tests/shared/al-outbound-message-runtime.test.ts packages/tests/shared-test packages/tests/shared/services`
      - `npx tsc -p packages/shared/tsconfig.json --noEmit`
      - `node scripts/check-tests-typecheck.mjs`
      - `npm run check:repo-style:changed -- origin/main HEAD`
      - `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`
      - `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
      - `npx vitest run packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`
      - `npx dprint check <touched files>`
      - `npm run test:rallar:full-stack:memory:alm`, once.

### Task 6: Re-observe hosted under the regime rule, the PR, and the gates

**Files:** none in production; the lane's artifacts and the pull request.

**Re-read after Tasks 7 and 8 (maintainer ruling, 2026-09-23).** The first pass of Steps 1–3 ran on
`7add928af` at full scope and was red on all three cells (`.superpowers/s2a-full-read-diagnosis.md`):

- rtc and fallback lost the submission's ACK inside the sender's cancel-hold. Task 7 names candidate
  sites and rules out control admission on both carriers under its pin's fixed timing; the
  hold-window ACK loss itself is unfixed and was not reproduced. A repeat red on rtc or fallback at
  `receipts-1` / `assert-confirmed-1` is expected: read it against the cell's `-page-diagnostics.json`
  file and the snapshot's claim waits and page regime, record the reading, and route it to the
  maintainer rather than counting it as a regression of Tasks 1–4. D31 stays unmet until a hosted run
  in a normal page regime, with a same-regime green baseline, passes both scenarios.
- ws failed `delivery-reload`, whose original was admitted behind an in-flight inbound batch.
- Every cell ran on a slow page, and the outbound regime scored rtc `normal`. Task 8 classifies the
  page.

Steps 1–3 are re-run on the head that carries Tasks 7 and 8. Step 2's workflow input has landed
(`.github/workflows/release-gate.yml:15-19,203`, `.github/workflows/branch-release-gate.yml:114`), so
only its read re-runs. The repository variable `RALLAR_BLACK_BOX_ALM_SCOPE` stays `full` for that
read and is cleared after it. The PR body reports each change and the run that carried the read.

- [ ] **Step 1: Push, then classify before judging.** The Release Gate's non-blocking
      `alm-conformance-observation` job (`.github/workflows/release-gate.yml:196-249`) uploads
      `alm-conformance-lane-<sha>`. Read `regime` and `pageRegime` in every
      `alm-observation/<carrier>-<scope>.json`. The rtc cell's two regimes together are the runner's
      verdict. A red counts only against a green baseline whose two regimes match, and `unclassified`
      in either is no evidence. That is the "Classify before judging" rule Task 8 Step 3 writes into
      "Reading a red" (`packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md:101-126`
      before Task 8).
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
      (full) green on all three carriers, in regimes that have a green baseline with the same two
      regimes. Record per cell:

      - `regime` with `perOperation.medianMs`
      - `pageRegime.regime` with `storageProbeMedianMs` and `sampleCount`
      - the receiver's `sendControlClaimMedianMs` and `intraBatchWaitMedianMs`

      Set them beside Task 0's reading and the diagnosis' bands: `send-control` 689–1 187 ms green,
      and the 5.9 s intra-batch wait of `f33dd8118 / rtc`. A cell whose record lacks either regime is
      not accepted. **The 2C decision rule (maintainer, 2026-09-23)** applies to the re-read's rtc cell:

      - `regime` and `pageRegime.regime` both `normal`, and the receiver `sendControlClaimMedianMs`
        above 1 200 ms: execute Task 2C, reporting its file count first as 2C's preface asks.
      - Both `normal`, and the median at or below 1 200 ms: 2C stays not chosen.
      - The page regime `slow` or `unclassified`: the cell decides nothing. Rerun once, and if the
        page is not `normal` again, route to the maintainer.

      Under shape A the `send-control` median may stay red while the delivery arrives — that is the
      point (proposal §5). F2c's inbound release median (525–908 ms) and pending share (6–11 %) stay unregressed. A
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
      budgets. The body also records Task 7's site reading, and lists Task 8's page constants (20 and
      50 ms per probe, 10 samples, the 60 s window end) as maintainer-visible. The body states that
      `sendLive` bypasses the WS submission-readiness fault port.
      `npm run pr:delivery -- status` decides the next action; `ready` and auto-merge are not used.
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

## Rulings during execution (2026-09-23)

- **R-S2a-1 (witness relay).** Decided: the "one event per round that finds a row still unreserved"
  witness rides on the existing `effect-drain` and `rotation-alive` events instead of a new
  per-round event. Why: a dedicated per-round event is exactly the relay cost that already doubled
  the RTC cell's per-operation time once (8.2 → 20.9 ms/op) and would repeat the F2b regression; the
  idle-rotation-relays-nothing pin (`al-indexeddb-operation-counts.test.ts:265-282`) has to hold.
  Changed in the plan: Task 0's "Why the witness rides on existing payloads" section and its
  discrimination table already describe this shape; no step adds a separate event.

- **R-S2a-2 (hosted full-scope read mechanism).** Decided: the hosted full-scope read for
  `delivery-reload` is a `release-gate.yml` observation-job input `alm_scope` (default `smoke`) fed
  by the repository variable `RALLAR_BLACK_BOX_ALM_SCOPE`, not a throwaway branch. Why: a variable
  flip is reversible and auditable without pushing, running and deleting a branch. Changed in the
  plan: Task 6 Step 2's workflow-input mechanics.

- **R-S2a-3 (effect ids recorded at source).** Decided: queue keys hash their context segment to
  more than 35 characters, so `toALInboundWorkKey`'s inverse cannot exist; `toALInboundWorkEffectId`
  and the generic `claimedKeys: readonly Key[]` field are dropped. Effect ids are instead recorded at
  the point that already decodes them: `runInboundClaim` appends each claim's own `effect.effectId`
  to a private run-order accumulator, and the selector's `getUnreservedDue()` returns
  `ALInboundDeferredEffect { effectId, dueAtMs }` directly. Why: the brief's inverse-function design
  was unimplementable once the actual key encoding was read. Changed in the plan: Task 0's Files
  list, Interfaces (no `ALWorkUnreservedDue` type, no `toALInboundWorkEffectId`, no `claimedKeys`
  field) and Steps 1–3's implementation text.

- **R-S2a-4 (claimWaits definitions).** Decided: `batchStartedAtMs` is captured at the run loop's
  start, after the selection and reservation, not before them. `reservationWaitMedianMs` is due to
  that run-loop start (the wait for a round, plus that batch's own selection and reservation);
  `intraBatchWaitMedianMs` is the serialization behind earlier claims of the same run loop. Why: a
  quality review found the original timestamp placement made intra-batch wait over-count the batch's
  own selection/reservation cost. Changed in the plan: Task 0's `claimWaits` JSDoc.

- **R-S2a-5 (superseded emission site).** Decided: the dispatch admission itself
  (`ALOutboundDispatchAdmission.commitDispatchOnce`) emits `superseded`, guarded, after a committed
  result — covering enqueue, pending replay and dequeue from one call site inside the existing lock,
  with no new queue or timer — once per predecessor transition, derived from observed-vs-written
  supersedence state so a re-commit of the replacement row emits nothing. Why: only enqueue/dequeue
  pass through the runtime's `commitDispatchPlan`; the pending replay and repair commits call the
  admission's commit directly, so a `commitDispatchPlan`-only emitter would miss two of the four
  paths. Changed in the plan: Task 3's Files list and Step 3 now name
  `al-outbound-dispatch-admission.ts` and `commitDispatchOnce`, not the runtime's
  `commitDispatchPlan`.

- **R-S2a-6 (reading the code for the maintainer's wake condition).** Decided: the wake-on-admission
  the maintainer asked for already exists — `admitDecodedMessage` calls `commitWork()` on
  `wroteWork` (`al-inbound-message-runtime.ts:335`), which runs `restartScan()` and
  `ALWorkHandler.committed()` → `queueEngine.wake()` (`al-work-handler.ts:218-220`), and a wake
  landing during a batch is drained by one follow-up batch at that batch's end (`:168`). Why: this
  answers the maintainer's condition that the wake "builds on existing functionality" and introduces
  no new abstraction. Changed in the plan: Task 2's "Read on 2026-09-23" resolution and Task 2D's
  Step 0, which pin the existing wake rather than build a new one.

- **Maintainer ruling (2026-09-23, amends D19).** Decided: Task 2 = 2D (RTT heartbeats off the
  durable AL commit path) plus wake-on-admission, conditioned on the wake building on existing
  functionality and introducing no new abstraction or layer. Why: Task 0's Step 9 probe showed RTT
  heartbeats are the lock hog (2D), and the maintainer separately wanted the reservation term
  addressed without a new scheduling owner. Changed in the plan: Task 2's header text and its "Task 2
  = 2D plus one pin" resolution; Task 2C is recorded as the not-chosen lever, not executed.

- **Maintainer ruling (2026-09-23).** Decided: the controller may set and clear the repository
  variable `RALLAR_BLACK_BOX_ALM_SCOPE` for Task 6's full-scope read, reporting each change in the PR
  body. Why: paired with R-S2a-2's workflow-input mechanism, this lets the full-scope hosted read
  happen without a throwaway branch or a standing scope change. Changed in the plan: Task 6 Step 2's
  final two sentences, on setting and clearing the variable and recording which run carried the full
  read.

- **Maintainer ruling (2026-09-23, the re-plan after the full-scope read).** Decided: add Task 7 and
  Task 8, then re-run Task 6 Steps 1–3.
  - Task 7, the ACK admitted under a hold: a deterministic RED test over both carriers' holds, then
    the fix at the control-admission site it names.
  - Task 8, the storage-probe median as a page regime in the observation artifact, so that slow pages
    are classified and the same-regime rule is applied honestly.
  - Task 6 Steps 1–3 re-run on the head that carries them, with `RALLAR_BLACK_BOX_ALM_SCOPE` kept
    `full` for that read and cleared after it.
  - Task 2C only if that re-read, on a normal page regime, still shows the receiver `send-control`
    median above 1 200 ms.

  Why: the full-scope read of `7add928af` (`.superpowers/s2a-full-read-diagnosis.md`) showed two
  things. The rtc and fallback reds are an ACK lost inside the sender's cancel-hold, which Task 4's
  reordering exposed. The outbound regime also scored a slow page `normal`: rtc 16.61 ms/op, with an
  `age-bound` probe of 141–210 ms against P's 2–4 ms. So P's large improvement was mostly a fast-page
  draw, not the lever. Changed in the plan: Tasks 7 and 8 added before Task 6; Task 6's preface and
  Steps 1 and 3; Task 2's 2C sentences; the regime-constants bullet of Global Constraints; the
  Self-review.

- **R-S2a-7 (Task 7: the ACK is not lost in admission).** Decided: skip Task 7 Step 3 and commit the
  test as a pin, per Step 2's all-GREEN escalation. Reading: over a real memory runtime of each
  carrier, the armed and the unarmed case alike read `outbound-answered` / `committed`, record the
  ACK's `admission-outcome` (`control`), and the handle reads `acknowledged`, with the hold engaged
  (RTC `drop` observations, WS `not-ready` observations) and no ACK frame asked of the fault port.
  E1 (the submission's own `ack-timeout` retransmission under the held typeId, `attempts` 0 → 1
  before the ACK), E2 (the lane's cancel of the held send) and E3 (the same matrix over fake-indexeddb
  stores, in `acknowledgement-under-transport-hold-indexeddb.test.ts`) are GREEN each, and E1 with E2
  together is GREEN on both stores. The witness does discriminate: a throw injected into
  `ALOutboundRepairAdmission.acceptControlMessage` reads `outbound-threw` and turns the armed cases
  RED. So the ACK is admitted and the send reaches `acknowledged`, hold armed or not, under the pin's
  fixed timing on memory and fake-indexeddb stores, through both carriers' real ingress: this is not
  reproducible in admission or ingress under the pin's interleavings, so the hosted loss is not in
  those paths under that timing. An await that never settles on slow storage (C3; the hosted F page's
  `age-bound` probe ran 66.5–358 ms, while the pin's stores settle within a few turns) is not ruled
  out. Routed to the maintainer with the diagnosis' one harness-only addition, sender
  `pageerror`/console capture in the lane — which can name a throw or a rejection, not a hang — not
  built here. Why: no case reproduced, and the brief
  forbids a fix without a RED. Changed in the plan: nothing beyond this entry. The pin widens the
  brief's fixture by `readPendingAck` on `HoldSender` (E1 reads the receipt's `timeoutMs` and
  `attempts`), a `HoldEscalation` third argument to `expectAcknowledgedUnderHold` and the shared case
  matrix `ACK_UNDER_HOLD_CASES` (12 cases per store). The WS opener fakes `Date`, `setTimeout`,
  `setInterval` and their clears, not every timer, because fake-indexeddb completes on `setImmediate`
  and E3's unarmed WS case otherwise never settled; this matches `ws-durable-owner-recovery.test.ts`.
  Corrected in fix round 1: the first pin handed the WS ACK straight to
  `WsQueueBoxClientService.acceptIncomingMessage`, which skipped the WS ingress. So the claim was
  symmetric only for RTC and for the closed-client guard (`ws-queue-box-client-service.ts:431-433`).
  Both carriers now raise the ACK as the native `message` event. On RTC, the fixture's
  `channel.receive` reaches `onmessage` (`qrtc-data-channel.ts:494`) and then the `status.dc` guard
  (`:519`). On WS, `TestWebSocket.receive` reaches `JsonWebSocketClient.dispatchMessage`, whose guard
  requires the event's socket to be the client's current `ws` (`json-web-socket-client.ts:205`).
  Next is the inbox callback, whose guard requires `event.target` to be `this.socket.ws`
  (`ws-queue-box-client-service.ts:417`). Only then does `acceptIncomingMessage` run. The matrix is
  still GREEN on both stores, so WS C0 is ruled out: the `not-ready` hold only reads
  `ws.readyState` in `decideSubmissionReadiness` and never replaces the socket, so the ACK arrives
  on the same socket identity both guards compare. Inverting any one of the three guards turns the
  six WS or six RTC cases RED as `never-admitted`, so each guard is on the pin's path.
  **Corrected by Task 9 (R-S2a-8).** The mechanism is found, and it is neither C3 nor a carrier
  discard. It is C2 at the read. After the ACK's `readControlAdmission` read an expired row, its
  `IndexedDbAdmissionBackend.readWithin` evicted that row under the write token it had read. Another
  writer had already moved the row, so the eviction threw `ALAdmissionBackendConflictError` (`IndexedDB
  AL admission expiry cleanup conflicted`) out of `admit`. The RTC `onMessage` catch dropped the
  error. The reading above holds for the pin's interleavings, which had no expired row in the ACK's
  read set. Its conclusion does not hold: "not lost in the sender's admission" was wrong. The hold
  is incidental.

- **Maintainer ruling (2026-09-23, Task 7b).** Decided: build the harness-only addition R-S2a-7 routed
  — sender/receiver `pageerror` and console capture in the ALM lane, folded into the observation
  artifact as a required `pageDiagnostics` block — as its own task (7b), immediately after Task 7.
  Why: R-S2a-7's escalation left the hosted ACK loss unattributed between the carrier and the
  capture, and the artifacts carried no page-level evidence at all to narrow it further. Changed in
  the plan: Task 7b added between Task 7 and Task 8.

- **R-S2a-8 (Task 9: the ACK's control admission read throws an expiry-cleanup conflict).** Decided
  by the controller, under the maintainer's decision to fix the ACK-under-hold defect: reproduce
  first, then fix at the source.
  - **Reproduction.** Task 7's IndexedDB pin gained a sibling case. In it, the submission's `acks` row
    is expired, and a second chain evicts that row between the ACK chain's snapshot and the ACK
    chain's eviction. The case reads `outbound-threw` with the hosted error, and the send stays at
    `transport-accepted`. This holds on both carriers, armed and unarmed.
  - **Fix.** The IndexedDB backend's read-side expiry eviction no longer turns its guarded write's
    "not committed" into `ALAdmissionBackendConflictError`. The row is left to the writer that moved
    it, and the read answers from its snapshot. `admit` was not given a catch for the read, and the
    conflict was not made into `pending-control`.
  - **Why.** The eviction is not part of the reader's decision: the reader already treated the row as
    absent. The only conflict that can be the reader's is caught by its own write's fence, which
    already returns a typed value. Fixing the backend also covers every other read surface, and
    F2's second uncaught site (`admit`'s effect read) with it, so nothing new was added at the call
    sites.
  - **Changed in the plan:**
    - Task 9 added after Task 8.
    - R-S2a-7 corrected.
    - The Self-review's Task 7 bullets now point at Task 9.
    - The headless ceiling moves from 271 to 272, measured at 271.0087890625 KiB, under the Global
      Constraints' next-whole-KiB rule.

- **R-S2a-9 (Task 10: a late acknowledgement inside the deadline acknowledges).** Decided by the
  controller, under the maintainer's decision of 2026-09-23: reproduce first on an advanced clock,
  then fix at the source.
  - **Reproduction.** The Task 7/9 pin gained three clock variables. With the ACK 2 s past the
    receipt's retry schedule, and with or without the retries run, the outbound admission answers
    `rejected: AL acknowledgement sender has no pending outbound obligation`, and the handle stays
    `transport-accepted`. This holds on both carriers, armed and unarmed, over both stores. An ACK 1
    s before the schedule's end acknowledges.
  - **Fix.** The receipt row's expiry is the message deadline, never shorter than the retry schedule.
    The `ack-timeout` rows keep the schedule's end, and a spent budget schedules nothing and deletes
    nothing.
  - **Why.** The receipt is the obligation an ACK completes against, and the `ack-timeout` rows are
    the retransmission schedule. The two lifetimes were one number, so ending the retries ended the
    obligation.
  - **Diagnostic.** The outbound verdict that every carrier discarded is now the `control-admission`
    outbound diagnostic.
  - **Changed in the plan:** Task 10 added after Task 9.

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
- The re-plan (2026-09-23) and its coverage:
  - The hold-window ACK loss is covered by Task 7, which did not fix it. Steps 1–2 give the
    one-variable RED over both carriers' holds and a witness that names the stop site as a value; all
    cases read GREEN, so Step 3 was skipped per the brief's all-GREEN escalation (R-S2a-7). Step 4
    keeps the operation-count pins and both carriers' hold and admission suites. Task 9 reproduces
    the loss from the hosted page record. The ACK chain's expiry eviction conflicts with a concurrent
    eviction. Task 9 fixes the loss at the IndexedDB backend (R-S2a-8).
  - The page speed is covered by Task 8. The constants are derived from 24 hosted cells, the window
    skips start-up for a stated reason, and the "Classify before judging" rule makes the rtc cell's
    two regimes the verdict.
  - The re-read and the 2C rule are covered by Task 6's preface and Step 3.
  - No harness budget, lane constant or outbound threshold moves. Task 7 adds no timer, queue or
    registry: its settle is a count of turns, and it fixed no site. Task 9 adds none either. Its seam
    orders two real chains, and its fix removes a throw.
- Type consistency: `ALWorkUnreservedDue`, `toALInboundWorkEffectId`, `ALInboundDeferredEffect`,
  `ALMObservationInboundClaim`, `ALMObservationInboundClaimWaits`, `readALInboundRowEligibility`
  and the fixture's `acknowledged` are defined in Task 0 before Tasks 1 and 5 use them;
  `computeALInboundClaimOrder` and `InboundTestEffectCall` in Task 1 before 2C relies on the order;
  the `superseded` settlement arm in Task 3 before Task 4 relies on `observe-superseded-3` resolving
  locally. `HoldSender`, `ControlAdmissionStop` and `ControlAdmissionWitness` are test-only and are
  defined in Task 7's fixture before its test uses them. `ALMObservationReadinessProbe` (snapshot) is
  defined before `ALMObservationPageRegime` (regime) reads it, and the page regime reuses
  `ALMObservationRegimeName` rather than naming a second vocabulary. No type is introduced twice and
  no alias renames one.
- File size: every added function is under 40 lines, and Task 0 Step 2 splits the 49-line
  `readALInboundPageEligibility` rather than growing it. Near the 1 200-line backstop:
  `al-work-handler.test.ts` (1 186; two literals gain three fields, no test added),
  `al-inbound-effect-worker-lifecycle.test.ts` (1 156; untouched — Task 1's test lives in the
  259-line selection suite) and `create-alm-conformance-recipes.ts` (1 064; Task 4 moves commands
  and adds one short function). Task 8 widened `compute-alm-observation-regime.ts` past the review
  threshold, so the sibling-file split named in Step 2 landed: `compute-alm-observation-regime.ts` is
  back to 422 lines (8 runtime exports), and the new `compute-alm-observation-page-regime.ts` carries
  89 lines (8 runtime exports). `alm-observation-snapshot.ts` (351; about +25) and
  `alm-observation-regime.test.ts` (662; about +90) are otherwise unaffected. Task 7's fixture,
  `acknowledgement-under-hold-fixture.ts`, is a new file of 456 lines whose functions stay under 40
  lines.
- Placeholder scan: every step names files with line ranges, the symbol, the test code or exact
  edit, and the command. The branch points each have a written rule:
  - 2C or 2D is decided by Task 0 Step 9, and 2C is decided again by Task 6 Step 3's re-read rule.
  - Task 7's site table gives each candidate site a written fix or a written stop-and-route; the
    all-GREEN escalation fired, so no site's fix was picked, and the all-GREEN path (skip Step 3,
    commit as a pin, route to the maintainer) is written out.
