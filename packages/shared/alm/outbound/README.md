# Outbound admission and durable replay

[`ALOutboundMessageRuntime`](./al-outbound-message-runtime.ts) is the public
lifecycle boundary: it enqueues, accepts control messages, claims work, and routes
each claimed durable effect to the owner that runs it. It never sends or mutates
admission state itself. [`ALOutboundDispatchAdmission`](./al-outbound-dispatch-admission.ts)
owns optimistic read/compute/commit. Nothing serializes a sender's commits, in a tab or across tabs:
every commit is fenced on the sender's one version, and a commit whose write lost that fence to
another commit of the sender reads, decides and writes again at once, `AL_OUTBOUND_COMMIT_ATTEMPTS` (3)
attempts in all, the last after a jittered 10 ms pause; past the bound a send retains its request as
a pending admission and any other commit leaves its claim to its work retry (see
[Commit conflicts](#commit-conflicts)).
[`ALOutboundRepairAdmission`](./al-outbound-repair-admission.ts) owns control
acceptance, the ACK-timeout schedule, and the not-yet-in-sync retry schedule; it
commits new bundles and never sends.
[`ALOutboundRepairRetransmission`](./al-outbound-repair-retransmission.ts) owns the
repair-by-hint path and commits through dispatch admission. Without a repair planner it
retries a room-scoped message along the sender's own hop only: every peer still owed, or the
hop that asked for the hint, must be the sender's own hop, so a retry resends the same frame
to the same hop and never widens a room audience. A peer is the sender's own hop from either of
two sources: the captured plan's next hops (`ackTracking.nextHopPeerIds`), or the hops the
composition declares every frame passes through (`ALOutboundMessageRuntime.Dependencies.hopPeerIds`).
A WS client's unicast addressed to the server, and its `hop` or `subtree` room send, track the
server as a next hop; a `receiver` or `leader` room send, or a `receiver` session unicast, has no
client-tracked hop: the WS client holds a first-hop wait for it until the server first answers for it
([Server receipts on WS](#server-receipts-on-ws)), and from that answer on it is the server's to retry. The WS client also
names its server as its
composition's hop, so an ordered at-least-once room send at the browser's defaults, whose effective
`ack` is `none` and tracks no receipt, still has the server's gap NACK served along that hop; the
RTC compositions and the WS server declare no fixed hop. Control acceptance applies the same
exemption: without a repair planner, a room-scoped gap NACK, repair control or `not-yet-in-sync` NACK is admitted
only when its requester is the sender's own hop, so the server's gap NACK to its own WS client commits the
repair hint that retransmits the missing ranges along that hop, and its `not-yet-in-sync` ends the client's first-hop
wait and schedules no retry. The WS server repairs its own
publications through its repair planner instead: a WS client's gap NACK on a track whose sequences
the server minted pages the missing sequences from the server's ordering index and resends each to
that requester alone, and only when the requester is in the audience the resent message was admitted
to: a peer the receipt expects, or a session of the row's captured `admittedAudience`
([`isALOutboundExpectedRepairPeer`](./control/is-al-outbound-expected-repair-peer.ts)), so a session that joined
later is never served (D43, D153). The same rule serves a WS session's gap NACK on a browser-origin track the server
relayed, which names the track's origin: the server's inbound authorization admits it for a requester inside that
row's `admittedAudience` and refuses one outside. The budget counts per requester: each receiver that misses a
sequence may spend `maxRepairs` attempts on it, and the request past one requester's budget ends the message for every
receiver (below). Only the `outbox` fan-out mints on the server; a keyed publish without a sequence at `live-only` or `none` is
refused. Each browser carrier mints its own keyed room sends ("Server-minted sequences" below).
Application consumers select an ordering key for each independent stream and advance its epoch when the stream restarts.
[`isALOutboundOwnHopPeer`](./is-al-outbound-own-hop-peer.ts) is the one predicate both owners share.
Control acceptance also knows who spoke a recipient's control, as the composition states it in
`ALOutboundMessageRuntime.Dependencies.recipientAuthentication`: the WS client and the WS server state `carrier`, whose
socket authenticates its peer; the RTC overlay states `signature`. Under `signature`, a peer ACK or NACK about a
`receiver` or `leader` send that speaks for a recipient the receipt counts is verified in the read phase
([`readALOutboundRecipientProof`](./control/read-al-outbound-recipient-proof.ts)) against the key the sent row froze
for it (`receiptProofKeys`; a row that froze none keys nobody). One that speaks for a peer the receipt does not count
is a hop fact: carrier-authenticated when that peer is its own sender, so the validators judge it as they judge any
hop's control, and refused `unknown-key` when it speaks for another. A refusal (`missing-proof`,
`unknown-key`, `key-mismatch`, `invalid-signature`) is an `unauthorized` issue and a `rejected` admission carrying
`proofRefusal`, which the control-admission diagnostic states as `proofRefusal`, `claimedRecipientPeerId` and
`channelPeerId`; nothing is counted, written, retained or answered. A repair request, and a `hop` or `subtree`
receipt, carry no proof and are admitted as before; a control addressed to another owner than the sent row's is not
judged, and is refused for its address alone. The RTC planner states the keys, each counted recipient's
`{ keyId, publicJwk }` from the room snapshot, on the plan that freezes the audience (at admission when the snapshot
is cached, at the dequeue that first has it otherwise), and the sent policy adopts them once and never replaces them;
[`computeRtcReceiptKeyRefusal`](../../multicast/receipt-proof/compute-rtc-receipt-key-refusal.ts) refuses that
plan's leg `unsupported`, so a fallback carrier takes it, when the page holds no WebCrypto, a counted session the
snapshot names live registered no publication key, or a unicast names no room; a send that counts nobody is not
judged.
A hint names what is missing as inclusive `ALSeqRange` `{ from, to }` ranges (`missingRanges`, at
most `AL_MESSAGE_RESOURCE_LIMITS.repairRanges` = 128, the most a 256 window can hold), as the
`al.control.nack.v5` and `al.control.repair.v3` payloads and the planner's NACK plan do;
[`decodeALSeqRanges`](../../al-contracts/al-seq-range.ts) is the one bounded range decoder for the
wire and the rows. A NACK and a repair request naming the same gap are one hint: the gap --
requester, ordering track and ranges, the ranges joined as `from-to` with `,`, then the request number -- names the hint's
effect row ([`toALOutboundRepairHintEffectId`](./to-al-outbound-effect-id.ts)), never the control
that reported it, so the second control is absorbed by the write-if-absent effect store rather than
filed again. Both controls carry the same `gapRequestNumber`, 1 for every report an arrival causes and one more at
each renewal of a gap that stands ([inbound README](../inbound/README.md), "Ordering gaps and resynchronization"), so a
renewal is a new hint; a hint names the number exactly when it names a missing range, so the hint of a gap NACK that
names no range carries none. A relay's gap NACK for a recipient below it also names that recipient
(`logicalRecipientPeerId`, absent when the requester is the recipient): under a logical receipt the origin admits it
from a next hop for a recipient the receipt still owes, and for a room send also from a relay the message never went
through, a new parent after a reshape, once its repair authority planned a repair to that relay (6d); under `hop` and `subtree` it refuses it as one hop speaking for
another, so relayed gap recovery stays closed there (D582, D706). The responder admits the copy on that recipient while sending it to the
relay, and the recipient joins the hint's identity, so each recipient a relay reports one gap for is its own
hint and a hint without one keeps its identity. One execution of a hint retransmits at most
`AL_MESSAGE_RESOURCE_LIMITS.repairPageMessages` (32) sequences, ascending across its ranges, and
re-commits the remaining ranges as one follow-up hint whose identity is those ranges, so a wide gap
costs a bounded page of indexed reads and dispatch commits per execution and no page is served
twice. The repair budget (`maxRepairs`, 4 by default for an at-least-once multicast: the first report and three
renewals) is charged by dispatch admission under the sender's fence, once per attempt identity, so a hint re-executed
after a conflict or an expired lease finds its sends committed and charges nothing more. A ranged hint's sequences are
charged per gap -- requester, ordering track, sequence, recipient and request number
([`toALOutboundRepairGapAttemptIdentity`](./to-al-outbound-effect-id.ts)) -- so a later frame's report of the same
gap, which repeats its number, charges nothing, and a renewal is a new attempt that writes a frame; a hint without a
track or ranges keeps its own identity. Each requester has its own count in the message's one repair-attempt row
(`attemptsByRequester`), keyed by [`toALOutboundRepairRequesterKey`](./to-al-outbound-effect-id.ts): the receiver that
misses the sequence, which is the logical recipient a request names or else the requesting peer, so a relay that
carries a request earns it no second budget. The charge is
[`computeALOutboundRepairAttemptCharge`](./repair-budget/compute-al-outbound-repair-attempt-charge.ts); a message can
cost its requesters times the budget in frames, and each resend goes to its requester alone. At the defaults no gap
request on one route is past a budget; a send that lowers `maxRepairs` meets one, and so can a receiver reported both
directly and through a relay, whose two attempts per request number spend one budget. When dispatch finds a requester's budget spent it
answers `skipped`/`repair-exhausted`, and that commit ends the message: it marks the stored row ended and deletes the
open receipt with its timer, the first-hop wait with its timer and the repair-attempt row
([Receipt ends and the hand-over](#receipt-ends-and-the-hand-over)). Once it lands the retransmitter
settles the message with that verdict through the lane's settlement sink: the handle reads `failed` with
`failure.kind: 'skipped'` and `failure.reason: 'repair-exhausted'`, and the message's other receivers lose the
receipt's remaining retries.
[`ALOutboundMessageEffects`](./al-outbound-message-effects.ts) runs the three message-shaped effects
— `admit-message`, `dequeue-message`, and `send-prepared`.
[`ALWorkHandler`](../work/al-work-handler.ts) registers outbound work with the existing
[`InboxOutboxEngine`](../../services/inbox-outbox-engine.ts) through
[`ALWorkQueuePort`](../work/al-work-queue-port.ts). QueueBox owns durable reservation, release,
expiry, retry, and exhausted-attempt recovery. A queued native send retains its claimed work until
transport settlement; it does not block available peers or complete merely because the carrier
accepted local queue ownership.

## Private server receipt work evidence

[`ALOutboundReceiptWorkEvidence`](./lane/al-outbound-receipt-observation.ts) owns the
closed receipt/work snapshot for a decoded claim. WS-server construction installs
its optional `Capture` capability: the concrete `createALOutboundReceiptWorkEvidence`
function, the [batch observation resource](../work/al-work-batch-observations.ts) constructor
and the server observer. Browser composition installs none of these and the lane
imports only the evidence type, so receipt projection is outside browser bundles.
The factory reads readonly decoded facts, without policy, clocks, storage or sink calls;
the lane guards construction failure and still carries the batch deferral to transport.
The evidence captures the immutable receipt, worker, effect kind, attempt count and existing audit/batch/lease stamps;
message effects add the authority, actual admission return and known failure stage.
`effectLocator` hashes the exact effect/attempt id; `workLocator` hashes the exact
work key. They are compact diagnostic joins, not authority: raw identities may
contain session, trace or prepared-message data and are never published.

Capture-enabled [`ALWorkHandler`](../work/al-work-handler.ts) batches supply a
private observation deferral capability from that resource. The handler calls the installed class's `tryCreate` and owns when to call `publish`;
the resource guards its own construction and owns the callback array,
ordered reentrant drain and per-sink guards. Their references to the canonical
deferral/resource types are erased, so their two-way type dependency is not a runtime cycle.
The lane carries the deferral on the existing send
lifecycle to the WS recipient/cluster owner and registered publisher. Each producer
freezes its own facts before deferring the sink call. The handler drains that bounded
batch after release, timing, readiness/end and pending-commit scheduling, also on
failure; no new clock or storage read is made. Disabled batches create no capture
buffer. If an enabled batch resource fails to construct, the handler supplies the
resource's inert `discard` deferral: work/native/cluster diagnostic records are lost, never published
early or treated as negative delivery facts. Per-claim evidence construction
failure with a healthy batch still permits native diagnostics after release.
The installed canonical static methods are the verified capability; `tryCreate`
constructs the selected subclass through `new this()`. Arbitrary static overrides
are outside these guarantees.
A `callbackOutcome` is the callback's actual return or `threw`, never a
release-success receipt. A retained callback can settle and release later, outside
that batch; this server receipt transport currently returns settled results only.

The [WS server map](../../services/ws-queue-box-server/README.md#private-receipt-evidence)
owns the native, publisher and wrapper distinctions. Missing or lost evidence proves
no negative delivery fact, and producer clocks are not synchronized across processes.

## Construction and registration

WS client, WS server, and RTC multicast composition supply a completed admission
store, queue, clock, engine, worker identity, transport planner, and prepared
message decoder before constructing `ALOutboundMessageRuntime`;
[`createDefaultALOutboundRuntimeResources`](./create-default-al-outbound-message-runtime.ts)
is the named composition root that resolves the optional resources once. The
constructor builds its `ALWorkQueuePort`, asks the admission store for the scope's
[`ALOutboundControlAdmission`](./control/al-outbound-control-admission.ts), then
constructs dispatch admission, repair admission, repair retransmission, the
`ALWorkHandler`, and finally the message-effect owner. Registration does not invoke
any of them. `ready()` answers the durable lane's storage as a value before the first claim:
`ALStorageUnavailable` when its pair cannot open, recorded on the pair's health, and the next call
opens again; any other open failure throws. While its last open failed the lane starts no work
and its idle readiness probe answers no work without touching storage. Disposing the
runtime closes dispatch admission, removes its engine task, and aborts owned RTC queue
items; the same abort signal is what the effect owner reads as "disposed". A supplied
engine remains available to its other tasks; a runtime-owned engine stops. An
interrupted durable claim remains recoverable after its lease expires.

**One durable owner per session.** The resources carry `durableWorkOwnership`
([`ALDurableWorkOwnership`](../work/al-durable-work-ownership.ts)). The durable lane's work follows
it; the memory lanes always run their own pairs, and the checkpoint of the checkpoint lane follows it
(see "The checkpoint lane"). The default, `ALWAYS_OWNED_AL_DURABLE_WORK`, is the
server's, Node's and every runtime's whose durable store no other runtime drains, and keeps the
handler's construction-time registration. While another runtime of the session owns the work, the
durable lane's [`ALWorkHandler`](../work/al-work-handler.ts) joins no engine round, its `ready()`
runs no bootstrap batch, and a commit runs no batch: it is announced (`announceCommit`) under the
lane's work type, `toALOutboundWorkType(namespace)`, which every runtime of the session shares. The
lane still admits. When ownership turns true (once, never back) the handler
registers its task and runs the bootstrap batch once; that batch's first-batch report is the
takeover's recovery outcome. A row the previous owner held is recovered by the lease sweep of a later
batch, at its lease end plus at most 16.6 s, never sooner. The owner's lane hears every commit another
runtime announced for its work type (`onForeignCommit`) and runs it through `applyForeignCommit(rows)`,
the same `committed(rows)` its own commits take, so its batch claims the rows at once instead of at
its remembered answer's age bound; in the browser the announcement travels on the connect's session
channel ([`BrowserALSessionChannel`](../../../shared-web/browser/al-runtime/browser-al-session-channel.ts)).
The browser's value is the connect's
[`BrowserALDurableWorkClaim`](../../../shared-web/browser/al-runtime/browser-al-durable-work-claim.ts),
the second name on the lock port: `rallar:al-durable-owner:<applicationId>:<workspaceId>:<sessionId>`,
requested once per connect, never per send, and held until the connect ends; without the Locks API
every connect owns its work, as before. The claim hands a foreign commit (`applyForeignCommit`) to its
work type's listeners only while its connect holds the work, so a waiting runtime never runs one nor
announces it again. Its own `announceCommit` posts on the session channel, so a waiting tab's row
reaches the owner at once; where the browser has no `BroadcastChannel` it reaches no other tab, and
the row waits for the owner's readiness memory to age.

The transport decoding owners are
[`decodeALOutboundPreparedMessage`](./al-outbound-effect-validation.ts) for WS
client and RTC envelopes, and
[`decodeWsQueueBoxServerPreparedMessage`](../../services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts)
for the server's recipient/cluster-completion union. Prepared transport values
are reconstructed from a canonical envelope and compact persisted transport
descriptors. Admitted send-action replay does not regenerate its recipients or
policy by rerunning a planner.

## Store lanes and routing by durability

Each browser carrier runtime (the WS client's and the RTC overlay's) holds two store pairs (D54): the
IndexedDB pair its scope resolved before S3a, the durable lane, and a memory pair of its own
([`createBrowserALVolatileOutboundRuntimeStores`](../../../shared-web/browser/al-runtime/browser-al-runtime-stores.ts),
namespace `browser:<name>:volatile`), the volatile lane. `ALOutboundMessageRuntime` routes; each
[`ALOutboundStoreLane`](./lane/al-outbound-store-lane.ts) owns the admission, control and receipt
admission, repair retransmission, work handler and engine task over its one pair, all on the carrier's
shared engine. The WS server builds the runtime without a memory pair (`volatileStores: undefined`), so
every server message keeps its one backend.

- **Routing by durability.** An admission goes to the lane its plan's `lane` names, and every
  browser planner states `lane` as `resolveALOutboundStoreDurability(effective.durability.algo)`: the
  message's effective durability, except a first admission of its own room send that names an ordering key, which
  owns its track's sequence and names `durable` whatever its durability (`toALOutboundMintingPlan`). `local-outbox` and `local-inbox` name `durable` and go to
  IndexedDB; `volatile`, the default for every send that names none, goes to memory; `local-checkpoint`
  names `checkpoint` and goes to the checkpoint lane; a runtime without one sends it to its volatile
  lane, `durable: false`, and a runtime with neither memory pair (the one-lane Node compositions, whose
  server planner never produces a checkpoint plan) to its only lane, the durable one. A
  dropping plan names `volatile`. A captured policy row keeps only whether its copy outlives memory
  (`persist`), so a re-plan under it keeps its own lane when the two agree and reads `durable` or
  `volatile` when they do not. Reliability no longer implies durability: a default
  typed send is at-least-once, receipted and volatile (D2, D52), and a lane send that names no
  durability is volatile too (R-S3a-0). The plan is computed once and handed to that lane's admission. The admission verdict's
  `durable` says whether rows were persisted: the memory lane states every admission `durable: false`.
- **A `local-checkpoint` send carries no client sequence and asks for none.** A restored checkpoint could send a `seq`
  again for different content, so both browser planners refuse a `local-checkpoint` send that carries
  one, and a room send that names its ordering key alone (asking its outbound to mint from a head the checkpoint
  lane cannot keep), as `unsupported`
  ([`computeALOutboundOrderingRefusal`](./admission/sequencing/compute-al-outbound-ordering-refusal.ts)). A
  superseded unsent copy was never seen outside the runtime, so it passes.
- **Grouped sends.** A group whose members differ in durability commits as one group per lane: there
  is no cross-store atomicity. No caller mixes today; an ACK batch is all volatile.
- **Controls, receipts and retransmission** go to the memory lane, volatile or checkpoint, that owns
  the target message (a memory read each), else to the durable lane.
- **One cancel.** `cancel(msgId, traceId)` is runtime-wide: one set of send controls serves both lanes, and the
  lane that holds the message stores its end
  ([A cancel and a hand-over end the message](#a-cancel-and-a-hand-over-end-the-message)).
- **Only the durable lane admits foreign dequeue rows.** The volatile lane names no dequeue type and
  shares no store with another tab, since memory is per tab. A
  planner that returns zero prepared messages for a volatile message must settle it (drop code or an
  immediate zero-recipient receipt, as the RTC empty-audience plan does) — the volatile lane has no
  claimant for a `NEW` canonical row.
- **Eviction on the owner's round.** Nothing outside the lane touches the memory pair: session cleanup
  and a storage reset never reach it, and it dies with its runtime. The volatile lane (worker id
  `${effectWorkerId}/volatile`) sweeps its expired rows from its own work round, at most once per
  `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS` (60 s, the IndexedDB eviction's cadence) of its clock; no
  timer runs for it. Its message-owner and sent-message rows live for the message deadline plus the 30 s
  receipt grace ([`computeALReceiptRetentionExpiryMs`](../delivery/compute-al-receipt-retention-expiry-ms.ts), D74), the
  window in which a receipt or a late control about the message is still answered; the durable pair keeps
  them for `max(deadline, now + 1 h)`. A control that arrives after them finds no lane owning its message,
  goes to the durable lane and is refused there as a control about an unknown message. The control-history
  rows and a completed receipt row stop at the same deadline plus the grace on the volatile pair and keep 30 min
  (`controlHistoryTtlMs`, `durableEffectTtlMs`) on the durable pair; the per-origin version row keeps
  `versionTtlMs` (1 h) on both, since it fences every commit of its origin rather than one message.
- **Duplicate detection is per lane.** A msgId the memory lane admitted is invisible to the IndexedDB
  lane, and the reverse. That is sound because a message's durability is fixed by its policy, so one
  msgId always resolves to one lane. A caller that re-sent one msgId under another durability would get
  a second copy in the other lane whose receipt never completes, because every control for that id
  goes to the memory lane first. No caller does this.
- **Tracks do not span stores.** An ordering or supersedence track whose messages declare different
  durabilities is split between the lanes; no caller declares one that way.
- **A volatile admission never leaves the caller's turn.** It reads no IndexedDB,
  so it completes within the caller's microtask chain, and a loop of awaited volatile sends yields no
  task turn until it ends (R-S3a-7). A burst loop should yield or batch: the outbound claim order is
  the queue's own order, not a rotation across senders or tracks, so a backlog admitted ahead puts
  a later sender's send behind it. V1b-ii measured this and kept the order, since concurrent
  admissions interleave through the per-sender commit queue.
- **Every lane-emitted diagnostic names its lane.** `commit-phases`, `effect-drain` and
  `readiness-probe` carry a required `lane` (`ALStoreDurability`: `durable`, `checkpoint` or
  `volatile`) (R-S3a-15), so a reader of the runner's storage speed can leave the memory lanes out.

### The checkpoint lane

A carrier runtime given `checkpointStores` holds a third pair: a memory pair built as the volatile one
is, without the budget and with the memory retention rule, whose rows a checkpoint saves to IndexedDB
([`createCheckpointALOutboundRuntimeStores`](../al-runtime-stores.ts), built once per connect under the
connect's claim, which the pair's `checkpoint` port, an [`ALCheckpoint`](../checkpoint/al-checkpoint.ts),
holds). A `checkpoint` plan
(`local-checkpoint`) is admitted, dispatched, receipted and cleaned up from memory by the lane
`${effectWorkerId}/checkpoint`, in every runtime of the session.

- **Saved rows.** The checkpoint owns the pair's
  [`ALCheckpointDirtySet`](../checkpoint/al-checkpoint-dirty-set.ts) and its
  [`ALCheckpointWriter`](../checkpoint/al-checkpoint-writer.ts), which saves the dirty keys in one
  readwrite over `entries` and `alm-work`
  ([`IndexedDbAdmissionBackend.writeUnfencedMutations`](../indexed-db-admission-backend.ts), one
  `al-admission` `write`): the row shapes the durable pair writes, under the pair's own namespace
  (`browser:<checkpoint store id>`), which is also its canonical scope, so two memory pairs never save
  one row. The oldest unsaved change arms one checkpoint an interval after it; nothing runs while the
  pair is clean; one write is in flight; a completed write clears only the keys still at the revision it
  captured.
- **Owner only.** Only the runtime that owns the session's durable work (`durableWorkOwnership`) saves
  and restores the checkpoint. Another runtime's checkpointed sends run from its memory and its
  `admitted` verdicts read `durable: false`; what it changed is saved once ownership turns to it. A
  checkpoint lane's settlement is relayed to the session's other tabs as a durable lane's is.
- **Restore.** The lane's readiness restores before its first work batch: one `al-admission` `list`
  ([`IndexedDbAdmissionBackend.readNamespaceRows`](../indexed-db-admission-backend.ts) over
  [`readALWorkRowsInRanges`](../storage/read-al-work-rows-in-ranges.ts)) reads the pair's rows, and the
  live ones load into the memory pair without marking, keeping every key the pair already holds. A
  reserved row is claimed once its lease ends; a work row past its expiry is not loaded and is counted
  as expired. The first batch after the restore reports `restored` (or `expired-at-recovery`) under the
  checkpoint store's id. On takeover the restore runs when ownership turns true and wakes the lane. A
  store that cannot be read is stated on the checkpoint store's health, and the lane runs from memory.
- **Lag.** The checkpoint store's health reads `delayed` once a write failed (it is retried an interval
  later and named on the state) or the oldest unsaved change is two intervals old, a throttled timer; a
  timer a few milliseconds late states nothing. Past the recovery-lag bound it reads `failing` with cause
  `checkpoint-lag`; a completed checkpoint ends either. The lane keeps admitting from memory: the browser
  dispatch, which reads the store's health, refuses or downgrades a new checkpointed send while the store
  reads `failing`, for the lag or any other cause, as the channel's `onStorageUnavailable` says.
- **Flush.** `flushCheckpoint()` starts a checkpoint now, or right after the one in flight, and is never
  awaited: a write the page does not finish leaves the saved rows as they were.

The storage cost is pinned in
[`al-indexeddb-operation-counts.test.ts`](../../../tests/shared/alm/al-indexeddb-operation-counts.test.ts):
one durable send spends 10 `al-admission` and 9 `al-work` IndexedDB operations; one
volatile send beside a durable pair spends 0 `al-admission` and 0 non-probe `al-work` operations, and
so do `local-checkpoint` sends on the checkpoint lane, whose checkpoint is counted on its own: one
IndexedDB `write` per interval, whatever the sends changed, and none while the lane is clean. The
idle durable owner's probes (`work-page`, `work-probe`) are reported beside that zero, never inside it
(D55): a cold runtime's first volatile send runs the durable owner's one-time bootstrap batch over an
empty queue, which spends only probes, and its second send spends nothing. A queue read that reserves,
times out or finalizes nothing counts as `work-probe`; one that writes counts as the work it did
(R-S3a-11, R-S3a-13). An RTC origin alone in its room spends 0 `al-admission` and 0 non-probe `al-work`
operations on a volatile `receiver` send and states its complete acknowledgement at the commit
([`al-indexeddb-empty-audience-counts.test.ts`](../../../tests/shared/alm/al-indexeddb-empty-audience-counts.test.ts),
D75).

## The admission directory

[`admission/`](./admission) holds the state this scope persists and the transaction
that writes it. [`ALOutboundAdmissionStore`](./admission/al-outbound-admission-store.ts)
is the public port and owns the commit fence;
[`ALOutboundAdmissionReads`](./admission/al-outbound-admission-reads.ts) assembles
every read DTO; [`ALOutboundAdmissionMutations`](./admission/al-outbound-admission-mutations.ts)
turns each `ALOutboundAdmissionMutation` into the state write it names, checks the
guards that write carries, and applies it inside the transaction;
[`al-outbound-admission-keys.ts`](./admission/al-outbound-admission-keys.ts) owns
the admission key strings, and
[`al-outbound-ordering-track-keys.ts`](./admission/al-outbound-ordering-track-keys.ts) those of
one ordering track (its head, its messages by sequence, its recipients' sent positions);
[`ALOutboundAdmissionEffectStore`](./admission/al-outbound-admission-effect-store.ts)
owns durable effect rows;
[`ALOutboundDecisionReadSession`](./admission/al-outbound-decision-read-session.ts)
is the read session of a single send's decision, which answers a work row it already read from that
read; [`read-al-outbound-send-guards.ts`](./admission/read-al-outbound-send-guards.ts) reads the
guards a prepared send rechecks before its carrier runs; and
[`al-outbound-admission-validation.ts`](./admission/al-outbound-admission-validation.ts)
decodes the persisted snapshots. Every fence — the sender version, the message version, the pending-admission
row, an observed effect row, and a moved supersedence observation — resolves a conflict
the same way: the guard throws `ALAdmissionBackendConflictError` inside the transaction so
the backend aborts without writing, leaving every row at the revision and write token it
already had, and the store catches it at its public boundary and returns the typed
`'conflict'` result. A single send (`readOutgoingDecision`) reads its decision surface, decides on
it, and reads the effect rows and canonical pair its bundle's commit fences in one readonly session,
so its commit opens only the write phase's fence snapshot and the write; `commitBundle` without that
observation, and a group's `commitBundles`, read it in a readonly session of their own first; a group
reads the observations of all its bundles at once, so a backend that batches one turn's reads answers
the group in the rounds of one member rather than one member after another. Every observation is
re-read inside the write, however old it is. Only a write conflicts. A read chain's
expiry eviction that finds its row moved by another writer leaves the row to that writer and answers
from its snapshot (the inbound README's decision-surface section), so `ALOutboundControlAdmission.admit`
never loses an acknowledgement to a throw out of `readControlAdmission` or its effect read.

Each message has a version row, keyed by its origin and id as its receipt row is (D40,
`toALOutboundOriginMessageKey`). Every commit that writes one of the message's rows -- its owner, sent row, receipt,
repair count, first-hop wait or control histories -- moves that version, and fences on the version its read saw. A
bundle fences on the sender version too, because its decision reads rows other messages of the sender share: the
track head, the sent positions, the room sent floor and the supersedence latest. A peer control reads and writes only
its message's rows, so it fences on that message's version alone: a send, repair or control of another message of
the same sender never conflicts with it (ruling 24). So does a server receipt, unless it is an `admitted` receipt that
reads the shared-head rows, the sent positions and the room floor (ruling 26); a bundle states this as `fencesSender`,
and a bundle without it that writes a row the sender's messages share is refused. A commit that names several fences
writes them all; on PostgreSQL it writes every fence but the last alone, a compare-and-set in key order, then its rows
on the last, so two commits always reach the fences they share in one order; no row is locked explicitly (ruling 25).

A dequeued batch (`ALOutboundDequeuedAdmission.admitDequeuedMessages`) reads the same way before its commit.
Each row's gate and pending-authority wait run two rows at a time. Once every row has passed or been
decided there, the rows that passed read together in one turn: every row's carrier authority, and the
group's supersedence in one session (`readMessageSupersedence`), which reads nothing when no row passed.
Each row settles its own two reads, a corrupt read first, so a corrupt row fails alone and is charged
once, and the rest of the group commits without it. After the commit the dispatch reads nothing: each row publishes
under the policy its commit wrote.

The carrier's dequeued-admission authority (`readDequeuedAdmissionAuthority`) reads with the sequences the batch
claimed. A tracked row may answer `follows-batch-predecessor` with the predecessors it follows
(`batchPredecessorSeqs`): its carrier admits it only behind those sequences of its track, which the same batch
claimed. Such a row commits in its predecessors' group, whose positions chain in sequence order, and after them when
the group's members commit alone. When one of them reaches no commit ahead of it, the row is left to the next pass as
`not-ready`, uncharged. The WS server's track-order owner
([`ws-queue-box-server-track-order.ts`](../../services/ws-queue-box-server/ws-queue-box-server-track-order.ts)) answers
for a tracked row past `seq 1` that has not recorded: it lists the track's ordering index once and reads the listed
lower sequences' stored rows in one session, from the highest sequence down to the first settled one
(`readStoredPredecessorsToSettled`; measured in S7-i on Postgres: past `seq 1` the prefix list returns N rows at depth
N, the row's own index row included, and the front makes 3 point reads with every predecessor settled, 4 with the
nearest unstored and N + 1 with none stored, one statement each; the completing dequeue's durable re-check reads outside
this front: at least two statements on a room row, the current snapshot then the authority batch, and an unmeasured pair
on a principal row), and a lower sequence is pending while its stored row is absent (a producer row before its first
dequeue) or still has to record (`toALOrderingPendingPredecessors`). The row follows every pending
one its batch claimed, is `held` on the nearest one its batch did not, and passes with none, so a sequence nobody
indexed, and one recorded, expired or admitted to no audience, holds nothing. A held row's authority names the one read
that releases it (that predecessor's index row and stored row), and the claim's 50 ms re-check reads that alone rather
than the whole authority: it releases once the predecessor records, names another message or its index row is gone.
A tracked row whose dequeue reaches a terminal outcome (completed, superseded, refused, or failed non-retryably)
without recording deletes its own index row (`delete-ordering-message`, guarded on its `msgId`,
[`write-al-outbound-track-index-end.ts`](./lane/write-al-outbound-track-index-end.ts)), which releases its successors;
a deferred, pending or `no-route` outcome keeps it while the row retries, and a row that recorded keeps it for repair,
as does a delivered row that positioned nobody (no durable audience), since no successor waits on it.
The end write's own failure is one `track-index-end` diagnostic (`ALOutboundRuntimeDiagnosticsEvent`) and leaves the
successors to the row's deadline. Either way a track's positions are written in sequence order.
Each row's after-admission effect then runs in the same follower
order, so a recipient receives the rows of a track that one batch admits in sequence order.

## Canonical message storage

[`al-outbound-canonical-message.ts`](./al-outbound-canonical-message.ts) owns the
canonical key, full message reference, identity fact, and their validation.
[`al-outbound-canonical-storage.ts`](./al-outbound-canonical-storage.ts) reads and
compares those observations; [`admission/al-outbound-canonical-fact-writes.ts`](./admission/al-outbound-canonical-fact-writes.ts)
observes the canonical pair a commit may write, re-reads it inside the admission write (a dequeue's own
claim answers for its row) and writes new facts through the admission transaction.
Each message has one raw envelope. Sent metadata, recipient actions, and repair work
refer to it; [`al-outbound-transport-message.ts`](./al-outbound-transport-message.ts)
captures and reconstructs the permitted transport differences.
The identity fact covers the envelope version, sender, `msgId`, timestamp, session and the required
`id.traceId`, so the trace is fixed before first admission. Retries, the carrier fallback, repair
retransmission and checkpoint restore re-send the stored envelope, so each attempt carries the
same trace with no code of its own.

Every stored key is `topicId/resourceId/contextId`. Outbound work is
`AL_OUTBOUND/<namespace>/<effectId>`; the canonical envelope is
`AL_OUTBOUND_MESSAGE/scope-<hash>/message-<hash>` and its immutable identity fact
mirrors that locator under `AL_OUTBOUND_IDENTITY`. The owner leads the key so one
browser session's rows are a bounded key-range delete rather than a scan.

Browser RTC and WS for the same local session share the durable lane's canonical scope and
queue, with separate admission/action namespaces; each keeps its own memory pair. The bounded hashed physical key is a
locator; the retained full-identity fact and exact content establish valid reuse.
Different sessions cannot share authority through a matching locator.

Canonical payload and identity retention ends at the original delivery deadline.
Their `COMPLETED` queue status denotes a retained fact, not a receiver receipt.
Compact receipt/control state can remain useful after the payload expires, but
payload-dependent sends and repair stop at the deadline. Live missing or mismatched
references are corruption. Superseding messages retain separate canonical payloads;
they do not overwrite a predecessor's envelope.

A claim reads the canonical pair its work row references unless the durable lane's own commit handed
it over. [`ALOutboundCanonicalHandoff`](./lane/al-outbound-canonical-handoff.ts) holds the committed
canonical row for each prepared send the commit wrote, keyed by that send's work slot, in a
`LatestRepository` capped at four work pages (`maxEntries`, oldest dropped first) whose entries each
expire at their send's deadline on the lane clock; the claim takes a live one and checks it against
the reference exactly as it checks a stored pair. It is a cache of an immutable row, never a source:
another tab's claim, a reload, a replayed pending admission, a retried claim and a row at its
deadline read storage. Its safety rests on its key and on the reference check, not on hearing of
resets: an entry is found only for a work row committed with the same effect id, and a held row that
does not match that work row's reference fails closed as corruption and is never sent. Dispose
clears it, and a commit that resolves after dispose records nothing. A storage reset clears it only
when the lane is notified through `ALStorageResetListeners`: the IndexedDB pair's own
open forwards an observed external recreation. Database-wide cleanup reports such an
observation on its database-named storage sink, which does not notify this pair. Cleanup
itself removes selected rows and never resets the database; the memory pair's lane has
no IndexedDB reset listener.
After `attempt-started` the claim reads its guards, the stored row's end marker, supersedence and then (unless
ended or superseded) receipt state, in one readonly session (`readSendGuards`), so a hand-off hit costs the claim one
admission read session and a miss two: the canonical read stays its own session before the
attempt starts.

### Commit conflicts

Every admission -- a send, a control hand-off, a dequeue, a repair -- runs the same read, computation,
validation and optimistic commit, and no queue or Web Lock orders the commits of a sender. Each commit
is fenced on the sender's one version, which is what keeps a track's sequences unique and gap-free:
two commits that read one version mint one sequence, and only one of their writes lands. The other
write answers `conflict`, and its commit reads, decides and writes again at once
(`AL_OUTBOUND_COMMIT_CONFLICT_RETRY` in
[`al-outbound-dispatch-admission.ts`](./al-outbound-dispatch-admission.ts), on the shared
`try-with-policy` primitive). The first retry runs at once, since a lost fence means the winner has
committed; the third and last attempt first waits 10 ms with half of it jittered. A commit therefore
makes at most three reads and three writes and waits at most 15 ms, and contention costs fresh
reads, never a wait for another commit's read. Concurrent sends of one track are sequenced in the
order their commits land, not the order they were called: the outbound promises no call order
between sends that are in flight at once.

Past the bound a send retains its request: the canonical payload, immutable identity and compact
`admit-message` work, atomically, through
[`retainALOutboundPendingAdmission`](./al-outbound-pending-admission.ts). That fallback returns
`pending`, meaning durable ownership exists, not that transport ran. A replay, a dequeue and a
repair that lose every attempt throw a retryable conflict, so their claim's work retry runs them
again. A burst of one sender's commits at once is the costly case: each round of its attempts lands
one commit, so most of a large burst is retained and replayed one by one by the durable worker
(measured in the in-memory server test that admits 4096 at once: about 33 s against about 6 s with the
removed commit lock).

Controls are `volatile` (`computeALControlMessage` in
[`al-control.ts`](../../al-contracts/al-control.ts)), so a runtime with a memory pair — both browser
carriers — admits them in the memory lane; a runtime without one (the WS server, or a WS client built
without `outboundVolatileStores`) admits them in the durable lane. The memory lane shares nothing
between tabs, so the two-tab proof covers the durable lane: two tabs of one session that share the
IndexedDB lane and hand off the same controls at once, or where one tab closes after its commit,
send each control once and in hand-off order; a tab that closes inside its send leaves that send to
be retried once after its lease lapses, at least once on the wire
([`al-outbound-control-handoff-two-tabs.test.ts`](../../../tests/shared/alm/outbound/al-outbound-control-handoff-two-tabs.test.ts));
a send a closed tab still holds under its lease waits for that lease on either path.

The outbound worker claims the retained `admit-message`, rereads current admission
facts, and replays one new attempt. The retained policy, original deadline, and authorized transport provenance
remain unchanged; the stored candidate contains no prior mutable write context. A
retention conflict leaves no false ownership for the caller to complete, and a terminal
pending descriptor cannot be revived merely because its content matches.

The server's independently produced `WS_OUTBOX` rows remain active canonical
sources. Cluster notifications carry bounded key/type/deadline claims, which the
[`QueueBoxPubSubBridge`](../../../shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts)
checks against the retained message and identity before delivery. Publication is a
transport action and does not confirm the logical audience; a server receipt does (below).

## Admission and invocation paths

| Entry                        | Decision and durable result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | After commit                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enqueueIfAbsent`            | Dispatch admission reads validated state and computes a bundle. Its commit compares sender versions and original supersedence observations, then writes admission state and QueueBox work atomically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The runtime wakes the existing worker after commit.                                                                                                                                                                                                                                                                                                |
| `enqueueAllIfAbsent`         | One sender's messages read, compute, and validate as `enqueueIfAbsent` does. The group attempts one `commitBundles` write under one version fence and falls back to members alone (see Grouped sends below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The runtime wakes the existing worker for committed work; each message still reports its own `commit-phases` event.                                                                                                                                                                                                                                |
| `acceptControlMessage`       | Repair admission checks that this scope owns the control, then `ALOutboundControlAdmission` validates identity, control history, and pending receipts and commits control state and repair work together.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The runtime wakes the existing worker; repair admission schedules a not-yet-in-sync retry when the committed control is a not-yet-in-sync NACK, unless its message has ended or is a room send without a repair planner, whose own hop retains it.                                                                                                 |
| `admit-message` work         | The lane first reads the message's `end-message` row and completes without admitting while one exists. `ALOutboundMessageEffects` then reads pending admission authority, rechecks the retained deadline, and commits the retained policy through dispatch admission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The claim completes. Rejected or expired authority completes without admitting; a not-ready authority reschedules with its own delay.                                                                                                                                                                                                              |
| `dequeue-message` work       | A foreign queue row this owner admits: `ALOutboundMessageEffects` first reads the carrier's dequeued admission authority with the batch's sequences, then rereads the message, drops it when superseded, and commits a dispatch plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Circuit-open resilience reschedules; a `not-ready` authority holds the claim (one `not-ready` attempt, re-checks in memory); `no-route` retries; expired, superseded and skipped complete; an admitted plan completes and hands the configured `afterDequeueAdmission` port the policy its commit wrote and the dequeue authority it planned from. |
| `send-prepared` work         | `ALOutboundMessageEffects` rechecks the message's end, supersedence and receipt completion from one read session (`readSendGuards`), then the deadline and abort, before calling the transport; a copy of an ended message completes without a frame.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | An immediate outcome completes or reschedules; a queued native send is retained until the transport settles it.                                                                                                                                                                                                                                    |
| `ack-timeout` work           | Repair admission rereads the receipt snapshot. For an ended message whose kept receipt row is incomplete it writes nothing. Before the deadline it recommits the next timeout. At it, while the receipt has charged nothing and every copy of the dispatch that opened it (`firstAttempt`) is still queued for its carrier, it commits the next timeout alone: nothing is charged and nothing hinted. Otherwise it charges one attempt and commits the next timeout plus a `repair-hint` when it can re-plan the message (a relay's forwarded copy it cannot, so its row gets no hint: the origin retries that copy; an origin whose own re-plan drops at the deadline, as in a transient carrier gap, is charged the attempt and retries nothing in that window), clears a complete receipt (a receipt a control ended has its timeout row completed in that commit, so only a row a batch already leased gets here), and out of budget ends the message and states its terminal exhaustion.                                                                                                                     | New work is available to the existing engine; the schedule never sends directly.                                                                                                                                                                                                                                                                   |
| `repair-hint` / `nack-retry` | Repair retransmission reresolves the cached messages (by ordering track and sequence when the hint names missing ranges: one page of `repairPageMessages` per execution, the remaining ranges re-committed as one follow-up hint), applies repair policy, and commits a fresh dispatch through dispatch admission, which charges the repair budget (per requester, and per gap and request number for a ranged hint, so a later report of the same gap charges nothing and a renewal is a new attempt) and answers `skipped`/`repair-exhausted` once a requester's budget is spent, in a commit that ends the message; for an ended message it answers `skipped`/`message-ended` and writes nothing. Without a repair planner, a room-scoped hint is served only as the sender's own-hop retry (every failed peer, or the hint's requester, is the sender's own hop: a tracked next hop or a composition-declared one); a `receiver` room send with no client-tracked hop schedules no `ack-timeout` and is not retried here: until the server answers, its first-hop wait writes it again (`first-hop-timeout`). | New work is available to the existing engine; retransmission does not recursively invoke the work handler.                                                                                                                                                                                                                                         |
| `first-hop-timeout` work     | [`ALOutboundFirstHopWait`](./first-hop/al-outbound-first-hop-wait.ts) rereads the wait and its message. A wait a receipt or a refusal ended has nothing to do, and the wait of a message gone, ended or past its deadline is deleted. Before the deadline it recommits the timer; at it, a re-plan refused for good ends the message with that refusal, an attempt whose every copy is still queued commits the next deadline and charges nothing, a spent wait ends the message and states `receipt-exhausted`, and otherwise it commits the next attempt and its timer, then a fresh dispatch of the message on the hop under a new attempt identity, each commit fenced on the sender version.                                                                                                                                                                                                                                                                                                                                                                                                                 | New work is available to the existing engine; the resend dispatches only after the wait's own commit committed.                                                                                                                                                                                                                                    |
| `end-message` work           | [`ALOutboundLaneMessageEnd`](./message-end/al-outbound-lane-message-end.ts) completes the retained admission the row names, waiting `not-ready` while that row is held, then rereads the message and commits its end; a row already ended or gone writes nothing, and a conflict is redelivered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | The claim completes. Every later path meets the stored end.                                                                                                                                                                                                                                                                                        |
| Startup / scheduled wakeup   | `ALWorkQueuePort.claim` reserves; `ALOutboundAdmissionEffectStore` then decodes and validates the claimed row with the canonical message it references, handed over by the lane's own commit or else read (`readWorkSnapshot`, `validateObservedWork`). Malformed work becomes `NON_RETRYABLE`; valid claims remain independently available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | One batch runs at a time and its claims run in order; a commit landing behind a batch earns one follow-up batch. QueueBox compares the exact reservation on release, so an old worker cannot alter a newer claim.                                                                                                                                  |

The message's original deadline bounds retention of its pending receipt and `ack-timeout` work.
The timeout's scheduled time says when to charge the next retry; elapsed time alone does not spend
attempts. Keeping the work until that deadline lets an owner restored after downtime execute a
persisted, unspent retry without extending the message's lifetime. When the last timeout closes
with the attempt budget spent, repair admission ends the message (the stored row marked ended, the repair-attempt row
deleted, the receipt row kept as its final snapshot) and states `receipt-exhausted` once. A late ACK cannot resurrect
that terminal receipt: it is refused as naming a message that has ended. An ACK before
that terminal commit can still complete a live receipt, but an ACK at or after the message deadline
is refused even if a receipt can still be read. Every carrier discards `acceptControlMessage`'s answer, so repair
admission records it as the `control-admission` outbound diagnostic (outcome, the reasons of a
`rejected` or `duplicate` refusal, and a NACK's own reason and the track it asks about) for every control it decides.
A committed `resync-required` NACK is a hop's refusal of a
retained send (D50): it states a `relay-rejected` settlement, which ends a receipt-tracked handle
`rejected`, and like a `stale` NACK it ends the receipt row and its repair attempts, so nothing resends
the message. A multi-recipient receipt therefore keeps the recipient evidence it had at the rejection:
later ACKs find no row. A receipt-less send (`receiptAlgo: 'none'`, the receipt its admitting carrier
tracks, R-S3a-4) is terminal at `transport-accepted` by lifecycle design, so a rejection that reaches
it later is evidence only: the handle keeps `transport-accepted` and names the relay in
`relayRejection` (R-S2c-ii-5a). A caller that checks `state === 'rejected'` alone misses that case;
`relayRejection` is the fact. A default typed send tracks a receipt, so the case is left to a send
that names `ack: 'none'` explicitly, or asks WS for a `hop` or `subtree` room receipt the WS client
does not track. Over RTC an explicit `ack: 'none'` send keeps no receipt row, so control admission refuses its hop's
`resync-required` NACK and states no `relay-rejected` at all. Every control arrives
with its source (`ALOutboundControlSource`), and trust follows the source, never the carrier. A WS client hands its server's controls over as `trusted-server`: the
server never relays a peer NACK, so its `resync-required` NACK is the relay's own verdict, admitted
without an expected peer (every other check stands), and stated as a server relay that is never named.
Every other control, the WS server's own included, arrives as `peer` and must come from an expected
receipt peer or the unicast addressee. A gap NACK, a `not-yet-in-sync` NACK or a repair request for a send that asks
for no receipt and keeps no receipt row may also come from a recipient its frozen audience names, or, for a room send
to no single addressee that froze none, from any requester the repair authority planned a repair to, which needs a
ready room neighbour; a relayed gap NACK for such a send needs only that planned repair of its sender and a logical
recipient of the frozen audience (6c). The per-requester repair budget bounds it as it bounds a receipted send's.
Since that budget is charged to the recipient a relayed gap NACK names, over RTC such a NACK is admitted only with a
proof its recipient signed, verified against the key the message's room registers for that recipient now (no key was
frozen for a send without a receipt); an unsigned or wrongly signed one, or one for a recipient the room no longer keys,
is refused before it charges anything. The recipient's own gap NACK needs no proof: its carrier names its sender.
Over RTC, under `receiver` and `leader`, a control that speaks for a counted recipient confirms, excludes or ends
nothing until its proof is verified against the key the sent row froze for that recipient (above), whichever hop
forwarded it: a relay forwards its child's signed control and cannot speak for the recipients below it (see the
inbound README). A retained control keeps its source for its replay, and its replay verifies it again.

A receipt row is keyed by its origin and message id
(`toALOutboundOriginMessageKey({ namespace, row: 'pending-ack', originPeerId, msgId })`), so origins that share one
store namespace never collide on a message id. Its `mode` is the send's resolved ack algorithm
and types its peer lists: next hops under `hop` and `subtree`, logical recipients under
`receiver` and `leader`. Its `firstAttempt` names the dispatch that opened it, its attempt identity and phase, so its
first deadline can read that attempt's send rows (below); the field is absent on a row a server's receipt opened, which
no timer here retries. An ACK confirms the peer that mode names -- its `logicalRecipientPeerId` under
`receiver` and `leader`, its sender under `hop`, and under `subtree` its sender only on that hop's own
completion ACK (a leaf's `delivered`, a relay's terminal `subtree-complete`), never on a
control the hop forwards for a recipient below it -- so a hop ACK never stands in for a
logical recipient. A control
is a duplicate only when its sender, logical recipient and status all repeat; an ACK for a peer
the receipt already counted is refused with its own reason, so an ACK that moves no receipt costs
no write and no version bump. The exception is the completion ACK of a next hop still open whose
`accepted` ACK the receipt already counted: it enters the ACK history without moving the receipt,
so the hop reads complete and a retry never resends into its subtree. The `acknowledgement`
settlement carries the `mode`, so `complete` under `receiver` is logical completion, and under
`leader` it is the confirmation of the one director session the carrier froze at admission (D164). A
`receiver` room send frozen to an empty audience (an origin alone in its room) is admitted and
states a complete `acknowledgement` settlement at its commit, with no receipt row, as the WS
server answers an empty audience.

When an `ack-timeout` retries a `receiver` receipt, the repair request carries the hops whose
subtree the ACK history shows complete (`completedHopPeerIds`). The RTC origin of a frozen
multicast retries only through the next hops that may still lead to a missing recipient: a
missing recipient that is a direct hop, and every hop whose subtree has not completed; a
completed hop never gets a copy (D25). The hop view is the origin's own (`OverlayTree`: its next
hops and those whose completion ACK arrived; R-S2c-ii-3): no browser peer holds the tree beyond its
own hops, so with several relay hops outstanding the retry over-approximates, never to a completed
hop. Every other retry re-plans around the failed hops through an alternate parent. Under `subtree`
that retry, and a targeted repair to a requester, add their hops to the expected set and never drop an
unfinished one (R-S2c-ii-14): a new hop that already holds the copy answers for its own part only, a
leaf re-acknowledging or a relay giving the sibling answer, so its completion cannot stand in for the
subtree of the hop the retry routed around. An unfinished hop that left stays expected, and the
receipt times out rather than reading complete. Every other mode replaces the hops it expects.
`retransmitAdmittedMessage` sends an admitted message again as a repair attempt of its own identity;
a relay uses it to pass a retried copy on to the child hops it still waits on (the inbound README
covers the relay's side: which children it owns, and why its row always completes).

A peer asks for a retransmit only for a child it owns and could not reach (R-S2c-ii-9); a leaf never
does, since the retry of a recipient the origin already counted is the origin's decision. So an RTC
origin that owns no next hop for a send -- members in the room but no overlay next hop, or a frozen
audience that has since left -- has nothing to plan and settles `unroutable`/`no-route` rather than
`skipped`/`planner-drop` (R-S2c-ii-9a): `rtc-with-ws-fallback` then falls back to WS, `rtc` alone
settles `attempts-exhausted`, and a re-planned queued entry retries within the attempt cap. An origin
alone in its room is the empty frozen audience above, not this case.

**The RTC carrier gap (D96).** An RTC origin checks a room fanout's room authority and the overlay it selected
([`compute-rtc-outbound-carrier-availability.ts`](../../multicast/compute-rtc-outbound-carrier-availability.ts)).
Only a selected overlay that is removed or belongs to another scope, or the room authority's own refusal (an
inactive or expired room, session or member), refuses the send `unauthorized`, on every strategy. Every other
missing or stale observation is a carrier gap: no room snapshot, a room whose transport is not `flowing`, no active accepted layout, or no
cached overlay that is the exact accepted server layout (a missing, `bootstrap` or other-version overlay). The leg
decides what a gap means at admission. A leg with a fallback carrier (`rtc-with-ws-fallback`) admits through
`WebRtcOverlayMulticastManager.enqueueLegIfAbsent(msg, 'hand-over')` and reads a gap `unroutable`/`no-route` at
once, so WS takes the send (D56). A leg without one (`rtc`, or the RTC leg of `ws-then-rtc`) passes `'hold'`: a
volatile send still reads `no-route`, and a durable one is admitted with no prepared copy and waits as
`dequeue-message` work. Its claim states one `not-ready` attempt when the gap begins and stays reserved while it
re-checks the authority in memory every 50 ms, so the gap writes nothing to storage; it releases the row once, when
the authority returns, at its 10 s lease end (the next claim states the attempt again, on the same attempt row), or
at the deadline. When the exact accepted overlay returns inside the deadline the dequeue plans the copies to the
audience frozen at admission, and the receipt starts with them; otherwise the row's deadline ends the message
`expired` (D10). A unicast keeps its own admission. A copy already prepared when a gap opens settles `not-ready` on every attempt, so
`rtc-with-ws-fallback` hands it to WS after three and `rtc` alone retries it to the deadline. A re-plan that
states no `ackTracking` keeps the captured `receiver` set, so a durable RTC send whose provider defaults
change during a gap keeps its receipt (D96).

### The frozen audience

A `multicast` target carries its logical audience as `recipientPeerIds` with the `snapshotVersion` it
was frozen at ([`al-frozen-multicast-audience.ts`](../../al-contracts/al-frozen-multicast-audience.ts)),
both or neither (R-S2c-ii-1). Absence means "not yet frozen", a distinct state:
`newALMulticastMessage` builds a multicast before any snapshot exists, so the carriers freeze it, and
`assertPersistedALTargets` accepts the unfrozen shape or a complete pair (a unique id list and
`snapshotVersion ≥ 1`). The pair is pinned on the room's `GroupSnapshot.group.snapshotVersion` (D26).

- The RTC origin freezes its own multicast once, at the first plan that has a room authority
  ([`web-rtc-overlay-frozen-audience.ts`](../../multicast/web-rtc-overlay-frozen-audience.ts)): the
  sessions that authority admits (active members with live leases) minus itself, at the admission's
  `snapshotVersion` (R-S2c-ii-2). Every later attempt and every stored row keeps that audience, whatever
  the room has become.
- A principal or fixed-list send narrows that audience at the same freeze (D159, D160):
  `computeFrozenAudience` takes a required `narrowing: ALAudienceNarrowing | undefined`, `undefined`
  freezing the whole room, `{ kind: 'principal', principalId }` keeping the admitted sessions of that principal,
  `{ kind: 'list', recipientPeerIds }` the admitted sessions the list names and `{ kind: 'leader', sessionId }`
  the director session alone, in the origin freeze
  (`toRtcOriginFrozenMessage`) and in the carrier-gap path alike, so a room-bounded audience is one
  computation on RTC. A listed session the room does not admit is dropped silently, as a multicast's
  audience narrows, and an empty result is an empty frozen audience, as for an origin alone in its
  room. RTC carries no `world` or `all` audience, nor a principal broadcast that names no room: such a broadcast is refused at admission as
  `refused/unsupported` (D157), and the browser sender routes a `world` send to WS first whenever
  the strategy allows it.
- A granted publication narrows that audience at the same freeze to the live sessions whose principal holds
  effective `subscribe` on its topic in the origin's cached snapshot
  ([`computeGrantedSubscribeHolders`](../../multicast/publication/compute-granted-subscribe-holders.ts), passed as
  `subscribeHolders`; `null` for any other send) when the leg is admitted (`admitLeg`), before its first admission
  signs it (`signAdmitted`, after that admission's read stamped it), so the signed targets and the receipt
  row's expected set are the narrowed audience, receipted or not. A granted room multicast, a listed room broadcast,
  a principal broadcast naming its room and a room unicast are narrowed at that one freeze; the unicast is first
  translated into the one-entry listed room broadcast of its room
  ([`toRtcGrantedListedLeg`](../../multicast/publication/to-rtc-granted-listed-leg.ts)), so it rides as a frozen,
  signed multicast of one. A named session without `subscribe` is frozen out silently, and an audience frozen to
  nobody owns no children: under `receiver` its receipt of zero recipients completes at once, and under `none` the
  plan drops `no-route`, a fallback trigger. Any other granted shape (an exclusions-only room broadcast, `world`, a
  roomless principal) is refused before freezing as `refused/unsupported`
  ([`resolveRtcGrantedPublicationShapeRefusal`](../../multicast/publication/compute-rtc-granted-publication-refusal.ts)).
  A granted `group-leader` send whose room's director
  holds no `subscribe` is refused before freezing as `refused/unsupported`, which a fallback carrier takes over
  ([`resolveRtcGrantedLeaderRefusal`](../../multicast/publication/compute-rtc-granted-publication-refusal.ts)); a
  room without a director, or one the sender directs, keeps `refused/no-leader` as any room send does.
- A `group-leader` room send narrows that audience to the room's leader (D164, D165, D166). The narrowing
  comes from the message, its `delivery.ack` on a room-bounded target, never from a side input, and its
  `sessionId` is resolved at admission from the room snapshot the carrier holds by
  `resolveRallarGroupLeaderSessionId` ([`group-director.ts`](../../api/group-director.ts)): the appointed
  director session when `isRallarGroupDirectorSessionActive` holds, so `isALAudienceSession` stays a session
  comparison. The RTC origin refuses the admission `refused/no-leader` when it resolves no director, when the
  director is the origin itself, and when the director is outside the audience the send names after its
  exclusions (a fixed list or a principal without it, or `exceptPeerIds` naming it); otherwise it freezes
  `[director]`, and its receipt row, under mode `leader`, expects that session alone. A send held for a carrier
  gap resolves its director when it freezes. The leader stays frozen through a succession: the receipt expects
  the session it froze, and a resend re-admits against the current appointment.
  `refused/no-leader` is no fallback trigger, since WS reads the same appointment.
- An exclusive send is refused at the RTC origin as `refused/unsupported` (D174): no RTC peer can arbitrate an
  exclusive claim on its resource key.
  [`computeRtcExclusiveRefusal`](../../multicast/compute-rtc-exclusive-refusal.ts) reads the effective ownership the
  policy normalizes (a `qos.ownership` request wins over the `ownership` option) right after the scope refusal,
  before anything is persisted or sent, and names the refused message with the targets its sender gave, so a fallback
  carrier takes over the sender's own audience. The browser sender routes
  an exclusive send to WS first whenever the strategy allows it, as it routes a `world` send, so the refusal is the
  verdict of an `rtc`-only send and the RTC carrier's own guard.
- **The RTC room limit (R-S2c-ii-13).** The RTC frozen audience rides on the wire, where one
  collection holds at most `AL_MESSAGE_RESOURCE_LIMITS.collectionEntries` (256) ids, so an RTC room
  multicast reaches rooms of at most 257 sessions, the origin included. A larger audience is refused as
  `refused/unsupported`, naming the bound, in every ack mode and before anything is persisted or sent
  (`computeRtcFrozenAudienceRefusal`). That is the refusal a fallback takes over: `rtc-with-ws-fallback`
  delivers over WS, whose audience travels off the wire (below), and `rtc` alone settles `rejected`
  with the typed reason. A granted leg judges the bound right after its freeze, so a fallback takes over.
- The WS server freezes a room message at its admission stamp from the sessions it authorizes,
  narrowed for a principal broadcast that names its room to that principal's sessions (the group
  snapshot's `activeSessions[].principalId`), for a room broadcast that carries
  `recipientPeerIds` to the listed sessions, and for a `group-leader` send to the director session the room
  authorizer resolves from the snapshot it reads, the leader alone in the narrowed `sessions`; that narrowed set
  is the room audience its receipt
  expects and its repair serves, and the send is fenced on the room's roster as any room
  send (D143, D159). A multicast an RTC origin froze that falls back to WS keeps its frozen set
  narrowed to the sessions the server authorizes: a frozen audience narrows what the admitting
  authority allows and never widens it, and an empty intersection means nobody, never "no filter".
- The outbound authority checks split by stage. A planner's message is checked strictly against its source
  (`validateALOutboundPlannedMessage`): it may freeze an unfrozen audience and carry a sequence minted on the track
  its source named without one, nothing else. An admitted or stored copy, and canonical reuse, are checked leniently
  against the request (`validateALOutboundAdmittedMessage`, `toALOutboundRequestComparableMessage`): they may also
  carry the prior-sequence record and the proof the admission added. A copy that drops or changes a frozen audience,
  the key, the epoch, a stated sequence, a stated record or a carried proof still differs.
- RTC peer ingress refuses a room multicast that carries no frozen audience (`malformed`).
- Under `receiver` the origin's receipt row expects exactly the frozen recipients. The set a relay
  forwards over is the sessions authorized now, a late joiner included, but only a session of the
  frozen audience delivers locally or counts as a logical recipient; a session outside it may forward
  and ends its own subtree with `subtree-complete`. A join never widens a frozen audience, and a session
  that leaves stays expected and reads unconfirmed (D43).

### Server receipts on WS

A `receiver` or `leader` room send over WS expects nobody when it is admitted
([`toWsQueueBoxClientAckTrackingPlan`](../../services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts)):
the WS server freezes the audience and answers for it. A `leader` send is the same receipt with
one expected recipient, the director session, so the `admitted` receipt names the director and the
director's ACK completes it. Each recipient's ACK stays addressed to the origin (`toPeerId` is the
message's `senderId`); the server admits it at ingress as the hop that relayed the message and counts it, through
[`WsQueueBoxServerReceiptAggregation`](../../services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts),
in the [receipt record](../receipt-record/README.md) every instance of the server shares: any instance counts any
ACK, ends the receipt and answers a re-sent copy, so the receipt is the same whether or not the instance that
admitted the send survives. The admission that opens the record is the one whose socket admitted the message, or,
for a send the server kept, its replay or a copy's own admission. The record expects the frozen audience, keeps one
confirmation row per answering recipient, and holds the deadline as durable work any instance claims: the message's
own deadline, else its ACK timeout, never beyond the record's 30 min window. A send to more than 256 recipients is
admitted and gets no receipt, and one whose largest terminal receipt no receipt control could carry opens none
(`receipt-not-encodable`, one warning). The server answers the origin
with `al.control.receipt.v1` controls, each written as one durable `WS_OUTBOX` row that reaches the
origin's socket on this instance or, through the cluster publisher, on another: `admitted` at once
with the frozen audience, then `complete` when every expected recipient has acknowledged, or
`timed-out` at the message deadline naming whom it counted. The terminal receipt is enqueued by the record's ended
work, on whichever instance claims it, under one control id derived from the origin and the message id
(`toWsQueueBoxServerEndedReceiptControlId`), so a work row claimed twice enqueues one receipt. Every receipt row expires at the message
deadline plus `AL_RECEIPT_DEADLINE_GRACE_MS`, however early the server observed it. A receipt row
whose origin has no session on the instance that dequeues it is not settled by its first cluster
publication: its send
([`WsQueueBoxServerClusterPublication`](../../services/ws-queue-box-server/ws-queue-box-server-cluster-publication.ts))
publishes it again, each wait as long as the receipt has waited and the last one a second before the
row expires, until the origin has a session there or the row expires, so an origin that reconnects
on any instance up to a second before the row expires receives it; one that reconnects in that last
second does not.

**The first-hop wait.** Until the server first answers for a receipted send it never saw, only the WS client can
write it again, so the client holds a wait for it. The WS client's planner states `firstHopTracking`
([`toWsQueueBoxClientFirstHopTrackingPlan`](../../services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts))
on a send with a logical receipt that is not addressed to the server, a timeout above 0, at least one retry and a
frozen audience that is not empty, room or unicast; no other composition states it. The dispatch that writes the first
frame records the row `first-hop-wait:<msgId>` with its `first-hop-timeout` work
([`ALOutboundFirstHopWait`](./first-hop/al-outbound-first-hop-wait.ts)). The wait is not the receipt row, which only
the server's first receipt writes, and its deadline and attempts never become the receipt's. Its timer is the send's
own receipt policy (a 2 s timeout and 3 retries by default). At a deadline it writes the message again on its hop
under a new attempt identity, unless its attempt has not left (below); when its retries are spent it ends the message
and states `receipt-exhausted` ("The first hop did not answer after N of M retries."). Any receipt from the server
(`admitted`, `complete` or `timed-out`) ends the wait and completes its timer in the commit that admits it, and so do a
terminal NACK, a relay rejection and a re-plan refused for good, which ends the message with its refusal. So does the
server's `not-yet-in-sync` NACK: the server retains the send until its room view catches up, so the answer ends the
wait and its timer and states nothing, and the message stays open until the server answers again. The replay that
admits the send starts its receipt, so the sender reads `admitted` and then `complete` or `timed-out`; a replay its room
refuses answers with that refusal's NACK when the refusal sends one, and the handle reads `rejected`; a send still
retained at its deadline is answered nothing, and the handle reads `expired`. The outgoing read reads the
wait only for a plan that states it, and a control reads it only on a composition that declares a hop (`hopPeerIds`)
and only when the control can end the send or the wait. A resend is two
commits, each fenced on the sender version: a crash between them, or a resend whose re-plan drops silently, spends an
attempt that wrote no frame, and an `admitted` receipt that lands between them still lets that one frame out. A send
with retry `none` waits for the server alone.

**A duplicate is answered from the record.** The server admits a message once by its id: a re-sent copy is accepted
`duplicate` or `pending-admission` and never delivered twice. A retained send opens no record until it is admitted,
by its replay or by a copy's own admission, whichever comes first, and its `admitted` follows; a copy that is itself retained behind the room view is answered that view's NACK again and nothing
else. A send kept after a lost commit race whose other recipients have all left the room by its replay still expects
the recipients it captured at ingress: its `admitted` names them, none of them is sent the message, so the server
refuses an ACK from any of them as one from a recipient it never sent the message (guard `never-sent`), and its
`timed-out` at the deadline names them unconfirmed, so the handle reads `expired` at its deadline
(`ws-kept-send-receipt.test.ts`).
A send kept behind the room view captured no audience, so it expects the current one and, with nobody left, is
admitted to nobody and reads `acknowledged`. The server answers the copy from the record, on any instance, to that
sender alone and under a fresh control id
([`writeAdmittedReceipt`](../../services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts)): `admitted`
with the confirmations so far while the receipt is open, and the terminal receipt, from the record's own sets, once
it has ended. A copy that finds no record opens it from the inbound admission row's audience, frozen as a first
admission freezes it, and is answered `admitted`; that covers an admitting instance lost between its admission's
commit and its record. Such a copy opens nothing when it has no admission row, when the message names no deadline or
one beyond the record's window, when the message is as old as the window by its own stamp, or when the row freezes to
nobody. A copy accepted `not-admitted`, `resync-required` or `disposed` is answered nothing. The sender admits an
identical second `admitted` without a write, and one with a newer confirmed set as progress; a sender that already
holds the terminal receipt refuses the second as it refuses any receipt for an ended message. A memory-only server
keeps no record across a restart.

The server's other controls (its ACKs, NACKs and repair requests) come from its inbound work, which any
instance may claim. The claiming instance sends one to a socket it holds; when it holds none for the
target and a cluster publisher is registered,
[`WsQueueBoxServerControlDelivery`](../../services/ws-queue-box-server/ws-queue-box-server-control-delivery.ts)
admits the control here as one durable `WS_OUTBOX` row that expires 30 s after the hand-off. Unlike a
receipt, its first dequeue publishes it once and completes, so a target connected to no instance
costs one publication and no retry (D107).

A room topic's declared fanout picks the carrier, whatever the message's QoS (D71, D99). On an `outbox` topic the
server's own outbound owner sends the message and keeps the `receiver` row described below. On a `live-only` topic
the router sends once and keeps no copy to retry: to this instance's sockets and, with Postgres pub/sub, as one
cluster notice
([`publishRallarServerLiveWsNotice`](../../../shared-server/rallar-system/websocket/router/publish-rallar-server-live-ws-notice.ts))
that every other instance hands to its own sockets without running a handler. The notice is best effort and one
attempt: an instance whose listener is down misses it. A live-only publication whose notice would reach the
NOTIFY limit and that has no canonical inbound row to point at is refused `failed`, never moved to the outbox.
Either way the receipt is the record above, so a recipient the one send did not reach, or that never
acknowledged, reads unconfirmed and the receipt ends `timed-out` naming it. A `none` topic runs its handlers only.

The server's own state-sync rows never pass the router: they are `WS_OUTBOX` rows with a frozen audience. The
group-state delta is the production server publication that asks a receipt. It is a room broadcast with
`ack: 'receiver'` to the group's active sessions, sent under the WS service's peer id because a session's ACK
names the delta's sender and counts only at that peer, so the server's outbound owner keeps the `receiver` row
described below and the admin read shows who confirmed it under the request's trace. A client-state event and every
snapshot page keep `ack: 'none'`: a principal audience names no room to confirm against, and a snapshot page is
superseded by the next one.

A recipient's ACK reaches the server through the recipient's own socket, which may be on another instance than the
one that admitted the message; the instance it reaches counts it, and nothing is handed to another instance. At
ingress the server checks what needs no store: the sender is the authenticated session, the ACK speaks for itself and
is addressed to the origin it names. The inbound runtime then reads the record once, in the refusal hook
`readRelayedAckRejection` (named for the server's relay of the origin's message to its recipients). With a record, it
refuses, as a typed value, what the record's own validator refuses: an ended receipt, a sender outside the frozen
audience, a passed deadline, a recipient the server never sent the message. With none, it proves the ACK against the
inbound admission store, which every instance shares: the store must hold the message the ACK names, sent by the
origin it names, with the ACK's sender in the audience admission ran under (`readIngressAudience`, the volatile store
first, then the durable one). A forged ACK (unknown message, sender outside the audience, another origin) is refused
after those reads and writes nothing. A proven ACK that finds no record has overtaken the record's `open` and is
counted ahead; the `open` that follows counts it, or the ACK's own read after its write finds the record and ends it
when complete. The outbound admission store cannot prove such an ACK, because it records an admitted audience only for
a message the router enqueued on an `outbox` topic. A repeated ACK writes nothing and is not refused. An ACK addressed
to the server is counted in the record when it acknowledges the server's own receipted publication (below); any other
goes to the server's outbound owner.

Since S3c-i a WS origin knows its server: `/api/config` names it as `serverPeerId`, and the WS client plans against it
([`toWsQueueBoxClientAckTrackingPlan`](../../services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts)).
A unicast addressed to the server, and every `hop` or `subtree` send, expects the server's own ACK: the server is the
one hop a WS origin has (R-S3a-4). A `receiver` unicast that names its room (`targets.groupRef`) is counted like a
room send over one member: the router delivers it to its addressee
([`toWsQueueBoxServerInboundPlan`](../../services/ws-queue-box-server/ws-queue-box-server-inbound-plan.ts)), the
`admitted` receipt names the addressee, and the addressee's own ACK completes it. Any pre-admission `unauthorized`
or `membership-fenced` refusal by the trusted server is answered with a NACK, which the origin states as a
trusted-server `relay-rejected` with that reason, so a receipted send reads `rejected` at once rather than at its
deadline ([`resolveALOutboundRelayRejection`](./control/resolve-al-outbound-relay-rejection.ts) decides which NACK
refuses the whole send); `membership-fenced` is a room send whose sender the server, at or beyond the send's `rosterVersion`, no
longer finds an active member. A peer's `membership-fenced` NACK before any receipt row is a peer
`relay-rejected` naming it only when the peer is the unicast addressee or a composition hop; an RTC room send names
no hop, so its sender hears a peer's fence only through a tracked receipt (`receipt-exhausted`, `hop-refused`), and
a room send with `ack: 'none'` never hears it. The `unauthorized` refusals are a unicast to a session outside
the room's admitted audience
([`toWsQueueBoxServerAddresseeAuthorization`](../../services/ws-queue-box-server/to-ws-queue-box-server-addressee-authorization.ts)),
a room unicast whose `route.contextId` names another room than its `groupRef`, a message whose room or principal names another application or workspace than its connection authenticated (D100, [`toWsQueueBoxServerScopeAuthorization`](../../services/ws-queue-box-server/scope/to-ws-queue-box-server-scope-authorization.ts)), a client's `all` broadcast (D158), and any room send the room
authorizer ([`ws-topic-room-authorizer.ts`](../../../shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts))
refuses — a halted transport, a scope mismatch, data before activation; a sender without a live session or
an active member is `membership-fenced` instead. A `group-leader` room send is refused at ingress with a
`no-leader` NACK when the snapshot the room authorizer reads appoints no director present in the room, when the
sender is the director, or when the send's exclusions, fixed list or principal leave the director out; the
origin states it as a trusted-server `relay-rejected` with that reason and the handle reads `rejected` (D165).
An exclusive send whose resource key another session's live exclusive claim holds is dropped at the server's
admission with a `held-by-other` NACK, which the origin states the same way, a trusted-server `relay-rejected` with
that reason, so a receipted send reads `rejected` and a receipt-less one names it in `relayRejection` alone (D171,
D175; the exclusive claim itself is [the inbound README's](../inbound/README.md)). Unlike the pre-admission refusals
it refuses the whole send whatever the receipt, and it ends the receipt as `resync-required` does: a claim the server
retained on a conflict has no receipt, and its replay's NACK is its only answer.
A volatile best-effort latest-wins publication
([`isALVolatileBestEffortPublication`](../../al-contracts/publication/is-al-volatile-best-effort-publication.ts)) on a
topic whose effective fanout is `outbox` -- the topic's own, or a matching proxy rule's -- is refused at the router's
ingress with an `unsupported` NACK and never enqueued (D482): the browser cannot know a topic's fanout, so the server
refuses. Proxy rules are read from their declarations, since running a rule's `authorize` at ingress would break the
pure pre-admission check: a suppressing rule whose `authorize` or `targets` skips it at runtime leaves the topic's
`outbox` fanout published and the publication enqueued (under-refusal), and a rule that publishes to `outbox` refuses
the publication even when it would itself have skipped (over-refusal). Neither is reachable in the product today, which
declares no proxy rule and no client topic with an `outbox` fanout. The origin states it as a trusted-server `relay-rejected` with that reason whatever the receipt; a live
handle tracks none, so it keeps `transport-accepted` and names the refusal in `relayRejection` alone.
A publication on a granted topic whose sender holds no effective `publish` grant is refused with a
`no-publish-grant` NACK at socket admission or at `route` (D487); an inbox dispatch that reads the revocation first
drops the message without a NACK, so its receipt settles at its deadline, and a pending replay that reads it first
answers the NACK, starts no receipt, and the handle reads `rejected`. Like `held-by-other` the
NACK refuses the whole send whatever the receipt and ends it: a held dispatch already has its `admitted` receipt when
`route` re-reads the grant.
A `receiver` unicast that names no room is refused `unsupported` at admission (D71). A message addressed to the server keeps the server's own ACK and opens no
receipt record (D76). A message carrying a frozen multicast audience — an RTC leg handed to WS — is counted over that
audience verbatim, so a session that left since reads unconfirmed (D73), and a recipient whose ACK confirms nobody
(`subtree-complete-not-subscribed`) is recorded in the receipt's `outsideAudienceRecipientPeerIds`, never confirmed.

The wire `targets.groupRef` scopes every row that names a group (D101): its captured policy stores no
`recipientScope`, `principalTargetId`, `sessionInvalidation` or `accountView`
([`resolveALOutboundScopeAuthority`](./admission/al-outbound-scope-authority.ts)), a row that stores one is corrupt,
and a room unicast's or a direct room row's send checks the recipient's connection against the group's scope. A
stored recipient scope remains only on rows that name no group: a unicast whose producer proved a scope, a principal
target, a principal or world broadcast. A raw `WS_OUTBOX` row without producer provenance fails closed, the producer's
proof is written in its row's own outbox statement, absent-or-expired, as the index row is (the view-invalidation
producers keep their guarded batch), and a unicast `router.publish` that names no group and carries no scope returns
`failed` (D103).

The reserved account-wide view notice uses a separate
[`accountView`](./admission/al-outbound-scope-authority.ts) authority: version and
principal ID, mutually exclusive with scoped/session authority and frozen
recipients. Its unicast account target and exact payload must agree with the
committed proof. Capture, dequeue and repair preserve that authority. The
standalone prepared effect and each cluster subscriber resolve current local
authenticated account sockets across scopes at execution; they never persist
that transient recipient set. Scoped account-view notices retain their exact
application/workspace authority.

A client's broadcast audience is bound to the scope its connection authenticated (D158). A `world`
broadcast names no group, so its row keeps that scope as `recipientScope` and the send-time
recipient selection delivers it only to connections in that scope; the cluster's live notice of a
`world` send carries the scope, and every other instance filters it by that scope, while the `broad`
notice of the server's `all` stays unscoped. A `principal` broadcast must name its room's
`groupRef`, so its row is scoped by the group like a room send; one that names no room, and a `world`
broadcast on a `room.` topic, are refused `malformed`. A client's `all` is refused
`unauthorized` at ingress; the router's `toAll` and the server's own state-sync, CRDT and
client-state rows keep their paths. Under a topic router the topic's fanout alone carries a client's
`world` broadcast: the service's inbound forwarding relays it only in the standalone composition, a
fanout-`none` topic such as the CRDT topics sends no raw copy, and `live-only` or `outbox` sends one
copy to each session of the scope, the outbox row as a scoped recipient per connection. A `world` live
send that names neither an inbound nor a recipient scope, and a `world` row that captured none, are
refused as an unscoped unicast is. A principal broadcast that names its room is a room audience on the
cluster's live notice too: it rides the `room` notice with its narrowed sessions, so a notice of 8 000
bytes or more falls back to the canonical inbound key as a room send does; the `principal` notice
stays for the server's own principal rows. One predicate,
[`isALAudienceSession`](../../al-contracts/al-audience-narrowing.ts), narrows a room on both carriers.

In the production outbox fan-out (`forwardsRoomScopedMessages: false`) the server's own outbound owner
sends the room message and keeps a `receiver` pending row for it, keyed by the origin and message id
(D38): the record of what is still to be retransmitted. The receipt record is its one settlement authority, and
the row learns of no confirmation before the receipt ends: the record's ended work admits the terminal receipt
through the same receipt admission as the origin, so a `complete` receipt leaves that row complete and its
`ack-timeout` stops retransmitting, on whichever instance claims it. Until then a retry asks only for the recipients
the record has not confirmed or placed outside, and one whose receipt has ended or whose deadline has passed asks for
nothing
([`toWsQueueBoxServerUnconfirmedRepairRequest`](../../services/ws-queue-box-server/receipt/to-ws-queue-box-server-unconfirmed-repair-request.ts)).
That row is not the origin's kept final snapshot: once complete, the next `ack-timeout` deletes it,
and nothing reads it after that. The router hands the audience it admitted to the outbox beside the
message, never on the wire, where a room larger than the collection limit would not fit: the plan
carries it as `admittedAudience`, the captured policy keeps it with the sent row, and every later plan of
the message receives it. The server sends to that audience only and a `receiver` row expects exactly it,
never a session that joined after admission (D24, D43); a `hop` or `subtree` row expects the hops this
instance sent to. WS never re-routes, so a retry or a repair of any receipt mode keeps every peer the row expects and
every one that confirmed, and resends only to a failed peer the message was admitted to (R-S3c-i-31). A multicast frozen by its origin and sent without a router keeps planning against its
own `recipientPeerIds`. A receipt that runs out of receipt-admission attempts is retained as
pending-control work and replayed until its deadline.

The server's own room notifications carry receipts too (D58, D77), and so does every server or proxy publish that
names its room (D104). The router freezes any publish that carries a `groupRef`, a multicast or a room broadcast at
any fanout but `none` and from any sender, to the room's live sessions at publish
([`readRallarServerWsPublicationAudience`](../../../shared-server/rallar-system/websocket/router/rallar-server-ws-publication-audience.ts));
a proxy publish takes the audience the room authorizer grants, and an admitted client message keeps the audience it
was admitted to. The server's pending row expects those sessions. A logically receipted one is counted in the
receipt record too, opened at its dequeue from that pending row, so its ACKs take no fenced commit on the server's
version row; only a publication whose opening the record or the codec refuses (more than 256 sessions, a receipt the
control cannot carry) is still counted per ACK in the row ([receipt record README](../receipt-record/README.md)). The
publishing instance's dequeued send checks the
policy its own commit wrote and reads nothing back. Every other instance's receive, and the receipt or prepared-message
publication, read the row's captured policy once from the shared admission store (`readCapturedPolicy`). Every send
fails closed on a row that differs from its admission, and narrows to the audience it holds. Every settlement of the
server's outbound owner feeds one bounded in-memory recorder per process
([`createRallarAlmReceiptDiagnosticsRecorder`](../../../shared-server/rallar-system/observability/alm-receipt-diagnostics.ts),
256 messages), read as `almReceipts` on `/api/admin/operations/realtime`: per message the confirmed and unconfirmed
sessions, the last settlement kind and whether the receipt ran out (D61, D73). For a publication the record counts,
it learns of the receipt when the receipt ends, not after each ACK: one everybody confirms reads `acknowledgement`
within milliseconds of its last ACK, and one somebody never confirms reads it at its deadline, ended `timed-out`
rather than `receipt-exhausted`, with the unconfirmed sessions named.

**Server-minted sequences.** A message the WS server publishes itself that names `ordering.orderingKey` (and
an `epoch`) without a `seq` asks the server's outbound for the sequence (D150). The server's planner marks the plan
`mintsSequence` only at admission (`phase: 'immediate'`) and only when the message's `senderId` is the server's own
peer id; a relayed browser send that carries a key and no `seq` passes through unsequenced, as it came. A row a
producer wrote straight to the outbox carries its producer's `seq` and is never minted, but its producer writes the
track's ordering index row (`toALOutboundOrderingMessageKey` in this admission's namespace, valued with its `msgId`)
in its own transaction, and it records positions at its first dequeue like any other tracked row. An
admission of a marked plan that finds no sent row for the `msgId` reads the track's ordering-head row
(`toALOutboundOrderingHeadKey(namespace, trackKey)`, the track named by `toALSequenceMintTrackKey`: key, sender and
epoch, as `toALOrderingTrackKey` names it once the `seq` exists) in the session that reads the sender version, and
stamps `head + 1` on the message; the commit writes the head `{ seq }` beside the canonical row, the sent row and the
ordering index, fenced by the sender version every commit of the sender bumps, so two instances or two runtimes over
one store cannot mint one sequence twice and a restart continues where the store stands. The sequence belongs to the
attempt that commits: a commit that loses the fence retains its pending admission with the message as its sender
asked for it (no `seq`, and the captured policy keeps `mintsSequence`), and the work queue's replay of that admission
mints again when it commits, replacing the retained request in the canonical row by the minted message (the only
change a pending canonical row accepts). An admission of a `msgId` that already has its sent row mints nothing and
answers with the stored message. The head row keeps the receivers' track retention: a durable pair keeps it
`max(deadline, repositoryTtlMs, controlHistoryTtlMs)` past the mint, and a receiver's ordering-track TTL defaults to
the repository TTL (60 minutes), so a receiver remembers a track as long as its sender keeps the head. Two limits
remain: sequences follow commit order, so under contention two publications of one track can commit out of publish order
(a first-in-first-out mint per track is a follow-up), and a track silent for over an hour restarts at 1 on both sides.
Each browser carrier marks the first admission of its own room send that names an ordering key
(`toALOutboundMintingPlan`): a key alone takes the next sequence, and a stated `seq` at or below the head is refused
`unsupported` while one above it moves the head (`computeALOutboundSequenceMint`). Both carriers' durable pairs of one
session keep one head per track under the pair input `orderingHeadNamespace` (the session's
`toBrowserSessionALOrderingHeadNamespace`; any other pair keeps its heads in its own namespace), so a fallback send's
WS leg and its RTC leg never take one sequence twice. The two pairs fence on different sender-version rows, so the
head write is a compare-and-set: the commit re-reads the head inside its transaction and conflicts when it no longer
holds the value the admission read, and the conflict retries the admission from a fresh read. A copy handed over to WS
after its RTC admission (D56) carries the sequence that admission fixed and enters through
`enqueueHandedOverIfAbsent`, which plans it at stage `hand-over`: it is never guarded.

**Sent positions (S4-R1, S4-R2).** The authority that finalizes a copy's audience records, per track and recipient,
the last sequence it sent that recipient. A plan names those recipients in `recordsSentPositions` (the RTC origin at
its first admission of a frozen multicast on a track, granted topic or members topic alike); an admission of it that
finds no sent row reads each recipient's sent-position row (`toALOutboundSentPositionKey`) in the session that reads the
sender version, after the sequence is known, stamps the copy's `ordering.priorSeqByRecipient` with
`computeALOrderingPriorSeqRecord` (a recipient last sent below `seq - 1`, `0` for one never sent; so a track's first
frame carries `{}`), and its commit moves each recipient below the sequence to it beside the ordering head, fenced by
the same sender version. A commit that loses the fence retains the request without the record (the captured policy
keeps `recordsSentPositions`), and its replay reads the positions again. When both browser carriers share the head
(`orderingHeadNamespace`), a minting admission whose plan records no recipient -- the WS leg, which hands its audience
to the server -- also moves the track's room-wide sent floor, a `room-sent-floor` row beside the head
(`toALOutboundRoomSentFloorKey`, [`al-outbound-room-sent-floor.ts`](./admission/sequencing/al-outbound-room-sent-floor.ts)) that holds the sequences whose audience no receipt has named: the highest
mint of a send with no logical receipt mode, which no receipt will answer, and the receipted mints whose `admitted`
receipt has not landed, ascending (at most `AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS` = 64; past it the oldest is folded
into the first). The WS leg's `admitted` receipt (`expectedRecipientPeerIds`, the audience the server's route
captured) writes, in the receipt's own commit, one position row per named recipient at the send's sequence in the
shared namespace, forward only, and removes only its own sequence from the floor; a mint and a receipt write the
floor under one compare-and-set on the value they read, and a conflict retries from a fresh read. A recording
admission reads each recipient's prior as the highest of its own carrier row, its shared row and the floor's highest
sequence (`toALOutboundSentPositionPriors`): the RTC record never lists a recipient behind a sequence the WS leg sent
it, or one whose audience is still unknown, so a recipient whose WS copy is in flight asks a gap that copy closes
instead of reading an omission, while a recipient a landed receipt left out reads its own prior. A recipient the WS
server left out still stalls until resync or the track expires in three windows: the dequeue dropped it after the
route captured the receipt's audience; the send asked no logical receipt, so its sequence stays a floor until the row
expires; or the `admitted` receipt arrived after the `complete` one, which is refused as a repeat and writes no rows.
The WS server's receipt admission has no shared head and writes none. A pair whose head is its own (the WS server)
has no room-wide floor.
A send whose latest-wins supersedence only the sender's QoS provider defaults applied carries it in its own signed `qos`:
[`toALMessageWithAppliedSupersedence`](./supersedence/to-al-message-with-applied-supersedence.ts), called from
`computeALOutboundDispatchPlan`, writes it as an admission addition of the sender's own enqueue, before the sequence is
minted, the record stamped and the frame signed, so the proof covers it and every receiver plans the copy as latest-wins
(the inbound entry rule does not hold such a copy for a lost first frame). A supersedence the app requested is kept, a
message that already carries a proof is never rewritten, and an explicit plan (a relay forward, the WS server's queue
box) never stamps. A retained admission's drain keeps the stamp its first admission decided and never stamps again.
Request comparison strips the stamp. This is a delivery change for existing senders: a send whose latest-wins came only
from provider defaults is now planned latest-wins by every hop and receiver, exactly as one the app requested is, where
before only its sender planned it so. A server-originated send whose latest-wins comes only from the server's provider
defaults is not stamped: its copies carry no supersedence of their own.
On RTC the carrier then signs a frame that must carry a publisher proof, once, at the dispatch that first holds its
frozen audience and its room snapshot: the first admission, or the dequeue that freezes a held send
(`signAdmittedMessage`, `RtcSignedPublicationCarrier.signAdmitted`, which returns every other frame as it is). A frame
must carry a proof when its topic is granted, or when it is a room send that asks a `receiver` or `leader` receipt
([`isRtcPublisherProofRequired`](../../multicast/publication/is-rtc-publisher-proof-required.ts), D758); a send that
asks no logical receipt stays unsigned and costs no sign and no verify. The stored canonical carries the proof over
the sequence and the record, and every re-plan, dequeue and repair resends it as stored (D519). A granted
publication's refusals that `admitLeg` can know (shape, leader, a page that cannot sign) run before admission. A
receipted room send's signer refusal is its first admission's (`key-not-registered`, a page without WebCrypto), and
at a freezing dequeue it ends the held send `rejected`, as a keyless counted recipient does; an exclusions-only room
broadcast that asks a logical receipt is never frozen and is refused `unsupported`. A signer that still cannot sign in
the admission (`sign-failed`, a snapshot that moved) drops the frame `refused/unsupported` like them. That drop names the request without what the aborted admission added (`toALOutboundUnadmittedMessage`):
no sequence and no record, which belong to positions it never committed, and no proof; a latest-wins supersedence the
admission stamped stays on it, as on every retained request. Under `rtc-with-ws-fallback` WS takes that request over and
stamps its own copy (D498); under `rtc` alone the send settles `rejected`. A granted publication enters only as a leg:
`enqueueIfAbsent` refuses one without a proof `refused/unsupported` before admission. A planner's message is checked
against its source with only a minted sequence removed (`validateALOutboundPlannedMessage`), so a planner that adds a
record or a proof is refused; a retained request, an admitted copy and a canonical row's replacement are compared to
the request without what its admission added (`toALOutboundRequestComparableMessage`: a minted sequence, and the record
and the proof the request did not carry).

On WS the server records at the first dequeue of a tracked row -- a relayed browser-origin row, its own publication,
or a row a producer wrote straight to the outbox, each under its own sender version -- for the audience the dequeue
re-check narrowed, less the sender; a row admitted to no audience (account-view and world rows) and an immediate
(live-only) send record nothing. The dequeue and the receipt retry re-check the captured audience
against durable presence (the WS server's `durable` filter): a session with no live connection generation anywhere is
dropped and judged outside whatever this instance's sockets hold; a principal row judges only the principal's own
sessions and keeps a co-member's, and a row naming neither a room nor a principal keeps its captured audience (the
addendum's Slice 7 limits). A receipt retry records outside only the drops it still waits on. At send each instance
re-checks against its own open sockets (`local`), and the cluster bridge reports the captured sessions that re-check
dropped beside the recipients it skipped below their position, judged only when the session's socket here is open; a
session live nowhere is left to the retry's durable re-check. On a relayed row and on the server's own rows (its
publications and every producer row it sends under its peer id) alike, a recipient the WS server skipped below its
position, or a session a re-check dropped, is one `outside` confirmation in the receipt record: the server's
outside-audience ACK, counted on the instance that dropped it as any ACK is
([`writeOutsideAudience`](../../services/ws-queue-box-server/ws-queue-box-server-track-order.ts)), which the origin
reads in the receipt's `outsideAudienceRecipientPeerIds`. A server publication's drop at its dequeue precedes its
record and is counted ahead; the record, which expects only the judged audience, never tallies it. The
read records
whenever the stored row holds no positions yet, and stamps nothing on the stored canonical: the full priors live on
the sent row (`ALStoredOutboundMessage.sentPositions`, `null` when nothing was recorded, which a row written before
reads as) and on every `send-prepared` payload, and the WS server derives each recipient's copy from them
([`toWsQueueBoxServerRecipientCopy`](../../services/ws-queue-box-server/scope/to-ws-queue-box-server-recipient-copy.ts):
that recipient's entry, or nothing when its position is already past the sequence). No copy carries the origin's
proof, and a copy of a row no dequeue recorded (a live-only hand-over) carries no record either. Members of one
dequeue group that record on one track chain their reads in sequence order, so each recipient's row is written once
per group, at the highest sequence
([`compute-al-outbound-group-sent-positions.ts`](./lane/compute-al-outbound-group-sent-positions.ts)). In a cluster
the dequeue records every captured session with a live connection generation anywhere; the local socket filter applies
at each instance's send. A dequeue whose captured audience was judged and reaches no socket on this instance sends to
nobody here rather than answering `no-route`; the awaited-connection hold or the receipt retry decides.

Known limitations:

- An origin whose socket was half-open when its receipt was written to it never gets that receipt; a
  socket write counts as delivery.
- Nothing tells the publishing instance that another one delivered a receipt, so a receipt whose origin
  is connected elsewhere, or whose row another instance claimed first (the WS namespace is shared across
  the cluster), is published until its row expires: 8 publications for a 30 s message, 27 for a 10 min
  one, about 67 at the 30 min receipt window, each one an idempotent no-write refusal at the origin.
- On a rolling deploy an older instance cannot decode `cluster-receipt` work and releases it
  non-retryable, so a receipt row it claims stops being published.
- A multicast or a room broadcast that carries a `groupRef` is authorized in the room it names, but its
  `route.contextId` is not bound to that room, so an application keying on `route.contextId` can misattribute it
  (known debt, D82; it predates S3c-i). Only a room unicast is refused when the two differ (R-S3c-i-33).

The origin admits a receipt through
[`ALOutboundReceiptAdmission`](./control/al-outbound-receipt-admission.ts), not through control
admission: one conditional commit fenced on the origin's version replaces the row's expected set with
the frozen audience and adds the recipients the receipt confirmed. A terminal receipt may overtake its
`admitted` one; every phase leaves its final snapshot as the row until the deadline plus the grace, so a
redelivered receipt finds nothing to move and is refused without a write, and any receipt past that
bound is refused. A receipt that completes the row, or a `timed-out` one whoever it confirms, ends the message in
its commit and keeps its row as that snapshot (a `timed-out` that confirms nobody new is never refused as moving
nothing); any receipt for a message that has ended is refused ("AL receipt names a message that has ended"), so no row is rebuilt and no second terminal fact is stated. A receipt writes no work and
no `ack-timeout` schedule; the server's receipts own it. Every receipt phase ends the sender's first-hop wait and
completes its timer in the commit that admits it.
`acceptReceipt` takes the receipt control message itself and records its verdict as the same
`control-admission` diagnostic, under the control's own id with the receipt's message as
`targetMsgId`, whether it commits or is refused. Only a receipt's diagnostic carries a `phase`
(`admitted`, `complete` or `timed-out`), straight after `reason`; every other control's has none. Every
`control-admission` diagnostic ends with the control's own `traceId`, then its `corrId`, so on a receipt
they follow `phase`.

Every receipt row states its `acknowledgement` settlement through `toALOutboundAcknowledgementFact`.
Under `hop` and `subtree` the row counts next hops, so its peers are both the hop lists and the
expected, confirmed and unconfirmed recipient lists. Under `receiver` and `leader` the row counts the frozen
logical audience, the handle reads `acknowledged` only once every expected recipient is confirmed, and the hop
lists are the local hop view (`OverlayTree`): the next hops the captured ack plan names
(`nextHopPeerIds`), of which those whose own completion ACK is in the ACK history are confirmed. A relay
in front of a recipient is therefore a confirmed hop while the recipient is a confirmed recipient. A next hop's own
terminal ACK that confirms no expected peer, a relay's own `subtree-complete` when it is no recipient, is admitted
for the hop view. A control states a settlement only when the fact it would state differs from the last one: a
receipt class moves, or, under `receiver` and `leader`, whose hop lists are the hop view, a hop completes. Under `hop`
and `subtree` the hop lists are the classes, so a hop's completion alone states nothing. So under `receiver` and
`leader` a hop-end after the receipt completed states the hop confirmed, and in every mode a true repeat, refused
`duplicate`, states nothing. A WS
client names no hop; at the WS server each recipient session is its own hop, complete once confirmed.

An RTT heartbeat is not one of these entries.
[`WsQueueBoxClientService.sendLive`](../../services/ws-queue-box-client-service.ts) writes it
straight to an open socket -- the same bytes `enqueueOutboxIfAbsent` sends today -- with no
admission read, bundle, work row, or retry. A closed socket answers `'socket-closed'` rather than throwing; a lost
heartbeat costs nothing because the next one, latest-value telemetry, simply replaces it.
`sendLive` also bypasses the WS submission-readiness fault port, so a harness `not-ready` hold
never delays an RTT heartbeat; that is acceptable only because the heartbeat is latest-value
telemetry that no conformance scenario holds or asserts on.

### Addressed sends on RTC

Since S3c-ii a typed send names one peer on every strategy but `ws-then-rtc`: `send(payload, { peerId })`. The
envelope is one unicast that names its room (`targets.groupRef`, `route.contextId` the room id), built by
[`createBrowserUnicastMessage`](../../../shared-web/browser/messages/create-browser-unicast-message.ts). The RTC
carrier plans it to the addressee directly and never relays it. Its receipt is the addressee's own ACK. A granted
peer send is frozen in the granted leg as a multicast of one and relayed, receipted and repaired as one. On
`rtc-with-ws-fallback` the same envelope is re-admitted on WS when the RTC leg states a retryable outcome inside the
deadline (D63): the addressee is not in the ready set (`no-route`); the addressee is connected but is not the
origin's overlay next hop, is missing from the room's active sessions, or the room is in a carrier gap (three
`not-ready` attempts); or the receipt ran out. On WS the room's router delivers it and the server counts the
one-member receipt (D71). A peer send to the server id is refused `unsupported` on an
RTC strategy: the server is addressed over WS (D76). A peer send whose `contextId` names another room than its own is
refused at the sender.

### Replies and `actions`

The envelope's `actions` (`ALActions`: `corrId`, `replyToMsgId`) are written by the builders and by nothing
else. `newALUnicastMessage`, `newALMulticastMessage` and `newALBroadcastMessage` take an `actions` option and write
it verbatim; none mints a value, so an ordinary send carries no `actions` and keeps its bytes. A message without
`actions.corrId` correlates as its own `msgId` ([`toALCorrId`](../../al-contracts/reply/to-al-reply-actions.ts)); the
browser puts `corrId` on the wire only when the caller passes one to re-ask under an earlier request's correlation.
`replyToMsgId` is no send input: only a reply carries it. The canonical outbound identity covers the id fields
(`outboundMessageIdentity`) and not `actions`, and a fallback re-admits the first envelope's object, so the
fallback-identity test pins `actions` across the admission retry, the post-admission hand-over and the volatile
downgrade.

[`toALReplyActions`](../../al-contracts/reply/to-al-reply-actions.ts) mints a reply's fields from its request, and
[`toALReplyContextId`](../../al-contracts/reply/to-al-reply-context-id.ts) its context: the room's id when the request
named a room, whatever context it used, else the request's context. Both reply builders use the two. The browser's
[`BrowserRallarMessageSender.sendReply`](../../../shared-web/browser/messages/browser-rallar-message-sender.ts)
builds a reply as a WS unicast to the requester's session, on the request's topic and in its room (the room's id as
the context), with the `command` purpose's reliability, receipt and TTL, and returns an ordinary handle. The server's
[`newALReplyMessage`](../../al-contracts/reply/new-al-reply-message.ts) builds the same unicast, in the same context. No RTC send builds a
reply. The reply slot, the matcher and the two reply diagnostics are described in the
[inbound navigation map](../inbound/README.md#replies-and-their-diagnostics).

### The volatile bound

The volatile pairs keep their owner and sent-message rows until the message deadline plus the receipt grace
([`computeALReceiptRetentionExpiryMs`](../delivery/compute-al-receipt-retention-expiry-ms.ts)), not for an hour. One
budget per session ([`ALVolatileSessionBudget`](../volatile-budget/al-volatile-session-budget.ts)) counts the data
admissions the session originates and receives on its volatile pairs, by message and by envelope bytes, the age of
its oldest admission and the ordering tracks of its own ordered sends. An outbound admission is released at its own
deadline; an inbound one at the earlier of its deadline and 30 s after its arrival
(`AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS`, R-S3c-ii-6), because the inbound deadline is the sender's clock
and choice. Controls, receipts, acknowledgements, repairs, retransmissions and relay forwards are not counted, and
neither is a message whose sender named no deadline (RTC signalling). An outbound data admission is refused
`capacity` when it would pass one of four limits (D179): `AL_VOLATILE_SESSION_MAX_ADMISSIONS` (1 000) admissions,
`AL_VOLATILE_SESSION_MAX_BYTES` (4 MiB) of envelopes, a deadline further than `AL_VOLATILE_SESSION_MAX_AGE_MS`
(5 minutes) from now, or a new ordering track while `AL_VOLATILE_SESSION_MAX_TRACKS` (64) are counted. The count and
byte limits hold two pools (D189): `own`, the admissions `tryAdmit` counts, and `inbound`, the arrivals `record`
counts. An own admission passes the count or byte limit only when it would take both the total past the limit and
the own pool past its share, `floor(limit * AL_VOLATILE_SESSION_OWN_SHARE)` with the share 0.5 (500 admissions,
2 MiB at the constants); arrivals are never refused, so the total may exceed the limit. The handle
ends `rejected` with `evidence.failure` `{ kind: 'refused', reason: 'capacity', limit }`, `limit` naming the limit
the ledger's refusal names (`'admissions'`, `'bytes'`, `'age'` or `'tracks'`; only the own pool is ever refused, so
the name says which pool too, and the refusal carries the own pool's figures beside the totals), and no fallback is
tried, because the
other carrier shares the budget. The RTC circuit breaker does not count a `capacity` refusal as a failure. A counted
send whose commit then admits nothing stays counted until its deadline: the ledger has no release call.

A track is the ordering track key of a send that states an ordering key and a sequence together
([`toALOrderingTrackKey`](../../al-contracts/al-runtime.ts): the ordering key, the sender and the epoch); a send
that does not state both names none. A track is counted while the ledger holds
at least one counted admission on it, so it leaves the count when the last of them reaches its deadline. A received
message never opens a counted track. The ledger answers its state in one read, `readReport(nowMs)`
(`ALVolatileSessionReport`: the usage, the totals of both pools, with `oldestAgeMs`, 0 when nothing is counted, and
`tracks`; `own` and `inbound`, each pool's `admissions` and `bytes`; the limits; and `overloaded`), which the browser
exposes as `rallar.messages.readUsage()` and the black-box `stats` result as `rallar.alm` (D180, D189); beside it
`readUsage()` reports the connect's inbound `ordering` counters
([inbound README](../inbound/README.md), "Entry, omission and witness"), which the ledger does not keep.

An inbound admission is counted and never refused, and it counts toward the same limits as the session's own sends
(R-S3c-ii-3), in the inbound pool. Under one shared pool arrivals alone refused own sends: refusal began where
`30 * inbound rate + own deadline * own rate` reached the 1 000 count, so 33 arrivals a second refused two thirds of a
once-a-second own stream and 34 refused all of it, and 8.5 KB envelopes reached the byte limit at 16 a second. With
the share (D189) an own send is refused only once the own pool holds its 500, so a session keeps that many counted own
sends, about 16 a second at the 30 s default deadline, whatever arrives; arrivals holding the total at 1 000 still let
500 own sends through and refuse the 501st. The bound is also shared with the platform's own state sync that the
WS inbound runtime admits on the volatile pair (`group-state.event`, `client-state.snapshot`, `client-state.event`,
R-S3c-ii-7): a lane agent that leaves and rejoins a room holds about 26 KB of it, under one per cent of the
production limits. Whether platform topics leave the application's bound is an open decision for the maintainer.
While the smallest next own send would be refused at the count or byte limit (the total and the own pool both at their
bounds, D189) the session's QoS provider reports `overloaded` for the session's own outbound data originations only,
so arrivals alone no longer set it: never for a control, a receipt, an acknowledgement, a repair, a relay forward or an
inbound plan (R-S3c-ii-8), so a session at its bound still acknowledges, forwards and delivers for other sessions. Under
the default policy the RTC origin drops a best-effort room send that reads it, and that drop reads `capacity` as the
admission bound's refusal does: at the bound every send, best-effort or not, on either carrier, ends `rejected` with
`{ kind: 'refused', reason: 'capacity' }` and is never handed to a fallback. That drop names no `limit`, because
`overloaded` names none; only the ledger's own refusal does. The WS client runs the same congestion planning on its own
new data admissions but never reads `overloaded`: its session bound refuses a send `capacity`, naming the limit, after
the plan; a send the plan already dropped `congested` never reaches the bound. The RTC rate limiter spends its token
before the plan, so a refused send still spends one: a burst of refused sends can push a later send inside the bound to
`rate-limited`, which hands it to WS, where the shared budget admits it.

Channel backpressure is the policy's second live input (D184). A carrier reads it only when it first plans one of the
session's own new data admissions: the RTC overlay for a room send when the reliable channel of every ready next hop
holds at least its `flowControl.highWatermarkBytes` buffered (`computeRtcBackpressure`), the WS client when the socket's
`bufferedAmount` is at least `AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES` (256 KiB). A control, a receipt, a relay forward,
a retransmission, a replan, an inbound plan, an RTC unicast and an unaddressed RTC send never read it, and a scripted
transport fault's `backpressure` action holds a carrier backpressured for the frames it matches. The congestion policy
applies when the live state is `overloaded` or `backpressured`, and the drop names its cause (D185): `overloaded` first,
its drop the `capacity` refusal above; a backpressure drop is the drop code and refusal reason `congested`, which
`AL_DELIVERY_FALLBACK_REFUSAL_REASONS` lists, so an `rtc-with-ws-fallback` send refused `congested` on RTC is handed to
WS at admission with a refused RTC attempt row and no `carrierFallback`, and a send with no fallback ends `rejected`
with `{ kind: 'refused', reason: 'congested' }` and no attempt. `drop-low` drops a priority-0 (or lower) send only,
`reject` every send, `defer` none; a kept send waits at submission, where backpressure is a `not-ready` on both
carriers. Each decision is one `congestion` diagnostic, `{ carrier, cause, action, priority, msgId, atMs }` with `action`
`drop` (the outbound admission), `defer` (the submission, for every message the page holds there, relay forwards and
controls included) or `hand-over` (the browser's message dispatch, which hands a congested RTC leg to WS at admission
and names the message's own normalized congestion priority, not the one the carrier's QoS provider planned with) (D186);
the black-box harness counts them as `ALCongestionCounters`. Beside the three actions the counters carry
`rateLimited` and `circuitOpen`, the messages whose RTC hand-off the carrier's per-session rate limiter or open circuit
breaker refused (each `rtc-handoff-refusal` diagnostic adds its `messageCount`), and `queuedBytesHighWater`, the most
bytes an RTC data channel held queued when a submission read it (the largest `rtc-queued-bytes-high-water`).

Congestion duration is a per-message episode (D665). `atMs` is the runtime clock's reading at the decision, the clock
that stamps the delivery settlements, so a deferral and a settlement compare. An episode opens at a message's first
`defer` on a carrier and ends at the first `attempt-settled` of that message on that carrier whose outcome is not
`not-ready`, or at its `expired` settlement; the deferrals in between are the same episode. A deferral arrives on the
outbound diagnostics port and a settlement on the carrier's settlement sink, so one owner per connect measures them:
[`ALOutboundCongestionEpisodes`](congestion/al-outbound-congestion-episodes.ts), which the browser places in front of
both (`BrowserOutboundCongestionEpisodesSink`). It reports `durationMs`, a `BoundedHistogram` on
`AL_CONGESTION_EPISODE_BOUNDS_MS` (twelve bounds from 10 ms to 60 s), `openEpisodes`, the episodes no settlement has
ended, and `unrecordedSamples`: an episode it let go at `AL_CONGESTION_MAX_OPEN_EPISODES` (1 024, the oldest first)
or whose settlement was stamped before its deferral, counted and never estimated. A `drop` and a `hand-over` open no
episode. The report is `rallar.messages.readUsage().congestionEpisodes`, cumulative over the connect and across both
carriers; a relay forward or a control a carrier deferred is measured like the session's own send.

The age limit bounds the admissions the ledger counts, not the ordering state the pairs keep (D181): the volatile
pairs keep an ordering track for the repository's hour (`orderingTrackTtlMs`), because a receiver that forgot a track
would read the next sequence as a gap, and every track quiet for 5 minutes would stall on its repair. What the session
holds per message, track or peer is bounded instead of kept for the owner's lifetime. The send controls' cancelled and
handed-over message ids are [`LatestRepository`](../../cache/LatestRepository.ts) entries with
`DEFAULT_AL_REPOSITORY_TTL_MS` (60 minutes) as their TTL, the durable lane's row retention, so a cancelled durable
message a worker picks up after 5 minutes still does not send. The browser's resync recovery keeps the tracks it has
invoked a recovery owner for in a `LatestRepository` with `AL_VOLATILE_SESSION_MAX_AGE_MS` as its TTL, renewed by
each of the track's resynchronizations, so a track that resyncs again after that long without one invokes the owner
again; it remembers at most `AL_INBOUND_MAX_ORDERING_TRACKS` (256) tracks, the first remembered leaving first, even
one that resynchronized again since (D191). `WebRtcRxStreamerService` numbers every peer's
round-trip measurements from one counter and keeps no version per peer. None of them adds a timer or a sweep of its
own: a repository forgets an expired entry it reads, and an accept may sweep the rest, at the repository's eviction
rate.

**Limit:** the memory pairs plateau rather than empty: an idle inbound ordering track keeps two rows for the hour after
its last message, its ordering snapshot while it is one of the store's 256 (D191, inbound README) and its delivered
marker, which the cap leaves, and each sending origin keeps one outbound version row (`versionTtlMs`, 1 h). The long-run test
sends on the application's own sequences, as the browser does: only the browser builds the volatile outbound pair, and
the browser's volatile pair never mints: a send that asks its outbound for a sequence is admitted on the durable pair.
A volatile pair that did mint would drop a track's ordering head with its last sent row, after the deadline plus the
receipt grace, while a receiver keeps the track for the hour, so a track silent for longer than that would restart at
sequence 1.

### Grouped sends

`enqueueAllIfAbsent` admits one sender's messages as one group, controls and data alike, through
`ALOutboundDispatchAdmission.commitAll`'s optimistic group commit. Each member uses the single-message decision in a read of its own; `commitBundles` then reads
every bundle's effect rows and canonical pair in one observation read, fences the sender version once, runs every
bundle's own pending, effect, observation and identity fences, writes every bundle and bumps the version
once. The group falls back when a member settles before its write (it fails validation, finds its own
pending admission, or has nothing to commit), when a version moved between the members' reads, when two
bundles write one row, when the store answers anything but `committed`, or when the group attempt throws.
Every member then goes through the single-message commit, with its retries, one after another, and keeps its own answer:
a planning refusal is that member's `failed` value, as a single send answers it, and a member whose
single commit throws does not stop the members after it; the first such throw is rethrown once every
member ran, and the runtime wakes the owner for the members that landed before it rethrows. The RTC
multicast manager applies its circuit breaker once per group and its rate limiter once per group of the session's own
sends; a control hand-off answers an inbound message its admission already bounded and spends no quota.

## The publication stage

[`ALOutboundPublicationStage`](./publication/al-outbound-publication-stage.ts) paces the replaceable values of
`live` channels before admission (D469, D470). It owns one lane per channel route (`toALPublicationLaneKey`,
`topicId/typeId`), each with the channel's `ALPublicationPolicy`, its streams (`toALPublicationStreamKey`, in
first-staged order, each holding at most `retainNewest` values oldest first) and its next opportunity. A staged
value ([`ALOutboundStagedPublication`](./publication/al-outbound-staged-publication.ts)) keeps the `msgId`,
`traceId` and deadline of the message the sender built.

`stage()` refuses a value heavier than `drain.bytes` as `oversized` and settles nothing, so the caller settles the
refusal. [`ALOutboundPublicationLedger`](./publication/al-outbound-publication-ledger.ts) counts the streams, staged
values and staged bytes of every lane against the stage's `ALPublicationStageLimits` (the composition root passes
`AL_PUBLICATION_STAGE_LIMITS`, 64 / 1 000 / 4 MiB) and reads the stream as retention would leave it, so a value that
displaces its stream's oldest frees that value's share; a value that would still pass a limit, checked streams, then
values, then bytes, is refused `capacity` with that `limit` and settles nothing either (D477). Otherwise it settles
`staged` at once, and a value that pushes its stream past `retainNewest` displaces the
stream's oldest, which settles `superseded` with the new value's `msgId` as `replacementMsgId`; the stage appends
the value and keeps the newest `retainNewest` with [`retainNewest`](../../cache/retain-newest.ts), the primitive the
motion buffer's per-entity window shares. Staging on an idle lane
opens an opportunity at once: the stage runs it itself after the staging returns, rather than waiting for an engine
round, whose readiness probes include the durable lanes' storage reads, and hands it to the engine with
`retainSettlingWork`, so a failure is reported and `stop` joins it. On a scheduled lane the value waits for that
lane's boundary.

The stage registers one task on the session's `InboxOutboxEngine`; its `isWork` is "a lane is due" on the injected
`Clock`, and its opportunities run one at a time whichever path started them. Each due lane runs one opportunity:
[`computeALPublicationSelection`](./publication/compute-al-publication-selection.ts) settles the values whose
deadline passed `expired`, then takes the streams from the lane's cursor (`startIndex`), each oldest first, until the
next value would pass `drain.messages` or `drain.bytes`; the rest wait, and the lane's cursor moves to the returned
`nextStartIndex`, the stream after the last one served (D478). The selection goes to the caller's `submit` port; a `submit`
that throws settles each selected value `admission` `failed` with its message, and the opportunity writes one
payload-free `publication-opportunity` diagnostic (`laneKey`, `atMs`, `selected`, `deferred`, `expired`,
`bytes`). The next boundary is one cadence after the opportunity
([`computeNextCadenceAtMs`](../../resilience/timing/cadence.ts), whose boundary the motion send gate shares through `computeCadenceBoundaryAtMs`), so a lane the
engine reaches late runs one bounded opportunity, never a catch-up burst. A lane its opportunity emptied stays
scheduled for one more boundary, so a value staged within the cadence still waits, and then goes idle. After the due
lanes ran, the task calls `wakeAt` with the earliest next opportunity, or with `undefined` once every lane is idle.
`dispose()` leaves the engine and settles every staged value `skipped`/`disposed`.

`cancel(msgId)` removes a value the stage still holds and settles it `cancelled`, returning whether it held one; a
value an opportunity selected is its carrier's to cancel. A `stage()` whose policy differs from its lane's
reconfigures the lane first
([`computeALPublicationReconfiguration`](./publication/compute-al-publication-reconfiguration.ts)): values heavier than
the new `drain.bytes` leave and settle `refused`/`oversized`, each stream is re-trimmed to the new `retainNewest`
(the displaced settle `superseded`), and the next opportunity becomes the earlier of the scheduled one and one new
cadence after the last, never a second dispatch (D479). Each value's outcome (`staged`, `superseded`, `expired`,
`refused` with a capacity refusal's `limit`, `cancelled`) writes one payload-free `publication-staging` diagnostic
(`laneKey`, `msgId`, `traceId`, `atMs`, `outcome`, `limit`) and counts in the ledger; `readReport()` returns the
stage's `lanes`, the ledger's holdings and limits, and its cumulative counters, with `admitted` and `deferred` from
the opportunities (D480), and its `figures` (D651): the bounded histograms `selectionAgeMs`, `selectionToAdmissionMs`,
`drainMessagesPercent` and `drainBytesPercent`, and the counts `submittedOpportunities`, `missedOpportunities` and
`unrecordedSamples`. Whenever `unrecordedSamples` is 0, `selectionAgeMs.count` equals the `admitted` counter and the
other three histogram counts equal `submittedOpportunities`; a sample a histogram refuses is counted in
`unrecordedSamples`, never thrown or clamped. `selectionToAdmissionMs` ends at carrier admission, because `submit`
settles there. A value still staged at `dispose()` settles `skipped`/`disposed` with no event.

The stage never sends and never admits: what `submit` hands to a carrier enters today's admission unchanged, so the
frozen audience, fallback, supersedence and receipts apply to it as to any send.

## Read and failure boundaries

[`al-outbound-admission-validation.ts`](./admission/al-outbound-admission-validation.ts)
checks complete snapshot fields and trusted message slots.
[`al-outbound-effect-validation.ts`](./al-outbound-effect-validation.ts) checks
effect identity, metadata, discriminated payloads, prepared transport values,
and embedded queue messages. The backend wraps decoder failures in
`ALAdmissionCorruptionError`. Corrupt admission snapshots and repair dependencies
remain typed failures rather than guessed state or retryable transport failures.

Queued work has a separate terminal boundary: after reservation, a malformed payload,
foreign namespace, wrong queue slot, or inconsistent prepared message is released as
`NON_RETRYABLE`. Its stored content is retained, and valid claims from the same batch
continue. This applies to normal claims, timeout recovery, and exhausted-attempt
finalization. If the terminal write fails, the reservation remains recoverable through
ordinary QueueBox claims. Release uses the existing observed-entry comparison and
expiry conditions; a failed comparison returns a lost-reservation result.

Each store lane, browser and server alike, sweeps for lapsed leases and exhausted reservations on a
limiter pair of its own, the ResourceInbox dequeuer's lock-limiter design on the lane clock: the
first sweeps run on the lane's bootstrap batch, and no timeout sweep runs on a batch whose claim
filled the page. A sweep spends its allowance only when it comes back with room to spare, which
closes its window for one lease; a sweep that fills its room keeps the window open, so a
backlog of crashed or exhausted rows drains on consecutive batches. While a sweep's window is closed
the readiness scan does not advertise the reserved rows that sweep would recover, so no batch runs
empty waiting for it. A crashed lease or an exhausted row, a backlog included, is recovered at most
16.6 s after its lease ends: the window reopens one lease after the last spent sweep, then the
remembered readiness ages and the idle engine passes once. The bound assumes the readiness scan, 16
reserved rows per type, sees the row; a crashed row hidden behind 16 live leases is recovered by the
first batch that sweeps with its window open. On the PostgreSQL lane it also assumes the database
clock is not behind the lane clock: the scan advertises a lease end on the lane clock while the
sweep tests the lease on the database clock, so with the database δ behind, the sweep a lease end
triggers can come back empty and spend its window, and the worst case becomes lease end + δ +
16.6 s; the browser lanes are exact. The claim page is ordered by key, not by readiness: 15 or more
receipted sends left unacknowledged within one ACK timeout (with a send's own timeout row, 16 rows
ahead of its `send` row) still hide the next send's row until the first of them falls due; a
readiness-ordered scan is a later slice. The inbound owner sweeps on every batch.

One work batch releases every claim it collected in a single queue write, with a disposition
per entry; `releaseDurationMs` measures exactly that one write, run once at the batch's end
inside a `finally` so a throwing selection or claim cannot strand a reservation. A lost
reservation inside that batch drops the affected entry and retries the rest as one write; a
queue write conflict degrades the batch once to releasing each entry serially. A retained claim
is different: it releases on its own settlement, independently of any batch, one claim at a
time, with no coalescing window or timer.

A storage failure is a value at the lane, never a raw throw out of it
([`toALStorageUnavailable`](../storage/al-storage-unavailable.ts) names its cause). A send whose
commit fails for its storage settles `storage-unavailable` with that cause, where a
`NonRetryableException` settles `failed`; it wrote nothing. A control or a receipt its store cannot
persist answers `storage-unavailable` with that cause, never a raw throw: the inbound `admit-control`
claim that replays it retries, and a control arriving inline from its carrier is answered not handled,
its inbound `admission-outcome` naming the storage failure. A cancel or a hand-over whose lane cannot store
the end records the failure on that store's health and stays in the page's memory. A
commit inside a work claim (a dequeued row, a repair) still throws into its claim, which retries, and
a batch that fails for its storage records the failure on the pair's health instead of logging it.
A committed send and a flushed batch are recovery points, which end a `failing` health; a committed
control or receipt records none, so a failure a control recorded stays `failing` until a send or a batch
commits. A write deadline, a corrupt row, a conflict and a code defect keep their own meanings.

Readiness reads queue status and timestamps only. It never needs a transport decoder
or reparses terminal payloads. Payload validation occurs on the claimed item before
any message effect is returned for execution.

Queue-entry keys are decoded through the shared
[`ResourceEntry` key codec](../decode-al-admission-resource-entry-key.ts). Every
work payload is encoded through the canonical envelope/entry codec. QueueBox's own
codec preserves reservation and retry timestamps as ISO strings: IndexedDB structured
cloning does not preserve Temporal instances. An old empty-object timestamp remains corrupt.
Each work row validates its full namespace, effect identity, queue slot, and deadline
against its canonical reference.

## Transport attempt settlement

Transport adapters return an explicit result; a void return never establishes a send.
RTC registration uses the existing native queue's `onSettled` callback. Its local
attempt expires at the earlier of the message deadline and its durable claim lease.
An attempt lease ending before the message deadline permits another attempt with
the same identity; it does not expire the logical message. Settlement carries factual
per-message evidence of whether native submission was attempted. Closed or unavailable
channels, backpressure, and untouched queued siblings cleared by a channel
error return readiness. A native send that throws remains an attempted failure with
an uncertain delivery outcome.

Every `not-ready` either carrier returns names `retryAfterMs`
`AL_SUBMISSION_NOT_READY_RETRY_MS` (50 ms). Backpressure is one of them: on RTC the
channel's synchronous `dropped` result at or above its high watermark (a lane that
queues on overflow keeps queueing), on WS a socket at or above
`AL_WS_BACKPRESSURE_HIGH_WATERMARK_BYTES`, which holds every message, controls
included. Each such deferral states a `congestion` `defer` diagnostic.

Readiness uses the existing `RETRY` and future `nextTs`: release refunds only the
current reservation's attempt, preserving earlier failed attempts. It records neither
adaptive success nor adaptive failure. Real attempt failures retain their normal
retry budget. Readiness rechecks are bounded by the original message deadline, and
settlement at or after that deadline completes physical work without sending or creating
an acknowledgement. Cancellation ends the attempt directly. Submission
remains separate from receiver acknowledgement and application completion.

A replacement's own admission commit states `superseded` for every predecessor it newly
marks replaced -- one `ALDeliverySettlement` per predecessor, stated by
[`ALOutboundDispatchAdmission`](./al-outbound-dispatch-admission.ts)'s private
`emitCommitSettlements` from the facts `toALOutboundCommitSettlements`
([`compute-al-outbound-dispatch.ts`](./compute-al-outbound-dispatch.ts)) computes, before
that commit call returns to its caller. Only the commit
that moves the key's latest-supersedence pointer states it; a later commit of the same
message, or a predecessor the admission observed already replaced, states nothing again. By
the time a superseded predecessor's own queued work next runs, the lifecycle this settlement
named is already terminal, so its own attempt-time and dequeue-time supersedence checks
(read fresh in `writeAttemptedSend` through `admissionStore.readSendGuards` and in
`admitDequeuedMessages` through `admissionStore.readMessageSupersedence`) add nothing new:
dequeue completes the claim without sending and without a settlement of its own, and a
`send-prepared` attempt still states its own `attempt-settled` (`outcome: 'superseded'`) but
only as late evidence on a lifecycle a terminal settlement already closed.

The RTC Promise executor captures its resolver synchronously before `sendJson`
registers the callback. Native completion invokes it after queue mutation. This is
a language-level event bridge, not a forward dependency between services. No
additional queue, pending-work registry, or timer is introduced by settlement.

`ALOutboundMessageRuntime.cancel(msgId, traceId)` aborts one message's own live transport
signal and states one `cancelled` settlement under the caller's trace; disposal aborts every live signal but
states none of its own. Either way, an attempt that already stated `attempt-started`
still terminates with its own `attempt-settled` (`outcome: 'cancelled'`, `willRetry:
false`) -- stated directly when the abort lands before the carrier runs (inside the
admission-store reads `writeAttemptedSend` makes first), or by the carrier's own
settlement when it lands during or after the send. The page remembers the cancel for
`DEFAULT_AL_REPOSITORY_TTL_MS` (60 minutes, D181), which is its own immediate guard, and the lane that holds
the message ends it where it is stored, in a commit the cancel starts and `dispose` joins, so the next owner
drains nothing for it (D752). `handOver(msgId)` aborts the same signal, ends the message the same way and
states nothing at all; see [A cancel and a hand-over end the message](#a-cancel-and-a-hand-over-end-the-message).

Every settlement in this section is a per-message `ALOutboundSettlementFact` stated
through this owner's [`ALOutboundSettlementEmitter`](./al-outbound-message-runtime.ts):
the runtime's private `emitSettlement` stamps the fact with its own `carrier`, the
current `atMs` and the `lane` that stated it (`durable` or `volatile`; a runtime-wide
`cancel` names none) into the `ALDeliverySettlement` the sink receives, and guards that call
so a throwing sink logs and returns rather than changing dispatch, retry, or claim
behaviour. Every fact carries a required `traceId`: the trace of the request whose commit stated it.
That is the message's own trace, the replacement's on `superseded`, the admitted control's on a
settlement a control states, and the caller's on `cancel`. No settlement mints a trace. The browser's sink
for these settlements is the in-memory delivery registry,
[`BrowserRallarDeliveryRegistry`](../../../shared-web/browser/messages/browser-rallar-delivery-registry.ts)
(`packages/shared-web/browser/messages/`), which reduces each settlement into the
sending handle's lifecycle.

## Receipt ends and the hand-over

Every receipt this owner tracks ends in a settlement (S3b, D63, D64):

- **Budget exhaustion.** When the last `ack-timeout` window closes with the budget spent (`attempts >= maxAttempts`),
  [`ALOutboundRepairAdmission`](./al-outbound-repair-admission.ts) ends the message in one commit (below), deleting the
  repair-attempt row and keeping the pending-ACK row, and, once it lands, states `receipt-exhausted` with the row's
  confirmed and unconfirmed peers (next hops under `hop`/`subtree`, logical recipients under `receiver` and `leader`).
  The handle reads `failed` and keeps who confirmed. The message is marked ended, so the fact is stated once across
  replays and reloads and a late ACK is refused and completes nothing. Under persistent loss a revealing message whose
  recipient holds it buffered behind the gap is never confirmed (that recipient answers no copy until the release), so
  its handle ends `receipt-exhausted` too. A deadline charges only once the first transmission has left (below): the
  first deadline after it left charges the first attempt, so with the defaults (a 2 000 ms ACK timeout, three receipt
  retries) and uninterrupted timeout execution the budget ends about 6 s after that deadline, about 8 s after admission
  for a frame that leaves at once. Each gap repair that dispatches the message moves the receipt's deadline a timeout
  on, so renewals push the end later. A send whose carrier takes nothing is not charged and ends at its message's
  deadline, which the handle reads as `expired`. Downtime leaves unspent attempts available until the original message
  deadline.
- **A requester's repair budget.** `repair-exhausted` ends the open receipt at once with its message (`maxRepairs`,
  above), keeping its row, so the message's other receivers lose the receipt's remaining retries.
- **The first hop.** A WS client's first-hop wait whose retries are spent ends the message and states
  `receipt-exhausted`; a receipt from the server ends the wait instead and leaves the receipt to the server
  ([Server receipts on WS](#server-receipts-on-ws)), and the server's `not-yet-in-sync` ends it with nothing stated.
- **A hop that refuses for good.** An admitted `expired`, `unauthorized`, `membership-fenced` or `stale` NACK
  removes the row and ends the message;
  the commit states the incomplete acknowledgement, then `receipt-exhausted`. `resync-required` keeps its
  `relay-rejected` (D50).
- **Completion at a re-plan.** A retry whose plan replaces the expected set (the RTC missing-recipient
  repair, under `hop` and `receiver`) and so completes the row deletes it, marks the message ended and states the
  acknowledgement that completed it; the copies that dispatch queued meet the marker at `readSendGuards` and are never
  written.
- **A receipt no row tracks.** An admission whose plan writes no row -- a `qos.ack` timeout of 0, or a
  `hop`/`subtree` receipt that expects nobody -- reports `trackedReceiptAlgo: 'none'`, so the handle ends
  at `transport-accepted` with the downgrade in evidence (R-S3a-4). A `receiver` receipt with an empty
  expected set keeps `receiver`: the WS server's `admitted` receipt creates its row, and an empty frozen
  audience completes it at admission. That admission ends its message in its own commit: it writes the stored
  row `ended` and the canonical row `COMPLETED`, so no row is left for a later dequeue, the acknowledgement is
  stated once, and a queued copy of it leaves no frame (D753;
  [`isALOutboundEmptyAudienceReceipt`](./message-end/to-al-outbound-empty-audience-receipt.ts)).
- **Ends the deadline settles.** A receipt whose message is gone (the orphaned cleanup) and the WS
  server's `timed-out` receipt both arrive at the message deadline, which the handle already reads as
  `expired`.
- **The `not-yet-in-sync` budget.** When its retry schedule is spent the owner states
  `not-yet-in-sync-exhausted`. It ends nothing on its own -- the receipt budget still ends the message --
  and is one of the declared retryable outcomes below.

**A terminal settlement ends its message.** The commit that states a terminal settlement also ends everything the sender
holds for the message, and from then on the sender writes no frame and starts no timer for it. Terminal are the receipt
completed, `receipt-exhausted` (its budget spent or a hop's refusal), a server's `timed-out` receipt, a first-hop wait
spent, `repair-exhausted`, a re-plan refused for good and a relay's rejection. An empty frozen audience's completion at
admission is a receipt completed, and a cancel and a hand-over end their message with the same commit (below), to
which a hand-over adds the receipt row's delete. The commit is
[`toALOutboundMessageEndBundle`](./message-end/to-al-outbound-message-end-bundle.ts): the repair-attempt row's delete,
the first-hop wait's delete, the completion of both timers, and the marker: the field `ended` of the stored message row
every message already has (`<namespace>:sent:<msgId>`), so the marker costs no read and one more row write per message
end. The receipt row stays, whatever the carrier, as the final snapshot of who confirmed. It is fenced on the sender
version, so a commit decided on an older read conflicts and decides again on a read that holds the marker. A message
this sender only dequeues from an external source holds no row and gets no marker; every later path stops at the missing
row. Every end through this bundle keeps the receipt row as a final snapshot to its expiry -- an open receipt the end
settles, a complete one and a server's terminal one (a terminal NACK's removal and a hand-over still delete it) -- since
a gap request, own-word or relayed, is admitted by reading its revealing message's row, so the renewals of a gap
revealed by a message whose receipt ended still reach the origin. The marker lives as long as the row, past the
deadline, so a terminal fact is stated once per message across reloads. Afterwards a dispatch of the message answers
`skipped`/`message-ended`, which is never stated on the settlements port, so no handle ever reads it; a queued copy
meets the marker at `readSendGuards` and completes without a frame; a receipt is refused; a kept incomplete receipt row
is the final snapshot, so
[`validateALOutboundEndedMessageControl`](./message-end/validate-al-outbound-ended-message-control.ts) refuses an ACK or
an outside-audience NACK while it stands and no settlement follows the terminal one (a kept complete row still admits
them, a next hop's late terminal ACK included), and the server's own `commitOutsideAudience` answers `absent` for it;
any other NACK but a gap is refused; a gap NACK or repair request, which names the message whose arrival revealed the
gap, is admitted and served for every sequence it names that has not ended, the ended one served nothing and charged
nothing; and a timer that meets an ended message's kept incomplete row writes nothing. A control commit decides its own
end in [`toALOutboundControlMessageEnd`](./message-end/to-al-outbound-control-message-end.ts). Not terminal: a written
`ack: 'none'` send, whose obligation to repair runs to its deadline; an `admitted` receipt; `not-yet-in-sync-exhausted`;
a NACK from one peer on a send that holds no receipt. The deadline writes no marker: time is the marker. Supersede keeps
its own path. One frame can still follow an end that lands between
`readSendGuards` and the carrier's write.

**A deadline whose attempt has not left.** One rule decides a deadline of both timers that retry a send, the receipt's
`ack-timeout` and the first-hop wait:
[`computeALOutboundAttemptDeadline`](./attempt-deadline/compute-al-outbound-attempt-deadline.ts) answers `wait`,
`exhausted` or `retry` from the timer's budget and whether its attempt is held, and
[`readALOutboundSendAttemptHeld`](./attempt-deadline/read-al-outbound-send-attempt-held.ts) reads held: every copy the
message is planned with at the deadline has a send row of that attempt still pending, and there is at least one; the
read stops at the first copy that has none. A held attempt charges nothing and waits a whole timeout more, committing
only the next window, so a carrier that takes nothing does not spend a send's retries. The first-hop wait reads the
attempt it stands on. The receipt reads only the dispatch that opened it (`firstAttempt`), and only while it has
charged nothing: a retry is planned for whoever is still unconfirmed and no row names its copies, so a retry is charged
at every deadline whether or not its copy left. Charged as before: a held retry; a first attempt of which one copy
left; a first attempt the message is no longer planned with (a route lost, an overlay change); a receipt row that
names no first attempt. The copies a gap repair or a not-yet-in-sync retry queues for a held message are their own, so a
release can still hand the carrier more than one frame of it. A deadline that runs in the batch that hands the copy
over reads its row reserved and waits one timeout more.

A `not-subscribed` NACK speaks for one recipient, as an ACK does: under a logical receipt whichever hop forwarded it,
under `hop` and `subtree` only from the recipient itself. It comes from a next hop of the message or from a peer a repair may come from (a recipient the receipt expects, a unicast's addressee,
a hop every frame passes), and a WS session's NACK speaks only for itself; it moves a recipient the receipt still owes
into the row's `outsideAudiencePeerIds` and is refused for any other peer, a repeat or a confirmed one, and no ACK
confirms a recipient after it. A dishonest peer can thus remove itself. Under a `receiver` or `leader` receipt on RTC
a NACK for a counted recipient must carry that recipient's verified signature, so a next hop can no longer remove a
recipient it claims to relay for, though the origin does not know a hop's subtree. The recipient's own
`subtree-complete-not-subscribed` ACK, from a next hop, is admitted as that hop's completion and confirms nobody;
while the receipt still owes that recipient it also stands for the NACK, from that next hop or forwarded by a peer a
relayed NACK may come from
([`isALOutboundRecipientControlSender`](./control/is-al-outbound-expected-repair-peer.ts)), so a lost NACK records
the recipient outside at once, as every relay reads it
([`isALImpliedNotSubscribedNack`](../delivery/is-al-implied-not-subscribed-nack.ts)). One own-word rule covers the
hop-end, the outside-audience NACK and the relayed gap NACK
([`isALReceiptModeOwnWord`](../delivery/is-al-receipt-mode-own-word.ts)): under a logical receipt, whose counted
recipients sign their own, any hop's control speaks for its recipient; under `hop` and `subtree` only the recipient's
own control on its own channel does, so one hop cannot move another outside
([`isALOutboundImpliedNotSubscribedAck`](./control/is-al-outbound-implied-not-subscribed-ack.ts)), and a hop's NACK
naming another recipient is refused `unauthorized`
([`validateALOutboundRelayedNack`](./control/validate-al-outbound-relayed-nack.ts)).
The acknowledgement a NACK states reads its hop view from the ACK history. It ends no receipt and hands nothing over:
the row completes once every expected recipient is confirmed or outside and one is confirmed, and a receipt whose
every recipient is outside stays open to its deadline and ends `receipt-exhausted` (PL10, PL16).

An RTC origin resends a stored granted publication only while its cached snapshot still grants it `publish` (S3-R8):
the RTC carrier applies
[`computeRtcRepairRefusal`](../../multicast/publication/compute-rtc-repair-refusal.ts) before every
repair, re-plan and dequeue of a signed message, and a re-plan it refuses `no-publish-grant` ends the message
([`resolveALOutboundReplanRefusalSettlement`](./control/resolve-al-outbound-replan-refusal-settlement.ts)): the
ack-timeout retry deletes the pending receipt under the version its decision read, the dequeue and the retransmit end
it inside the dispatch's own commit, a conflicting commit decides again from a fresh read, and the handle settles
`rejected` with nothing handed to WS. Only a revoke the snapshot shows ends it: with no readable snapshot the room's
own planning decides, as for any stored send. A dequeue also ends an `unsupported` re-plan, as it ends `no-publish-grant`
(S8ii-R2): a held send its carrier cannot take at its freezing dequeue (a keyless counted recipient, a room past the RTC
room limit, or any other `unsupported` refusal met there) settles `rejected`, its receipt deleted in the dequeue's own
commit, and the fallback does not take it, since no fallback-capable leg is ever held. The site is the re-plan's own
(`ALOutboundReplanSite`): the retransmit and the ack-timeout retry keep their silent drop of an `unsupported` re-plan,
so the receipt still runs on to `receipt-exhausted`, which the fallback takes, and an `unauthorized` re-plan keeps its
silent drop at every site.

A receipt that a control ends -- a complete ACK or a terminal NACK -- completes the send's `ack-timeout`
work row in the commit that ends it, so no timeout batch runs for it; a row a batch already leased is
left to that batch, which reads the ended receipt and completes. For a complete receipt the old timeout
batch also cleared the receipt row; that row now waits for its own expiry, which is harmless: every
reader treats a complete receipt as ended.

**The hand-over (D66).** `ALOutboundMessageRuntime.handOver(msgId)` gives a message to another carrier's
owner: it remembers the id for `DEFAULT_AL_REPOSITORY_TTL_MS` (60 minutes, D181), aborts the live attempt (which still settles its own
`attempt-settled`), completes every later effect of the message silently, ends the message on the carrier it
leaves and deletes its receipt row there (below), and states no settlement -- the message is not cancelled.
RTC reaches it through `WebRtcRxStreamerService.handOverOutbox` -> `WebRtcOverlayMulticastManager.handOver`. Only the page's live
handles hand over: a durable RTC message resumed after a reload is not handed over (D64), and one that handed
over before the reload stays ended on RTC, so the reloaded page sends nothing for it there.

### A cancel and a hand-over end the message

A cancel and a hand-over are stated where every other end is: on the stored message row (D752). The runtime
keeps its memory step (the send controls abort the live attempt and complete each effect of the message this
page claims), and [`ALOutboundPageMessageEnds`](./message-end/al-outbound-page-message-ends.ts) asks the lane
that holds the message to end it: a memory lane that stores it or remembers its retained admission, else the
durable lane. `handOver` awaits that end; `cancel` stays synchronous, starts it, and `dispose` joins it before
the lanes are disposed. An admission that commits a message the page already cancelled ends it before it
returns, with its verdict unchanged.

The lane's end is [`ALOutboundLaneMessageEnd`](./message-end/al-outbound-lane-message-end.ts), one per lane,
which orders the page's own ends of one message:

- **The stored row.** [`writeALOutboundMessageEnd`](./message-end/write-al-outbound-message-end.ts) reads the
  stored row, the sender's and the message's versions, the open receipt and the first-hop wait without planning
  the message
  ([`readALOutboundMessageEnd`](./message-end/read-al-outbound-message-end.ts)) and commits
  `toALOutboundMessageEndBundle`. It states nothing. A cancel keeps the receipt row, as every end does; a
  hand-over also deletes it in the same commit, since the carrier the message moves to owns its receipt now,
  and deletes it alone from a row an earlier end marked (an RTC receipt exhausted before its fallback hands the
  message to WS). A lane that stores no row for the message, or a cancel whose row is already ended, writes
  nothing, so a carrier that never admitted the message pays one read and a memory lane pays no IndexedDB
  operation.
- **A conflict is retained as work.** The commit is fenced on the sender's and the message's versions. When it conflicts the lane
  writes one `end-message` work row, unfenced and write-if-absent (one id per message), naming whether the end
  was a cancel or a hand-over (`endedReason`), due before every other
  row and expiring with the message, and announces it as a commit's rows are. The runtime that owns the
  session's work runs it: the same end, and a conflict there is redelivered by the queue. A tab that does not
  own the work therefore needs no claim of its own. The page's memory guard never completes an `end-message`
  row.
- **A retained admission.** A message whose first commit conflicted exists only as an `admit-message` row. The
  lane remembers the admissions this page retained; an end first completes that row, then ends the stored row
  regardless, since a replay that won wrote the stored row in the commit that completed its admission. A row
  a replay or its retry schedule still holds cannot be completed yet: the lane retains an `end-message` row
  that names it (`admissionEffectId`), whose run, in any tab, waits `not-ready` until the row can be claimed
  and completes it. A retained admission's replay reads its message's `end-message` row first and admits
  nothing while one exists, one read on that replay only. The canonical row and the identity fact retained
  with the admission expire on their own, as when the memory guard completes the row.

After the end a reloaded page and the session's other tabs find the message ended: a queued copy meets the
marker at `readSendGuards` (it states `attempt-started` first and nothing after), a dispatch answers
`message-ended`, and no timer retries or exhausts the receipt. A checkpointed message is saved with its marker
at the next checkpoint. What stays: a cancel is stored once its commit or its `end-message` row lands, so a
page that dies in the milliseconds before that loses it; and when the cancelling tab's end names an admission
another tab's replay is committing, one frame can leave before the end row is claimed, the same frame that can
follow any end.

**The declared retryable outcomes (D65)** live in
[`resolve-al-delivery-fallback-trigger.ts`](../delivery/resolve-al-delivery-fallback-trigger.ts). At
admission every `unroutable` reason (`no-route`, `circuit-open`, `rate-limited`) and
`refused/unsupported` hands the send to the fallback carrier at once, while `refused/no-leader`
hands nothing over (D165), nor does a trusted-server `held-by-other` or `unsupported` relay rejection (D175, D482); an RTC
room fanout in a carrier gap reads `no-route` there (D96). After
admission `AL_FALLBACK_NOT_READY_ATTEMPTS` (3) consecutive `not-ready` RTC attempts across the
message's send-prepared rows (reset by a `sent` attempt or an acknowledgement),
`not-yet-in-sync-exhausted` and `receipt-exhausted` hand an admitted `rtc-with-ws-fallback` message
to WS inside its unchanged deadline. The browser's
[`BrowserMessageFallbackController`](../../../shared-web/browser/messages/browser-message-fallback-controller.ts)
takes that decision from the delivery registry's `record`; this owner only hands over.
`resolveALDeliveryFallbackTrigger` is stateless per settlement: the controller hands over once per
msgId and only inside the deadline, so a repeated `not-yet-in-sync-exhausted` after the first
hand-over, or one past the deadline, hands nothing over again (C7).

**The left carrier (C3).** Once a message has handed over, the reducer's `isLeftCarrierReceipt` guard
keeps a settlement that still arrives from the carrier it left -- an acknowledgement, `receipt-exhausted`
or `relay-rejected` -- from moving the handle again; the handle already reads the fallback carrier's
outcome, and the left carrier's own attempt rows still land as evidence. A receiver on the other carrier
still answers its own ACK again over the arrival carrier, whether or not it holds a relay row (R-S3b-1,
R-S3b-21); see [the inbound README](../inbound/README.md) for that duplicate-answer rule -- it is the
receipt the WS leg needs from every member of the frozen audience to complete.

## Atomic IndexedDB work storage

[`openIndexedDbAdmissionDatabase`](../open-indexed-db-admission-database.ts) creates
the fixed admission and `alm-work` stores together. The work store uses the canonical
[`IndexedDbQueueBox` schema](../../queuebox/indexed-db-queue-box-store.ts). A QueueBox
can use the same `IndexedDbConnection` as admission; opening that connection remains
an explicit storage effect.

Each open also says what it found ([`ALStorageOpening`](../open-indexed-db-admission-database.ts)):
the database existed or was genuinely absent and created. A creation after this document
had opened it is observed as another context's reset (`other-context`) after a
`versionchange` closed it, or as an eviction without that observation.
A creation, reset or eviction one store of a connect found is a fact of that connect
([`ALStorageConnectOpenings`](../storage/al-storage-connect-openings.ts), one per connect):
each store of the connect reports it once, though another store's open found it, and a
later connect reads the database as it is. The document keeps per database only whether a
`versionchange` closed it, which tells another context's reset from an eviction.
A pair the factory opens itself, and whose store has an `ALStorageHealth`, carries an
[`ALStorageRecoveryReporter`](../storage/al-storage-recovery-reporter.ts) on its stores; the lane's
first `work-batch` diagnostic hands it the batch's claims, and it states the store's one
recovery outcome of this connect, with the expired rows the store's reservations deleted up
to that batch, through that health (`recordRecovery`); an eviction is a failure of the health instead
(`recordFailure`, cause `evicted`). The reporter reads no store of its own: the claims come
from the batch the lane already runs, the expired rows from the queue's in-memory count. The
inbound pair, which both carriers' lanes share, has one reporter per lane instead (see the
[inbound README](../inbound/README.md)).

[`writeIndexedDbAdmissionMutations`](../write-indexed-db-admission-mutations.ts)
accepts already computed admission and QueueBox mutations. The pure QueueBox
validator returns an `Either` before transaction entry. The joint transaction uses
QueueBox's existing revision-guarded writer and applies the supplied values without
recomputing them. Admission rows carry a per-row revision, so a moved row the write
phase observed, a moved key set behind a prefix it listed, a stale queue revision, or a
guarded removal rolls back the whole transaction. A native abort also preserves neither
write.
Reopened QueueBox instances can reserve the committed work through the ordinary
queue API.

Message admission supplies its original execution deadline to this write boundary,
including queue-only pending retention. Native IndexedDB request completion and the
last awaited PostgreSQL mutations check it while rollback remains possible. Expiry
preserves neither new admission metadata nor new work. Control retention and terminal
bookkeeping may continue separately without permitting an expired payload to be sent.

A write context that uses only `readWork` and `writeWork` uses QueueBox's existing
atomic observed-row writer. Unrelated admission metadata cannot invalidate that
queue-only ownership decision. Any metadata read, list, set, or removal is fenced on
exactly what it observed -- the keys it read or wrote, and the keys every prefix it
listed returned -- including a metadata-dependent decision that writes only queue rows.
Empty mutation output alone does not establish independence.

[`ALAdmissionWorkBackend`](../al-admission-work-backend.ts) connects admission to its
QueueBox. Memory, IndexedDB, and PostgreSQL implementations commit the work and its
admission decision together. Browser composition supplies its existing engine to the
outbound runtime. Due-work inspection uses the bounded QueueBox `readWorkPage` port;
the existing browser cleanup owner removes expired and session-owned work from the
shared store through those bounded key ranges. It requires a valid current-schema database
and never resets or rewrites it. Independent reset observations concern IndexedDB; the
memory pair is swept by its own lane (Store lanes, above).

The canonical opener creates stores and their initial schema record only in a genuinely
absent database. Existing stores, key paths, indexes and recorded schema identity must
match without a rewrite. A store/schema mismatch or a missing/different identity throws
`ALStorageSchemaMismatchError`; an unreadable or undecodable identity throws
`ALStorageSchemaIdentityError` with its original Error cause. Metadata inspection is an
explicit read before pure schema validation. Every acquired handle closes on inspection,
identity, callback or opening-initialization failure. Refusal preserves the existing
schema and every row, including live and unselected data; it performs no delete/recreate
attempt or deletion timeout. The exported `ALStorageResetBlockedError` class is removed.

The required `onStorageReset` callback reports an external recreation this opener
observes after this document recorded `versionchange`: the database name, the current
schema id and the reason `other-context`, the only reason there is. The browser
composition forwards it as the store's `reset` event on the `storage` port;
database-wide cleanup names the database. Recreation without a recorded `versionchange`
remains an eviction observation. No reset reason and no failure cause describes a
schema-mismatch reset: nothing performs one.

Inbound and outbound execution use their direct ALM owners with QueueBox and
InboxOutboxEngine. The separate outbound effect scheduler and browser physical
transport queues have been removed. The application-facing delivery handle
(`packages/shared-web/browser/messages/`) observes these settlements directly. Logical
audience receipts exist on WS room sends through the server's receipts, and on RTC room sends
through the frozen audience and the retry to the missing recipients through the tree (S2c-ii).
[`al-storage-snapshot.test.ts`](../../../tests/shared/alm/al-storage-snapshot.test.ts)
records what one standard supersession workload leaves in browser storage: as a durable opt-in, the
figures it held before S3a (216 outbound and 72 inbound rows, the same byte bands); taking the volatile
default, 0 rows added on either leg. Existing
paged due-work reads still do not establish that every backend query or cleanup path
has met its performance goal.
