# Inbound admission and queued delivery

[`ALInboundMessageRuntime`](./al-inbound-message-runtime.ts) is the incoming
message boundary. It decodes the envelope, validates the authenticated source,
separates controls from data, and returns an `Either` with rejection or admission
information. Admission is protocol acceptance; application completion requires
separate application evidence.

## Construction and registration

[`createDefaultALInboundRuntimeResources`](./create-default-al-inbound-message-runtime.ts)
assembles the store, clock, entry construction port, worker identity, and existing
QueueBox engine. The WS client and server construct the runtime in
[`WsQueueBoxClientService`](../../services/ws-queue-box-client-service.ts) and
[`WsQueueBoxServerService`](../../services/ws-queue-box-server/ws-queue-box-server-service.ts).
RTC ingress is wired by
[`WebRtcRxStreamerService`](../../services/web-rtc-rx-streamer-service.ts).
These composition owners supply the planner, delivery, forwarding, and control ports. The WS
client and RTC ingress also pass the optional `onResyncRequired` sink
(`ALInboundMessageRuntime.Dependencies`), which the browser fills with its resynchronization
recovery (see "Ordering gaps and resynchronization" below); the WS server passes none. The WS
server alone passes the optional `onReplayAdmitted` dependency: the runtime hands it each kept
message a replay admits, as a `ReplayedAdmission` (`msg`, the `source` the replay ran under, the
`pendingSource` the message was kept under with the audience it captured at ingress, and the room
`snapshotVersion` its authority read), after the attempt's commit and before the replaying work
batch returns, and not while the runtime shuts down. The server starts that message's receipt from it
(outbound README, "Server receipts on WS"). A hand-over that rejects leaves the attempt committed:
the replay is retried, reads `duplicate` and hands nothing over again, so the message's diagnostic
states that `duplicate`, and the delivery it wrote waits for the rotation.

The runtime constructs its [`ALWorkQueuePort`](../work/al-work-queue-port.ts),
[`ALInboundMessageAdmission`](./al-inbound-message-admission.ts) and
[`ALInboundAdmittedDelivery`](./al-inbound-admitted-delivery.ts) before passing them to
[`ALWorkHandler`](../work/al-work-handler.ts) — the same worker the outbound runtime
uses, with `maxConcurrency` fixed at one task. The inbound half of that worker is
[`createALInboundWorkSelector`](./read-al-inbound-work-selection.ts): it owns the rotating
new/retry/reserved page scan that answers the handler's readiness probe and turns one observed
page into claims. The worker registers
with [`InboxOutboxEngine`](../../services/inbox-outbox-engine.ts); registration does
not invoke admission or delivery. Storage readiness precedes the first work scan.
Disposal prevents further local work and unregisters the task. A runtime-owned
engine stops; a supplied shared engine remains available to its other tasks.

## Store identity and carrier partition

One inbound admission store exists per browser session, keyed
`browser-session-inbound:<sessionId>` and resolved once, in the browser's
composition root
([`initialiseMiddleware`](../../../shared-web/browser/connection/initialise-browser-middleware.ts)),
by
[`resolveBrowserSessionALInboundRuntimeStores`](../../../shared-web/browser/al-runtime/browser-al-runtime-stores.ts).
That one resolved store is injected as a required dependency into both
carrier services — the WS client's `WsQueueBoxClientService` and RTC's
`WebRtcRxStreamerService` — and neither resolves its own.

### The memory and IndexedDB lanes

Since S3a the session's inbound store has two lanes (D54), and each is still one per
session shared by both carriers (D20 kept): the IndexedDB pair above, and a memory pair
the same composition root creates once
([`createBrowserALVolatileInboundRuntimeStores`](../../../shared-web/browser/al-runtime/browser-al-runtime-stores.ts),
namespace `browser:<name>:volatile`) and hands to both carriers beside it. So a
volatile duplicate over the other carrier still meets its first admission. A WS
server carries both lanes too, with an unbudgeted memory pair beside its shared
PostgreSQL store, so a best-effort message such as an RTC signal is admitted and
delivered in memory. A WS server beside other instances keeps only what
`keepsVolatileMessageInMemory` accepts in its memory pair: an instance-local RTC signal
(best-effort, unacknowledged, small enough for an inline live notice). Every other
message takes the shared store, since another instance proves an acknowledgement's sender
against its admission there, and reads an oversized live notice's message there. No server
relays an acknowledgement to another instance: each counts the ones it receives in the
receipt record they share.
[`ALInboundMessageRuntime`](./al-inbound-message-runtime.ts) routes; each
[`ALInboundStoreLane`](./lane/al-inbound-store-lane.ts) admits, retains and delivers over
its own pair on the shared engine. The IndexedDB pair is one store shared by both carriers'
lanes, and each lane claims only its own carrier's work type, so recovery is reported per lane:
each lane has its own [`ALStorageRecoveryReporter`](../storage/al-storage-recovery-reporter.ts), and
its first work batch reports the lane's one recovery outcome of the connect through the store's
health, under the store id followed by the carrier (`<store id>/ws`, `<store id>/rtc`), with that
lane's own claims and the expired rows of its own work type.

The durable lane takes the session's `durableWorkOwnership` as the outbound one does (see the
outbound README): while another runtime owns the work it admits and runs no batch, announcing each
commit under its work type `toALInboundWorkType(namespace, carrier)`, and its first batch after
ownership turns true reports the lane's recovery. Inbound commits name no rows, so the owner's lane
applies a foreign one (`applyForeignCommit()`) as its own: a head read and an undescribed commit. The
WS server and Node keep the always-owned default.

- **The durability is the sender's, carried on the envelope.** A data message goes to
  the lane [`resolveALInboundStoreDurability`](./lane/resolve-al-inbound-store-durability.ts)
  names from the envelope's normalized `qos.durability`: the IndexedDB lane exactly when
  it is `local-inbox`. `local-checkpoint` and `local-outbox` keep the sender's copy
  only, so they do not make the receiver durable; `volatile` and the default do not
  either. No receiver-side
  policy moves the decision, and every copy and retry of one message resolves to the
  same lane.
- **The origin's own ACK short-circuits.** An acknowledgement of a message this peer
  originated (its `originPeerId` is this peer,
  [`isALOriginAcknowledgement`](./control/is-al-origin-acknowledgement.ts)) is answered
  `not-handled` and reads no store: the origin keeps no inbound decision surface for its
  own message, and its outbound receipt admission owns the ACK.
- **Every other control tries memory first.** It goes to the volatile lane, and to the
  IndexedDB lane only when the memory lane answers `not-handled`, which writes nothing.
  A control about a durable message therefore costs one memory read before its
  IndexedDB admission, and a control the memory lane handles never reaches IndexedDB. A
  late or unresolved control (its rows swept, or from a peer its owner index does not
  name) costs one IndexedDB read.
- **Duplicate detection is per lane.** A msgId the memory lane admitted is invisible to
  the IndexedDB lane, and the reverse. The lane is fixed by the envelope, so a copy of
  one message always meets its first admission.
- **Tracks do not span stores.** An ordering or supersedence track whose messages
  declare different durabilities is split between the lanes; no caller declares one
  that way.
- **Eviction on the owner's round.** Session cleanup and a storage reset never reach the
  memory pair; it dies with the middleware. Each lane over it (worker id
  `${effectWorkerId}/volatile`) sweeps its expired rows from its own work round, at most
  once per `AL_VOLATILE_STORE_EVICTION_INTERVAL_MS` (60 s) of its clock. Its message-owner
  row lives for the message deadline plus the 30 s receipt grace
  ([`computeALReceiptRetentionExpiryMs`](../delivery/compute-al-receipt-retention-expiry-ms.ts), D74),
  or longer when the work the message owns does; a message with no expiry of its own has
  the deadline its admission implies (`durableEffectTtlMs`, 30 min). The durable pair keeps
  the owner row for the repository's 1 h. Both inbound lanes sweep the shared pair on their
  own 60 s schedule; this is idempotent. After the volatile pair's ordinary expiry sweep,
  that same turn can also release a canonical envelope whose direct work has completed
  ([`evictTerminalVolatileInboundMessages`](./admission/evict-terminal-volatile-inbound-messages.ts)) and
  which no buffered slot or owed child-forwarding receipt still needs. Its owner, dedup and
  control facts keep their original retention. A pending or queued admission write prevents
  this early release; the durable and checkpoint pairs keep their existing policy.
- **The age limit bounds counted admissions, not tracks.** Every pair keeps an ordering
  track's snapshot for `orderingTrackTtlMs`, the repository's 1 h, the volatile pair too
  (D181): a receiver that forgot an unrecorded track would read the sender's next sequence as a
  gap from 1 and stall the track on a repair. Each of the browser's inbound stores keeps at most
  `AL_INBOUND_MAX_ORDERING_TRACKS` (256) ordering snapshots, though (D191, below), and at most
  `AL_INBOUND_MAX_DELIVERED_MARKERS` (256) delivered markers. The server's stores are uncapped
  for both: every WS client's tracks share one store, so a cap there would evict live tracks of
  other sessions, and each marker leaves at its expiry, an hour after the last admission on its
  track; the admin realtime read counts them (`alm.deliveredMarkers`). **Limit:** an idle track
  therefore holds two rows for the hour after its last message on the server, and in the browser
  until a newer track pushes it past either cap.
- **Diagnostics name the lane.** `effect-drain`, `claim-settled` and `rotation-alive`
  carry a required `lane: 'durable' | 'volatile'` (R-S3a-15).

[`al-indexeddb-operation-counts.test.ts`](../../../tests/shared/alm/al-indexeddb-operation-counts.test.ts)
pins the cost: one message admitted and delivered over a durable pair spends 8
admission operations, as before S3a, and so does a `local-inbox` message beside a
volatile pair; a volatile message beside a durable pair spends 0 admission and 0
non-probe work operations; the origin's own ACK reads no store. An idle IndexedDB
rotation over an empty queue spends only page reads (`work-page`): no batch runs, so no
`work-probe` or other work operation reaches storage (R-S3a-11).

An RTC relay keeps 5 rows in the session's memory pair for one relayed volatile message
([`rtc-relay-row-retention.test.ts`](../../../tests/shared/multicast/rtc-relay-row-retention.test.ts), the
standard four-session relay): its pending-ACK row (the relay row), its control-owner index and the canonical
envelope while an owed child may still need forwarding, at most until the message deadline; its message-owner
row lives until the deadline plus the 30 s receipt grace, and
the dedup row for the longer of the 60 s dedup window and the deadline plus the grace (see the dedup retention
below). Once its child's ACK arrives it adds an acknowledgement-history row, kept until the deadline plus the grace
as well. Before S3c-ii the owner row stayed for an hour and the history row
30 min. The acknowledgement-history row of a relay row whose message named no deadline keeps its 30 min
(`controlHistoryTtlMs`), since it has no deadline to be cut to (R-S3c-ii-1).

An inbound data admission on the volatile pair is recorded in the session's volatile budget
([`admitALInboundVolatileBudget`](./lane/admit-al-inbound-volatile-budget.ts)) and released at the earlier of the
message deadline and 30 s after its arrival (`AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS`, R-S3c-ii-6); it is
never refused for capacity (D74, D78). It counts in the ledger's inbound pool (D189) and raises the totals (R-S3c-ii-3):
its count, its bytes and the age of the oldest counted admission, but never the track count, since the ledger records
it with no ordering track (D179). The session's own send is refused, and `overloaded` read, only once the totals are at
the limit and the own pool at its share as well, so arrivals alone refuse no own send. A duplicate, a rejected arrival and a message whose sender named no
deadline count nothing, except a duplicate or a rejected arrival whose admission lost the write of every attempt: it is retained
`pending-admission` (D640) and counts as an admission does, until the earlier of its deadline and 30 s after its
arrival, whatever its replay decides. The platform's own state sync admitted on the volatile pair counts as well (R-S3c-ii-7). An
inbound plan never reads `overloaded` (R-S3c-ii-8), nor `backpressured` (D184): at its bound a session still delivers a best-effort arrival at
once, still forwards it to the children it owns and still sends its ACKs and NACKs.

A message handed from RTC to WS (D66) reaches a receiver twice when its RTC copy was delivered but not
receipted: the WS copy meets the first admission in the shared session store, is refused
`not-handled`/`duplicate`, and, since the message-owner row records the RTC admission, the receiver sends
its own ACK again over WS, a relay as well as a leaf (R-S3b-1, R-S3b-21, see the duplicate answers below)
-- the receipt the WS leg needs from every member of the frozen audience.
The message-owner row also records whether its admission was origin-authenticated (`originAuthenticated`, stored
only when true, so a row written before the field existed reads as not authenticated): the copy's publisher proof
verified here, or the WS server delivered it. A room copy that asks a `receiver` or `leader` receipt and is
origin-authenticated is admitted as new over an admission without that mark
([`isALInboundOriginAuthenticatedReadmission`](./admission/is-al-inbound-origin-authenticated-readmission.ts), D758):
a member's forged unreceipted copy under the origin's id cannot make the origin's own copy a confirmed duplicate. The
application then receives the forged content and afterwards the origin's, each once; the readmission waits while the
first delivery is still queued. Every other second copy is a duplicate as before: an unreceipted, `hop` or `subtree`
copy, a unicast, and any copy that meets an authenticated admission. A readmission whose ordering sequence the
forged copy already released is dropped `ordering-rejected` and answered nothing, and a relay delivers a readmitted
copy locally and forwards nothing, since its stored canonical row is an immutable fact.
The message-owner row records whether the recipient delivers the message, at once or on its ordered release
(`deliveredLocally`; a row written
before the field existed reads as delivered), so a WS copy that meets the RTC admission of a frozen recipient that
answered `not-subscribed` answers `subtree-complete-not-subscribed`, never `delivered`, and the WS server's receipt
aggregation records that recipient in `outsideAudienceRecipientPeerIds`, never as a confirmation.
The WS server narrows its current room to the frozen audience, so a session that left after the RTC
freeze is absent from the WS receipt rather than read unconfirmed.

Every stored key stays session-logical: dedup, message-owner, ordering,
supersedence, and control rows are shared across carriers, because a given
message and its control history are one identity no matter which carrier
delivered them.

### Dedup retention

An admitted message writes one dedup row, whose expiry
[`computeALInboundDedupExpiryMs`](./admission/al-inbound-delivery-mutations.ts) computes; a copy that meets it is
`duplicate`, is never delivered again, and is answered as the duplicate answers below describe, except the
origin-authenticated readmission above. Identity dedup
(`msg-id`, `msg-id+sender`) keeps the row for the longer of the dedup window (60 s by default, at most 5 min) and
the message's own deadline plus the 30 s receipt grace, so a replay inside the deadline meets its first admission
(D125). The deadline term is capped at the message-owner lifetime (`msgOwnerTtlMs`,
60 min by default), the bound a durable message-owner row already has, so a sender's deadline never sets how long
a receiver keeps the row: a replay after the cap and before a deadline further out is delivered again. A message
that names no deadline keeps the window. `semantic-key` dedup keeps the window whatever the deadline, since held
to the deadline it would drop new messages that share the key. Memory, IndexedDB and the WS server's PostgreSQL
store write the row through the one mutation.

What is partitioned per carrier is which QueueBox work rows a runtime may
claim. [`toALInboundWorkType`](./al-inbound-work-entry.ts) types a work row
`AL_INBOUND:<carrier>:<fnv1a64(namespace)>`, so each inbound runtime — RTC or
WS — reserves only its own carrier's type and re-plans, delivers, sends
control, and forwards only on its own carrier. One data-admission commit
bundle carries one carrier — the arriving message's own — on every ordinary
effect it writes (dispatch, forward, ack, nack, repair, and the `renew-gap` timer, which takes its gap NACK's
carrier). The one exception is
a buffered release: the buffered slot records the carrier the buffered
message itself arrived on, and its `release-buffered` row is written under
that slot's carrier, never the releasing message's, so the buffered
message's own runtime is the one that re-plans and dispatches it. When a
releasable slot has already vanished, its confirmation-only row falls back
to the releasing read's carrier, because there is no slot carrier left to
read and the row dispatches nothing.

The control and ACK row family — `pending`, `acks`, and the owner index — is
carrier-tagged too, and lives in its own file,
[`inbound/control/al-inbound-control-rows.ts`](./control/al-inbound-control-rows.ts):
`pending.carrier` is the data message's own arrival carrier, and each entry
in `acks` carries the carrier that ACK itself arrived on, independent of the
message's carrier.
[`ALInboundControlAdmission.admit(msg, source)`](./control/al-inbound-control-admission.ts)
takes the arrival source, from which its carrier is derived. A message's
pending admission retained concurrently over both carriers is a value
outcome, not a thrown corruption: the retained row keeps the first arrival's
source and carrier.

An ACK is `al.control.ack.v3` and a NACK `al.control.nack.v5`
([`al-control.ts`](../../al-contracts/al-control.ts)): beside its hop
sender and receiver each names the message's origin (`originPeerId`, the
message's `senderId`) and the recipient it speaks for
(`logicalRecipientPeerId`), and carries a required nullable `proof`. A
receiver's own control speaks for itself; a relay forwards a child control it
admits as the child sent it, readdressed by
[`toALForwardedReceiptControlMessage`](./control/to-al-forwarded-receipt-control-message.ts),
which keeps every signed field and the proof and rewrites only `fromPeerId`,
`toPeerId` and an ACK's `carrier`: once per distinct statement about a
recipient and, under `receiver` and `leader`, only for a member of the frozen
audience, the only recipients the origin counts. Two child controls are one
statement when they name the same recipient and either are one signed
statement -- both ACKs or both NACKs, one proof identity (`keyId|signature`)
and the same signed content, compared as the proof's own signing input,
which each control's prepared subject encodes at most once
([`toALReceiptStatementSubject`](./control/is-al-same-receipt-statement.ts)) --
or both carry `proof: null`, whatever their content, or are both that
recipient's own word on its own channel (`fromPeerId === logicalRecipientPeerId`,
[`isALOwnWord`](../../al-contracts/receipt-proof/al-receipt-proof.ts))
([`isALSameReceiptStatement`](./control/is-al-same-receipt-statement.ts)). So
above the first relay, where every forward carries the relay's `fromPeerId`,
the proof and what it signs still tell two statements apart, a copied proof
over another content is its own statement, and every honest unsigned flow keys
by the recipient as before; under `hop` and `subtree` on `rtc` a child that
attaches distinct non-null proofs makes distinct statements, which adds no
class there, since such a row has no upward audience and its child could
already name any recipient. It authors only its own word: its `accepted`, its terminal
ACK (below) and its NACKs about itself. The relay refuses a child's ACK as a
duplicate only when its sender, whether it completes the child's hop and its
statement all repeat, so a child relay's ACKs for different recipients are each
admitted, and so is a recipient relay's terminal ACK after its `accepted` one,
while a recipient's repeated own ACK, under a fresh proof, is refused. A relay's
own ACK names its message-owner row's sender as the origin, and a forwarded
control keeps the origin its child signed: both the relay's inbound control
admission and the origin's outbound control admission refuse an ACK or a NACK
whose `originPeerId` names another origin. An
`al.control.ack.v1` or `al.control.ack.v2` envelope is refused `unsupported`
like any unknown control id. The same file defines `al.control.receipt.v1`, the
WS server's word to an origin, addressed and routed to `originPeerId`.

On the WS server the same inbound admission runs for every client message,
with two receipt rules. A `receiver` or `leader` room message the server answers a receipt for
withholds the server's own ACK
([`toWsQueueBoxServerInboundPlan`](../../services/ws-queue-box-server/ws-queue-box-server-inbound-plan.ts)):
the receipt speaks for the audience, and a relay row would forward the
receivers' ACKs as well. A `receiver` message whose logical
recipient is the server keeps its ACK. The server receives an authorized room unicast to another
session itself (D71), so its router delivers it; a unicast to a session outside the room's admitted audience is
refused before admission. A receiver's ACK for a room message
is addressed to the origin, not to the server; the server admits it as the
hop that relayed the message, on whichever instance it arrives, and counts it in the
[receipt record](../receipt-record/README.md) every instance shares. At ingress the
server checks only what needs no store: the ACK speaks for its own sender, and the
receipt hook (`readRelayedAckRejection`, asynchronous) checks that it is addressed to
the origin it names. In the
inbound runtime the hook reads the record once: an ACK the record's validator refuses
(an ended receipt, a sender outside the frozen audience, a passed deadline, a recipient
the server never sent the message) is refused as a typed value and writes nothing. An ACK
that finds no record must be proven by the inbound admission row every instance shares:
the row holds the message under the origin the ACK names, with the ACK's sender in the
audience admission ran under (the volatile store's answer first, then the durable one's).
A proven one is counted ahead of the record; an unproven one is refused. A repeated ACK
is counted as a no-op, not refused (outbound README, "Server receipts on WS"). The
inbound authority does not keep a control message for admission while its room view
is behind; the production authorizer authorizes every control.

Every control carries its subject's trace. The commit bundle stamps the ACK, NACK and repair controls
it writes with the admitted message's `id.traceId`. The WS server's inbound-authority NACK takes the
refused message's trace. The relay ACK takes the admitted ACK's own trace, which is the acknowledged
message's, because every ACK is built from the message it acknowledges; the owner row stores no trace.

The receipt row the ACK completes against is the origin's outbound
pending-ACK row, keyed `(namespace, originPeerId, msgId)`; the group is row
content, not a key segment, because message ids are origin-unique and no
group exists at every key site (R-S2c-i-2, amending D40; see the outbound
README). A relay's inbound `pending` row tracks the child hops it forwarded
to (S2c-ii). A child's confirming ACK it admits is forwarded upward at once,
with the child's own status, time and proof, when the origin counts that
recipient and no earlier child ACK made the same statement about it, so a far
recipient is never lost
behind a relay whose row already completed. Under `receiver` and `leader` a
relay that is itself a logical recipient confirms itself at once with
`accepted` beside its row, when it delivers or when an ordering gap releases its
buffered copy: its confirmation never waits on its subtree, and `accepted`
completes no hop. A child hop completes only on its
own `delivered` ACK (a leaf) or its `subtree-complete` terminal ACK (a relay).
Once this peer is ready and every child hop completed, the relay sends its
own terminal `subtree-complete` ACK, naming itself, last; the parent reads it
as the end of the subtree. A peer that delivered nothing -- local delivery
off, or a session outside the frozen audience, which may forward but never
delivers locally or counts as a recipient -- ends its subtree with
`subtree-complete`, never `delivered` (R-S2c-ii-4). A frozen recipient of a granted RTC publication that may
not subscribe or holds no active token
([`computeRtcPublicationAdmission`](../../multicast/publication/compute-rtc-publication-admission.ts)'s
`forward-not-subscribed`) is the one peer
that says why: under `receiver` and `leader` it sends its hop a `not-subscribed` NACK naming itself, and never
confirms itself -- no `accepted`, no `delivered`, on a retried copy neither. Its hop still ends as any hop does,
with a terminal ACK once its subtree answered (a leaf at once), but of status `subtree-complete-not-subscribed`,
which completes the hop and confirms no recipient: the origin counts nobody for it (PL11), and while a row still owes
that recipient a relay forwards it upward, where it stands for the NACK
([`isALImpliedNotSubscribedNack`](../delivery/is-al-implied-not-subscribed-nack.ts)), so a lost NACK still records
the recipient outside. Such a recipient witnesses the copy's ordering track: its position moves to the copy, nothing
is buffered and no gap is ever asked for, so a copy past where a gap would have been is answered the same way. A
recipient that receives a recorded frozen copy below the position it entered the track at answers `before-entry`
for itself, which places it outside the audience as `not-subscribed` does. A relay admits a child's relayed NACK
(`not-subscribed`, `before-entry`, `gap` -- the NACKs inbound control admission handles; every other NACK stays its
outbound owner's) from a child hop its row waits on and for a recipient of the frozen audience it has neither
recorded outside nor relayed a confirmation for by the same statement. When the history no longer holds any control
that recorded the recipient outside, no recorder is left: the relay forwards the control and the origin judges it,
refusing one for a recipient it holds outside. A non-gap NACK is
refused as past the persistence limits when the row's outside list is full (256) and does not already name its
recipient, since the list gains a recipient only when it is absent. A `gap` NACK must carry its `orderingKey`,
`expectedSeq` and `missingRanges` (else it is refused as malformed); the relay writes no row for it and forwards it,
one relay hop lower and otherwise as the recipient signed it, to its current upstream peer, or to the row's parent when
none resolves, so the origin repairs that recipient through the relay (S4ii-R3). A send
that asks for no receipt leaves no relay row: on a lane that passes a copy down again (it supplies
`forwardRetriedCopy`, as the RTC relay's does; the WS server's lane does not, so the server relays no such NACK), the
relay forwards a child's gap NACK about such a stored message without one, each time it admits it, and records
nothing (6c). It sends it one relay hop lower to its current upstream peer, or to the peer the message arrived from
when none resolves. It admits one from a child (one it forwards the message to, or one the accepted layout of the
message's room names), never that peer, naming
a recipient of the message's frozen audience, when one is frozen, and the message's own track; whom a NACK about a
message that froze no audience speaks for the origin judges, by the recipient's signature. The origin answers a repeat
of a numbered request `duplicate`. A sequence the relay already forwarded and its child lost is
repaired too: on the same lane, a duplicate of such a message from the peer it first arrived from,
naming this relay a next hop, is passed down again as a retried forward to the next hops it would go to were it new,
and a child that holds it reads a duplicate and answers nothing. Nothing tells a repair copy from another copy of the
parent's, so a parent that replays copies is passed down each time, the exposure the receipted parent-retry path
already accepts; a copy from any other neighbour goes nowhere. The leaf's paired `repair` control is not relayed. An
outside-audience NACK the relay records in the row's `outsideAudiencePeerIds` and in a `nacks` control history beside
`acks` (`set-control-nacks`, bounded and expired as `acks` is), and forwards to its parent, once per distinct
statement; its answer to a retried copy forwards again the first of each distinct statement among the stored NACKs
and hop-ends that named the recipient, a NACK, with the child's own reason, before a hop-end of the same statement.
The NACK completes no hop, and no confirming ACK for that recipient that is the same statement is admitted after it
(PL9, PL16). When a not-subscribed recipient's hop-end reaches the relay before its NACK, the relay forwards the
hop-end and refuses the later NACK: the origin records the recipient outside in either order, but the child's reason
reaches it only when the NACK comes first. A row stored before `outsideAudiencePeerIds` existed reads none. The row
stays until it expires, so a child ACK that arrives after completion is still relayed, and a retried copy of the
message is answered from it
([`computeALInboundDuplicateChanges`](./admission/compute-al-inbound-duplicate-changes.ts)):

- from the relay's recorded parent, the relay forwards again each child
  control it already forwarded (per recipient the first of each distinct
  confirming statement, and per recipient recorded outside the first of each
  distinct NACK or hop-end statement that named it), since any of them may be
  the one the origin lost, then its terminal ACK when its subtree completed or
  the copy onward to the child hops it still waits on (R-S2c-ii-4). The copy is
  cut to its commit bundle's cap of 256 durable effects
  ([`resolveALInboundBoundedRetriedEffects`](./admission/compute-al-inbound-duplicate-changes.ts)):
  the relay's own effects always stay, and the stored child controls fill the
  rest, a recipient's own words first, in the order the copy would have sent
  them. The cut is not a flood effect only: an honest room at the RTC room
  limit, 256 recipients below one relay, re-forwards 256 statements beside the
  relay's own effects, so one forwarded word is cut, own words being kept
  first; before S8-ii that retried copy was refused whole;
- from the origin, or from any sender that is not one of its child hops once
  the recorded parent left (no longer a member of the room, or no longer
  reachable), the relay writes that sender as the parent of its row and
  answers it as it would its recorded parent: every forwarded control again,
  the copy onward to the child hops it still waits on, and its terminal ACK only
  once its subtree completed (R-S2c-ii-12). The origin is nobody's child, so
  its copy never comes from a sibling; a retried copy is forwarded as planned
  against the peer that sent it, not the first arrival. A former parent that
  is still present gets the sibling answer at once: it no longer waits on this
  peer, so its own row completes and, under `receiver`, its own delivery is
  still confirmed by its terminal ACK (R-S2c-ii-14);
- from a sibling, a sender that does not own this peer while the recorded
  parent is still present, the relay answers with its own terminal ACK at
  once, so the sibling's row completes whatever the visited exclusion missed
  (R-S2c-ii-8c). The real terminal still reaches the recorded parent;
- a peer with no relay row sends its own ACK again, unless its track still holds the copy's sequence buffered
  behind a gap: it has delivered nothing yet, so it answers nothing, and its `delivered` goes out on the release, as
  for the first copy. A relay row's answer needs its own readiness already.

A copy on the other carrier than the message's first admission is answered as
well, whatever next hops it names: a sender that hands a message from RTC to
WS (D56) admits the same envelope there, and this peer's first ACK went out
on the carrier the sender left. A peer whose message-owner row records the
other carrier sends its own ACK again over the carrier the copy came in on
(R-S3b-1). A peer that holds a relay row does the same, since its own
delivery is what the other carrier's receipt counts; the ACKs it relayed stay
on the first carrier (R-S3b-21). One rule holds on both carriers: a copy whose sequence its track still holds buffered
draws no answer on either, so no `delivered` confirms a message before its release. Answering one would complete the
recipient's statement at its relay and its origin, which then refuse every renewal of the gap that holds the
message back. The buffered slot records instead every carrier and peer pair that brought a copy (`copyCarriers`: each
carrier with the peer its copy acknowledges to, the slot's own pair first, each pair once): a copy from a pair the slot
does not record yet adds it, and the release sends `delivered` to each recorded pair once. A sender that handed the
message over (D56) holds its receipt on the carrier it moved to, and a parent a reshape gave this peer while the gap
held holds its own on the same carrier as the first, so each receipt is confirmed once the message is delivered. A
slot holding `collectionEntries` (256) pairs, the most its decoder reads, records no further pair, whose copy then
draws no answer at the release.

No retried copy is delivered locally twice: a copy meets the dedup row. The one admitted message is handed to the
application again only when its own work runs twice: an ordered delivery's completion that hands the work back (below,
"A delivery's completion"), a crash between dispatch and completion, or a second instance that claims the work after
the first one's lease ran out. A next hop outside the frozen audience reads complete at the origin once
its own terminal hop-end arrives, which confirms no recipient but completes its hop in the origin's hop view, so a
retry resends into its subtree no more; until then every retry resends to it, bounded by the attempt cap.

**Who may confirm a recipient over RTC.** Over WS a session speaks only for
itself (S2c-i). Over RTC, under `receiver` and `leader`, a counted recipient (a
session the frozen audience names or the unicast addresses) signs every ACK and
NACK it authors about the message, and the origin counts it only after
verifying that signature against the key it froze for that recipient when it
froze the audience, whichever peer forwarded it (outbound README). A relay
therefore cannot make the origin confirm, exclude or end a receipt for a
recipient below it; it can only withhold the copy, which the origin's timeout,
retry and fallback cover. An honest relay verifies nothing: it forwards every
distinct statement a child makes about a recipient (above) and the origin
judges each, so a child hop that names another recipient with a proof that does
not verify, or that carries the recipient's real proof over another content (a
peer that held it), no longer pre-empts that recipient's true control here; the
origin refuses the forgery and counts the true control. A parent on the recipient's
path can still withhold the copy or its control. The flood and its three
faces remain, and two need no flood by the forger (below): a child may send any number of distinct forged statements, each stored,
forwarded once and refused at the origin. The relay keeps the last 256 child
ACKs and the last 256 outside-audience NACKs per message, so enough later
statements evict a recipient's true control and a retried copy no longer
re-forwards it, though its first forward had gone up; at a relay above the
first one the cut of a retried copy is arbitrary among forwarded words; and a
history flood can evict the control that recorded a recipient outside (a forged
hop-end records it from the ACK history, where any 256 later child ACKs, honest
ones included, evict it),
after which no recorder is left, so the relay forwards the recipient's later
controls and the origin judges them: its true control goes up and is counted,
and a stale one costs one more forward that the origin refuses. That eviction needs only one forged hop-end and 256
later child ACKs, honest ones included, and in a room at the RTC room limit the
cut falls even without a flood, so a few early forged statements can take the
place of true forwarded words in a re-forward. A child that reuses one
well-formed proof over many altered contents makes the relay encode each
control's signed content once per scan, not once per pair it compares: a
validation prepares its history and control once for every scan, and a retried
copy's grouping
([`toFirstOfEachALReceiptStatement`](./control/is-al-same-receipt-statement.ts))
prepares each stored control once and compares only within one recipient. The
origin counts only what verifies. The
signing runs in
[`signALInboundReceiptControls`](./receipt-proof/sign-al-inbound-receipt-controls.ts)
at the four commit sites (the message admission, both ordered-delivery
commits and the control admission), after validation and before the one
conditional commit, so the stored control is the signed one every later send
resends. It signs a control exactly when
[`is-al-inbound-recipient-receipt.ts`](./receipt-proof/is-al-inbound-recipient-receipt.ts)
marks it: a counted recipient's own ACK or NACK on `rtc`, and a relay's own ACK
when the frozen audience counts the relay; whether this session is
counted is read from the message's own receipt, never from the plan that
refused it, so its refusal NACKs (`not-yet-in-sync` and its siblings, whose
plan states no receipt) are signed too; never a repair request, a control a
relay forwards, a `hop` or `subtree` control or anything on `ws`, which carry
`proof: null`. On `rtc` a receiver also signs its gap NACK, and each renewal of
it, for a message that asks for no receipt: a relay forwards that NACK with the
proof intact, and its origin charges the repair to the recipient it names, so it
admits a relayed one only under that recipient's signature. A composition states it: the RTC overlay `signed`, with the
signer `WebRtcRxStreamerService` builds from the session's publication crypto,
the WS client and the WS server `carrier-authenticated`. A control whose sign
fails is left out of the commit, nothing unsigned goes in its place (its
hop-end included), except the gap NACK of a message that asks for no receipt,
which goes unsigned (its origin admits it unsigned only from the recipient
itself), and the inbound `receipt-sign` diagnostic names it; the data
rows commit, the parent's row stays open, and the origin's retry completes the
recipient. A relay whose own terminal ACK fails to sign leaves its hop
unconfirmed while the receipt completes on its recipients' own words, and signs
it again when a copy reaches it again. A hop still completes only on its own
terminal ACK, a relay's own terminal names itself, and a session outside the
frozen audience is never counted as a recipient.

**Which children a relay owns (R-S2c-ii-8, 8a).** A relay's children are its
next hops minus its sender and minus the sender's forwarding set, the siblings
that already hold the message from that sender
([`resolveALOwnedChildPeerIds`](../../al-contracts/resolve-al-owned-child-peer-ids.ts)).
Every RTC transport copy names only its one addressee in
`forwarding.nextHopPeerIds`, and ingress refuses anything wider, so the
sender's forwarding set rides on `diagnostics.visitedPeerIds`: each group copy
carries the visited set plus its sender plus the dispatch's next hops, and a
relay never forwards to a visited peer. In a star a recipient therefore owns no
children and acknowledges itself `delivered`; in a tree a relay still owns its
descendants, and a peer that is both sibling and descendant is not owned. A
multicast frozen to its recipients (a `group-leader` send, a narrowed audience)
keeps only the children whose subtree over the accepted layout's adjacency
(`OverlayInfo.nextHopsBySessionId`) holds a recipient, at the origin, at every
relay and at the origin's missing-recipient retry; without that adjacency, or
with a recipient it does not place, every child stays. A peer that is the only
recipient keeps no child. A relay that is no recipient and whose adjacency leads
none of its children to one holds a layout that disagrees with its sender's, so
it keeps every child, as the flood did. That fallback cascades: once one peer
keeps every child (no adjacency, an unplaced recipient, or a path child its
room, hint or visited set removes), each relay below it with a consistent layout
sees every recipient behind its sender and keeps every child too, so one
disagreement floods that whole subtree at the cost of the flood before the
adjacency was kept, still at least once. A receiver admits a replaced layout's
authorized neighbours for the session's whole overlap after a layout promotion,
but a sender forwards over that layout only for the first half of it, rounded
down to a whole millisecond, so an overlap of 1 ms forwards never
([`resolveRtcRoomRoutingEdges`](../../multicast/room-authority/resolve-rtc-room-routing-edges.ts)).
A copy is then not refused when two browsers applied the promotion up to that
half apart. In that first half a relay and an origin also own that layout's
authorized neighbours, after the accepted layout's children and without
repeats, a frozen multicast pruned over that layout's own adjacency. The fallback is narrower in that
half: when every recipient has a neighbour that leads to it and only the visited set removes (a path child the
other layout may have addressed), a relay keeps only the neighbours whose subtree holds a recipient over the
edges of both layouts, not every neighbour. A recipient behind the sender in every layout in force, a layout
with no adjacency and an unplaced recipient still keep every child, as does a path child the room, hint or
broadcast list removes, and the relays below a flooding peer flood too. A layout whose own adjacency finds
no route keeps only the neighbours that the union of both layouts' edges leads to a recipient; a layout whose
adjacency finds one prunes over its own. The missing-recipient retry and the failed-peer
repair keep the accepted layout's adjacency, but a failed-peer repair's re-plan
is an ordinary dispatch, so its copy can also reach a replaced-layout child. The
same exclusion governs the forward of a retried copy and the relay row's
expected set. A targeted repair copy inherits the repaired dispatch's own copy
for its peer, so a requester never owns its siblings. Unicast copies carry no
visited list.

**The termination guarantee.** Termination never depends on that exclusion:
the duplicate answer to a sender that is not the recorded parent completes an
over-approximated owner's row. The visited list is capped at
`AL_MESSAGE_RESOURCE_LIMITS.visitedPeers` (64 entries, pinned against the
overlay degree limit so a star's forwarding set never truncates); past the
cap the cost is redundant relays, never a deadlock. The RTC per-copy cost of
the list is estimated at about 117 B in a three-session star and at most about
2.5 KB, well inside every envelope limit; it has not been measured on the wire.

**Repair requests.** A peer attaches an `al.control.repair.v3` retransmit
request to its ACK only for owned children it could not reach (R-S2c-ii-9). A
peer that owns no children never asks: the retry of a recipient the origin
already counted is the origin's decision from its receipt (see the outbound
README for the origin's `no-route` verdict when it owns no child).

The schema identity is `AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-10-roster-fence'`. An
existing browser database at a different schema identity is refused without deletion or
rewriting, as described under
["Selection, failure, and cleanup"](#selection-failure-and-cleanup) below.

S3c-i bumped it because a unicast may now name its room (`targets.groupRef`),
which older decoders refuse (C1). The scoped-delivery bump (D101) followed because the WS
server's rows gained fields older decoders refuse: the captured policy's `recipientScope`,
`principalTargetId` and `sessionInvalidation`, the `ws-client` source's `authenticatedScope`,
and the prepared recipient kinds `scoped-recipient`, `room-recipient` and `invalidated-session`.
A row whose targets name a group stores none of the three captured fields: its `groupRef` scopes it.
The range-repair bump (D139) followed because the buffered slot rows persist the handling plan,
whose NACK plan and ordering observation now carry `missingRanges` (inclusive `{ from, to }`
ranges, at most `AL_MESSAGE_RESOURCE_LIMITS.repairRanges`) where they carried `missingSeqs`
lists; the retained `repair-hint` work and the outbound control history carry the same field.
No row is migrated: an older row's `missingSeqs` fails strict decoding.
The roster-fence bump (D147) followed because every room send's targets carry the sender's
`rosterVersion` (a multicast's in place of `membershipEpoch`, a room broadcast's beside
`minSnapshotVersion`) and the envelope version moved to `AL_MESSAGE_ENVELOPE_VERSION = 3`; a row an
older build wrote carries `id.v: 2`, which the one envelope decoder refuses `unsupported`.
The trace bump (D447) followed because every envelope now carries a required `id.traceId`
(1 to 128 characters of `[A-Za-z0-9_-]`, decoded by `decodeALTraceId`) and the envelope version moved
to `AL_MESSAGE_ENVELOPE_VERSION = 4`. The one envelope decoder refuses a missing or malformed trace
`malformed` and a `v: 3` row an older build wrote `unsupported`. No row is migrated.

**The deploy window.** No row kind this change touches lacks an expiry, so
nothing the WS server's PostgreSQL store holds from before the deploy stays
undecodable or unclaimed forever — but the window is longer than "30
minutes" for two of the four row kinds:

- `pending` and `acks` control rows, and carrier-less `admit-control`
  retained payloads, are undecodable for their control TTL — 30 minutes by
  default (`controlHistoryTtlMs`/`controlPendingTtlMs`) — except that a
  `pending` row whose own message TTL outlives 30 minutes stays undecodable
  for that longer message TTL instead.
- A buffered-slot row written by the old build carries no `carrier` and is
  undecodable for the message's own TTL, or 60 minutes by default
  (`bufferedMessageTtlMs`/`repositoryTtlMs`) when the message has none. Until
  it expires, every later admission on that same ordered track calls
  `readOrderingState`, which lists and decodes every buffered slot of the
  track, so the whole track stalls on `ALAdmissionCorruptionError` — not only
  the one message the slot buffered. Past expiry, the row keeps throwing
  until the runtime-state expiry worker sweeps it, because the PostgreSQL
  prefix read decodes a row before it applies the expiry filter.
- Old-format `AL_INBOUND:<fnv1a64(namespace)>` work rows with no carrier
  segment are simply unclaimed by either runtime until they expire.

An ACK sent by a page still running the old build is refused as
`unsupported` (its type id is `al.control.ack.v1`) until that page reloads —
this is not bounded by the row TTL, since the page itself, not a stored row,
is what is out of date. The refusal is symmetric: an old-build page also
refuses a new-build `al.control.ack.v2`, until it reloads.

**The signed-receipt window.** Slice 8 moved the ACK and NACK to
`al.control.ack.v3` and `al.control.nack.v3` on both carriers, with a required
nullable `proof` and the NACK's `originPeerId`, and refuses `v2` `unsupported`.
A stored `acks` or `nacks` history written by the previous build decodes
through the strict `v3` payload decoders, so it fails as
`ALAdmissionCorruptionError` at the next control or retried copy about that
message until the row expires: for its control TTL (`controlHistoryTtlMs`, 30
minutes by default) in a browser's IndexedDB pair and in the server's
PostgreSQL store, and at the deadline plus the receipt grace in the volatile
lane. A retained `send-control` or `admit-control` row of the previous build is
dropped once as corrupt. Nothing is migrated and `AL_ADMISSION_SCHEMA_ID` is not
bumped, since a different schema identity refuses a returning browser's
durable store rather than resetting it. A page still running the previous
build confirms nothing on either carrier until it reloads: its `v2` controls are
refused by a new page on `rtc` and by the server on `ws`, and it refuses this
build's `v3` controls symmetrically.

**The scoped-delivery window.** The WS server's PostgreSQL rows carry no schema identity, so the
browser identity check refuses an older schema without resetting it. On the server:

- A server rolled back past this change cannot decode a captured policy, a prepared recipient or a
  `ws-client` source this build wrote; each stays undecodable for its row's TTL.
- A raw `WS_OUTBOX` row an older build wrote has no producer provenance and ends `NON_RETRYABLE` at
  its first dequeue (D103).
- `ws-client` work an older build retained carries no `authenticatedScope`, fails strict decoding and is
  dropped once as corrupt.

**The range-repair window.** PostgreSQL rows carry no schema identity here either, so the
browser identity check refuses an older schema without resetting it. On the server, a buffered-slot row, a retained
`repair-hint` and a `nacks`/`repairs` control history row written by the old build fail strict
decoding until they expire: the ordering track TTL (`orderingTrackTtlMs`, by default the repository
TTL of 60 minutes) bounds the buffered slots of a track, and the message deadlines bound the
retained work and the control history, so the window closes without a migration. A NACK or repair a
page still running the old build sends is refused `unsupported` (`al.control.nack.v1`,
`al.control.repair.v1`) until that page reloads, symmetrically with the acknowledgement cutover
above.

**The gap-request-number window.** A gap NACK and a `missing-seq` repair request carry `gapRequestNumber`:
which request for the sequences they name this is, 1 for every report an arrival causes and one more at each
renewal of a gap that stands (2 to 4; "Ordering gaps and resynchronization" below). The NACK moved to
`al.control.nack.v4` and the repair request to `al.control.repair.v3`, refusing `al.control.nack.v3` and
`al.control.repair.v2` `unsupported`, and the NACK proof tag to `rallar-alm-nack-proof-v2`, which signs the number.
The decoders require the number on a `gap` NACK and a `missing-seq` request and refuse it on every other reason; a
`missing-seq` request names at least one missing range, and a `retransmit` or `resync` request names none. A
stored `nacks` or `repairs` history row of the previous build that holds a gap NACK or a `missing-seq` request fails
strict decoding until it expires (`controlHistoryTtlMs`, 30 minutes by default, in a browser's IndexedDB pair and in
the server's PostgreSQL store; the deadline plus the receipt grace in the volatile lane), and a retained
`send-control` or `admit-control` row that holds a previous-build control is dropped once as corrupt. A retained
`repair-hint` row of the previous build that names a missing range carries no number and is dropped once as corrupt
when the lane claims it (a hint names its number exactly when it names a missing range). Nothing is migrated and
`AL_ADMISSION_SCHEMA_ID` is not bumped. A page still running the previous build has its gap NACKs and repair
requests refused `unsupported` on `rtc` and by the server on `ws` until it reloads, and refuses this build's
symmetrically.

**The relay-hop window.** A gap NACK carries `relayHopsLeft`, the relays it may still pass toward its origin
("Ordering gaps and resynchronization" below). The NACK moved to `al.control.nack.v5`, refusing
`al.control.nack.v4` `unsupported`. The proof tag stays `rallar-alm-nack-proof-v2`: the count lies outside the
signed content, so the signing input is unchanged. A page still running the previous build has every NACK refused
`unsupported` on `rtc` and by the server on `ws` until it reloads, and refuses this build's NACKs symmetrically. A
retained `send-control` or `admit-control` row of the previous build that holds a NACK fails strict decoding and is
dropped once as corrupt when the lane claims it. A relay writes no `nacks` row for a gap NACK, but an origin keeps
every NACK it admits in its `nacks` history, so a stored `nacks` history row of the previous build that holds a gap
NACK fails strict decoding until it expires (`controlHistoryTtlMs`, 30 minutes by default, in a browser's IndexedDB
pair and in the server's PostgreSQL store; the deadline plus the receipt grace in the volatile lane). Nothing is
migrated and `AL_ADMISSION_SCHEMA_ID` is not bumped.

**The copy-carriers window.** The buffered slot's `copyCarriers` is required: its own pair first, each carrier and
peer pair once, so one carrier may appear once per peer. No store resets for it, and
`AL_ADMISSION_SCHEMA_ID` is not bumped: since #652 a different schema identity refuses a returning browser's durable
store rather than resetting it, and the slot's `carrier` field (#588) gave no precedent for a bump, since #588 bumped
the identity for the one-inbound-store-per-session namespace it introduced. A buffered-slot row the previous build wrote
carries no `copyCarriers` and fails strict decoding until the expiry sweep removes it, not merely until it expires:
both the server's PostgreSQL store and a browser's IndexedDB pair decode a row before they apply its expiry. Its expiry
is the message's own TTL, or `bufferedMessageTtlMs` (the repository TTL of 60 minutes by default) when it has none.
Until the sweep runs, every admission on that ordered track, which reads every buffered slot of the track, stalls on
`ALAdmissionCorruptionError`; other tracks and every other row are untouched. Memory pairs start empty after a reload or
a restart, so they hold no such row. Nothing is migrated.

**The envelope-version window.** PostgreSQL rows carry no schema identity, so the roster-fence bump
(D147) made older browser schemas incompatible, which current opening refuses without resetting them.
The trace bump (D447) moved the envelope from `v: 3` to `v: 4` with a required `id.traceId`. On the
server, a row an older build wrote holds an older envelope and fails decoding `unsupported` at its
next read; no row is migrated. A persisted topology publication from before `v: 4` has no `traceId`
and is refused as unsupported: replay treats it as a gap and re-hydrates from current topology, and
listings skip it, with no backfill. A page still running an older build sends older
envelopes and controls, refused `unsupported` until it reloads; it refuses this build's `v: 4`
symmetrically.

Web and API deploy together.

## Admission and invocation paths

| Entry                           | Decision and durable result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Subsequent execution                                                                                                                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data ingress                    | `ALInboundMessageAdmission.attempt` reads observations, computes the admission bundle, validates it, then calls `commitBundle`. The store compares the original message, ordering, supersedence, receipt, and delivery observations before writing state and work together.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | A commit that wrote work announces it; one that wrote none leaves that round unannounced — every engine pass walks the rotation either way.                                                                                                                                            |
| Initial data admission conflict | An admission whose write is lost reads and decides again at once, in the same call, three attempts in all with no wait (`retryALInboundLostWrite`): the winner has committed, so the next read sees it. The message is retained as `admit-message` in the same inbound QueueBox namespace, with its source and original deadline, only when all three writes lose, or when it is a readmission that waits for its first delivery (`waiting`, which wrote nothing and is not attempted again), whether its plan admitted or dropped it: a bundle that writes nothing never meets the fence, so the rolled-back one carried rows or effects (a drop's NACK among them) that the replay plans afresh against the winner. Retention checks exact content and identity on reuse. | The caller receives `pending-admission`; the worker later calls `replay`, which makes up to three fresh attempts in its claim, each asking the replay's authority again. Pending storage earns no ACK and, on the WS server, no receipt: the replay that admits the message starts it. |
| Control ingress                 | [`ALInboundControlAdmission`](./control/al-inbound-control-admission.ts) reads the tracked message and expected control peer, then [`computeALInboundControlAdmission`](./control/compute-al-inbound-control-admission.ts) and [`validateALInboundControlAdmission`](./control/validate-al-inbound-control-admission.ts) decide the candidate before a conditional commit of its state and effects. Unknown controls cannot create a pending data message.                                                                                                                                                                                                                                                                                                                  | A commit that wrote work announces it, and the configured control callback receives the acceptance. A commit conflict retains `admit-control` work, answers `pending-admission`, and the worker's replay reports the acceptance through the same callback.                             |
| Admitted delivery               | `ALInboundAdmittedDelivery` decides on the surface its eligibility read carried, and reads that surface itself — the retained message and its stored planning state, from one session — for a claim that carries none. It then re-checks expiry and ordering before it dispatches locally or forwards through the supplied port.                                                                                                                                                                                                                                                                                                                                                                                                                                            | The worker completes or reschedules the claimed QueueBox entry.                                                                                                                                                                                                                        |
| Buffered release                | [`ALInboundOrderedDelivery`](./al-inbound-ordered-delivery.ts) reads progress and buffered work, computes a permitted release or resynchronization result, and commits the observed transition. A release whose write is lost reads the slot and the progress and decides again in the same claim, three attempts in all with no wait; only when all three lose does it hand its work back (`retry`).                                                                                                                                                                                                                                                                                                                                                                       | Local dispatch occurs only after the required release decision; the batch that completes it hands on the track's next delivery, a release or a dispatch (D190, D785), and later work becomes eligible through the same worker.                                                         |
| Gap renewal                     | A `renew-gap` row comes due: [`ALInboundGapRenewal`](./gap-renewal/al-inbound-gap-renewal.ts) reads the track's ordering snapshot and, while part of its range is still missing, retains the gap NACK and `missing-seq` request for that part under the row's number and the next number's timer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The claim completes; the retained controls are sent as any `send-control` row is, and the next timer comes due later.                                                                                                                                                                  |

**A delivery's completion.** After the application is handed an ordered message, its completion moves the track's
delivery progress and deletes the slot in one write guarded on its position and its slot alone
(`commitDeliveryCompletion`), keeping the later of the stored and observed expiry, so an admission's expiry refresh or
a control row written meanwhile does not conflict it. The write places the new position itself, from the stored slot
and the stored `completedThrough` (`computeALInboundDeliveryCompletion`), and writes nothing when they place none. The
slot is compared whole, the retention its message row gives it (`ownerRetainUntilMs`) included, so any rewrite of the
slot between the completion's read and its write, a retention extension among them, costs the completion one attempt.
A write that loses, to a moved position or slot, or on PostgreSQL to a row version another commit moved inside the
write's own round trip, starts a fresh attempt: the completion reads the slot and the progress again as they then are,
decides again (a position already past the message reads it completed), and writes again, three attempts in all, one
after another with no wait. The attempts run through one function, `retryALInboundLostWrite`
([`admission/retry-al-inbound-lost-write.ts`](./admission/retry-al-inbound-lost-write.ts)), which the arrival's
admission, a retained admission's replay and a buffered release use too: one bound and no wait for every inbound
write that is lost. After a dispatch the completion hands the work back (`retry`) in two cases, every attempt
lost or the shutdown signal aborted it, and the application can then be handed the message again, as after a crash
between dispatch and completion. It also hands the work back when its predecessor has not completed, so no completion
can be placed yet; no dispatch precedes that answer, since a dispatch needs the predecessor completed: only a dropped
plan or a disabled local delivery reach it, and they hand the application nothing. An attempt ends in a
`NonRetryableException` when the slot holds another message, when the progress row is gone, or when the slot is gone
and the position has not moved past the message.

**A buffered copy that expires during a read.** A buffered slot names its message row instead of holding the message,
and when the slot is the message's only owned work the two expire at the same instant. No backend reads a chain at one
snapshot or one clock reading: each read drops an expired row against the clock at that read, and on PostgreSQL a
chain's slot read and its message read are separate statements. So a chain can read a slot just before that instant and
its message row just after it, or after a writer that met both expired deleted them. The one function that resolves a
slot's message, `readALInboundBufferedMessage`
([`al-inbound-ordering-validation.ts`](./al-inbound-ordering-validation.ts)), decides that case: on an absent message
row it reads the slot's own key once more through the same session or transaction, and a slot gone there left with its
row, so the chain read no slot. Its three readers answer as a read made
just after the expiry would: the track read (`readOrderingState`, behind the admission read, `readOrderingTrack`, and
the guard of a commit on a track read, which an admission and a bounded hold's end commit on) leaves the slot out; the
single-slot read (behind `readBufferedRelease`, the delivery completion's write, and the guard of a commit on a slot
read, which a release and a resync rejection commit on) answers `undefined`; and `readOrderedDelivery` takes the branch
it takes for an absent next or predecessor slot, the lookup of a lower slot whose reach passes the predecessor included.
A commit whose re-read meets a copy that expired by its clock therefore answers `conflict`.

A PostgreSQL commit cannot decide it by that read alone. It answers a key it has already read from the row it recorded
at that first read, which is what keeps every row it writes conditional on the version its guard compared, so the
expiry sweep, which deletes on the database's clock, can delete a copy's slot and message row between a commit's two
reads while the instance's clock still reads both as live, and the commit's second read of the slot still finds it.
So when the session or transaction still shows the slot, the reader reads the slot's key once more through the store's
own backend, outside the commit: a slot gone there left with its row, and a slot still stored there is the throw. That
answer only chooses between the two; no value the commit compares or writes comes from it. A message row that is
present costs no further read, on any backend. The path that used to throw costs one point read of the slot's key, on
PostgreSQL one autocommit `select` and no transaction; several slots torn in one track read issue theirs in one turn.

Each commit that re-reads a slot then answers `conflict`, and its caller goes on as it does for any lost write. An
admission at the socket and a retained admission's replay try again at once, three attempts in all, and commit against
a track without the copy. A bounded hold's end hands its timer back (`retry`) and the timer's row runs again, where
before it ended for good. A resync rejection hands its row back (`retry`), and the row ends one run later, as an
expired copy's does, with no NACK written. A release and a delivery completion try again at once, find no slot, and end
in a `NonRetryableException` unless the track's position passed the message, as an expired copy's do. On IndexedDB the
added read is the backend's own, so when the clock reaches the slot's own expiry between the commit's re-read and that
read, the backend's existing removal of an expired row runs from inside the commit's callback, before what would have
been the throw; it removes only a row already expired, guarded by the write token it read.

A slot still stored at the last read has lost its message row, which no write leaves, and throws
`ALAdmissionCorruptionError`, as does a message row that names another track or sequence. Two faults of the same shape
throw it too, with no stored record invalid and a second attempt that reads cleanly: a slot written again at the same
sequence between the reads, since the last read decodes whatever the slot's key then holds; and an instance clock that
steps back across the copy's expiry between two reads, so the message row reads absent by the clock and both slot reads
find a live slot. Neither writes anything. At the socket the throw answers the sender nothing; in a replay it ends the
retained admission `non-retryable`, so an accepted message is never admitted or delivered and its sender hears nothing
more; in a release, a resync rejection, a bounded hold's end or a delivery completion it ends that work row the same
way. An operator's prune of the runtime-state category cannot leave a slot without its message row: a page whose delete
removes fewer rows than it read, because a row was rewritten after the page read, throws and rolls back whole
([`admin-prune-page-worker.ts`](../../../shared-server/rallar-system/admin-operations/prune/admin-prune-page-worker.ts)).
A work claim that ends on a corrupt record, these faults' among them, prints one line, `ALM work ended on a corrupt
record`, naming its work row's key and the error ([`al-work-handler.ts`](../work/al-work-handler.ts)); a designed end,
such as an expired copy's `NonRetryableException`, prints nothing. Two other reads still throw corruption for a message
that only expired, so the line prints for them as well: a dispatch's read of its retained message
(`readStoredDeliveryObservation`, [`al-inbound-admitted-delivery.ts`](./al-inbound-admitted-delivery.ts)) and the
admission store's read of an admitted message's ingress source (`readMessageOwner`).

The contract
[`al-inbound-buffered-slot-expiry-contract.ts`](../../../tests/shared/alm/inbound/al-inbound-buffered-slot-expiry-contract.ts)
pins each reader on memory, IndexedDB and PostgreSQL; an admission's commit, a release's commit and a delivery
completion's write across the expiry by the clock on all three; the four commits that lose the copy's rows to another
writer during their re-read (an admission's, a release's, a resync rejection's and a delivery completion's), which
answer `conflict` on IndexedDB and on PostgreSQL, the resync rejection's ordered delivery `retry` and the completion's
`NonRetryableException`; and, on all three, a slot that outlives its message row inside each of the four commits, which
still throws. Memory has no lost-rows case: its writes queue.
[`al-inbound-swept-buffered-copy.test.ts`](../../../tests/shared-server/integration/postgres/al-inbound-swept-buffered-copy.test.ts)
runs the sweep's own predicate on PostgreSQL with the instance's clock 10 s behind the database's: the torn admission
answers `conflict` and its fresh attempt commits, the torn commit spends one autocommit read of the slot's key and no
transaction, and its untorn twin none. A bounded hold's end is pinned in two halves: its guard is the admission's, which
the contract runs, and its `retry` on a commit refused as `conflict` or `expired` is pinned on memory
([`al-inbound-gap-renewal.test.ts`](../../../tests/shared/alm/inbound/gap-renewal/al-inbound-gap-renewal.test.ts)).

**Under load.** Measured through the WS server on PostgreSQL, three instances with every statement, BEGIN and COMMIT
delayed 5 ms, five publishers of receipted room sends that ask for hop order, one track each at 2 a second (D784,
D785). A browser's room send is unordered unless it states an `orderingKey` or a `seq`, and a room channel declared
`order: 'edge'` sends unordered messages that the receiving page sorts, so neither takes this path. On a quiet host,
in three 20 s runs and one 45 s run, every message completed by its deadline (200 of 200, 450 of 450), no send was
parked, recipients read a message 0.6 to 0.7 s after its send (p50, at most 1.2 s), and receipts were read at 19.3 to
19.7 a second of the 20.0 to 20.1 offered. Every admission on a track still rewrites its delivery-progress row only to
extend its expiry (`computeDeliveryProgressRetention`), so a completion, a buffered release or another admission that
read the row still loses its compare-and-set and makes another attempt. A replay or a release that loses three writes
goes to RETRY, which the work rotation reads only after every NEW row (`read-al-inbound-work-selection.ts`), and its
track waits with it.

When one message's dispatch and completion take longer than the gap to its sender's next send (a loaded host, a database
slower than +5 ms a statement, one slow completion, or a sender faster than the cycle), the next message's delivery
reads its predecessor waiting and is set aside, and the batch that completes the predecessor claims it ("Buffered
releases and the snapshot cap.", below). With eight CPU burners beside the run (a 1-minute load of 6.6 to 10.2 at a
run's start), in each of three runs every message completed, no RETRY row was made, no track ended, nothing was handed
to the application twice and every track's hand-offs were in order; the largest batch ran 4.1 to 4.9 s with 16 claims,
and the slowest read of a run was 5.4, 1.7 and 8.0 s. The three loaded runs with the batch-age bound met the same rules,
their figures not told apart from these. At +10 ms on a quiet host every run, two before the bound and three with it,
completed 200 of 200 with no track ended. So five ordered publishers keep up on a host and a database fast enough that a
message completes before its sender's next one arrives. When one does not, in these runs the track's messages still
completed, but while its sender kept its rate its lag climbed (the worst of each loaded run 1.3, 5.1 and 7.7 s, before
the batch-age bound; 13.1, 3.1 and 3.4 s with it, three runs each, not told apart), falling once the sends ended.

A claim's work row stays reserved until its batch ends, so a batch that runs longer than its 10 s lease lets another
instance claim the rows it completed early: an ordered one reads `completed` and is not dispatched again, an unordered
one is handed to the application a second time. Before the batch-age bound, at +10 ms a statement 21 of the 33 inbound
drains of two runs held 16 claims and the five longest of each run took 7.3 to 8.0 s. With it, in three runs, no batch
held 16 claims and the longest took 5.8 to 6.1 s; 44 of the 61 drains that handed on ran past 5 s, the worst 6.07 s with
13 claims, 1 068 ms past the limit, since the claims it already held still ran. No batch came near the lease in any run.
A page of a batch's own 16 claims, with no hand-on, still takes about 16 claims' time and would pass the lease at about
0.6 s a claim; that is older than the hand-on. The bound costs ordered latency where the hand-on carried the load: at
+10 ms every message still completed, but the recipients' read p50 was 8.6 to 10.7 s over three runs against 7.2 and
8.1 s before it, later in every run, and receipts were read at 14.4 to 14.7 a second against 14.8 and 15.1, fewer in
every run. The bound trades later ordered messages, on a saturated database and for a track
past its rate, for a wider margin under the lease.

One ordered track keeps up at 3 messages a second in both runs. At 4 a second every message still completes (80 of 80 in
both runs) but the track runs seconds behind: its last message was read 15.7 and 7.5 s after its send with the bound,
5.8 and 6.4 s before it, further behind in both runs. At 5 a second only the track's first messages complete, on both
codes: 20 to 69 of 100 over four runs with the hand-on, 11 to 72 over eight without; with the hand-on built the track
ended `resync-required` in both runs, the code before it in one of its two. At 10 a second the sends parked at admission
dominate: 4 and 0 of 200 completed, the track not ended. One track at 5 a second beside five unordered publishers on the
same server left the unordered publishers complete (200 of 200 in every run) at a read p50 of 0.83 and 1.44 s with the
bound and 0.72 and 0.86 s before it (two runs each, not told apart), against 0.454 s without the track, since a message
arriving on that lane waits for the track's batch; the code before the hand-on read 1.38 and 0.70 s, not told apart from
either. How the code stood before, and the changes not built with what is known of each, are in `plans/backlog.md`
("What stays of the limit of one ordered track").

`validateALInboundControlAdmission` returns every reason an acknowledgement is
inadmissible; the caller joins them into one rejection reason. Only an absent pending
obligation short-circuits, because the remaining checks read that obligation.

**Ordering gaps and resynchronization.** A receiver orders a sender's messages per track
(ordering key, sender, epoch) behind the last contiguous sequence
([`compute-al-ordering-observation.ts`](../compute-al-ordering-observation.ts)), buffering what
arrives early inside a window of `AL_MESSAGE_RESOURCE_LIMITS.repairWindow` (256) sequences and at
most `bufferedMessages` (256) and `bufferedBytes` (1 MiB) per track. An in-window gap is a `gap`
observation whose `missingRanges` are the inclusive ranges between the contiguous head and the
buffered set; the planner's NACK (`al.control.nack.v5`) and repair request
(`al.control.repair.v3`) carry them, and the sender retransmits them by range. A receiver asks again while a gap
stands. The admission that reveals a newly missing range writes one `renew-gap` timer row for it
([`ALInboundGapRenewal`](./gap-renewal/al-inbound-gap-renewal.ts)), keyed by the track, the range, the next request
number and the revealing message (`toALInboundGapRenewalEffectId`) and due when the range went missing plus an
interval ([`toALInboundWorkEntryDueAt`](./gap-renewal/compute-al-inbound-gap-renewal.ts) moves the planned row's due
time; every other inbound row is due at once). The intervals are
`AL_MESSAGE_RESOURCE_LIMITS.gapRenewalIntervalsMs`, 1 s, 2 s and 4 s, so requests 2, 3 and 4 go about 1 s, 3 s and
7 s after the range went missing, each interval stretched by a factor between 1 and `gapRenewalMaxStretch` (1.5) that
each inbound lane draws once from the runtime's `random`, so receivers behind one gap do not all ask at once. A run
reads the track's ordering snapshot, asks again under its own number for exactly the part of its range still missing,
with the gap NACK and `missing-seq` request an arrival would send (signed as that report is), and arms the next
number; once nothing is missing, the track is gone or the row has expired it ends and writes nothing, and there is no
request past 4. The last timer ends a bounded hold instead of asking a fourth time, on a track the entry rule below
opened at `0` that has delivered nothing ("Entry, omission and witness"). Every row has a fixed id written if absent, so a run a lease recovery repeats finds what the first
wrote, and a burst of later frames arms one row; reports caused by arrivals keep their one number. The rows expire
with the message (a held start range's live for the track's ordering TTL without retaining its message, "Entry,
omission and witness"), and on the server's PostgreSQL store an expired row is never claimed and the queue's expiry sweep
removes it. A durable lane renews after a reload, a volatile lane does not. A run asks the peer the gap was first
reported to, which the row records, while the lane still routes over it: on `rtc`, a connected neighbour of the
layout it replaced while that one is still forwarded over
([`isRtcRoutedPeerReady`](../../multicast/resolve-rtc-upstream-peer-id.ts)), so during a reshape's overlap the old
relay, which still forwards to the leaf, is asked. A direct link wins over that: once the accepted layout links the
leaf to the origin, the run asks the origin, whose copies no longer pass through the old relay. Once the recorded peer
is gone the run asks the track's current upstream peer, the one connected neighbour the accepted layout routes toward
the origin ([`resolveALUpstreamPeerId`](../../al-contracts/resolve-al-owned-child-peer-ids.ts)); when none resolves
(a WS runtime, a layout without an adjacency, the revealing message no longer kept) it asks the recorded peer again.
Every run arms the next number. The gap NACK carries the repair; a repair request needs no forward. So a renewal
reaches the origin behind a relay, on an `ack: 'none'` track and after a reshape alike: every relay path below forwards
the child's gap NACK, and the lane cells `relayed-gap-renewal` and `relayed-unreceipted-gap-renewal` state it over
`rtc` by the request number the origin's `control-admission` diagnostic names. The row path and 6c take one child rule
(`isALInboundRelayChild`): a child is a peer the plan its copy went down named, or one the accepted layout of the
message's room names below it ([`isRtcLayoutChildPeer`](../../multicast/resolve-rtc-upstream-peer-id.ts)). A relay
forwards a child's gap NACK toward the origin while it holds a pending row that waits on that child; about a stored
message that asked for no receipt (6c); and from a layout child its row does not wait on, or about a message it holds
nothing of (6d), whether the NACK is the child's own word or one it relayed for a recipient below it. Every path sends
it to the relay's current upstream peer, the one connected neighbour the accepted layout routes toward the origin and
never the sender; when none resolves, to the parent it knows, the row's or on 6c the peer the message arrived from
(`resolveALInboundGapNackTarget`). A relay that holds nothing of the message reads no room for it, so it passes the
NACK to the upstream peer its accepted layouts name ([`resolveRtcRelayParent`](../../multicast/resolve-rtc-upstream-peer-id.ts)).
Relays whose accepted layouts
disagree during a reshape can pass one NACK round a cycle, so a gap NACK carries a hop limit (ruling 20):
`relayHopsLeft`, required on a gap and outside the recipient's signature as `fromPeerId` and `toPeerId` are. The
decoder refuses a count above `AL_GAP_NACK_RELAY_HOP_LIMIT` (255), the wire ceiling: the overlay planner bounds a
layout's degree, not its depth, so the longest line in a room at the RTC room limit passes that many relays. The leaf
grants one fewer than the live sessions of the message's room, at most that ceiling (`computeALGapNackRelayHops`), read
only when it builds its report or a renewal (`readGapNackRelayHops`, passed to the effect facts as a reader, so an
admission or release that builds no gap NACK reads no room; a WS runtime grants the ceiling): layouts that
disagree route a NACK along no one layout, so only the room's size bounds its path. Each relay forwards it one lower,
and never higher than one fewer than its own grant, read by the same rule from the message's room, or, holding nothing
of the message, from the room whose layout names the sender its child (`computeALRelayedGapNackHops`). A relay's room
bounds the grant only once its presence also names the child the NACK came from and the peer it forwards it to; with
no room to read, as on WS, or presence that lags behind any of them, its grant is the ceiling. Presence that names
them but lags behind relays further up can still grant too few, which costs a request until the next renewal reads
again. So the room bound holds at every relay whose presence names the NACK's neighbours, whatever count a child
claims, and
a cycle ends within the grant's forwards of each copy; a relay refuses a NACK its grant leaves no hop to forward,
validation alone deciding it, and a duplicate delivery
of a forward starts a copy of its own, since 6c and 6d record nothing. A relay also refuses a NACK that speaks
for itself, its own report come back round a cycle, as its own reports leave from its gap run. Whom a relayed NACK
speaks for the origin judges, by the recipient's signature or its receipt. The forwards of 6c and 6d record nothing, and
a row is left as it was. The origin ignores the hop count. The origin admits a
gap NACK such a relay re-sends for a room send once its repair authority planned a repair to the relay, a ready room
neighbour, and while the receipt still owes the recipient (or, with no receipt, the
audience names it); the repair copy reaches the relay as a first arrival, which it forwards down its own layout. A
sequence past the window, or a track at a buffer ceiling, is `resync-required`: the message is not buffered and the
sender is NACKed. When the admission accepts a message `resync-required`, or
[`ALInboundOrderedDelivery`](./al-inbound-ordered-delivery.ts) can no longer order a buffered
release, the runtime hands `{ msg, cursor }` to the optional `onResyncRequired` sink after the
NACK has committed, so the owner is told of a resynchronization the sender is already told of. The
cursor ([`ALInboundResyncCursor`](./al-inbound-resync-required.ts)) is where the track stands:
`orderingKey`, `senderId`, `epoch`, `lastContiguousSeq`, `expectedSeq`, `observedSeq` and
`carrier`. The runtime resets no track after a resynchronization; the sender's new epoch is a new
track. Without the sink -- the WS server's case -- the message is dropped as before and the
diagnostics state the refusal. A WS client admits every server frame as `trusted-server`, so a
server publication that carries a sequence is ordered on the track
`<orderingKey>:<serverPeerId>:<epoch>` (the default server peer id is `default-qbox-server`), and the NACK and repair request for its gap go to the server, since a
`trusted-server` source's `fromPeerId` is the message's `senderId`; the server repairs its own
publication (D153). The recovery owner of a server track is the typed channel the publication's
topic and type name, found as for any sender (D142). A receiver remembers a server track for its ordering-track TTL, by default the repository
TTL (60 minutes) that also bounds the server's head, so a track silent for over an hour restarts at
`seq` 1 on both sides, and since the server's sequences follow commit order, two publications of one
track can commit out of publish order under contention.

**Entry, omission and witness.** A copy an ordering authority recorded carries
`ordering.priorSeqByRecipient`, the last sequence that authority sent each listed recipient before this one
(outbound README, "Sent positions"); a recipient it lists not had `seq - 1`
([`resolveALOrderingPriorSeq`](../../al-contracts/al-runtime.ts)). The runtime's required `orderingObserver` input
says whose tracks it keeps: `addressed` (the RTC receiver and the WS client) keeps a track only for a copy addressed
to it, `every-track` (the WS server, its clients' ordering hop) every track it admits.
[`resolveALOrderingObserverRole`](./admission/resolve-al-ordering-observer-role.ts) reads the planner snapshot's
`selfPeerId`: an `every-track` runtime or a delivering admission is a `recipient`, a frozen recipient that may not
deliver a `witness`, and any other peer, a pure relay included, `none`, which observes nothing and forwards a
recorded track it never saw. A recipient with no snapshot opens the track at `0` where the copy's record owes it the
start ([`isALOrderingTrackStartOwed`](./admission/is-al-ordering-track-start-owed.ts)): the copy's frozen audience names
the recipient, the copy's plan repairs gaps (a plan whose repair algorithm is `none` plans no gap NACK, so it could
never ask), it is not latest-wins in its plan, the store has not evicted the track, and the prior `p` is above `0` and
below `seq`, within the repair window (`p` at most 256). It then treats the copy as tracked above `0`: it buffers the
copy and asks the gap `1` to `p` through the gap NACK, renewal and release path above. The record speaks only for the
copy's frozen audience, so a copy whose audience does not name the recipient enters as it always did: the WS server,
ordering hop of every track, is never in an RTC copy's frozen audience, so the RTC admission's message a client hands
over to it after admission enters there. A copy of a client's own WS send carries no frozen audience (the server keeps
the audience it freezes at ingress beside the message, not in it), and neither does a unicast copy, so a WS client
enters at such a copy; but an RTC leg handed over to WS after its freeze keeps its frozen multicast verbatim, so a WS
client that audience names takes the rule on the server's copy, with the server's own record for it. Any
other recipient with no snapshot enters a recorded track at its copy (`entered`); one whose position `L` the copy's
prior meets, with the sequence past `L + 1`, delivers it `omitted`; a
prior ahead of `L` is a gap that ends at the prior; a prior behind `L`, `0` on a held track, or a copy without a
record reads the rule above. `entered` and `omitted` deliver as `in-order` does, a buffered copy whose own prior
equals `L` is released as its successor, and delivery progress jumps to a delivered sequence once its predecessor
completed ([`al-inbound-delivery-progress.ts`](./admission/al-inbound-delivery-progress.ts)). A witness moves its
position to the copy and buffers, asks and releases nothing; its progress passes the copy only when nothing below is
pending delivery, so a session that witnessed while its own deliveries were pending, and is a recipient again,
resyncs its next delivered copy. A recorded frozen copy below a recipient's position is `stale` and answers a
`before-entry` NACK (above, under the relay); an unrecorded stale copy is dropped with no NACK, as before recorded
tracks, and so is a copy of a WS send, which carries no frozen audience: over `ws` the server skips a copy below a
recorded position before it is sent. After each committed admission, replays included, and after a bounded hold's
end that enters at a copy (below),
[`recordALInboundOrderingPosition`](./admission/record-al-inbound-ordering-position.ts) states an `ordering-position`
diagnostic for an `entered`, an `omitted`, a `witnessed` copy that moved the position and a `before-entry`
refusal, with the lane's `workerId`, the track, `seq`, the record's `priorSeq` (`null` without one) and the
carrier. Its bounded dimensions are `status` (four values) and `carrier` (`rtc`, `ws`); `workerId`, `trackKey` and the
trace (`msgId`, `traceId`, `corrId`) are identifiers for logs and traces, and `seq` and `priorSeq` are values, never
metric labels. [`computeALInboundOrderingCounters`](./admission/al-inbound-ordering-counters.ts) folds those events
into `ALInboundOrderingCounters` (`entered`, `omitted`, `witnessed`, `beforeEntry`), returning its input unchanged for
any other event; it counts events, not distinct copies, so a repeated `before-entry` refusal or a duplicate `witnessed`
counts again. The browser keeps one fold per connect in a tee around the connect's inbound diagnostics sink, shared by
both carriers, and reports it as `rallar.messages.readUsage().ordering`, keyed on `status` alone. The store knows an
evicted track from one row, `<namespace>:ordering-evicted`
([`al-inbound-evicted-ordering-tracks.ts`](./admission/al-inbound-evicted-ordering-tracks.ts)): the tracks the browser's
256-track cap evicted, each until its eviction plus the ordering TTL, newest last, at most 256. The eviction pass
([`evict-al-inbound-ordering-tracks-past-cap.ts`](./admission/evict-al-inbound-ordering-tracks-past-cap.ts)) writes it in
the transaction that removes the snapshots, for the snapshots it actually removed, and gives the row its newest entry's
instant as its expiry, so the row leaves the store once every entry lapsed; an admission whose track has no live
snapshot reads it, in a capped store only. The row is decoded fail-loud, like every stored row: a corrupt row fails
every admission in the store whose track has no live snapshot, and the eviction pass, until it is removed. A track on
it enters at its next copy, as before, since its earlier frames were delivered. A snapshot that expired needs no row:
the receiver's TTL outlasts the sender's head, so the sender restarts such a track at `seq` `1` with prior `0`, which
enters. A late joiner's first copy enters too wherever its record names it with prior `0`, the authority having sent
it nothing on the track; under `rtc-with-ws-fallback` that does not always hold, since the record raises a recipient
never sent the track to the room's WS-leg floor (outbound README, "Sent positions"), so a genuine late joiner can read
a prior above `0`, ask a range the RTC origin cannot serve, and enter only when its bounded hold ends.

**Bounded hold.** A track opened at `0` that has delivered nothing (its position still `0`) waits for its start at
most until its renewal schedule ends. The admission that opens it arms the start range's timer (`1` to `p`,
[`isALOrderingHeldStartRange`](./gap-renewal/compute-al-ordering-held-entry.ts)) to live at least as long as the
track's ordering snapshot does from the reveal (`orderingTrackTtlMs`), whatever the copy's own lifetime, so the last
timer runs however late the engine claims it; every other gap timer still expires with its message. The admission
decides once that the timer holds the start and the timer carries it (`heldStart`, a required field of the
`renew-gap` row). Such a timer names the copy that revealed the range without retaining it
([`isALInboundMessageRetainingWork`](./gap-renewal/compute-al-inbound-gap-renewal.ts): the bundle neither extends
the message's canonical and owner rows to the timer's expiry nor requires them to outlive it), so that message keeps
its own lifetime. When that last timer comes due with
the range still missing, the third request has gone unanswered for its whole interval, so the timer asks no fourth
time and ends the hold instead: about the sum of the renewal intervals (1 s, 2 s and 4 s) times the lane's stretch (1
to 1.5) after the gap was revealed, so 7 to 10.5 s. The last run reads the track by its key alone
(`readOrderingTrack`: its snapshot, live buffered copies and delivery progress, guarded by the rows of the message the
timer names, held or not). One rule,
[`computeALOrderingHeldEntry`](./gap-renewal/compute-al-ordering-held-entry.ts), over the timer's `heldStart` and the
track's live buffered copies, ends it: the track passes every
buffered sequence below its lowest live copy and enters at that copy, releasing it and each live successor the run
reaches across nothing but expired copies, and its position also passes the expired copies right after that run (none
will be delivered), so only a sequence never received stays a gap; with no live copy (every held copy expired) it
passes every buffered sequence and releases nothing, so its next copy follows in order. A buffered slot records the
sequence its completed delivery moves the progress through (`completesThrough`, a required slot field: its own
`seq`, and for the run's last copy the end of the expired copies passed after it), so completing that copy completes
the passed ones too and the next copy, in order after them, is delivered; one rule,
[`computeALInboundDeliveryCompletion`](./admission/al-inbound-delivery-progress.ts), beside the omission's jump to its
prior, reads it for every completion, and its reach predicate `isALInboundDeliveryReaching`
serves the delivery-readiness lookup of a predecessor (the predecessor's own slot by its key, or on a miss the slot
whose reach passes it, so a copy that arrives before the run's last delivery completed waits on that delivery) and the
check, at write and at read, that a slot reaches at least its own sequence. A buffered copy is live only
while its message lives: its slot is written with the message's own expiry and every rewrite of it takes a release
row's, which is that expiry too.
[`computeALInboundHeldTrackEntry`](./gap-renewal/compute-al-inbound-held-track-entry.ts) commits an entry as an entered
admission of that copy would, from that copy's own admission surface: the new position, the copy's slot recording it
`entered` (so its delivery waits on nothing below it), and a release of the copy and of each contiguous live successor
through the buffered-release path; after its commit it states the copy's `entered` `ordering-position`, as an entered
admission does, so `readUsage().ordering` counts the hold's entry;
`computeALInboundPassedTrack` moves the position and the delivery progress past the buffered sequences, as a witness
does, and states no position event: it judges no copy, and none of the four statuses describes passing expired copies.
Both are guarded by the track as read, so an arrival that moved the track first wins and the timer runs again, as does
an end that cannot commit because its copy expired meanwhile. A copy below the new
position that arrives later is `stale` and answers `before-entry`, as at any entry. A track that delivered anything,
or whose start range's revealing copy owes no start (an unrecorded track, the WS server's initial window included),
keeps the mid-track behaviour: the fourth request goes out and the track waits.

**Limits:** a fresh recipient whose copy's prior is above 256 enters past the lost frames; a start the origin cannot
serve (its retention ended, it left, or the path repairs nothing) holds the later copies until the bounded hold ends
and is then lost, and under `rtc-with-ws-fallback` a genuine late joiner whose prior the WS-leg floor raised waits the
same bound before it enters; a recipient that forgot a track it delivered (one pushed off the evicted list by 256 later
evictions, a storage reset or a new connect that keeps the peer id) asks for its start again: the frames the origin
still retains are delivered once more (at least once, past the 60 s dedup window), and older ones end the hold; a
live-only hand-over copy carries no record and is dropped silently (`ordering-rejected`, no NACK), and over plain `ws`
it is dropped `stale` with no NACK and stays unconfirmed in the origin's receipt.

**Buffered releases and the snapshot cap.** The message that closes a gap writes one release row per sequence it makes
releasable, and each release is eligible only once its predecessor is delivered, so a page holds one claimable release
of a track and defers the rest. One rule carries a track on, whichever kind its next delivery is (D190, D785): the
batch that completes a delivery of track T, a dispatch or a release, claims the delivery T's next message waits on.
Who claims is the lane's own work batch that ran the completing claim (on the WS server the instance whose worker
completed it, over the store every instance shares; in a browser the tab that owns the session's work). The completion
states the position it committed, `completedThrough` k, and the handler hands it to the selector's
`claimOrderedSuccessor` ([`claim-al-inbound-ordered-successor.ts`](./lane/claim-al-inbound-ordered-successor.ts)),
which finds the successor by one read of T's slot at seq k + 1 and then the row that slot names, by its key, not by
searching a page. It reserves the row only when it is this lane's work type, not expired, due (a new row, or a retried
one whose delay has passed), its delivery reads ready now, by the readiness read the rotation's page makes, and the row
is still as the read saw it, as a new or retrying row (`claimObserved`). The handed-on claim runs after every claim the
batch already holds, and the batch asks for a successor only while it holds fewer than `AL_INBOUND_WORK_PAGE_SIZE` (16)
claims and has run less than half its work lease (`AL_INBOUND_HAND_ON_BATCH_AGE_MS`, 5 s of the 10 s
`AL_INBOUND_WORK_LEASE_MS`), counted from the batch's first clock reading, which precedes every reservation it makes.
Both checks come before any read; a successor refused for either stays as it is and is found by the head read or the
rotation. The age bounds when hand-ons stop, not when the batch ends: the claims the batch already holds still run.
It claims nothing, and writes nothing, when no slot stands at k + 1 (the next message not admitted yet, behind
a gap, or left out for this receiver), when the slot names no delivery row or one of another carrier's lane, or when
the row is reserved elsewhere, expired, not due, not ready or moved since the read. A successor whose track has ended
(its progress row gone, its delivery reading `resync-required`) is reserved, so that its dispatch rejects it, as the
rotation's page reserves it. A delivery that did not complete hands nothing on, a full batch or a lane being disposed
asks for nothing, a track never has two deliveries claimed at once, and a delivery never hands on another track's. The
lookup reads no page, leaves the rotation's position where it was and runs no lease-timeout sweep; the only write is
the reservation, and order is decided again at dispatch, from the store. A `claimOrderedSuccessor` that throws is
reported as the batch's failure and hands nothing on; the completed claim stays completed and the batch's unrun claims
still run. On PostgreSQL an ordered completion with nothing waiting costs one statement more, the slot read, and a
hand-on spends 10 statements on its row against the rotation's 6 (the slot read, the row read, and a second read of the
message and its owner row, since the handed-on delivery reads its own surface again), where the rotation also spends
three reads a batch (its page, the rows out of attempts, the lease-timeout read). A 64-message buffer drains in 5
batches of 16, 16, 16, 16 and 1 claims: the first delivers the gap-filling message and hands on 15 releases, each of
the next three hands on 15, and the last runs one. Measured before this rule, when the first batch ran the gap-filling
message alone and only a release was handed on, the same buffer drained in 5 batches where one release per engine round
took 65: 0.4 s against 7.5 s in memory, and 0.7 s against 13.5 s on IndexedDB with 84 % fewer IndexedDB operations; a
255-message buffer drained in 17 batches (2.1 s in memory, 33.5 s before), well inside the 30 s default message
lifetime that the one-release drain outlived. Those timings were not taken again. The `effect-drain` of such a batch
counts the deliveries it ran by hand-on as `promoted`, and they leave its `deferred`.

A store built with `maxOrderingTracks` keeps at most that many ordering snapshots (D191): the browser's
session and volatile stores pass `AL_INBOUND_MAX_ORDERING_TRACKS` (256); the WS server's Postgres stores, the
Node runtime's and the default factories' pass `undefined`, run no pass and state no count, since one server
store holds every relayed client's tracks and a cap there would evict live ones. A commit that opens
a track lists the store's ordering prefix right after it commits and, past the cap, removes the least
recently updated snapshots in a write of its own, each only while it is still the very snapshot read (a
track updated again in the same millisecond survives). Between the two writes the store may hold 257. A
snapshot whose removal finds it changed, or whose write conflicts, is left to the next new track and counts
as still held until then, while one that a rival pass already removed counts as gone. The pass is
best-effort: the admission has committed, so a snapshot that does not decode, a failed removal write or a
throwing reporter ends the pass without a count, the commit still answers `committed`, and the next new
track evicts. The evicted track's next arrival is read as a new track's: a recorded copy enters it again, an
unrecorded one reads from sequence 1, and
the release of a message buffered on a track evicted beyond its delivered head reads `resync-required`. Only
the snapshot leaves: the track's `delivered` marker has its own cap. A store that
names a reporter (`reportOrderingTracks`) is told the number of snapshots it holds after each such pass; the
browser states it on the `storage` diagnostics port as `ordering-tracks`. **Limit:** a receiver holding
more than 256 live ordered tracks in one store thrashes: each new track evicts a live one, whose next unrecorded
arrival reads as a gap from sequence 1 and goes to repair or resynchronization.

**The browser's delivered-marker cap.** Each of the browser's inbound stores, the session's IndexedDB pair and
its volatile memory pair alike, keeps at most `AL_INBOUND_MAX_DELIVERED_MARKERS` (256) delivered markers
([`evict-al-inbound-delivered-markers-past-cap.ts`](./admission/evict-al-inbound-delivered-markers-past-cap.ts)).
The store keeps an in-memory index of its markers in the order their expiry last moved forward
([`al-inbound-delivered-marker-index.ts`](./admission/al-inbound-delivered-marker-index.ts)), fed by every
committed marker write; a track's first marker past the cap evicts the index's head, the least recently admitted
track's marker, in one guarded write that rereads it, without reading the store's other markers. The first pass
of a store lists its markers once so the index also holds the rows written before it existed. The index drops
markers as they expire, so a sender that stops opening tracks leaves no entry once its markers expire. **Soft
cap:** a marker whose track still buffers a release is never evicted, an in-order message waiting for its
delivery included (every locally delivered ordered message keeps a buffered slot until its delivery completes),
because that delivery reads the marker as its completion evidence; the next oldest leaves instead, and a store
whose every marker buffers stays past the cap until its releases drain or expire. A track whose marker left
reads its next release as `resync-required`, as one whose snapshot left does. The store states the markers it
holds after each pass to `reportDeliveredMarkers`; the browser states it on the `storage` port as
`delivered-markers`, and the harness reads the sum as `stats.rallar.alm.deliveredMarkers`.

**Room authority and the membership fence.** An RTC receiver judges a room send against the room
snapshot it holds before planning it
([`rtc-room-snapshot-admission.ts`](../../multicast/room-authority/rtc-room-snapshot-admission.ts); the sender and peer
verdicts in [`resolve-rtc-room-peer-denial.ts`](../../multicast/room-authority/resolve-rtc-room-peer-denial.ts)). Behind the
send's `minSnapshotVersion` or its `rosterVersion` the verdict is `pending`: the message is dropped
`not-yet-in-sync`, its hop is NACKed with that reason, and the receiver refreshes the room once and
re-admits the message once. At or beyond both, a sender whose member is absent or not `active` is
`membership-fenced`: the message is dropped with that code and its hop is NACKed with that reason,
with no ordering hints, no repair request and no refresh. A sender whose session is absent while its
member is present stays `pending` at its own roster, since presence is not the roster, and is fenced
in a roster beyond its stamp; every other room denial stays `unauthorized` and sends no NACK. An
unstamped room copy (no `rosterVersion`) is judged as at its sender's roster, so a sender that is
not an active member is fenced there too. The
fence applies at ingress only (a copy with a `fromPeerId`); the origin and targeted repair keep their
verdicts. A held relayed copy is re-judged at dispatch with its ingress hop, so a sender fenced since
the hold resolves `rejected` instead of waiting to its deadline, while the origin's own held copies
keep today's verdicts. The WS server applies the same two floors and fences a sender with no
live session or no active member at its admission and its dispatch-time re-authorization
([`ws-topic-room-authorizer.ts`](../../../shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts)); the
receiving WS client trusts it. Behind either floor at its admission the WS server retains the
message as a pending admission ([`retainPending`](./al-inbound-message-admission.ts)) instead of
refusing it, answers the advisory NACK, and its replay re-authorizes the message every 50 ms until
the floor is met or the deadline passes. The NACK ends the sending WS client's first-hop wait and nothing else, so
the client writes the send no more. A replay that admits the message starts its receipt, and the sender reads
`admitted`, then `complete` or `timed-out`; a replay its room refuses answers the sender with that refusal's NACK when
the refusal sends one (see
"Replay authority and deadlines"); a message still kept at its deadline is answered nothing, and the handle reads
`expired` (outbound README, "Server receipts on WS").

**Room-bounded audiences.** A principal or fixed-list send is a room send whose audience is narrowed
to the principal's sessions or the listed sessions in the room (D156, D159). Over RTC the origin
freezes the narrowed audience on the multicast, so a peer outside it may forward a copy but never
delivers it locally or counts as a recipient, as for any frozen audience. The shared planner also
reads a broadcast's `recipientPeerIds`: it reads this peer as a broadcast's logical recipient when
`exceptPeerIds` does not name it and, if the broadcast carries `recipientPeerIds`, the list does
([`al-policy.ts`](../../al-contracts/al-policy.ts)), and a relay owns as children only listed peers,
by the rule a multicast's frozen list applies
([`resolveALOwnedChildPeerIds`](../../al-contracts/resolve-al-owned-child-peer-ids.ts)). A listed
room broadcast is therefore delivered only at listed sessions, over WS as over RTC; a WS server
whose router owns the room fanout hands a listed broadcast that leaves it out to its router, as it
hands a room unicast to another session. A broadcast without a list keeps the `exceptPeerIds` rule
alone. A `group-leader` send is the narrowest of these audiences: the room's director session alone,
frozen at the RTC origin and admitted by the WS server (D164). Only the director delivers it, and its
ordinary ACK, sent at admission as any recipient's, is the one the `leader` receipt expects; a room
peer that carries it over RTC only forwards it and ends its subtree with `subtree-complete`.

**Exclusive claims.** The WS server's admission of a client's exclusive message decides an exclusive claim on
the message's resource key (D171–D173); it is not the worker's claim on a work row. The admission store's private
`toALInboundClaimKey` ([`al-inbound-admission-store.ts`](./al-inbound-admission-store.ts)) names the key
`<applicationId>/<workspaceId>/<groupId>/<topicId>/<contextId>/<resourceId>`, each part URI-encoded, only when the
admission source is `ws-client`, the message's effective ownership is `exclusive` and its targets name a room
`groupRef`; the room scope is part of the key because the same group id exists in other scopes. `readIncomingMessage`
reads the exclusive-claim row at `<namespace>:claim:<key>` beside the dedup key, as a guarded observation of the
commit: its value is the holder's peer id and its liveness is the row's own expiry, which every backend applies on
read. The planning observation `claimHolderPeerId` carries the holder, and `resolveMessageDrop`, right after the
duplicate check, drops an exclusive message whose key another peer holds with the code `held-by-other`; `planNack`
answers it with a NACK of that reason to the sender, so nothing is delivered and a claim dropped at its first attempt
starts no receipt. An admitted exclusive message writes the `set-claim` mutation, its sender as holder and its own
deadline as expiry, in the transaction that commits its dedup, ordering and ACK rows: the holder's re-send moves the
expiry, and an exclusive claim past its message's deadline leaves the key free for the next claimant. A message with no
deadline of its own (no `expiresAtMs`, no expiry policy) holds the key until the deadline its admission implies
(`durableEffectTtlMs`, the store's retention default); every browser send carries a `ttlMs`. Two claimants that both
read a free key conflict at the commit, and the loser's fresh attempt, in the same call, is planned against the winner.
An admission that loses the write of all three attempts is retained (D640), so on the WS server every replayed drop of
a receipted room send, a `held-by-other` claim, a `resync-required` gap or any other drop its replay NACKs, first
answers `pending-admission`, which starts no receipt. The replay's NACK is the only answer the origin reads: it ends the send whatever its receipt,
and the handle reads `rejected`. A kept send its replay admits starts its receipt then. A `shared` message neither
reads nor writes an exclusive claim, and an `rtc-peer` or `trusted-server` admission never reads or writes one, so a
browser never drops a message for it.

A commit announces the work it wrote, and only that. A data or control replay whose own
commit persisted work, and an inline control admission whose commit wrote a row, announce
it through `commitWork()`: it asks the rotation page for a head read
([`ALInboundRotationPage`](./lane/al-inbound-rotation-page.ts)) and then tells the handler.
The next page read starts at the head of NEW and stores no position, so the rotation resumes
where it stood; a page a probe held is dropped without moving the rotation. The row reaches the
batch the commit starts when the owner is idle, or the follow-up batch the running batch's end
runs. Both land one batch later when a head batch ran since the last rotation read. At most one
head read runs between two rotation reads: a commit that lands during a head batch, or after one
before the next rotation read, waits for the read after that rotation read, and the lane announces it again at that
rotation read, so the handler's own follow-up batch runs it. The rotation therefore advances at
least every other page read while commits keep arriving, and later NEW pages, RETRY rows and expired
reservations keep their turn. A retained
conflict announces for the same reason, and only when retention left a claimable row: a message
already past its deadline is rejected before the write or as a row written already expired, and a
row that is already terminal holds nothing to claim. An admission that wrote no row announces nothing, because
there is nothing for the worker to claim; a bundle that writes nothing commits without meeting
the fence, so it never conflicts and is never retained.

## The admission directory

[`admission/`](./admission) holds the pure inbound admission decision.
[`computeALInboundAdmission`](./admission/compute-al-inbound-admission.ts) turns one
read plus its handling plan into the mutations and effect intents an admitted message
owns, delegating the dedup/ordering half to
[`al-inbound-delivery-mutations.ts`](./admission/al-inbound-delivery-mutations.ts).
[`validateALInboundCommitBundle`](./admission/validate-al-inbound-commit-bundle.ts)
checks the bundle as a whole — its limits, effect writes, provenance lifetimes and
canonical messages — and
[`validateALInboundAdmissionMutation`](./admission/validate-al-inbound-admission-mutation.ts)
reports every reason one mutation may not be committed, including whether it writes
outside the original observations the read captured.

[`ALInboundAdmissionStore`](./al-inbound-admission-store.ts) owns persisted
observations and conditional admission; its private provider-backed implementation
writes through [`ALAdmissionWorkBackend`](../al-admission-work-backend.ts).
[`ALInboundDurableEffectStore`](./al-inbound-durable-effect-store.ts) writes effect
ownership into QueueBox rows inside the admission transaction and reads ordered-delivery
evidence; reservation and release belong to the work port alone.

Every inbound decision surface — `readIncomingMessage`, `readBufferedRelease`,
`readDeliverySurface`, `readOrderedDelivery` and `readControlDecisionSurface` — reads
its whole chain inside one
[`ALAdmissionWorkBackend.readWithin`](../al-admission-work-backend.ts) session, so a
surface costs one store snapshot rather than one read per row it needs. On IndexedDB that
session is a single readonly transaction over the admission store and the work store; the
memory and PostgreSQL backends hold no snapshot to keep open and serve the session from the
backend itself. A read issued after that transaction ended continues on a fresh one, so an
await on anything but a session read splits the surface in two without saying so: a
decision surface awaits the session's own promises and nothing else. The session never
writes, which is why these reads stay outside the write that follows them, and the fence
`requireOriginalObservations` still re-reads the whole observed surface inside the write —
the snapshot makes the read cheap, the fence is what makes the commit conditional.

A row the chain read past its expiry reads as absent. On IndexedDB, once the chain has read
everything, `readWithin` evicts those rows in one readwrite, each removal guarded by the write
token the chain read it at; the direct `read` and `list` evict the same way. If another writer
replaced or removed one of those rows in between, for example a concurrent chain that evicted it
first, the guard rolls the whole eviction back and the row is left to that writer or to the next
chain that reads it expired. The guarded write answers that as not committed, and the eviction
does not turn the answer into an error: the chain already answered from a snapshot in which the
row was absent, and a conflict belongs only to a write that fences on what it read. A read
surface therefore never throws `ALAdmissionBackendConflictError`, so the admission reading it —
the outbound control admission of an ACK included — reaches its own commit and its own typed
conflict.

What makes that commit conditional differs by backend. On memory and IndexedDB every key the
write phase read or wrote is compared: the in-memory backend serializes writers on its own
write-tail promise, so what the write phase reads is what its commit sees; IndexedDB records, for
every key the write phase read or wrote, the revision and write token it observed there (or that
the key was absent), and for every prefix it listed, the exact key set that listing returned, then
re-reads exactly those rows and prefixes before the transaction commits and rolls back as a typed
conflict only when one of them moved. PostgreSQL guards the keys a write touched and not the keys it
only read: `PSqlAdmissionMutationCollector` emits one insert-if-absent, replace-if-revision or
delete-if-revision guard per written key, while the store-level re-read of the observed surface
runs before the transaction opens and fences nothing by itself. The arbitration rests on what the
three share: every key the two writers of the stale-read then sequential-commit schedule arbitrate
on — the dedup key, the supersedence latest, the ordering track, the message owner, and on the
outbound side the supersedence latest and the sender version — is one both writers write, so the
written-key guard decides the schedule alike on all three. The schedule module
[`al-shared-key-arbitration.test.ts`](../../../tests/shared/alm/al-shared-key-arbitration.test.ts)
is the proof: it runs that schedule over memory, IndexedDB and pglite for both stores and names,
per case, the written key whose guard decides it — the dedup key, the supersedence latest, the
ordering track, the outbound supersedence latest and the outbound sender version, which two messages of one sender,
each on its own ordering track, share and nothing else; the same-message
case of
[`inbound-supersedence-concurrency.test.ts`](../../../tests/shared/alm/inbound-supersedence-concurrency.test.ts)
covers the message owner on the same three backends. An admission, send, or ACK against a different
message's rows and a different listed range touches none of that and commits alongside it.

Every stored key is `topicId/resourceId/contextId`, and inbound work is
`AL_INBOUND/<namespace>/<effectId>` so one session's rows are a bounded key range.
An admitted message writes two provenance rows: the message owner row, keyed by
namespace, message id and sender id, which retains the validated ingress source and
supersedence key ([`al-inbound-source-validation.ts`](./al-inbound-source-validation.ts)),
and the canonical inbound message row
([`al-inbound-canonical-message.ts`](./al-inbound-canonical-message.ts)), which retains the
envelope until the `retainUntilMs` its own row states — the latest deadline of the effects
and slots that bundle owns, so a bundle owning neither writes no canonical row. Both must
outlive the owned work the same bundle writes; a bundle whose provenance expires first is
rejected. For the fresh volatile pair alone, `retainUntilMs` is an upper bound: its existing
maintenance turn can remove the full envelope earlier once no live direct work, buffered
slot or owed child-forwarding receipt requires it. Owner and receipt facts remain held.

## Replay authority and deadlines

A retained conflict's replay re-reads its decision surface. It does not carry one forward,
and cannot: a conflict means an authority-bearing observation moved, so the surface the
attempt read is exactly the thing that has to be read again. The pre-plan, the deadline and
the decoded message are pure work re-derived from the message and the source
[`retainPending`](./al-inbound-message-admission.ts) already persists; the effect facts are
carried by neither, and are taken fresh instead — `readALInboundEffectFacts` constructs
`selfPeerId`, `observedAtEpochMs` and a new `controlIdPrefix` from the replay's own clock
and this owner's effect preparation. So the retained payload carries nothing it did not
carry before and the stored schema identity did not move. The replay runs in the batch the
owner's own commit starts when the worker is idle, or in the follow-up batch `commitPending`
schedules when a batch is already running (in either case one batch later when a head batch ran
since the last rotation read); it never waits for the rotation to come round to it.

Pending replay uses the currently configured planner. The WS server additionally supplies
`readPendingAdmissionAuthority`, which calls its existing asynchronous authority owner before
admission and applies the addressee check ingress applies, so a kept unicast whose addressee has
left the audience is refused, not admitted to nobody. Current authorized recipients intersect the
captured recipients, and the answer states the room snapshot version they were read at. An admitted
room multicast counts the server among its group members, so the server delivers it locally to the
topic router, which owns the room's fanout; the server never forwards it. A refusal answers the
sender as the same refusal at ingress would: when the refusal's `sendNack` is set, the server sends
its advisory NACK with that reason, then retires the pending work without admission metadata or
receipts. An application refusal, or a room message with no authorizer installed, retires it with no
NACK, as at ingress. Temporary authority catch-up (`not-yet-in-sync`, or a server being disposed)
sends nothing and uses the existing `RETRY`/future `nextTs` path with `reason: 'not-ready'`,
preserving the processing attempt count.

Each replay that reaches a verdict states its own `admission-outcome` after the
`pending` / `pending-admission` its ingress stated; a replay whose authority asks for a retry,
and one cut short by shutdown, states nothing. The mapping is stated once, in the
[runtime diagnostic contract](../../../shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md)
(`admission-outcome`).

The deadline is captured before pending retention and checked again after awaited
authority reads. Changed policy, restart, and retry cannot extend it. Conditional
write conflicts are attempted again at once, three attempts in a claim, and each fresh attempt
asks the authority and checks the deadline again; a replay whose every write lost goes back
as `retry` and consumes an ordinary processing attempt, under QueueBox's bounded retry policy.
A readmission that waits for its first delivery answers `waiting`: it wrote nothing, is not
attempted again, and stays retained. An arrival's fresh attempts run inside the one call its
carrier authorized and do not ask the carrier's authority again: on the WS server the socket's
scope and the frozen room audience are read above the inbound runtime, before the call. A
resynchronization NACK whose write is lost, which ends a track, answers `retry` and is not
attempted again at once. A pure computation does not make sending atomic with completing work:
crash replay can repeat an external effect, and so can an ordered completion that hands
its work back, so protocol identity and deduplication remain necessary.

Message admission also passes that deadline to the existing backend write boundary.
IndexedDB checks native request completion while the transaction can still abort;
PostgreSQL checks after its awaited mutations before leaving the transaction.
Expiry rolls back admission metadata and work together. Later control retention and
terminal bookkeeping can omit an execution deadline without authorizing another send.

## Selection, failure, and cleanup

A message its durable store cannot persist is `not-admitted` with reason `storage-unavailable`: the
failed transaction wrote nothing, so the sender's receipt retries it. A control that its inbound store,
or the outbound owner it is handed to, cannot persist answers its carrier as an unhandled control, and
its `admission-outcome` reads `not-handled` with reason `storage-unavailable: <cause>`; inside an
`admit-control` replay claim the outbound failure retries the claim instead. That retry finds the
inbound admission already committed and completes without handing the control over again; the receipt
timeout and the peer's re-ACK heal it. The
failure is recorded on the pair's health, as is a work batch that fails for its storage; every
admission that wrote work and every flushed batch is a recovery point. `ready()` answers a pair that
cannot open as a value, and the next call opens again; until then the lane starts no work and its
idle readiness probe answers no work without touching storage.

The worker holds one 16-entry observation page. It reads through QueueBox's
`readWorkPage` port and
[`createALInboundWorkSelector`](./read-al-inbound-work-selection.ts) skips known
ineligible ordered work before reservation. QueueBox compares the observations
when claiming and owns reservation timeout, retry, exhaustion, and release.

The delivery that an eligibility read cleared does not read that surface again. For a
`dispatch-local` or `forward-message` row the read takes the retained message and its
stored planning state, and the selector carries exactly that surface to the claim by effect
id ([`ALInboundDeliveryObservation`](./al-inbound-admitted-delivery.ts)). It is recorded
only for a row the port went on to reserve, and it is replaced by the next claimed selection. A
commit leaves it in place: it describes a row the running batch holds, and a commit changes neither
that reservation nor the stored message, source and plan it carries. The delivery then decides
again only what cannot be decided as early
as the page: every expiry, against a fresh clock reading, and an ordered message's
predecessor, which can land inside the claim window. A claim that carries no observation
reads the surface for itself.

A batch runs the page's claims in rank order rather than page order:
[`computeALInboundClaimOrder`](./read-al-inbound-work-selection.ts) puts `dispatch-local` and
`release-buffered` first, then admission replays and rows whose kind the page never decoded,
then `forward-message` and `renew-gap`. Where `send-control` runs depends on the lane: on the volatile lane it
runs first, since an ACK confirms admission, never the handler, and must not wait behind a page
of deliveries; on the durable lane it runs last beside `forward-message`, so its commits never
delay a delivery (D19). The sort reads the kind from the map
the eligibility read already filled, so it costs no operation and opens no transaction, and it
is stable within a rank, so page order still decides among equals.

A batch's `send-control` claims share one send. The selection records every `send-control` row
the port reserved, with the envelope its eligibility read decoded
([`getClaimedControlSends`](./read-al-inbound-work-selection.ts)), in a fresh array per
selection. The first of those claims to run hands the whole array to `sendControlMessages`, and
every other claim of that batch awaits the same send. The browser carriers commit that array as one
outbound admission (`enqueueAllIfAbsent`); the WS server sends its messages one after another, in
order
([`WsQueueBoxServerControlDelivery`](../../services/ws-queue-box-server/ws-queue-box-server-control-delivery.ts)).
The round is keyed by that array's identity, never by time, so a row retried in a later
batch never joins a finished round. A commit leaves the claimed array in place, so a running batch's control claims still send as one round.
When the round's send throws, each of its claims sends its own message alone, so each
claim settles on its own message. That path serves the WS client, whose grouped admission rethrows
a member's storage throw once every member ran: a message the round already admitted then answers
`duplicate`, and only the claim whose message throws again carries that failure. On RTC the round
does not throw, because the multicast manager's circuit breaker answers a throw as `failed` values,
as it answered a single send's throw before grouping. The WS server writes to the sockets it holds
and admits nothing, except a control whose target has no socket on the instance that claimed its
row. Any instance of a deployment may claim that row, so with a cluster publisher registered the
control is admitted as one durable `WS_OUTBOX` row, idempotent by message id, whose first dequeue
publishes it to every instance once; the instance holding the target's socket sends it, and the row
completes whether or not one does. Without a cluster publisher the control is dropped with a
warning. A throw in the WS server's round sends the messages before it a second time, which
receivers drop by message id.

The probe walks the rotation. It reads pages back to back until one holds work it can claim, and
then answers due now and holds that page for the batch that follows; or until a rotation it read
from the head of NEW wraps, and then answers the earliest readiness it scanned, its head reads'
included, or no work. A walk that starts mid-rotation finishes that rotation and reads one more
whole, so it never answers without having read every status. The next probe continues after the
claimed page, so one status never hides work on the next. A head read stores no position, a
rotation read stores its position only from the position it was read at, and a read a commit or a
batch took from the probe mid-read ends the walk as due — that commit owes a head read, and the
batch it starts runs it — so a walk reads at most about two rotations. A batch therefore
runs only for a page it can claim from, or for a commit, and the engine's own idle backoff, 100 ms
doubling to the 3 s idle ceiling, paces an idle lane
([`al-inbound-idle-engine-pass-rate.test.ts`](../../../tests/shared/alm/inbound/al-inbound-idle-engine-pass-rate.test.ts)).

A held row — one eligibility defers, for a missing predecessor or consumer, a group snapshot not
yet in sync, or a congestion defer — adds no readiness and no timer of its own. The worker is
constructed with `AL_WORK_PROBE_EVERY_ROUND` rather than the remembered readiness the outbound
owners use, so every engine pass walks the rotation again and re-reads it: at once after any wake
(a commit, a batch's progress, a consumer registration through `onInboxMessageDo`, a group snapshot
refresh), and otherwise on the engine's idle backoff, within the idle ceiling plus its jitter.
Measured over a hundred engine passes of an idle owner — `al-indexeddb-operation-counts.test.ts`,
both an empty queue and one holding a row no consumer claims — each pass walks NEW, RETRY and
RESERVED once, 302 page reads in all (the first pass also finishes, at RETRY and RESERVED, the
rotation the bootstrap batch began), and no batch runs. Over a held backlog an idle pass reads one
rotation's pages and makes one eligibility read per held row.

The runtime relays no `readiness-probe` for it. One event per engine round is cheap in
storage and expensive in the conformance lane, where every relayed diagnostic is a round
trip out of the page: it roughly doubled the page's event traffic and its measured
per-operation cost, 8.2 to 20.9 ms/op, which delayed RTC signaling far enough that the
delivery baseline received nothing and the cell failed. Suppressed, the same cell passes
at 10-13 ms/op — 12.6 measured on the full lane, 10.3 on the rtc-only run that isolated
this relay — and `rotation-alive` remains the liveness witness that a scanning rotation is
still running.

What the owner does relay is `effect-drain`, for a batch that touched work, reporting where
that batch spent its time — selection, claim, run and release, which do not sum to its
duration, for the reasons the contract document states — and how long the earliest row it
claimed had been due (`queueWaitMs`); one `claim-settled` for each claim that ran to an
outcome, with that claim's own duration, attempts, outcome and wait — a row that cannot be
decoded and a claim that throws are counted by the drain but emit no `claim-settled` event.
Enabled ACK association or handoff evidence can separately record a thrown claim. The owner relays
`rotation-alive` from completed rotations, at most once per `AL_INBOUND_ROTATION_WINDOW_MS` window,
the idle ceiling less its 20 % jitter (2.4 s): the first rotation that completes at least that long
after the window opened states it (`rotationCount`, and the window's `durationMs`) and opens the
next, so every idle pass, 2.4 to 3.6 s apart, states one. `longestRotationReadMs`, the slowest
rotation's own page reads summed, each from before its read to its settlement, keeps one crawling
scan from being averaged away by the rest. Each `claim-settled`
also carries `effectId` (the claimed row's own key), `subjectMsgId` (the message the effect
acts on) and the three instants a delivery's wait splits at — `dueAtMs`, when its row became
due; `batchStartedAtMs`, when its batch's run loop started, after that batch's selection and
reservation; and `startedAtMs`, when the claim itself started — so the reservation half
(`batchStartedAtMs − dueAtMs`) and the intra-batch half (`startedAtMs − batchStartedAtMs`, the
serialization behind earlier claims of the run loop alone) are each named rather than left for
a reader to subtract. `effect-drain` carries the matching `startedAtMs`, names the effects it
ran in run order (`claimedEffectIds`, recorded by this owner as it runs them) and counts the
deliveries it ran by hand-on (`promoted`, D190, D785). The due rows a page
saw and did not run ride on the events that already exist, never on one of their own: a
batch that ran claims lists them in its `effect-drain.deferred`, and every completed rotation
folds the rows it held back into its window's `rotation-alive` (`deferredRotationCount`, and
`latestDeferred`: the latest such rotation's rows, oldest first, at most one page of them). A
batch that claimed nothing — a commit's page with nothing claimable, or a port that reserved
nothing the page cleared — relays nothing and counts toward nothing. No
`readiness-probe` reaches the inbound topic. The field-by-field contract is in
[`runtime-diagnostic-contract.md`](../../../shared-test/rallar-bb-test/docs/runtime-diagnostic-contract.md).

Explicit ACK capture is owned by
[`ALInboundAcknowledgementEvidence`](./control/al-inbound-acknowledgement-evidence.ts).
The black-box browser diagnostic installer supplies its class and the existing
`ALWorkBatchObservations` resource through the callable sink's optional
`acknowledgementCapture`. Runtime/lane/admission reference that owner only as a
type; ordinary sinks create no new ACK evidence. It covers both controls the relay
admits — a child's ACK and its `not-subscribed` NACK — through one recording path,
each identity naming its `control`. The association retains exact
received and generated control identities, logical recipient, prior owner/source,
pending parent, candidate validity, actual conditional commit and retention results.
A conflict's candidate IDs remain distinguishable from a replay's newly generated
IDs. Terminal sender ACKs bypass inbound storage without inventing upward work.

Capture copies closed owned facts before mutable consumers, with guarded snapshots.
The evidence owner selects and snapshots claim context in `tryCreateClaim`;
`publishClaim` selects replay or handoff from that snapshot. The lane retains
mandatory work and clocks. A returned handoff remains returned if the enclosing
claim later throws, for example at its existing duration-clock read.
Ingress publishes after its mandatory lane wake and outbound callback, including
original exception unwind. Replay and actual `sendControlInRound` outcomes use the
handler's existing deferral and publish after mandatory release/end/failure/clear/
pending-commit work. Failed optional batch construction discards publications.
There are no additional store reads, generated IDs or clock reads. Commit return
is not independent persisted readback; handoff is not native receipt; absent events
are not proof of absent work. The detailed field meanings and clock limitations
are in the diagnostic contract linked above.

[`decodeALInboundWorkEntry`](./al-inbound-work-entry.ts) checks the stored variant,
namespace, full identity, queue slot, and deadline. Malformed claimed work becomes
`NON_RETRYABLE`; valid work from the same batch continues. Operational failures
return to ordinary QueueBox retry. A failed terminal write does not establish a
successful finalization.

Browser expiry and session cleanup are owned by
[`browser-al-work-cleanup.ts`](../../../shared-web/browser/al-runtime/browser-al-work-cleanup.ts)
in each scope's admission database. Because every AL-owned key leads with its owner,
cleanup deletes one bounded key range per owned `AL_INBOUND`/`AL_OUTBOUND` namespace
and per owned canonical scope, and each range ends its `resourceId` with the `/`
delimiter so a neighbouring owner whose id is a string prefix is never pulled in.
Unrelated work is preserved.

A browser database whose stores or recorded schema identity do not match is refused with
`ALStorageSchemaMismatchError`, preserving its schema and rows. Unreadable or undecodable
identity throws `ALStorageSchemaIdentityError` with its original cause; acquired handles
close on failure. Genuine absence still creates the current stores. The required
`onStorageReset` callback reports observed external `other-context` recreation after a
recorded `versionchange`, not a destructive mismatch recovery; the details are in the
[outbound navigation map](../outbound/README.md#atomic-indexeddb-work-storage).
The outbound canonical storage cutover does not establish the roadmap's
zero-IndexedDB volatile path for inbound work.

Semantic evidence starts with
[`al-inbound-pending-admission.test.ts`](../../../tests/shared/alm/al-inbound-pending-admission.test.ts),
[`ws-rtc-signaling-admission-recovery.test.ts`](../../../tests/shared/webrtc/ws-rtc-signaling-admission-recovery.test.ts),
and [`ws-queue-box-server-ingress.test.ts`](../../../tests/shared/services/ws-queue-box-server-ingress.test.ts).
These entry and persistence tests complement the real browser workflow; passing
them does not by itself prove native RTC connection readiness.

## Replies and their diagnostics

A message whose `actions.replyToMsgId` is set is a reply. The inbound runtime admits and deduplicates it like any
message: a copy that meets the first admission's dedup row is never delivered (the origin-authenticated readmission
apart), so a cross-carrier duplicate or a retransmission of one reply reaches a consumer once. Matching a reply to its request is not inbound-runtime work.
In the browser, [`BrowserMessageReplyInbox`](../../../shared-web/browser/messages/reply/browser-message-reply-inbox.ts)
is a handler of the WS any-message inbox (`message-replies`, order 15), and the messaging subscriptions skip replies,
so a reply never reaches an `onMessage` subscriber of its type. The inbox hands the reply to the delivery registry,
whose entry for the request owns one
[`BrowserMessageReplySlot`](../../../shared-web/browser/messages/reply/browser-message-reply-slot.ts). The slot's
admission is `matched` (the first reply, from the unicast's addressee or any sender for an audience request),
`wrong-responder` (the request was a unicast to another peer; judged first) or `late`. A request the registry no
longer retains has no entry, so its reply is `late`.

Replies travel over WS only. The RTC inbox keeps one callback per type, which the messaging subscriptions own, so a
reply that arrives over RTC is not matched: when the page subscribes to its type over RTC, the subscriptions drop it and
state `reply-late` with cause `unobserved` and `carrier: 'rtc'`, even while the request is awaited. A reply on a type
with no RTC subscription never reaches the inbox, so nothing is stated.

Each dropped reply states one event on the session's inbound diagnostics sink, built by
[`toBrowserReplyDropDiagnostic`](../../../shared-web/browser/messages/reply/to-browser-reply-drop-diagnostic.ts) and
typed in [`ALInboundRuntimeDiagnosticsEvent`](./al-inbound-runtime-diagnostics.ts):

- `reply-late`, with `cause` `replied` (the slot already holds a reply), `timed-out` (a reply wait timed out and
  closed the slot) or `unobserved` (no retained entry holds the request, or the reply arrived over RTC);
- `reply-wrong-responder`, with `expectedSenderId`.

Both carry `msgId`, `replyToMsgId`, `corrId`, `typeId`, `senderId` and `carrier`, and never the payload. A matched
reply states nothing.
