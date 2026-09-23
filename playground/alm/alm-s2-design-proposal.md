# ALM S2 design proposal — one identity and receipted audiences

Prepared 2026-09-22 against merged `main` `5fbf9a165` (F2c, PR #581), after S1 merged as `f82c64e23`.
Read-only survey and proposal; section 4's questions are open and their answers are the maintainer's.

## 1. The problem

S2's roadmap outcome (`alm-improvement-plan.md:452-460`) names a session-logical inbound namespace,
ACKs carrying origin and logical recipient, an audience frozen at admission with retry to missing
recipients only, and the carried-in `not-yet-in-sync` retention. Grounding those against this checkout
produced four findings; the first is not in the roadmap and outranks the rest.

### 1.1 The hosted `delivery-lifecycle` intermittent is a receiver-side drain-scheduling defect

S1 merged with two hosted reds on its own new scenarios, recorded and not diagnosed. They are one
defect and it is not message loss: in every failing cell the receiver logs `admission-outcome
outcome=committed reason=admitted` for the `msgId` the sender committed, and the delivery is then lost
between that commit and the page.

The mechanism is the work batch. `ALWorkHandler` runs a batch's claims strictly serially
(`al-work-handler.ts:358-367` iterates `selection.claims` awaiting `runOne`) and the batch duration _is_
the rotation cadence, since the inbound rotation runs one batch per engine round
(`inbound/al-inbound-message-runtime.ts:223`, `services/InboxOutboxEngine.ts:12` at 3 000 ms). A claim
set mixes two effect kinds three orders of magnitude apart in cost: a `dispatch-local` claim — the page
delivery the caller waits for — settled in **0–501 ms in every one of the twelve hosted cells**, while each
`send-control` claim (ACK, NACK, repair) performs a full outbound AL IndexedDB commit _inside_ the inbound
drain and cost **689–1 187 ms green against 1 508–18 115 ms red**
(`.superpowers/s2-hosted-lifecycle-diagnosis.md` §2.6, §4.7).

So a delivery waits a whole drain cycle — 7–23 s hosted — and which budget breaks depends on where the
cycle boundary falls, which is why the failing step looked non-deterministic: it is a monotone function
of the receiver's `send-control` median across twelve cells on three heads, without exception (§2.6).
`f33dd8118 / rtc` shows it directly — the batch starts at 24.05 s, runs `al.control.repair.v1` and
`al.control.ack.v1` (its own commit 4 050 ms), then reaches `dispatch-local` at 32.88 s, so 5.9 of the
8.8 s sat inside the batch ahead of the claim while `queueWaitMs` reported only 2 670 ms, because it
measures `batchStartedAtMs − dueAtMs` (`inbound/al-inbound-message-runtime.ts:391`). In the three
total-loss cells only **two** drains ran in the window: the admission landed 0.33 s after the second
batch's claim set was fixed and no third batch began (§3.A).

Five rival explanations are ruled out with evidence (§5): the supersedence hold does not race the
replacement; no ALM message is admitted `not-yet-in-sync` in the corpus; nothing expires by TTL; the
receiver's selectors match wherever a page event exists; the RTC lane closes only _after_ the loss. One survives as a **variant** (§6 alternative 1): the receiver's `typeId=rtt` outbound
commits rose from 551–631 ms to 1 874–5 813 ms and are the only high-frequency non-ALM traffic on the
per-session outbound commit lock the `send-control` effects need. If that term dominates, the fix is to
keep RTT probes off the durable AL commit path.

**The hypothesis is strong but not confirmed by a one-variable run**, because `queueWaitMs` collapses
the reservation wait and the intra-batch wait into one number — precisely the discrimination needed. The
diagnosis names the smallest confirming instrumentation (§6): per `dispatch-local` effect record
`dueAtMs`, the batch's `startedAtMs` and the claim's own `startedAtMs`, plus the ordered `effectId` list
the batch reserved and a witness for an inbound round that finds a row still unreserved.
`claimStarted − batchStarted` dominating means intra-batch serialization; `batchStarted − dueAt`
dominating means round scheduling. It is an observation only, batched into the existing `effect-drain`
payload (`inbound/al-inbound-runtime-diagnostics.ts:30-46`) and never relayed per claim — a per-claim
relay is itself a measured per-operation cost in the lane.

### 1.2 Cross-carrier dedup does not exist by construction

Inside one inbound store every key is already session-logical, none carrying a carrier component: the
message owner and canonical message (`inbound/al-inbound-source-validation.ts:69-71`,
`al-inbound-canonical-message.ts:31-33`), dedup under the default `msg-id+sender` algorithm
(`al-inbound-admission-store.ts:860-862`, `al-contracts/al-policy.ts:773-781`), the ordering track key
(`al-contracts/al-runtime.ts:66-74`), supersedence (`:868-874`) and the control histories (`:1009-1015`).

The split sits one level up, at the **namespace**: the browser composes one inbound store per carrier,
`browser:browser-ws-client:${sessionId}` and `browser:browser-rtc-rx:${sessionId}`
(`browser/al-runtime/browser-al-runtime-identity.ts:12-16,18-22`, consumed at
`browser-al-runtime-stores.ts:97,111`), resolved as two independent instances with no shared identity
(`:135-151`). The keyspaces are disjoint, so the dedup and owner rows an RTC admission writes are
invisible to a WS admission transaction: **the same logical message arriving over RTC and then over WS
fallback is delivered twice.** The outcome's "carrier-tagged control and ACK histories" is a change of
direction — today those histories are carrier-_blind_.

### 1.3 Receipts are greenfield, not a refactor

`ALAckMode` on the contract is `'none' | 'receiver' | 'all-logical-recipients' | 'group-leader'`
(`al-contracts/al-contract.ts:87`), but the implemented algorithm is
`ALAckAlgo = 'none' | 'hop' | 'subtree'` (`al-contracts/al-policy.ts:28`) and
`normalize-al-qos-policy.ts:453-462` collapses `receiver` straight onto `hop`. `ALAckPayload`
(`al-contracts/al-control.ts:35-40`) carries `ackedMsgId`, `fromPeerId`, `toPeerId`, `status`,
`observedAtEpochMs` — no origin and no logical recipient distinct from the acking peer. Pending-ACK
tracking is populated from next-hop peers only (`alm/al-runtime-state-stores.ts:95-96`,
`ws-queue-box-server-outbound-planning.ts:199-213`) and completion is satisfied once every expected
_hop_ has acked (`outbound/transition-al-outbound-pending-ack.ts:89-94`).

Relays do not forward far ACKs: when a relay's own subtree completes,
`computeCompletedAcknowledgementWork`
(`inbound/control/compute-al-inbound-control-admission.ts:123-151`) **originates a new** ACK stamping
itself as `fromPeerId`, so no origin survives a hop. The WS server has no ACK code at all — no
`ALAckPayload` or `AL_CONTROL_ACK_TYPE_ID` reference exists under
`packages/shared-server/rallar-system/websocket/` or `apps/api-v1/`; ACKs route as opaque payloads
through `publish-rallar-server-ws-message.ts:27-60`, and neither the `live-only` nor the `outbox` branch
aggregates them. The public WS send contract is equally bare: `RallarRtcSendInput` has `seq`/`orderingKey`
(`browser/messages/rallar-message-contracts.ts:47-55`) and `RallarWsSendInput` has neither (`:60-66`), so
no WS-carried AL message ever populates `msg.ordering` (`browser-rallar-message-sender.ts:140-175`).

### 1.4 The carried-in `not-yet-in-sync` retention is already implemented — and invisible

The carried-in item (`alm-improvement-plan.md:460`) says a receiver-side `pending` admission is
discarded and the sender's retry never fires. That is **stale as of F2/PR #559**.
`shouldRetryALInboundDelivery` returns true exactly for `dropReasonCode === 'not-yet-in-sync'`
(`inbound/al-inbound-effect-intent.ts:206-209`) and gates readiness, dispatch and forwarding at
`inbound/al-inbound-admitted-delivery.ts:88,222,277`, each returning `'retry'` so the message and its
durable effect are retained. The sender's NACK retry exists too:
`al-outbound-repair-admission.ts:65,74,109-120` schedules it through
`outbound/control/al-outbound-control-admission.ts:177`, committing an effect keyed
`['nack-retry', msgId, 'not-yet-in-sync', attempt]` (`al-outbound-repair-admission.ts:190-194`).

What is missing is evidence: `not-yet-in-sync` occurs **zero times in all twelve hosted cells**. S2 must
carry the retention through whatever namespace change lands and add a scenario that produces a
receiver-side `not-yet-in-sync` admission, or the behaviour ships untested for a second release. The
producing conditions are reachable: a missing room snapshot, an unobserved peer session, a
`minSnapshotVersion` floor above the local version, or a lagging relay edge
(`multicast/rtc-room-snapshot-admission.ts:48-102,160-232`, plan at `:108-134`).

## 2. The slice as three PRs

D6 makes medium the default and allows one large PR where a cutover genuinely couples contracts,
consumers and harness. S2's three concerns have different blast radii and only the third is such a
cutover, so the slice is three sequential, independently mergeable PRs rather than the single "large"
the release map carries.

### 2.1 S2a — delivery ahead of control

**Outcome.** A page delivery never queues behind a control send: the observed admission-to-page latency
becomes the dispatch's own cost (0–501 ms measured) plus one round's scheduling.

**Task 0, before any behaviour change:** §1.1's confirming instrumentation; the hosted run then decides
between the primary hypothesis and alternative 1, and the shape follows from it, not from this document.

**A. Dispatch-first ordering inside the batch.** The claim list already carries the discriminator:
`readALInboundPageEligibility` decodes every page row for its readiness and the claims are assembled from
it (`inbound/read-al-inbound-work-selection.ts:175,288`), so putting `dispatch-local` and
`release-buffered` ahead of `send-control` and `forward-message` is a sort of an existing list — no extra
read, no storage shape, no scheduling object — bounding a delivery's intra-batch wait to the other
deliveries in the same batch.

**B. A separate dispatch lane or rotation.** Claims delivery effects only, so a slow control send cannot
occupy the delivery cadence at all and §3.A's cross-batch loss goes with it — but it is a second scheduling
owner over one queue with its own lease interaction, the only shape colliding with the standing "no
additional queue, pending-work registry, or timer" rule.

**C. One outbound commit per batch for that batch's control sends.** Attacks cost, not order: today each
ACK, NACK and repair is its own full outbound commit inside the drain (4 050 ms for one in
`f33dd8118 / rtc`). Batching follows F2c's `releaseEntries` precedent, with no timer or coalescing window;
it shortens the cycle for everyone but does not stop a delivery sitting behind the commit.

**D. Keep RTT probes off the durable AL commit path.** Conditional on alternative 1: the receiver's
`typeId=rtt` commits are 6–7 per window at 1.9–5.8 s each on red cells and contend for the same
per-session outbound commit lock. If RTT dominates this is the smallest of the four.

|                                      | A ordering | B lane | C batched commit | D RTT off path |
| ------------------------------------ | ---------- | ------ | ---------------- | -------------- |
| Bounds intra-batch delivery wait     | yes        | yes    | partly           | indirectly     |
| Fixes the missed-claim-set loss      | no         | yes    | shorter cycle    | shorter cycle  |
| New scheduling owner / timer / queue | none       | one    | none             | none           |

**Recommended: A, then C if the cost term rather than the order term dominates, and D instead of both if
RTT is the hog.** B is held in reserve for the total-loss shape and needs an explicit waiver, because
that rule is a real constraint and A, C and D honour it. S2a earns its margin from the owner and never
from a budget: `CONNECT_READINESS_TIMEOUT_MS` 30 000, `CONFORMANCE_DEADLINE_MS` 18 000,
`NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500 and the 30/35 ms regimes stay as they are,
per the 2026-09-11 ruling in `docs/alm-observation-artifact.md`.

**Exit evidence.** The three total-loss cells deliver; hosted admission-to-page latency inside the green
band (2.3–6.4 s); `claimStarted − batchStarted` collapsed for `dispatch-local`; no budget, workload
constant or assertion changed; no schema-id move and no operation-count change on a default admission.

### 2.2 S2b — one identity

**Outcome.** One logical message has one inbound identity per session whatever carried it, so an
RTC-then-WS-fallback arrival deduplicates instead of delivering twice; control and ACK histories become
carrier-tagged deliberately; and §1.4's retention is carried through the new keys and finally proven.

**A. One merged inbound store per session (Q1).** Collapse `browser-ws-client:*` and `browser-rtc-rx:*`
into one session namespace; every key is already logical, so dedup, ordering, supersedence and owner rows
unify for free and carrier becomes a _field_ on the control and ACK rows
(`al-inbound-admission-store.ts:1009-1015`) — the only shape in which the outcome's wording is literally
true. Cost: the composition root changes (`browser-al-runtime-stores.ts:97,111,135-151`), both runtimes
share one store and therefore one commit fence, and per-carrier storage isolation is gone.

**B. Two namespaces plus a shared identity index.** Keeps isolation and the current fence granularity, but
a second source of dedup truth must be written and read transactionally across two IndexedDB keyspaces,
which F2c's per-row fence covers within a store and not between two.

**Recommended: A.** F2c already made the IndexedDB fence per-row over the attempt's read and write sets
(D17), so merging no longer means one global revision scalar serializing everything — the objection that
would have killed A a release ago is gone. Either shape moves the key layout, so
`AL_ADMISSION_SCHEMA_ID` bumps from `rallar-alm-2026-09-f2c`
(`alm/open-indexed-db-admission-database.ts:16`) and every existing browser database resets on mismatch
(`:55-71,86,113-126`; D3, D17) — no migration, no compatibility window, no fallback.

**Exit evidence.** The same logical message over RTC then WS reaches the page exactly once, in both
fallback orders, the second admission a duplicate no-op; a scenario producing a receiver-side
`not-yet-in-sync` admission, the retained effect delivering after the snapshot refresh and expiring
undelivered when it never lands; one `alm.storage.reset`; section 6's three storage pins re-measured.

### 2.3 S2c — receipted audiences

**Outcome.** An ACK names its origin and the logical recipient it speaks for; `receiver` is a real
logical ACK algorithm; the WS server aggregates a broadcast's ACKs and routes them to the origin
connection; the audience is frozen at admission; retry targets only the recipients still missing; WS
sends carry `seq`/`orderingKey` (D11).

**(i) ACK payload (Q2): additive optional fields, or a bump of `AL_CONTROL_ACK_TYPE_ID` to `.v2`.**
_Recommended: the version bump, no dual-decode window._ D3 says there are no real users and D8 forbids
retained legacy; an optional origin is exactly the "optional field whose absence has no distinct domain
meaning" the standard rejects — an ACK either knows its origin or the protocol cannot claim logical
receipts. Web and API deploy together from `main`, and an unknown type id is a typed rejection.

**(ii) `receiver` in `ALAckAlgo` (Q4): a fourth value, or `hop` reinterpreted for `receiver` mode.**
_Recommended: a fourth value._ Overloading `hop` makes one name mean two algorithms at every
expected/acked-peer site (`al-runtime-state-stores.ts:95-96`,
`transition-al-outbound-pending-ack.ts:89-94`). A distinct value stops
`normalize-al-qos-policy.ts:453-462` collapsing and types every unimplemented pair carrier-unsupported.

**(iii) WS ACK aggregation state (Q3): in-memory on the live-fanout path, or durable.** _Recommended:
in-memory for `live-only`, durable through AppInbox only for durable channels._ `live-only` performs no
AppInbox call today (`publish-rallar-server-ws-message.ts:46-58`) and counting a live broadcast's ACKs is
not a database mutation; the moment a receipt becomes a persisted _fact_ — which the roadmap requires for
durable channels with an offline origin — that write goes through AppInbox. The cluster WS outbox
precedent governs routing, not counting: an ACK landing on another instance reaches the origin through
the existing pub/sub fanout, never a new server-side registry.

**(iv) The frozen audience and its pin (Q7): `GroupSnapshot.group.snapshotVersion`, or a separate
audience version.** _Recommended: reuse the snapshot version_ — ALM consumes group authority and never
mints its own epoch. Freezing **at admission** from the channel's addressed sessions plus that identified
snapshot is the real behaviour change: WS live-only re-resolves membership at send time
(`publish-rallar-server-ws-message.ts:62-90`), WS outbox keeps a _rule_ and resolves ids at dispatch
(`ws-queue-box-server-outbound-planning.ts:199-213`), and RTC recomputes the tree every attempt
(`web-rtc-overlay-multicast-manager.ts:630-663`). Groundwork exists on the receiving side only: the server
stamps a frozen `groupRecipientPeerIds` onto `ws-client` ingress provenance
(`ws-queue-box-server-service.ts:415-417,469,619,662-670`, capped at 1 MiB in
`inbound/al-inbound-source-validation.ts:9-11,14-30`); the RTC variant carries a bare `peerId` (`:27-30`).
R2 keeps fencing and `rosterVersion`: S2c freezes _who_, not _when_.

**(v) Retry to missing recipients (Q6): through the relay tree, or point-to-point from the origin.**
_Recommended: through the tree, narrowed by the frozen audience._ Point-to-point would require the origin
to hold a route to every logical recipient — what the overlay exists to avoid — and would bypass the
relay's authorization. The tree keeps re-originating per-hop ACKs
(`compute-al-inbound-control-admission.ts:123-151`); what changes is that the origin's expected set
becomes logical recipients, so a retry addresses only those.

**(vi) WS ordering issuer (Q5): client-assigned, or server-issued per topic.** _Recommended:
client-assigned._ The inbound ordering track and buffered release are already carrier-agnostic
(`al-contracts/al-runtime.ts:66-74`, `al-inbound-admission-store.ts:464-483`), so client-assigned `seq`
is the path RTC uses and needs only the two fields on `RallarWsSendInput` and the threading in `sendWs`.
A server-issued counter is a new authoritative, durably serialized monotonic counter — none exists under
`packages/shared-server/rallar-system/websocket/` — and the standing direction forbids ALM minting
authority; R1 already owns gap recovery.

**Exit evidence.** Three peers, one designated origin: a broadcast whose ACKs the server aggregated
reaching the origin connection; one lost ACK retried to the missing recipient only, the confirmed one
untouched; a `receiver` ACK proven distinct from `hop` on both carriers; a join and a leave after admission
leaving the frozen audience unchanged; WS `ordering-resync` green; an unknown ACK version typed-rejected.

## 3. Recommendation

**S2a, then S2b, then S2c, as three medium PRs.** S2a first because it is the only one that changes what
the lane can measure: while a delivery can sit 7–23 s behind a control send, every S2b and S2c assertion
inherits the same intermittent and a red on a receipts scenario cannot be told from a red on the drain.
S2b second because S2c's ACK rows and frozen-audience provenance land in the keyspace S2b re-namespaces.
S2c last because it is the genuine contracts-plus-consumers-plus-harness cutover, and the only one for
which D6's large-PR allowance could be claimed.

Constraints that bind all three:

- **No migration** — reset-on-mismatch is the only lever (D3, D17); S2b bumps `AL_ADMISSION_SCHEMA_ID`,
  S2a and S2c only if they add a persisted shape. **No new third-party dependency** (D8).
- **No new timer, queue or registry beyond what the outcome needs.** S2a shape A adds none (it orders a
  list already built), C adds none (F2c's batched release is the precedent), D removes work from a lock;
  **B adds one and needs an explicit waiver.** S2c's WS aggregation reuses the existing fanout split.
- **Harness budgets fixed:** `CONNECT_READINESS_TIMEOUT_MS` 30 000, `CONFORMANCE_DEADLINE_MS` 18 000,
  `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500, regimes 30/35 ms.
- **Bundle ceilings** 213 KiB brotli facade (`shared-web-browser-bundle-boundaries.test.ts:42-46`, measured
  212.299) and 271 KiB headless (`headless-bundle-boundary.test.ts:60-62`, measured 270.020), raised only
  by the next-whole-KiB rule with the measured figure recorded.
- **New shared files under `packages/shared/alm/delivery/`**, which holds only `al-delivery-lifecycle.ts`
  and `compute-al-delivery-lifecycle.ts`; `al-inbound-admission-store.ts` is already 1 015 lines, so
  S2b's key work splits it rather than grows it.
- **S1's handle is the surface receipts extend, additively.** `ALDeliverySettlement` and the hop lists
  get logical-recipient evidence _beside_ them, never renamed — AR Eye Hunter's match capability reads
  `confirmedHopPeerIds` today (D9, D12). `rallar.realtime` stays untouched (D15). The observation
  artifact's inbound block, which F2c taught to decode the inbound topic, is the acceptance instrument.
- **S2 pre-empts nothing.** R2 owns membership fencing and `rosterVersion`; A1 owns principal, world, all
  and fixed audiences; A2 owns leader ACK and exclusive ownership; I1 owns correlation and trace.

## 4. Maintainer decisions (2026-09-23)

The fourteen questions this section carried were settled with the maintainer on 2026-09-23, together
with the slice's split into three PRs; the roadmap's decision record holds them as D18 to D31.

1. **Three sequential PRs (S2a drain, S2b identity, S2c receipts) in that order, and may S2a merge before
   the drain hypothesis is confirmed hosted?** Split into three sequential PRs in that order, and S2a
   merges only after the hosted one-variable confirmation. This keeps a scheduling fix from being
   re-coupled with a schema move and a wire cutover, so a red localizes to one PR instead of a reordering
   landing that fixes nothing because RTT was the hog.
2. **Which drain shape?** Shape A — dispatch-first ordering inside the batch — is used now, with C or D
   decided by Task 0's reading and B not chosen. This addresses §3.A's missed-claim-set loss as a list
   ordering rather than adding a second scheduling owner over one queue.
3. **Merge the two inbound stores, or keep two plus a shared identity index?** The two inbound stores
   merge into one per session, with carrier a field on the control and ACK rows. This keeps dedup truth
   inside the one IndexedDB keyspace F2c's per-row fence actually spans, instead of splitting it across
   two keyspaces behind a shared index.
4. **Additive ACK fields or a wire version bump?** The ACK payload takes a wire version bump
   (`al.control.ack.v2`) with no dual-decode window. Origin and logical recipient are required from the
   cutover, so a receipt is never conditional on an optional field whose absence carried no domain
   meaning.
5. **`receiver` as a fourth `ALAckAlgo` value, or a reinterpretation of `hop`?** `receiver` is a fourth
   `ALAckAlgo` value. This keeps one name meaning one algorithm at every expected/acked-peer site, so the
   conformance matrix row closes honestly.
6. **Where does broadcast-ACK aggregation state live?** In memory for `live-only` channels, durable
   through AppInbox only for durable channels. This avoids a mutation on every live broadcast ACK, which
   that path has never had, while keeping a durable receipt from being lost when the origin is offline.
7. **WS `seq`/`orderingKey` client-assigned or server-issued?** Client-assigned. This avoids a new
   authoritative monotonic per-topic counter that would need durable serialization, against the standing
   direction and a much larger S2c.
8. **Missing-recipient retry through the relay tree or point-to-point?** Through the relay tree, narrowed
   by the frozen audience. This keeps the origin from needing a route to every logical recipient and
   preserves the relay's authorization.
9. **Frozen audience pinned on `GroupSnapshot.group.snapshotVersion` or a separate audience version?**
   Pinned on the existing snapshot version. This avoids a second monotonic authority counter inside ALM
   bought to freeze _who_ without pinning _when_ — a separation R2 needs, not S2.
10. **Should a replacement's admission settle its superseded predecessor synchronously in the same
    commit?** Yes — settled synchronously at the replacement's admission, in S2a. Today `superseded` is
    computed only when the outbound drain next attempts the old send
    (`outbound/compute-al-outbound-dispatch.ts:203-205`), waiting on a drain cycle plus the QoS policy's
    `retryTracking.retryDelayMs` (`outbound/al-outbound-message-effects.ts:214,333`); settling it
    synchronously fixes the diagnosis's C-class failure (§3.C) in S2a instead of leaving the 3 s
    `observe-superseded-3` budget a bet on an unstated backoff.
11. **May a hosted recipe poll `acknowledged` at all?** No for the cross-page round trip — hosted recipes
    observe the receipt on the receiver, where it is local, and correlate afterwards. The hosted control
    had passed `observe-acknowledged-1` at 10 004 ms against a 10 000 ms budget, zero margin in the
    passing cell; removing the cross-page wait stops `ws` proving less than `rtc` by asserting only the
    sender-local `transport-accepted` (`create-alm-conformance-recipes.ts:450-452,578-580`).
12. **Does acceptance require a third agent role?** Yes — `AlmConformanceRole`
    (`create-alm-conformance-recipes.ts:37`) gains one and the Hetzner catalog a three-agent entry beside
    the hardcoded two-agent one (`hetzner-alm-manifest-entries.ts:34-64`). This is what lets one origin
    and two recipients be proven at all, inside the generator's carrier expansion and shared registries
    rather than a hand-written recipe that proves one carrier and drifts.
13. **Should this proposal pre-declare the new row and operation counts for the three moving pins?** No —
    the pins are named (`al-storage-snapshot.test.ts:105-160`, `al-indexeddb-operation-counts.test.ts`,
    `inbound/al-inbound-admission-transactions.test.ts`, all moving under S2b) and the implementation
    measures and records each. This avoids a wrong pre-declared constant reading as a regression at
    review time.
14. **Are the two open hosted reds on S1's scenarios (`delivery-lifecycle`, `delivery-reload`) S2a's
    acceptance criterion?** Yes — S2a is done when both run green hosted in a regime with a same-regime
    green baseline, and not before. This stops the reds carrying into S2b and S2c the way they carried
    from S1 into S2, and ties the lane's return to `test:ci` to real evidence instead of an undiagnosed
    intermittent.

All fourteen matched the proposal's recommendations; the S2a plan argues from these and from the
diagnosis.

## 5. Acceptance evidence

Read from `alm-observation/<carrier>-<scope>.json` per cell, under the regime rule: a red counts only
against a same-regime green baseline.

**S2a.** The `rtc` cell's `effect-drain` block, with the new per-`dispatch-local` split showing
`claimStarted − batchStarted` at or near zero where it was 5.9 s (`f33dd8118 / rtc`), and the `send-control`
claim median beside it whether or not it moved — under shape A alone that median stays in its red band
(1.5–18 s against 0.7–1.2 s green) and the delivery still arrives, which is the point. Sender-commit to
receiver-page latency in the green band (2.3–6.4 s) on all three carriers against the failing 8.5 s–∞;
drain count back to 5–7 from 2; `delivery-lifecycle` and `delivery-reload` green at the unchanged
3 / 10 / 27 s step budgets; F2c's inbound release median 525–908 ms and pending share 6–11 % unregressed.

**S2b.** One `admission-outcome committed/admitted` and one `not-handled/duplicate` for the same `msgId`
in both fallback orders, with exactly one page dispatch — keyed on `msgId`, because `claim-settled` carries
`typeId: null` for `dispatch-local` by contract (`inbound/al-inbound-runtime-diagnostics.ts:54`) and the
artifact analysis' `typeId` filter silently hides every page dispatch today. One `alm.storage.reset` on
the schema-id move and none after. A `not-yet-in-sync` verdict in the corpus for the first time on an
`alm.conformance.*` typeId, with the retained effect's later delivery. The three moved pins re-measured,
and one default send's and admission's operation counts unchanged against `5fbf9a165`.

**S2c.** Logical-recipient confirmation complete for a broadcast the server aggregated, the origin
connection named; one lost ACK retried to one recipient with the other's confirmation untouched and the
retry's target set recorded; a `receiver` ACK whose payload carries an origin distinct from `fromPeerId`; a
WS `ordering-resync` cell green with client-assigned `seq`; a join and a leave between admission and
completion with the frozen audience unchanged. Both bundle figures in the PR body; `deno task check` and
`test:deno` green, since a shared type the api-v1 surface sees changes.

All three: `test:repo-governance`, the public API snapshots, the bundle-boundary test and
`check:browser-bundles`, `check:repo-style:changed` against `origin/main`, and no new
`file.cognitive-load` pin under `packages/shared/alm` or `browser/messages`.

## 6. Rough task decomposition (for sizing only)

**S2a — medium, ~10-15 files.** (0) Drain instrumentation and the hosted confirming run. (1) Claim
ordering in the inbound selection. (2) The per-batch control-send commit, if chosen. (3) The RTT commit
path, if chosen. (4) Question 10's synchronous `superseded` settlement. (5) The artifact analysis'
`typeId` filter removed, and the `send-control` effect id correlated to the message it acknowledges —
today it is suffixed with the _control_ envelope's `msgId`
(`inbound/prepare-al-inbound-commit-bundle.ts:74`). (6) The inbound README's drain section. **Pins that
move:** the inbound diagnostics contract document, the observation snapshot decoder, and the inbound
transaction-shape pins if the commit shape changes.

**S2b — medium, ~20-25 files.** (1) The merged session namespace and its identity derivation. (2) One
inbound store per session in the composition root. (3) Carrier as a field on the control and ACK history
rows, split out of `al-inbound-admission-store.ts`. (4) The schema-id bump and its reset proof. (5) The
`not-yet-in-sync` scenario. (6) The cross-carrier duplicate scenario in both fallback orders. **Pins that
move:** `al-storage-snapshot.test.ts:105-160`, `al-indexeddb-operation-counts.test.ts`,
`inbound/al-inbound-admission-transactions.test.ts`, the schema-id constant's test, and the public API
snapshots if store-id helpers are exported.

**S2c — large under D6's cutover allowance, ~35-45 files.** (1) `ALAckPayload` v2, the old type id
rejected. (2) `ALAckAlgo` gains `receiver`, with the QoS normalization and every carrier-unsupported pair
following. (3) Expected sets become logical recipients at dispatch, across the RTC overlay and the WS
server planner. (4) The frozen audience at admission, the RTC source variant gaining the provenance the WS
one has. (5) The WS server's ACK aggregation and origin routing. (6) Retry narrowed to missing recipients.
(7) `RallarWsSendInput.seq`/`orderingKey` and the `sendWs` threading. (8) Logical-recipient evidence beside
the hop lists on the handle and on `BlackBoxRallarDeliveryObservation`
(`black-box-rallar-operation-contracts.ts:296-308`). (9) The third generator role and the three-agent
Hetzner entry. (10) The AR Eye Hunter match-notification consumer proof. **Pins that move:** both bundle
ceilings, the public API snapshots, the storage snapshot, the api-v1 Deno check, and the ACK fixtures.

**Verification note.** Every claim was checked against `5fbf9a165`. Two corrections to the inputs: the
carried-in `not-yet-in-sync` item is already implemented on both sides and needs evidence, not code
(§1.4), and "carrier-tagged control and ACK histories" describes a change of direction, since those
histories are carrier-blind today (§1.2). One claim was strengthened: the claim list is built with each
effect's kind already decoded (`read-al-inbound-work-selection.ts:175,288`) and run strictly serially
(`al-work-handler.ts:358-367`), so shape A is a list ordering, not a scheduler change — but the hypothesis
still awaits its one-variable run.
