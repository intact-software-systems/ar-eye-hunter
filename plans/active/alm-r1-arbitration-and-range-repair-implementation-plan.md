# ALM R1: shared-key proof, range repair, the recovery owner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven development with test-driven development:
> one implementer per task, the failing tests first, the controller reviews and commits, one commit
> per task, a three-seat final review with one fix wave before the close. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Deliver Release 5, R1 (D136 to D142, `playground/alm/alm-r1-design-proposal.md`). The
sender retries its own hop after an acknowledgement timeout, which turns the I2b consumer proof
green. One schedule module proves shared-key arbitration over memory, IndexedDB and pglite for both
admission stores, and the inbound README states that PostgreSQL fences written keys only. Inclusive
sequence ranges replace missing-sequence lists on the wire (`v2` control ids), in the rows (schema
bump) and in the effect ids; retransmission is paged; exhausted repair settles `skipped` with
`repair-exhausted`. A typed channel may declare a recovery owner, invoked once per ordering track
with a bounded cursor when the receiver needs to resynchronize. The lane gains `ordering-gap-repair`
and `repair-exhausted`, `ordering-resync` observes the owner, and the Relic reload-mid-command case
passes.

## Global constraints

- **The maintainer's notes stand: "No legacy, avoid duplication, no migration code, prefer existing
  repo patterns."** The wire cutover is one step (D3): `al.control.nack.v2` and
  `al.control.repair.v2`; the `v1` ids are refused `unsupported` with `al.control.ack.v1`. The schema
  id bumps once (D139); no row is migrated.
- **D8 reuse first.** Named reuses, each verified at `file:line` by its task: the captured plan's
  `ackTracking.nextHopPeerIds`; `inbound-supersedence-concurrency.test.ts`'s three-backend
  `describe.each` and `createPSqlAdmissionTestStorage`; the gated real-PostgreSQL fixtures
  (`postgres-runtime-state-client-fixtures.ts`, `RALLAR_POSTGRES_INTEGRATION`); the control value
  codec and its caps; the lifecycle's `skipped`/`repair-exhausted`; `LatestRepository` for the
  once-per-track mark; the inbound diagnostics sink; the typed channel registry; the native hold and
  the `ordering-resync` scenario's waits; `packages/shared/cache` for keyed and latest state. Every
  task carries a D8 reuse inspection paragraph and its commit one `D8 reuse:` line.
- **No guarantee weakens.** The ledger, cold, inbound, D55 and checkpoint pins stay unedited; the
  256 window, the 256-message and 1 MiB ceilings stay; a room multicast's audience never widens on a
  retry (D24, D43); the WS server keeps its ordering gate and its `resync-required` NACK (D49, D50).
- **Code standard** (`.agents/skills/rallar-code-writing/references/repo-code-style.md`): canonical
  verbs; functions ≤40 lines; ≤3 positional parameters; `interface` for object contracts; required
  fields by default (a field is optional only when absence has domain meaning, stated in its doc
  line); `Either` for expected failure; kebab-case filenames after the primary export; no role
  folders; no comments but invariants, external constraints and tradeoffs; no plan, decision, task,
  PR or ruling id in code or tests. A widened union's consumers are swept by enumeration.
- **Formatting:** `npx dprint fmt <explicit file list>` on touched files only.
- **Per-task checks:** the focused Vitest files; `npx tsc -p packages/shared/tsconfig.json --noEmit`;
  the shared-web, shared-server and shared-test typechecks; `deno check` from the repo root on every
  changed `packages/shared/**` and `packages/shared-test/**` file (in this sandbox `cd apps/api-v1 &&
  deno task check` fails on import-map discovery; CI runs it); `node
  scripts/check-tests-typecheck.mjs`; the four pins (`al-indexeddb-transaction-ledger`,
  `al-indexeddb-operation-counts`, `al-storage-snapshot`, `al-indexeddb-empty-audience-counts`);
  the bundle checks with a private `TMPDIR` after any `packages/shared` or `shared-web` change
  (budgets: `browser/rallar.ts` 238, headless 303; a crossed budget rises to the next whole KiB with
  the figure in the commit message); for a public shared-web surface change
  `shared-web-public-api-snapshots.test.ts` and `shared-web-browser-bundle-boundaries.test.ts`; after
  the commit `npm run check:repo-style:changed -- origin/main HEAD`, `node
  scripts/check-test-structure-coupling.mjs --changed origin/main HEAD` and, when a test file is added
  or deleted, `npm run check:test-reachability`; `npm run test:postgres:integration` is owed by the
  task that changes `alm/inbound/**` source (Tasks 3 and 5), where a Postgres is available, and is
  otherwise read from CI's Postgres integration lane.
- **Sandbox notes.** Node 22 here (CI 24): a `CloseEvent` polyfill via `NODE_OPTIONS=--import` from the
  scratchpad for the unit project; Deno on `PATH` for the suites that spawn it. Known reds unrelated to
  this plan: `ws-room-provenance-delivery.test.ts` (one race case), `headless-worker-script.test.ts`;
  5 s load timeouts in pglite suites that pass alone.
- **Git.** One commit per task with one `D8 reuse:` line; the controller commits and pushes after
  review; never `git stash`; the PR body is written at the close.

## File structure

| Area                     | Files                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own-hop retry (1)        | `packages/shared/alm/outbound/al-outbound-repair-retransmission.ts`; `packages/shared/alm/outbound/README.md`; tests under `packages/tests/shared/services/` (WS client) and `packages/tests/shared/alm/outbound/`; `tests/playwright/relic-hunters/full-stack-propagation.spec.ts` (run only)                                                                                                                                            |
| Proof (2)                | `packages/tests/shared/alm/al-shared-key-arbitration.test.ts` (new); `packages/tests/shared-server/integration/postgres/al-outbound-supersedence.test.ts` (new); `packages/shared/alm/inbound/README.md`                                                                                                                                                                                                                                  |
| Ranges (3)               | `packages/shared/al-contracts/al-runtime.ts`, `al-control.ts`, `al-control-type-ids.ts`, `al-control-value-codec.ts`, `al-policy.ts`, `al-message-resource-limits.ts`; `packages/shared/alm/compute-al-ordering-observation.ts`, `alm/open-indexed-db-admission-database.ts`; the inbound and outbound files that carry `missingSeqs` (18 production files, listed in Task 3); `packages/shared/multicast/rtc-room-snapshot-admission.ts` |
| Pages and exhaustion (4) | `packages/shared/alm/outbound/al-outbound-repair-retransmission.ts`, `al-outbound-repair-admission.ts`, `compute-al-outbound-dispatch.ts`, `al-outbound-store-lane.ts`                                                                                                                                                                                                                                                                    |
| Recovery owner (5)       | `packages/shared/alm/inbound/al-inbound-message-runtime.ts`, `al-inbound-ordered-delivery.ts`, `al-inbound-resync-required.ts` (new); `packages/shared-web/browser/messages/rallar-message-contracts.ts`, `validate-rallar-typed-channel-policy.ts`, `browser-typed-message-channels.ts`, `browser-resync-recovery.ts` (new); the WS client and RTC rx composition that build the inbound runtime; `rallar.ts`, `rallar-core.ts`          |
| Harness (6)              | `packages/shared-test/rallar-bb-test/conformance/alm/scenarios/ordering-gap-repair.ts`, `repair-exhausted.ts` (new), `ordering-resync.ts`; the catalog, the Hetzner withholding, the control-server fixture; the harness docs                                                                                                                                                                                                             |
| Docs (7)                 | `packages/shared/alm/inbound/README.md`, `outbound/README.md`, `packages/shared-web/browser/README.md`, `docs/rallar-api-reference.md`, `packages/shared-test/rallar-bb-test/docs/*`, `playground/alm/alm-complete-product-description.md`                                                                                                                                                                                                |
| Close (8)                | the pins, the gates, the review, the PR body, this file                                                                                                                                                                                                                                                                                                                                                                                   |

## Task order

1 (own-hop retry) → 2 (proof) → 3 (ranges) → 4 (pages, exhaustion) → 5 (recovery owner) → 6 (harness)
→ 7 (docs) → 8 (close). Tasks 1 and 2 are independent of each other; 4 consumes 3; 5 consumes 3's
observation shape; 6 consumes 1, 3, 4 and 5 through the browser only.

## Rulings

- **R-R1-1:** The own-hop exemption applies in both guarded places of the retransmitter (`readRepairPlan`
  and `retryMissingAcknowledgements`): a retry whose failed peers are a non-empty subset of
  `plan.ackTracking.nextHopPeerIds` is the sender's own hop. _Cost if wrong:_ a room gap repair without a
  planner would also replay the frame to the hop that already holds it, which the hop deduplicates.
- **R-R1-2:** `ALSeqRange` lives in `al-contracts/al-runtime.ts` beside `ALOrderingObservation`; the
  pure translations `toALSeqRanges(seqs)`, `toALSeqsInRanges(ranges)`, `toALSeqRangesText(ranges)` and the
  decoder live in a new `al-contracts/al-seq-range.ts`. _Cost if wrong:_ one file moves.
- **R-R1-3:** The codec caps a payload at `AL_MESSAGE_RESOURCE_LIMITS.repairRanges = 128` ranges and
  rejects a range with `from > to` or a non-integer bound as malformed. _Cost if wrong:_ a constant
  changes.
- **R-R1-4:** Effect ids that joined `missingSeqs` join ranges as `${from}-${to}` with `,`; an id's
  length stays bounded by the range cap. _Cost if wrong:_ none, ids are opaque.
- **R-R1-5:** `AL_REPAIR_PAGE_SIZE = 32` lives in `al-message-resource-limits.ts` as
  `repairPageMessages`. The follow-up hint carries the remaining ranges and the same trigger and
  requester; its effect id is the page's first remaining sequence, so a hint is never re-served twice.
  _Cost if wrong:_ a constant changes.
- **R-R1-6:** Typed exhaustion is settled through the lane's existing settlement sink as
  `{ kind: 'skipped', reason: 'repair-exhausted', msgId }` once per message; a second exhausted hint
  for the same message settles nothing more. _Cost if wrong:_ a duplicate statement on the handle.
- **R-R1-7:** The inbound runtime gains the optional dependency `onResyncRequired` (absence: no owner
  anywhere, the server's case), called with `ALInboundResyncRequired { msg, cursor }` from both the
  admission acceptance and the ordered-delivery rejection; the browser's `BrowserResyncRecovery` owns
  the once-per-track mark and the channel lookup. _Cost if wrong:_ the mark moves into the runtime.
- **R-R1-8:** The `recovery-owner-invoked` diagnostics event is emitted by `BrowserResyncRecovery`
  through the browser ALM diagnostics port the storage events use, under the kind
  `'recovery-owner-invoked'` with the cursor, so the lane observes it on its existing topic. _Cost if
  wrong:_ the harness waits on a different topic.
- **R-R1-9:** The new two-agent cells are withheld from hosted manifests 18 and 22 (as I2b's were); they run locally and in the observation's full read. Manifest 18 is regenerated once in Task 3 where its `ordering-resync` cell waits on the NACK type id, which moves to `v2`; no other manifest line moves. _Cost if wrong:_ no hosted proof of the new cells; the hosted run of 18 is a regression read of the `v2` id.
- **R-R1-10:** The Relic full-stack case runs once in Task 1 (it needs `RALLAR_AUTH_CREDENTIAL_SECRET`
  and Chromium build 1228); its summary line goes to the PR body; a red there is diagnosed before any
  change. _Cost if wrong:_ one manual run.

## Limits (carried; Task 8 states them in the PR body)

- A lost client-to-server frame of a `receiver` room multicast or session unicast is not retried by
  the client: no client-tracked hop exists; the server owns those retries (D38, D48).
- PostgreSQL fences written keys only (D138); a key a writer only reads is checked by the store's
  re-read, which is not atomic with the commit. No shared key of the schedule is read-only.
- A reload re-invokes the recovery owner once (the once-mark is per runtime, D142).
- ALM resets no ordering track after a resync; the sender's new epoch closes it (D142).
- The WS server has no recovery owner and keeps NACKing `resync-required`.
- Hosted manifests 18 and 22 carry none of the new cells; 18 changes only by the `v2` NACK id (R-R1-9).

---

### Task 1: The sender retries its own hop (D136)

**Files**

- Modify: `packages/shared/alm/outbound/al-outbound-repair-retransmission.ts` — the two guards gain
  the own-hop exemption through one private predicate `isOwnHopRetry(plan, pending)` (R-R1-1):
  `failedPeerIds` non-empty and every one in `plan.ackTracking?.nextHopPeerIds`.
- Modify: `packages/shared/alm/outbound/README.md` — the repair owners paragraph (`:11-15`) and the
  `repair-hint` row (`:324-329`) state the own-hop retry and the client-untracked exception.
- Test (create): `packages/tests/shared/services/ws-queue-box-client-own-hop-retry.test.ts` — like
  `ws-qos-policy.test.ts:177-240` but with a `room.*` topic, a `groupRef` unicast to the server and
  `ack: 'receiver'`: two frames with the same msgId after one acknowledgement timeout; and the
  negative pin: a `receiver` room multicast writes no acknowledgement-timeout row and sends one frame.
- Test (modify): `packages/tests/shared/alm/outbound/al-outbound-repair-policy.test.ts` — the room gap
  repair without a planner still sends nothing when the failed peers are not the next hops (the
  audience never widens).

**Interfaces.** None new; `isOwnHopRetry` is private.

**D8 reuse inspection.** The captured plan already carries `ackTracking.nextHopPeerIds`
(`admission/al-outbound-admission-validation.ts:97-106`); the pending row carries `expectedPeerIds`
and `ackedPeerIds`; the retry path and its re-tracking are the ones `ws-qos-policy.test.ts:177`
exercises for a non-room message. No new field, row or planner.

- [ ] **Step 1: Write the failing tests** (the two new cases red: `expected 2 frames, got 1`).
- [ ] **Step 2: Run them red.**
- [ ] **Step 3: The predicate and the two guards.**
- [ ] **Step 4: Format; focused tests green; `packages/tests/shared/alm/outbound`, `packages/tests/shared/services`
      and `packages/tests/shared-web/messages` green; the four pins; typechecks; bundles.**
- [ ] **Step 5: The Relic full-stack suite once** (`RELIC_HUNTERS_FULL_STACK=1 npx playwright test --config
      apps/relic-hunters-v1/playwright.full-stack.config.ts`, R-R1-10). Expected: `2 passed`, the
      reload-mid-command case included. Restore `apps/relic-hunter-server-v1/deno.lock` if the server
      start rewrote it.
- [ ] **Step 6: Commit.**

```text
Retry the sender's own hop after an acknowledgement timeout

A repair retry whose failed peers are all the captured plan's next hops
replays the same frame to the same hop and cannot widen a room audience,
so the retransmitter no longer refuses it for want of a repair planner.
A WS unicast addressed to the server, which names its room, and a room
hop or subtree send tracked against the server are retried inside their
deadline, at most maxAttempts times; the server deduplicates the repeat
and acknowledges it again. A receiver room multicast or session unicast
has no client-tracked hop and stays the server's to retry. The Relic
reload-mid-command case passes.

D8 reuse: the captured plan's ackTracking.nextHopPeerIds and the pending row's peer sets decide the retry; the existing retry commit and re-tracking carry it; no new field or planner.
```

---

### Task 2: The three-backend proof (D137, D138)

**Files**

- Test (create): `packages/tests/shared/alm/al-shared-key-arbitration.test.ts` — `describe.each(['memory',
  'indexeddb', 'pglite'])`; one schedule helper `runStaleReadThenSequentialCommit({ readA, readB, commitB,
  commitA })` that asserts B committed, A `conflict`, A's writes absent and no revision bump on the key the
  case names. Cases: inbound dedup key; inbound supersedence latest; inbound ordering track (B advances
  the track, A's stale seq conflicts and recomputes); outbound supersedence latest (two senders); outbound
  sender version. Each case states the arbitrating key in its title.
- Test (create): `packages/tests/shared-server/integration/postgres/al-outbound-supersedence.test.ts` —
  gated (`RALLAR_POSTGRES_INTEGRATION=1`), two connections: stale read then sequential commit, one winner.
- Modify: `packages/shared/alm/inbound/README.md` `:449-456` — PostgreSQL fences written keys only
  (D138); the schedule module is the proof.
- Not touched: production code. The existing scattered cases stay.

**D8 reuse inspection.** `inbound-supersedence-concurrency.test.ts`'s backend matrix and
`createPSqlAdmissionTestStorage`; `outbound/al-outbound-admission-fences.test.ts`'s outbound store
builder over three backends; the real-PG fixtures of `al-inbound-supersedence.test.ts`. No new
fixture kind.

- [ ] **Step 1: Write the module red** (a deliberately wrong expectation proves the schedule bites:
      expect both to commit, see `conflict`; then set the real expectation). Record the red.
- [ ] **Step 2: Green over the three backends; the gated PG file compiles and skips here.**
- [ ] **Step 3: README correction; format; `check:test-reachability` after the commit.**
- [ ] **Step 4: Commit.**

```text
Prove shared-key arbitration over memory, IndexedDB and pglite in one schedule

One module runs the stale-read then sequential-commit schedule for both
admission stores over the three backends and names, per case, the written
key whose guard decides it: the inbound dedup key, supersedence latest and
ordering track, the outbound supersedence latest and sender version. The
gated PostgreSQL suite gains the outbound supersedence case over two
connections. The inbound README states that PostgreSQL fences the keys a
write touched, not the keys it only read, and that every arbitrated key
of the schedule is one both writers write.

D8 reuse: the existing three-backend matrix, pglite storage and real-PostgreSQL fixtures; no production change.
```

---

### Task 3: Ranges replace lists (D139)

**Files**

- Create: `packages/shared/al-contracts/al-seq-range.ts` — `toALSeqRanges(seqs: Iterable<number>):
  ALSeqRange[]` (sorted, merged, inclusive), `toALSeqsInRanges(ranges): number[]`,
  `countALSeqsInRanges(ranges): number`, `decodeALSeqRanges(value: unknown): Either<TypeError,
  readonly ALSeqRange[]>` (the one bounded range decoder for wire and rows, R-R1-3).
- Modify: `al-runtime.ts` — `ALSeqRange { from, to }`; `ALOrderingObservation.missingRanges` replaces
  `missingSeqs`.
- Modify: `al-control.ts`, `al-control-type-ids.ts` (`v2` ids; `v1` refused), `al-control-value-codec.ts`
  (ranges, caps), `al-policy.ts` (the NACK plan), `al-message-resource-limits.ts` (`repairRanges: 128`).
- Modify: `compute-al-ordering-observation.ts` — `computeGapOrdering` builds ranges from the contiguous
  head and the buffered set directly (no per-sequence list first).
- Modify (sweep by enumeration): `alm/inbound/al-inbound-effect-intent.ts`, `al-inbound-ordered-delivery.ts`,
  `al-inbound-planner-snapshot.ts`, `decode-al-inbound-plan.ts`, `prepare-al-inbound-commit-bundle.ts`;
  `alm/outbound/admission/al-outbound-admission-store.ts` (`ALOutboundRepairHint.missingRanges`),
  `al-outbound-effect-validation.ts`, `al-outbound-message-runtime.ts` (`ALOutboundRepairRequest`),
  `al-outbound-repair-admission.ts`, `al-outbound-repair-retransmission.ts` (reads every sequence of
  every range; Task 4 pages it), `compute-al-outbound-control-admission.ts`,
  `validate-al-outbound-control-admission.ts` (range containment: every range inside
  `[expectedSeq, triggerSeq)`); `multicast/rtc-room-snapshot-admission.ts`.
- Modify: `alm/open-indexed-db-admission-database.ts` — `AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-10-range-repair'`.
- Modify: `packages/shared-test/rallar-bb-test/**` decoders that read `missingSeqs` (if any; grep).
- Tests: `packages/tests/shared/al-contracts/al-seq-range.test.ts` (new); the 17 test files that carry
  `missingSeqs` move to ranges; `al-ordering-window.test.ts` gains "a gap of 2..5 with 3 buffered is the
  ranges 2-2 and 4-5"; the codec test gains the 128-range cap and the malformed range; the control
  validation test gains containment; the inbound README's schema bump history gains the row.

**D8 reuse inspection.** The codec's existing number-array decoder becomes the range decoder with the
same cap discipline; the observation, plan, hint and payload types are widened in place; no new store.

- [ ] **Step 1: Write the failing tests** (`al-seq-range.test.ts`, the ordering window case, the codec cap,
      the validation containment, the retransmitter reading ranges).
- [ ] **Step 2: Red.**
- [ ] **Step 3: Contracts and the ordering computation.**
- [ ] **Step 4: The sweep, guided by `tsc`; the schema id; the type ids.**
- [ ] **Step 5: Format; focused tests; `packages/tests/shared/alm`, `packages/tests/shared/al-contracts`,
      `packages/tests/shared-test`, `packages/tests/shared-server` green; pins; typechecks; `deno check`;
      bundles; the Postgres integration lane where available.**
- [ ] **Step 6: Commit.**

```text
Carry missing sequences as inclusive ranges

ALSeqRange {from, to} replaces the individual missing-sequence lists: the
ordering observation, the planner's NACK plan, the NACK and repair payloads
(al.control.nack.v2, al.control.repair.v2; the v1 ids are refused as
unsupported), the repair hint, the control validation (every range inside
the gap) and the effect ids, which join ranges as from-to. The receiver
computes ranges from the contiguous head and the buffered set; a payload
carries at most 128 ranges, the most a 256 window can hold. bufferedSeqs
stays a list. The buffered slot rows persist the plan, so the admission
schema id bumps to rallar-alm-2026-10-range-repair.

D8 reuse: the codec's bounded number-array decoding becomes bounded range decoding; the observation, plan, hint and payload types widen in place; no new store or row.
```

---

### Task 4: Paged retransmission and typed exhaustion (D140, D141)

**Files**

- Modify: `al-outbound-repair-retransmission.ts` — `retransmitFromRepairHint` serves at most
  `repairPageMessages` sequences ascending and commits one follow-up hint with the remaining ranges
  (R-R1-5); `repairByMsgId`'s budget exit settles `skipped`/`repair-exhausted` once (R-R1-6) and the
  warning goes; the "no cached message" warning stays (a programmer-visible condition).
- Modify: `al-outbound-repair-admission.ts` — the follow-up hint's bundle (the same effect shape, the
  remaining ranges, the page's first sequence in the id).
- Modify: `al-message-resource-limits.ts` — `repairPageMessages: 32`.
- Tests: `packages/tests/shared/alm/outbound/al-outbound-repair-paging.test.ts` (new): a hint of 70
  sequences serves 32, commits a follow-up with the remaining ranges, the follow-up serves 32, then 6,
  no fourth hint; `al-outbound-repair-exhaustion.test.ts` (new): at `maxAttempts` the handle reads
  `skipped`/`repair-exhausted` once and no `console.warn` is emitted (assert through the settlement sink
  and a spy that the warning is not called, without pinning a count).

**D8 reuse inspection.** The follow-up hint is the existing `repair-hint` effect; the settlement is the
existing `skipped` fact; the limits module holds the page size.

- [ ] Steps 1–2: failing tests, red. Step 3: the page and the follow-up. Step 4: the typed exhaustion.
      Step 5: format; focused and `packages/tests/shared/alm` green; pins; typechecks; bundles.
- [ ] **Step 6: Commit.**

```text
Page retransmission and settle exhausted repair as skipped

A repair hint is served thirty-two messages per work execution, ascending
across its ranges, and the remaining ranges are re-committed as one
follow-up hint, so a wide gap costs a bounded page of indexed reads and
dispatch commits per round. When a message's repair attempts reach the
budget, the retransmitter settles it skipped with reason repair-exhausted
once and writes nothing else; the warning is gone.

D8 reuse: the existing repair-hint effect and the lifecycle's skipped fact; one new limit constant.
```

---

### Task 5: The recovery owner (D142)

**Files**

- Create: `packages/shared/alm/inbound/al-inbound-resync-required.ts` — `ALInboundResyncCursor { orderingKey,
  senderId, epoch, lastContiguousSeq, expectedSeq, observedSeq, carrier }`, `ALInboundResyncRequired { msg:
  ALMessage, cursor }`, `toALInboundResyncCursor(msg, observation, carrier)`.
- Modify: `al-inbound-message-runtime.ts` — `Dependencies.onResyncRequired?: (resync) => void` (absence:
  no owner anywhere); called from the admission acceptance `resync-required` with the plan's ordering
  observation; `al-inbound-ordered-delivery.ts` — `reject` calls it too (R-R1-7).
- Create: `packages/shared-web/browser/messages/browser-resync-recovery.ts` — `BrowserResyncRecovery`:
  `onResyncRequired(resync)` looks the channel up by topic and type in the typed channel registry,
  invokes `recovery.onResyncRequired(cursor)` once per track key (`LatestRepository`), emits
  `recovery-owner-invoked` (R-R1-8); `closeTrack(trackKey)` on a new epoch.
- Modify: `rallar-message-contracts.ts` — `RallarTypedMessageChannelDefinition.recovery?: RallarChannelRecovery
  { onResyncRequired(cursor: RallarResyncCursor): void }` (absence: the message is dropped and diagnostics
  state it); `validate-rallar-typed-channel-policy.ts` (a function); `browser-typed-message-channels.ts`
  (registration exposes the owner); the WS client and RTC rx compositions pass `onResyncRequired`;
  `rallar.ts`, `rallar-core.ts` export the two types; the public API snapshot gains exactly them.
- Tests: `packages/tests/shared/alm/inbound/al-inbound-resync-required.test.ts` (cursor from an
  observation; the runtime calls the sink on acceptance and on rejection; absence calls nothing);
  `packages/tests/shared-web/messages/browser-resync-recovery.test.ts` (once per track; a new epoch
  re-arms; no owner → no invocation, diagnostics only); the public API snapshot.

**D8 reuse inspection.** The inbound runtime's optional-dependency pattern (`canDispatchMessage`,
`isRoomPeerPresent`); the typed channel registry; `LatestRepository`; the browser ALM diagnostics port.

- [ ] Steps 1–2: failing tests, red. Step 3: the cursor and the runtime sink. Step 4: the browser owner
      and the public type. Step 5: format; focused, `packages/tests/shared-web/messages`,
      `packages/tests/shared/alm/inbound` green; the public API snapshot and bundle boundary tests;
      pins; typechecks; bundles (raise a crossed budget to the next whole KiB).
- [ ] **Step 6: Commit.**

```text
Invoke a channel's recovery owner once when its track needs resynchronization

A typed channel may declare recovery.onResyncRequired(cursor). When the
inbound runtime accepts a message resync-required, or an ordered release is
rejected, it hands the message and a bounded cursor (ordering key, sender,
epoch, last contiguous and expected sequences, the observed sequence, the
carrier) to the composition's sink; the browser's resync recovery invokes
the channel's owner once per ordering track per runtime and states
recovery-owner-invoked on the diagnostics port. A new epoch re-arms the
track. Without an owner the message is dropped as before. The WS server
declares no owner.

D8 reuse: the inbound runtime's optional dependency pattern, the typed channel registry, LatestRepository for the once-per-track mark, the browser ALM diagnostics port.
```

---

### Task 6: The lane: `ordering-gap-repair`, `repair-exhausted`, the owner in `ordering-resync`

**Files**

- Create: `scenarios/ordering-gap-repair.ts` — the sender holds its carrier for seq 2 with the native
  hold, sends 1, 2, 3 (`at-least-once`, an ordering key); the receiver NACKs the range `2-2`
  (`al.control.nack.v2` admitted at the sender); the sender retransmits; the receiver delivers 1, 2, 3 in
  order and no fourth; over every carrier.
- Create: `scenarios/repair-exhausted.ts` — the hold stays on every retry; after `maxRepairs` the
  sender's handle reads `skipped`/`repair-exhausted`; the receiver got only seq 1.
- Modify: `scenarios/ordering-resync.ts` — the receiver's channel declares the owner (a harness-side
  owner the page installs on its generic room channel, recording to the diagnostics port); the cell waits
  for `recovery-owner-invoked` once with `expectedSeq: 2`, `observedSeq: 300`.
- Modify: the catalog, the Hetzner withholding (R-R1-9), the control-server fixture (ranges in its
  NACK model, the owner event), the harness docs, `apps/rallar-black-box` page if the owner installation
  needs a command field (`messages.subscribe` option `recoveryOwner: 'record'`).
- Tests: `packages/tests/shared-test/alm-conformance-ordering-repair.test.ts` (new) pinning the three
  scenarios' command names and assertions; the manifests `--check` byte-identical.

- [ ] Steps: failing pins; red; scenarios; fixture; docs; format; focused green; `deno test` on the
      fixture from the repo root; manifests check; commit.

```text
The lane repairs an in-window gap by range, states exhausted repair and observes the recovery owner

ordering-gap-repair holds the sender's second frame, sees the receiver's
range NACK admitted at the sender, the retransmission, and in-order delivery
of all three over every carrier; repair-exhausted keeps the hold through the
budget and reads skipped/repair-exhausted on the handle; ordering-resync
installs a recording owner on the receiver's channel and reads
recovery-owner-invoked once with the cursor. Hosted manifests 18 and 22
withhold the new cells and stay byte-identical; the control-server fixture
models ranges and the owner.

D8 reuse: the native hold, the ordering-resync waits, the catalog and withholding of I2b's cells; no new command kind beyond the owner installation field.
```

---

### Task 7: Navigation maps and the API reference

The inbound and outbound READMEs (repair owners, the `repair-hint` row, ranges, paging, exhaustion,
the resync sink), the shared-web browser README (the recovery owner), `docs/rallar-api-reference.md`
(a "Ordering, repair and resynchronization" subsection: `seq`/`orderingKey`, the 256 window, ranges,
`resync-required`, the owner and its cursor, `repair-exhausted` on the handle), the harness docs
(`schema-and-capabilities.md`, `runtime-diagnostic-contract.md` for `recovery-owner-invoked` and the
`v2` ids), and the product description's `PLANNED — R1` paragraphs become `CURRENT — R1`. One commit.

---

### Task 8: Close

Pins unchanged and bundles measured; the static merge bar (typecheck, build, changed-range gates,
reachability, dprint, manifests); the three-seat final review (product, harness, code quality) with
one fix wave; push; the Branch Release Gate, the API gates and CodeQL green on the code head; hosted
manifests 18 and 22 from the branch as regression reads; the PR body (Goal, Changes, Public surface,
Acceptance, Validation with every red named, Rulings, Corrections, Limits, Risk and rollback,
Follow-ups); the last commit records "Delivered (R1, <head>)" on the roadmap's release map row and
deletes this plan file.
