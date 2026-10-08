# Outbound admission and durable replay

[`ALOutboundMessageRuntime`](./al-outbound-message-runtime.ts) is the public
lifecycle boundary: it enqueues, accepts control messages, claims work, and routes
each claimed durable effect to the owner that runs it. It never sends or mutates
admission state itself. [`ALOutboundDispatchAdmission`](./al-outbound-dispatch-admission.ts)
owns sender serialization, browser locking, and optimistic read/compute/commit. Its cross-tab commit
lock, `rallar:al-outbound-commit:<senderId>`, is a name on the shared Web Locks port
[`ALBrowserLocks`](../storage/al-browser-locks.ts), which the default composition fills with
`navigator.locks` where the API exists.
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
client-tracked hop and stays the server's to retry. The WS client also names its server as its
composition's hop, so an ordered at-least-once room send at the browser's defaults, whose effective
`ack` is `none` and tracks no receipt, still has the server's gap NACK served along that hop; the
RTC compositions and the WS server declare no fixed hop. Control acceptance applies the same
exemption: without a repair planner, a room-scoped gap NACK or repair control is admitted only when
its requester is the sender's own hop, so the server's gap NACK to its own WS client commits the
repair hint that retransmits the missing ranges along that hop. The WS server repairs its own
publications through its repair planner instead: a WS client's gap NACK on a track whose sequences
the server minted pages the missing sequences from the server's ordering index and resends each to
that requester alone, and only when the requester is in the audience the resent message was admitted
to and still expected by the receipt of the message whose NACK revealed the gap, so a session that
joined later is never served and a keyed server publication asks `ack: 'receiver'` (an `ack: 'none'`
one gets no ranged repair) (D43, D153). The budget is per message: the first requester spends
`maxRepairs` and another requester of the same sequence falls back to the receipt's retries. Only
the `outbox` fan-out mints; a keyed publish without a sequence at `live-only` or `none` is refused.
Relic Hunters' round transitions are that track's consumer: one track per round, the game's
incarnation (`${gameId}:${createdAtEpochMs}`, since a reset keeps the game id) as ordering key and
the round the transition enters as epoch, the finish entering the round past the last (D151).
[`isALOutboundOwnHopPeer`](./is-al-outbound-own-hop-peer.ts) is the one predicate both owners share.
A hint names what is missing as inclusive `ALSeqRange` `{ from, to }` ranges (`missingRanges`, at
most `AL_MESSAGE_RESOURCE_LIMITS.repairRanges` = 128, the most a 256 window can hold), as the
`al.control.nack.v2` and `al.control.repair.v2` payloads and the planner's NACK plan do;
[`decodeALSeqRanges`](../../al-contracts/al-seq-range.ts) is the one bounded range decoder for the
wire and the rows. A NACK and a repair request naming the same gap are one hint: the gap --
requester, ordering track and ranges, the ranges joined as `from-to` with `,` -- names the hint's
effect row ([`toALOutboundRepairHintEffectId`](./to-al-outbound-effect-id.ts)), never the control
that reported it, so the second control is absorbed by the write-if-absent effect store rather than
filed again. One execution of a hint retransmits at most
`AL_MESSAGE_RESOURCE_LIMITS.repairPageMessages` (32) sequences, ascending across its ranges, and
re-commits the remaining ranges as one follow-up hint whose identity is those ranges, so a wide gap
costs a bounded page of indexed reads and dispatch commits per execution and no page is served
twice. The repair budget (`maxRepairs`, 1 by default) is charged by dispatch admission under the
sender's fence, once per attempt identity, so a hint re-executed after a conflict or an expired
lease finds its sends committed and charges nothing more. When dispatch finds the budget spent it
answers `skipped`/`repair-exhausted`, and the retransmitter settles the message once with that
verdict through the lane's settlement sink and writes nothing else: the handle reads `failed` with
`failure.kind: 'skipped'` and `failure.reason: 'repair-exhausted'`.
[`ALOutboundMessageEffects`](./al-outbound-message-effects.ts) runs the three message-shaped effects
— `admit-message`, `dequeue-message`, and `send-prepared`.
[`ALWorkHandler`](../work/al-work-handler.ts) registers outbound work with the existing
[`InboxOutboxEngine`](../../services/InboxOutboxEngine.ts) through
[`ALWorkQueuePort`](../work/al-work-queue-port.ts). QueueBox owns durable reservation, release,
expiry, retry, and exhausted-attempt recovery. A queued native send retains its claimed work until
transport settlement; it does not block available peers or complete merely because the carrier
accepted local queue ownership.

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
lane still admits under the commit lock. When ownership turns true (once, never back) the handler
registers its task and runs the bootstrap batch once; that batch's first-batch report is the
takeover's recovery outcome. A row the previous owner held is recovered by the lease sweep of a later
batch, at its lease end plus at most 19.1 s, never sooner. The owner's lane hears every commit another
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
  message's effective durability alone. `local-outbox` and `local-inbox` name `durable` and go to
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
- **A `local-checkpoint` send carries no client sequence.** A restored checkpoint could send a `seq`
  again for different content, so both browser planners refuse a `local-checkpoint` send that carries
  one as `unsupported` ([`computeALOutboundOrderingRefusal`](./admission/compute-al-outbound-ordering-refusal.ts)).
  An ordering key alone carries no position (every room send carries its group key), and a superseded
  unsent copy was never seen outside the runtime, so both pass.
- **Grouped sends.** A group whose members differ in durability commits as one group per lane: there
  is no cross-store atomicity. No caller mixes today; an ACK batch is all volatile.
- **Controls, receipts and retransmission** go to the memory lane, volatile or checkpoint, that owns
  the target message (a memory read each), else to the durable lane.
- **One cancel.** `cancel(msgId)` is runtime-wide: one set of send controls serves both lanes.
- **Only the durable lane admits foreign dequeue rows.** The volatile lane names no dequeue type and
  takes no browser lock: Web Locks guard cross-tab IndexedDB commits, and memory is per tab. A
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
- **A volatile admission never leaves the caller's turn.** It reads no IndexedDB and takes no Web Lock,
  so it completes within the caller's microtask chain, and a loop of awaited volatile sends yields no
  task turn until it ends (R-S3a-7). A burst loop should yield or batch; fairness is V1b's.
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
every admission key string;
[`ALOutboundAdmissionEffectStore`](./admission/al-outbound-admission-effect-store.ts)
owns durable effect rows;
[`ALOutboundDecisionReadSession`](./admission/al-outbound-decision-read-session.ts)
is the read session of a single send's decision, which answers a work row it already read from that
read; [`read-al-outbound-send-guards.ts`](./admission/read-al-outbound-send-guards.ts) reads the
guards a prepared send rechecks before its carrier runs; and
[`al-outbound-admission-validation.ts`](./admission/al-outbound-admission-validation.ts)
decodes the persisted snapshots. Every fence — the sender version, the pending-admission
row, an observed effect row, and a moved supersedence observation — resolves a conflict
the same way: the guard throws `ALAdmissionBackendConflictError` inside the transaction so
the backend aborts without writing, leaving every row at the revision and write token it
already had, and the store catches it at its public boundary and returns the typed
`'conflict'` result. A single send (`readOutgoingDecision`) reads its decision surface, decides on
it, and reads the effect rows and canonical pair its bundle's commit fences in one readonly session,
so its commit opens only the write phase's fence snapshot and the write; `commitBundle` without that
observation, and a group's `commitBundles`, read it in a readonly session of their own first. Every
observation is re-read inside the write, however old it is. Only a write conflicts. A read chain's
expiry eviction that finds its row moved by another writer leaves the row to that writer and answers
from its snapshot (the inbound README's decision-surface section), so `ALOutboundControlAdmission.admit`
never loses an acknowledgement to a throw out of `readControlAdmission` or its effect read.

## Canonical message storage

[`al-outbound-canonical-message.ts`](./al-outbound-canonical-message.ts) owns the
canonical key, full message reference, identity fact, and their validation.
[`al-outbound-canonical-storage.ts`](./al-outbound-canonical-storage.ts) reads and
compares those observations and writes new facts through the admission transaction.
Each message has one raw envelope. Sent metadata, recipient actions, and repair work
refer to it; [`al-outbound-transport-message.ts`](./al-outbound-transport-message.ts)
captures and reconstructs the permitted transport differences.

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
when the lane hears of it: the IndexedDB pair's own open tells the lane through
`ALStorageResetListeners`, while the browser session cleanup's and expiry eviction's reset events
(and another tab's reset) do not reach it; the memory pair's lane has none.
After `attempt-started` the claim reads its guards, supersedence and then (unless superseded)
receipt state, in one readonly session (`readSendGuards`), so a hand-off hit costs the claim one
admission read session and a miss two: the canonical read stays its own session before the
attempt starts.

A validated initial AL control enqueue runs the normal read, computation, validation,
and optimistic commit without entering the sender queue or browser Web Lock (D105). An
uncontended commit returns `admitted`; a real commit conflict atomically retains the
canonical payload, immutable identity, and compact `admit-message` work through
[`retainALOutboundPendingAdmission`](./al-outbound-pending-admission.ts). That fallback
returns `pending`, meaning durable ownership exists, not that transport ran. A spoofed
control type whose envelope does not decode as a canonical control stays on the ordinary
serialized path.

Controls are `volatile` (`computeALControlMessage` in
[`al-control.ts`](../../al-contracts/al-control.ts)), so a runtime with a memory pair — both browser
carriers — admits them in the memory lane, which takes no Web Lock: there the hand-off skips only that
lane's in-tab sender queue. A runtime without a memory pair (the WS server, or a WS client built
without `outboundVolatileStores`) admits them in the durable lane, where the hand-off also skips the
Web Lock when the platform has one. The memory lane shares nothing between tabs, so the two-tab
proof covers the durable lane: two tabs of one session that share the IndexedDB lane and the Web
Lock and hand off the same controls at once, or where one tab closes after its commit, send each
control once and in hand-off order; a tab that closes inside its send leaves that send to be
retried once after its lease lapses, at least once on the wire
([`al-outbound-control-handoff-two-tabs.test.ts`](../../../tests/shared/alm/outbound/al-outbound-control-handoff-two-tabs.test.ts));
a send a closed tab still holds under its lease waits for that lease on either path. The hand-off
shares the sender version fence with that sender's data commits, so a data commit that races a
control can conflict and retain a pending admission, which the worker replays.

The outbound worker claims the retained `admit-message`, rereads current admission
facts, and replays one new attempt through the unchanged sender queue and browser Web
Lock. The retained policy, original deadline, and authorized transport provenance
remain unchanged; the stored candidate contains no prior mutable write context. A
retention conflict leaves no false ownership for the caller to complete, and a terminal
pending descriptor cannot be revived merely because its content matches.

The server's independently produced `WS_OUTBOX` rows remain active canonical
sources. Cluster notifications carry bounded key/type/deadline claims, which the
[`QueueBoxPubSubBridge`](../../../shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts)
checks against the retained message and identity before delivery. Publication is a
transport action and does not confirm the logical audience; a server receipt does (below).

## Admission and invocation paths

| Entry                        | Decision and durable result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | After commit                                                                                                                                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enqueueIfAbsent`            | Dispatch admission reads validated state and computes a bundle. Its commit compares sender versions and original supersedence observations, then writes admission state and QueueBox work atomically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The runtime wakes the existing worker after commit, outside admission's sender/browser lock.                                                                                                                                                                                |
| `enqueueAllIfAbsent`         | One sender's messages read, compute, and validate as `enqueueIfAbsent` does. A homogeneous group attempts one `commitBundles` write under one version fence; a mixed control/data group commits members separately (see Grouped control sends below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The runtime wakes the existing worker for committed work; each message still reports its own `commit-phases` event.                                                                                                                                                         |
| `acceptControlMessage`       | Repair admission checks that this scope owns the control, then `ALOutboundControlAdmission` validates identity, control history, and pending receipts and commits control state and repair work together.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The runtime wakes the existing worker; repair admission schedules a not-yet-in-sync retry when the committed control is a not-yet-in-sync NACK.                                                                                                                             |
| `admit-message` work         | `ALOutboundMessageEffects` reads pending admission authority, rechecks the retained deadline, and commits the retained policy through dispatch admission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | The claim completes. Rejected or expired authority completes without admitting; a not-ready authority reschedules with its own delay.                                                                                                                                       |
| `dequeue-message` work       | A foreign queue row this owner admits: `ALOutboundMessageEffects` first reads the carrier's pending admission authority with no prepared copies, then rereads the message, drops it when superseded, and commits a dispatch plan.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Circuit-open resilience reschedules; a `not-ready` authority holds the claim (one `not-ready` attempt, re-checks in memory); `no-route` retries; expired, superseded and skipped complete; an admitted plan completes and runs the configured `afterDequeueAdmission` port. |
| `send-prepared` work         | `ALOutboundMessageEffects` rechecks supersedence and receipt completion from one read session (`readSendGuards`), then the deadline and abort, before calling the transport.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | An immediate outcome completes or reschedules; a queued native send is retained until the transport settles it.                                                                                                                                                             |
| `ack-timeout` work           | Repair admission rereads the receipt snapshot. Before the deadline it recommits the next timeout; at it, it charges one attempt and commits the next timeout plus a `repair-hint`, clears a complete receipt (a receipt a control ended has its timeout row completed in that commit, so only a row a batch already leased gets here), and out of budget schedules nothing more.                                                                                                                                                                                                                                                                                                                                                                                                  | New work is available to the existing engine; the schedule never sends directly.                                                                                                                                                                                            |
| `repair-hint` / `nack-retry` | Repair retransmission reresolves the cached messages (by ordering track and sequence when the hint names missing ranges: one page of `repairPageMessages` per execution, the remaining ranges re-committed as one follow-up hint), applies repair policy, and commits a fresh dispatch through dispatch admission, which charges the repair budget and answers `skipped`/`repair-exhausted` once it is spent; that answer is settled once per message. Without a repair planner, a room-scoped hint is served only as the sender's own-hop retry (every failed peer, or the hint's requester, is the sender's own hop: a tracked next hop or a composition-declared one); a `receiver` room send with no client-tracked hop schedules no `ack-timeout` and is never retried here. | New work is available to the existing engine; retransmission does not recursively invoke the work handler.                                                                                                                                                                  |
| Startup / scheduled wakeup   | `ALWorkQueuePort.claim` reserves; `ALOutboundAdmissionEffectStore` then decodes and validates the claimed row with the canonical message it references, handed over by the lane's own commit or else read (`readWorkSnapshot`, `validateObservedWork`). Malformed work becomes `NON_RETRYABLE`; valid claims remain independently available.                                                                                                                                                                                                                                                                                                                                                                                                                                      | One batch runs at a time and its claims run in order; a commit landing behind a batch earns one follow-up batch. QueueBox compares the exact reservation on release, so an old worker cannot alter a newer claim.                                                           |

The receipt an acknowledgement completes against is an obligation that expires exactly at the
message's deadline, however early or late its retry schedule ends. The `ack-timeout` rows expire
when the schedule ends or at the deadline, whichever comes first, and spending the budget stops
retransmission without deleting the receipt. So an ACK that arrives after the last retry but inside
the deadline still commits and states its `acknowledgement` settlement, and an ACK at or after the
deadline is refused. The receipt is gone by then, and control admission's validation refuses an
ACK whose deadline has passed even if a receipt is still read. Every carrier discards `acceptControlMessage`'s answer, so repair
admission records it as the `control-admission` outbound diagnostic (outcome, and a rejection's
reasons) for every control it decides. A committed `resync-required` NACK is a hop's refusal of a
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
receipt peer or the unicast addressee. Over RTC a `forwarded` ACK from any peer of the room confirms
the frozen recipient it names: RTC relays are trusted to speak for the recipients below them (see
the inbound README). A retained control keeps its source for its replay.

A receipt row is keyed by its origin and message id
(`toALOutboundPendingAckKey({ namespace, originPeerId, msgId })`), so origins that share one
store namespace never collide on a message id. Its `mode` is the send's resolved ack algorithm
and types its peer lists: next hops under `hop` and `subtree`, logical recipients under
`receiver` and `leader`. An ACK confirms the peer that mode names -- its `logicalRecipientPeerId` under
`receiver` and `leader`, its sender under `hop`, and under `subtree` its sender only on that hop's own
completion ACK (a leaf's `delivered`, a relay's terminal `subtree-complete`), never on a
`forwarded` ACK the hop relays for a recipient below it -- so a hop ACK never stands in for a
logical recipient. A control
is a duplicate only when its sender, logical recipient and status all repeat; an ACK for a peer
the receipt already counted is refused with its own reason, so an ACK that moves no receipt costs
no write and no version bump. The `acknowledgement`
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
  with the typed reason, never `failed`.
- The WS server freezes a room message at its admission stamp from the sessions it authorizes,
  narrowed for a principal broadcast that names its room to that principal's sessions (the group
  snapshot's `activeSessions[].principalId`), for a room broadcast that carries
  `recipientPeerIds` to the listed sessions, and for a `group-leader` send to the director session the room
  authorizer resolves from the snapshot it reads, the leader alone in the narrowed `sessions`; that narrowed set
  is the room audience its receipt
  aggregate expects and its repair serves, and the send is fenced on the room's roster as any room
  send (D143, D159). A multicast an RTC origin froze that falls back to WS keeps its frozen set
  narrowed to the sessions the server authorizes: a frozen audience narrows what the admitting
  authority allows and never widens it, and an empty intersection means nobody, never "no filter".
- The outbound authority checks (`validateALOutboundPlannedMessage`, canonical reuse) accept exactly one
  difference between an original and its planned or stored copy: unfrozen to frozen. A copy that drops
  or changes a frozen audience still differs.
- RTC peer ingress refuses a room multicast that carries no frozen audience (`malformed`).
- Under `receiver` the origin's receipt row expects exactly the frozen recipients. The set a relay
  forwards over is the sessions authorized now, a late joiner included, but only a session of the
  frozen audience delivers locally or counts as a logical recipient; a session outside it may forward
  and ends its own subtree with `subtree-complete`. A join never widens a frozen audience, and a session
  that leaves stays expected and reads unconfirmed (D43).

### Server receipts on WS

A `receiver` or `leader` room send over WS expects nobody when it is admitted
([`toWsQueueBoxClientAckTrackingPlan`](../../services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts)):
the WS server freezes the audience and answers for it. A `leader` send is the same aggregate with
one expected recipient, the director session, so the `admitted` receipt names the director and the
director's ACK completes it. Each recipient's ACK stays addressed to the origin (`toPeerId` is the
message's `senderId`); the server admits it at ingress as the aggregating relay hop and counts it in
[`WsQueueBoxServerReceiptAggregation`](../../services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts),
an in-memory map on the instance whose socket admitted the message. The server answers the origin
with `al.control.receipt.v1` controls, each written as one durable `WS_OUTBOX` row that reaches the
origin's socket on this instance or, through the cluster publisher, on another: `admitted` at once
with the frozen audience, then `complete` when every expected recipient has acknowledged, or
`timed-out` at the message deadline naming whom it counted. Every receipt row expires at the message
deadline plus `AL_RECEIPT_DEADLINE_GRACE_MS`, however early the server observed it. A receipt row
whose origin has no session on the instance that dequeues it is not settled by its first cluster
publication: its send
([`WsQueueBoxServerClusterPublication`](../../services/ws-queue-box-server/ws-queue-box-server-cluster-publication.ts))
publishes it again, each wait as long as the receipt has waited and the last one a second before the
row expires, until the origin has a session there or the row expires, so an origin that reconnects
on any instance up to a second before the row expires receives it; one that reconnects in that last
second does not.

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
Either way the receipt is the aggregate above, so a recipient the one send did not reach, or that never
acknowledged, reads unconfirmed and the receipt ends `timed-out` naming it. A `none` topic runs its handlers only.

A recipient's ACK reaches the server through the recipient's own socket, which may be on another instance than
the aggregate (D106). An instance that holds no aggregate for the ACK checks what needs none (the sender is the
authenticated session, the ACK speaks for itself and is addressed to the origin it names) and relays it once as a
`relayed-ack` notice on the cluster notice channel
([`WsQueueBoxServerAckRelay`](../../services/ws-queue-box-server/ws-queue-box-server-ack-relay.ts),
[`relayed-ack-notice.ts`](../../../shared-server/rallar-system/queue-pubsub/relayed-ack-notice.ts)); its ingress
answers an unhandled `control` instead of a refusal. The instance that holds the aggregate counts it with the same
checks as a local ACK; any other instance drops it, and nothing relays it again. The notice is best effort and one
attempt: a lost one leaves the recipient unconfirmed, and the receipt ends `timed-out` naming it. The relay runs
only with Postgres pub/sub; a single instance still refuses an ACK it holds no aggregate for. An ACK addressed to
the server is never relayed: the server's own pending row lives in the shared outbound admission store. The relay is
bounded twice before it publishes, each refusal a typed value at ingress. First the inbound admission store, which every
instance shares, must hold the message the ACK names, sent by the origin it names, with the ACK's sender in the audience
frozen at ingress (`readIngressAudience`); a forged ACK (unknown message, sender outside the audience, another origin) is
refused after one store read and costs no notice. The outbound admission store cannot answer this, because it records an
admitted audience only for a message the router enqueued on an `outbox` topic. Then each session may hand over 60 ACKs per
minute, so a genuine ACK stream is bounded as well.

Since S3c-i a WS origin knows its server: `/api/config` names it as `serverPeerId`, and the WS client plans against it
([`toWsQueueBoxClientAckTrackingPlan`](../../services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts)).
A unicast addressed to the server, and every `hop` or `subtree` send, expects the server's own ACK: the server is the
one hop a WS origin has (R-S3a-4). A `receiver` unicast that names its room (`targets.groupRef`) is aggregated like a
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
retained on a conflict has its `admitted` receipt before its replay drops it.
A `receiver` unicast that names no room is refused `unsupported` at admission (D71). A message addressed to the server keeps the server's own ACK and opens no
aggregate (D76). A message carrying a frozen multicast audience — an RTC leg handed to WS — is aggregated over that
audience verbatim, so a session that left since reads unconfirmed (D73).

The wire `targets.groupRef` scopes every row that names a group (D101): its captured policy stores no
`recipientScope`, `principalTargetId` or `sessionInvalidation`
([`resolveALOutboundScopeAuthority`](./admission/al-outbound-scope-authority.ts)), a row that stores one is corrupt,
and a room unicast's or a direct room row's send checks the recipient's connection against the group's scope. A
stored recipient scope remains only on rows that name no group: a unicast whose producer proved a scope, a principal
target, a principal or world broadcast. A raw `WS_OUTBOX` row without producer provenance fails closed, and a
unicast `router.publish` that names no group and carries no scope returns `failed` (D103).

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
(D38): the durable receipt. The aggregator is its one settlement authority. The server admits each
terminal receipt it writes through the same receipt admission as the origin, so a `complete` receipt
leaves that row complete and its `ack-timeout` stops retransmitting, on whichever instance claims it.
That row is not the origin's kept final snapshot: once complete, the next `ack-timeout` deletes it,
and nothing reads it after that. The router hands the audience it admitted to the outbox beside the
message, never on the wire, where a room larger than the collection limit would not fit: the plan
carries it as `admittedAudience`, the captured policy keeps it with the sent row, and every later plan of
the message receives it. The server sends to that audience only and a `receiver` row expects exactly it,
never a session that joined after admission (D24, D43); a `hop` or `subtree` row expects the hops this
instance sent to. WS never re-routes, so a retry or a repair of any receipt mode keeps every peer the row expects and
every one that confirmed, and resends only to a failed peer the message was admitted to (R-S3c-i-31). A multicast frozen by its origin and sent without a router keeps planning against its
own `recipientPeerIds`. Running out of receipt-admission attempts is reported as a warning
naming the message and its origin.

The server's own room notifications carry receipts too (D58, D77), and so does every server or proxy publish that
names its room (D104). The router freezes any publish that carries a `groupRef`, a multicast or a room broadcast at
any fanout but `none` and from any sender, to the room's live sessions at publish
([`readRallarServerWsPublicationAudience`](../../../shared-server/rallar-system/websocket/router/rallar-server-ws-publication-audience.ts));
a proxy publish takes the audience the room authorizer grants, and an admitted client message keeps the audience it
was admitted to. The server's pending row expects those sessions. Both cluster sends, the publishing instance's and
every other instance's, read the row's captured policy once from the shared admission store (`readCapturedPolicy`),
fail closed on a row that differs from its admission, and narrow to the audience it holds. Every settlement of the
server's outbound owner feeds one bounded in-memory recorder per process
([`createRallarAlmReceiptDiagnosticsRecorder`](../../../shared-server/rallar-system/observability/alm-receipt-diagnostics.ts),
256 messages), read as `almReceipts` on `/api/admin/operations/realtime`: per message the confirmed and unconfirmed
sessions, the last settlement kind and whether the receipt ran out (D61, D73).

**Server-minted sequences.** A message the WS server publishes itself that names `ordering.orderingKey` (and
an `epoch`) without a `seq` asks the server's outbound for the sequence (D150). The server's planner marks the plan
`mintsSequence` only at admission (`phase: 'immediate'`) and only when the message's `senderId` is the server's own
peer id; a relayed browser send that carries a key and no `seq` (an RTC room multicast and its WS fallback carry the
group key) passes through unsequenced, as it came, and so does a row a producer wrote straight to the outbox. An
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
answers with the stored message. The head row expires as the sent row does: a durable pair keeps it
`max(deadline, sentMessageTtlMs, controlHistoryTtlMs)` past the mint, and a receiver's ordering-track TTL defaults to
the repository TTL (60 minutes), so a receiver remembers a track as long as its sender keeps the head. Two limits
remain: sequences follow commit order, so under contention two publications of one track can commit out of publish order
(a first-in-first-out mint per track is a follow-up), and a track silent for over an hour restarts at 1 on both sides.
The browser's outbound never mints: no browser planner marks a plan.

Known limitations:

- An origin whose socket was half-open when its receipt was written to it never gets that receipt; a
  socket write counts as delivery.
- Nothing tells the publishing instance that another one delivered a receipt, so a receipt whose origin
  is connected elsewhere, or whose row another instance claimed first (the WS namespace is shared across
  the cluster), is published until its row expires: 8 publications for a 30 s message, 27 for a 10 min
  one, about 67 at the 30 min aggregate cap, each one an idempotent no-write refusal at the origin.
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
bound is refused. A receipt writes no work and no `ack-timeout` schedule; the server's receipts own it.
`acceptReceipt` takes the receipt control message itself and records its verdict as the same
`control-admission` diagnostic, under the control's own id with the receipt's message as
`targetMsgId`, whether it commits or is refused. Only a receipt's diagnostic carries a `phase`
(`admitted`, `complete` or `timed-out`), its last field; every other control's has none.

Every receipt row states its `acknowledgement` settlement through `toALOutboundAcknowledgementFact`.
Under `hop` and `subtree` the row counts next hops, so its peers are both the hop lists and the
expected, confirmed and unconfirmed recipient lists. Under `receiver` and `leader` the row counts the frozen
logical audience, the handle reads `acknowledged` only once every expected recipient is confirmed, and the hop
lists are the local hop view (`OverlayTree`): the next hops the captured ack plan names
(`nextHopPeerIds`), of which those whose own completion ACK is in the ACK history are confirmed. A relay
in front of a recipient is therefore a confirmed hop while the recipient is a confirmed recipient. A WS
client names no hop; at the WS server each recipient session is its own hop, complete once confirmed.

An RTT heartbeat is not one of these entries.
[`WsQueueBoxClientService.sendLive`](../../services/ws-queue-box-client-service.ts) writes it
straight to an open socket -- the same bytes `enqueueOutboxIfAbsent` sends today -- with no
admission read, bundle, work row, or retry, and it never takes the sender/browser lock the
ordinary data admissions use. A closed socket answers `'socket-closed'` rather than throwing; a lost
heartbeat costs nothing because the next one, latest-value telemetry, simply replaces it.
`sendLive` also bypasses the WS submission-readiness fault port, so a harness `not-ready` hold
never delays an RTT heartbeat; that is acceptable only because the heartbeat is latest-value
telemetry that no conformance scenario holds or asserts on.

### Addressed sends on RTC

Since S3c-ii a typed send names one peer on every strategy but `ws-then-rtc`: `send(payload, { peerId })`. The
envelope is one unicast that names its room (`targets.groupRef`, `route.contextId` the room id), built by
[`createBrowserUnicastMessage`](../../../shared-web/browser/messages/create-browser-unicast-message.ts). The RTC
carrier plans it to the addressee directly and never relays it. Its receipt is the addressee's own ACK. On
`rtc-with-ws-fallback` the same envelope is re-admitted on WS when the RTC leg states a retryable outcome inside the
deadline (D63): the addressee is not in the ready set (`no-route`); the addressee is connected but is not the
origin's overlay next hop, is missing from the room's active sessions, or the room is in a carrier gap (three
`not-ready` attempts); or the receipt ran out. On WS the room's router delivers it and the server aggregates the
one-member receipt (D71). A peer send to the server id is refused `unsupported` on an
RTC strategy: the server is addressed over WS (D76). A peer send whose `contextId` names another room than its own is
refused at the sender.

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
(5 minutes) from now, or a new ordering track while `AL_VOLATILE_SESSION_MAX_TRACKS` (64) are counted. The handle
ends `rejected` with `evidence.failure` `{ kind: 'refused', reason: 'capacity', limit }`, `limit` naming the limit
the ledger's refusal names (`'admissions'`, `'bytes'`, `'age'` or `'tracks'`), and no fallback is tried, because the
other carrier shares the budget. The RTC circuit breaker does not count a `capacity` refusal as a failure. A counted
send whose commit then admits nothing stays counted until its deadline: the ledger has no release call.

A track is the ordering track key of a send that states an ordering key and a sequence together
([`toALOrderingTrackKey`](../../al-contracts/al-runtime.ts): the ordering key, the sender and the epoch); a send
that states neither, or a key without a sequence, names none. A track is counted while the ledger holds
at least one counted admission on it, so it leaves the count when the last of them reaches its deadline. A received
message never opens a counted track. The ledger answers its state in one read, `readReport(nowMs)`
(`ALVolatileSessionReport`: the usage with `oldestAgeMs`, 0 when nothing is counted, and `tracks`; the limits; and
`overloaded`), which the browser exposes as `rallar.messages.readUsage()` and the black-box `stats` result as
`rallar.alm` (D180).

An inbound admission is counted and never refused, and it counts toward the same limits as the session's own sends
(R-S3c-ii-3): a session whose volatile traffic in and out stays above about 33 messages a second (at the 30 s default
deadline) has its own volatile sends refused. The bound is also shared with the platform's own state sync that the
WS inbound runtime admits on the volatile pair (`group-state.event`, `client-state.snapshot`, `client-state.event`,
R-S3c-ii-7): a lane agent that leaves and rejoins a room holds about 26 KB of it, under one per cent of the
production limits. Whether platform topics leave the application's bound is an open decision for the maintainer.
While the budget is at or over its count or byte limit the session's QoS provider reports `overloaded` for the session's own outbound
data originations only: never for a control, a receipt, an acknowledgement, a repair, a relay forward or an inbound
plan (R-S3c-ii-8), so a session at its bound still acknowledges, forwards and delivers for other sessions. Under the
default policy the RTC origin drops a best-effort room send that reads it, and that drop reads `capacity` as the
admission bound's refusal does: at the bound every send, best-effort or not, on either carrier, ends `rejected` with
`{ kind: 'refused', reason: 'capacity' }` and is never handed to a fallback. That drop names no `limit`, because
`overloaded` names none; only the ledger's own refusal does. The WS outbound path does not consult
`overloaded`; its admission bound refuses the same sends. The RTC rate limiter spends its token before the plan, so a
refused send still spends one: a burst of refused sends can push a later send inside the bound to `rate-limited`,
which hands it to WS, where the shared budget admits it.

The age limit bounds the admissions the ledger counts, not the ordering state the pairs keep (D181): the volatile
pairs keep an ordering track for the repository's hour (`orderingTrackTtlMs`), because a receiver that forgot a track
would read the next sequence as a gap, and every track quiet for 5 minutes would stall on its repair. What the session
holds per message, track or peer is bounded instead of kept for the owner's lifetime. The send controls' cancelled and
handed-over message ids are [`LatestRepository`](../../cache/LatestRepository.ts) entries with
`DEFAULT_AL_REPOSITORY_TTL_MS` (60 minutes) as their TTL, the durable lane's row retention, so a cancelled durable
message a worker picks up after 5 minutes still does not send. The browser's resync recovery keeps the tracks it has
invoked a recovery owner for in a `LatestRepository` with `AL_VOLATILE_SESSION_MAX_AGE_MS` as its TTL, renewed by
each of the track's resynchronisations, so a track that resyncs again after that long without one invokes the owner
again. `WebRtcRxStreamerService` numbers every peer's
round-trip measurements from one counter and keeps no version per peer. None of them adds a timer or a sweep of its
own: a repository forgets an expired entry it reads and sweeps the rest when it accepts one.

**Limit:** the memory pairs plateau rather than empty: an idle inbound ordering track keeps two rows for the hour after
its last message, and each sending origin keeps one outbound version row (`versionTtlMs`, 1 h). The long-run test
sends on minted sequences on the volatile lane, which no production planner does: only the browser builds the volatile
outbound pair, and the browser never mints. A volatile pair that did mint would drop a track's ordering head with its
last sent row, after the deadline plus the receipt grace, while a receiver keeps the track for the hour, so a track
silent for longer than that would restart at sequence 1.

### Grouped control sends

`enqueueAllIfAbsent` admits one sender's messages as one group. `ALOutboundDispatchAdmission.commitAll`
takes one sender-queue slot and one browser lock for an ordinary data group. Canonical initial
controls bypass those waits and use the same optimistic group commit; a mixed group settles each
member alone. Each member uses the single-message decision in a read of its own; `commitBundles` then reads
every bundle's effect rows and canonical pair in one observation read, fences the sender version once, runs every
bundle's own pending, effect, observation and identity fences, writes every bundle and bumps the version
once. The group falls back when a member settles before its write (it fails validation, finds its own
pending admission, or has nothing to commit), when a version moved between the members' reads, when two
bundles write one row, when the store answers anything but `committed`, or when the group attempt throws.
Every member then goes through the single-message commit, one after another, and keeps its own answer:
a planning refusal is that member's `failed` value, as a single send answers it, and a member whose
single commit throws does not stop the members after it; the first such throw is rethrown once every
member ran, and the runtime wakes the owner for the members that landed before it rethrows. The RTC
multicast manager applies its circuit breaker and its rate limiter once per group.

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
closes its window for up to 1.25 leases; a sweep that fills its room keeps the window open, so a
backlog of crashed or exhausted rows drains on consecutive batches. While a sweep's window is closed
the readiness scan does not advertise the reserved rows that sweep would recover, so no batch runs
empty waiting for it. A crashed lease or an exhausted row, a backlog included, is recovered at most
19.1 s after its lease ends: the window reopens within 1.25 leases of the last spent sweep, then the
remembered readiness ages and the idle engine passes once. The bound assumes the readiness scan, 16
reserved rows per type, sees the row; a crashed row hidden behind 16 live leases is recovered by the
first batch that sweeps with its window open. On the PostgreSQL lane it also assumes the database
clock is not behind the lane clock: the scan advertises a lease end on the lane clock while the
sweep tests the lease on the database clock, so with the database δ behind, the sweep a lease end
triggers can come back empty and spend its window, and the worst case becomes lease end + δ +
19.1 s; the browser lanes are exact. The claim page is ordered by key, not by readiness: 15 or more
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
its inbound `admission-outcome` naming the storage failure. A hand-over whose receipt row cannot end
leaves the row to expire. A
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
channels, backpressure rejection, and untouched queued siblings cleared by a channel
error return readiness. A native send that throws remains an attempted failure with
an uncertain delivery outcome.

Readiness uses the existing `RETRY` and future `nextTs`: release refunds only the
current reservation's attempt, preserving earlier failed attempts. It records neither
adaptive success nor adaptive failure. Real attempt failures retain their normal
retry budget. Readiness rechecks are bounded by the original message deadline, and
settlement at or after that deadline completes physical work without sending or creating
an acknowledgement. Cancellation ends the attempt directly. Submission
remains separate from receiver acknowledgement and application completion.

A replacement's own admission commit states `superseded` for every predecessor it newly
marks replaced -- one `ALDeliverySettlement` per predecessor, from
[`ALOutboundDispatchAdmission`](./al-outbound-dispatch-admission.ts)'s
`emitSupersededSettlements`, before that commit call returns to its caller. Only the commit
that moves the key's latest-supersedence pointer states it; a later commit of the same
message, or a predecessor the admission observed already replaced, states nothing again. By
the time a superseded predecessor's own queued work next runs, the lifecycle this settlement
named is already terminal, so its own attempt-time and dequeue-time supersedence checks
(read fresh in `writeAttemptedSend` through `admissionStore.readSendGuards` and in
`readDequeuedAdmissionOutcome` through `admissionStore.isMessageSuperseded`) add nothing new:
dequeue completes the claim without sending and without a settlement of its own, and a
`send-prepared` attempt still states its own `attempt-settled` (`outcome: 'superseded'`) but
only as late evidence on a lifecycle a terminal settlement already closed.

The RTC Promise executor captures its resolver synchronously before `sendJson`
registers the callback. Native completion invokes it after queue mutation. This is
a language-level event bridge, not a forward dependency between services. No
additional queue, pending-work registry, or timer is introduced by settlement.

`ALOutboundMessageRuntime.cancel(msgId)` aborts one message's own live transport
signal and states one `cancelled` settlement; disposal aborts every live signal but
states none of its own. Either way, an attempt that already stated `attempt-started`
still terminates with its own `attempt-settled` (`outcome: 'cancelled'`, `willRetry:
false`) -- stated directly when the abort lands before the carrier runs (inside the
admission-store reads `writeAttemptedSend` makes first), or by the carrier's own
settlement when it lands during or after the send. Cancellation is held in memory, never
persisted, for `DEFAULT_AL_REPOSITORY_TTL_MS` (60 minutes, D181): a row still pending when the owner is
disposed may be drained by the next owner as an ordinary send. A durable cancel fact
-- one that survives disposal or reload -- is a named sink seam left to S3 or I2
(D13), not part of this settlement path. `handOver(msgId)` aborts the same signal and
states nothing at all; see [Receipt ends and the hand-over](#receipt-ends-and-the-hand-over).

Every settlement in this section is a per-message `ALOutboundSettlementFact` stated
through this owner's [`ALOutboundSettlementEmitter`](./al-outbound-message-runtime.ts):
the runtime's private `emitSettlement` stamps the fact with its own `carrier`, the
current `atMs` and the `lane` that stated it (`durable` or `volatile`; a runtime-wide
`cancel` names none) into the `ALDeliverySettlement` the sink receives, and guards that call
so a throwing sink logs and returns rather than changing dispatch, retry, or claim
behaviour. The browser's sink for these settlements is the in-memory delivery registry,
[`BrowserRallarDeliveryRegistry`](../../../shared-web/browser/messages/browser-rallar-delivery-registry.ts)
(`packages/shared-web/browser/messages/`), which reduces each settlement into the
sending handle's lifecycle.

## Receipt ends and the hand-over

Every receipt this owner tracks ends in a settlement (S3b, D63, D64):

- **Budget exhaustion.** When the last `ack-timeout` window closes with the budget spent
  (`attempts >= maxAttempts`), [`ALOutboundRepairAdmission`](./al-outbound-repair-admission.ts) deletes
  the pending-ACK and repair-attempt rows in one commit and, once it lands, states `receipt-exhausted`
  with the row's confirmed and unconfirmed peers (next hops under `hop`/`subtree`, logical recipients
  under `receiver` and `leader`). The handle reads `failed` and keeps who confirmed. The row is gone, so the fact is
  stated once across replays and reloads and a late ACK completes nothing. With the defaults (a 2 000 ms
  ACK timeout, three receipt retries) the budget ends about 8 s after admission.
- **A hop that refuses for good.** An admitted `expired`, `unauthorized`, `membership-fenced` or `stale` NACK
  removes the row;
  the commit states the incomplete acknowledgement, then `receipt-exhausted`. `resync-required` keeps its
  `relay-rejected` (D50).
- **Completion at a re-plan.** A retry whose plan replaces the expected set (the RTC missing-recipient
  repair, under `hop` and `receiver`) and so completes the row deletes it and states the acknowledgement
  that completed it.
- **A receipt no row tracks.** An admission whose plan writes no row -- a `qos.ack` timeout of 0, or a
  `hop`/`subtree` receipt that expects nobody -- reports `trackedReceiptAlgo: 'none'`, so the handle ends
  at `transport-accepted` with the downgrade in evidence (R-S3a-4). A `receiver` receipt with an empty
  expected set keeps `receiver`: the WS server's `admitted` receipt creates its row, and an empty frozen
  audience completes it at admission.
- **Ends the deadline settles.** A receipt whose message is gone (the orphaned cleanup) and the WS
  server's `timed-out` receipt both arrive at the message deadline, which the handle already reads as
  `expired`.
- **The `not-yet-in-sync` budget.** When its retry schedule is spent the owner states
  `not-yet-in-sync-exhausted`. It ends nothing on its own -- the receipt budget still ends the message --
  and is one of the declared retryable outcomes below.

A receipt that a control ends -- a complete ACK or a terminal NACK -- completes the send's `ack-timeout`
work row in the commit that ends it, so no timeout batch runs for it; a row a batch already leased is
left to that batch, which reads the ended receipt and completes. For a complete receipt the old timeout
batch also cleared the receipt row; that row now waits for its own expiry, which is harmless: every
reader treats a complete receipt as ended.

**The hand-over (D66).** `ALOutboundMessageRuntime.handOver(msgId)` gives a message to another carrier's
owner: it remembers the id for `DEFAULT_AL_REPOSITORY_TTL_MS` (60 minutes, D181), aborts the live attempt (which still settles its own
`attempt-settled`), completes every later effect of the message silently and deletes the receipt rows in
one commit, and states no settlement -- the message is not cancelled. A conflict on that delete leaves an
inert row that nothing retries before it expires. RTC reaches it through
`WebRtcRxStreamerService.handOverOutbox` -> `WebRtcOverlayMulticastManager.handOver`. The hand-over is held
in memory like a cancellation: a durable RTC message resumed after a reload is not handed over (D64).

**The declared retryable outcomes (D65)** live in
[`resolve-al-delivery-fallback-trigger.ts`](../delivery/resolve-al-delivery-fallback-trigger.ts). At
admission every `unroutable` reason (`no-route`, `circuit-open`, `rate-limited`) and
`refused/unsupported` hands the send to the fallback carrier at once, while `refused/no-leader`
hands nothing over (D165), nor does a trusted-server `held-by-other` relay rejection (D175); an RTC
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
the database existed, was created, was reset, or was created again after this document
had opened it (another context's reset after a `versionchange`, an eviction without one).
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
shared store through those bounded key ranges. That owner and a storage reset are
IndexedDB-only; the memory pair is swept by its own lane (Store lanes, above).

A browser database whose stores or recorded schema identity do not match is deleted
and recreated once, and the reset is reported through the required `onStorageReset`
port with the previous and current schema ids; the browser composition states it as
the `reset` event of the store on its `storage` port. An undecodable schema row is treated
as "no schema record yet" and resets the same way. A mismatch that survives that
single reset is a storage invariant failure and throws; a delete that stays blocked by
another open connection throws `ALStorageResetBlockedError`. Unrelated application
storage is preserved, and only ALM-owned databases are reset.

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
