# ALM publication QoS and pub/sub addendum

Prepared: 2026-10-09. Status: Slice 1 (bounded publication pacing), Slice 2
(authorized WS pub/sub, as S2-i and S2-ii), Slice 3 (restricted RTC parity, as
S3-i and S3-ii), Slice 4 (ordered subscription entry, as S4-i and S4-ii), Slice
5 (producer-row positions, as S5-i), Slice 6 (granted unicast, list and
principal broadcast over RTC, as S6-i and S6-ii), Slice 7 (cross-instance
positions and outside class, as S7-i and S7-ii) and Slice 8 (signed receipts on
RTC, as S8-i and S8-ii) are implemented and recorded as applied in §7; Slice 9's
first part (one owner each, as S9-i) is recorded in §7 and its second part,
S9-ii, is pending; the later outcomes remain a proposed extension, not
implemented behavior or an adopted change to `docs/product.md`.

This plan brings the publication-pacing proposals in
[PR #632](https://github.com/intact-software-systems/ar-eye-hunter/pull/632)
and the publisher/subscriber membership discussion into one ALM design. It
extends the [persistence and performance QoS plan](alm-qos-product-plan.md),
the [complete product description](alm-complete-product-description.md), and
the [ALM roadmap](alm-improvement-plan.md). It does not replace their existing
delivery or durability guarantees. The
[RallarActor proposal](../../plans/active/rallar-actor.md) is a consumer of this
shared capability, alongside browsers and server producers.

Statements below are proposed requirements. Preparing and publishing this
document does not authorize their implementation or allocate new roadmap
decision numbers. Adoption must settle the compatibility and security choices
described here. The pull request remains the delivery record; this document is
not a progress ledger.

## 1. Intended outcome

An application can express a directed data flow inside a scoped Rallar group:
who may publish, who may subscribe, and which live sessions currently receive
the feed. Each channel declares QoS appropriate to its facts. Replaceable
state may use bounded publication pacing; commands and durable events retain
their independent delivery requirements.

The host keeps simulation, interest management, payload meaning, processing,
and business authority. ALM owns publication admission and delivery semantics.
Group-state owns membership and publication permissions. A browser, native
actor, server producer, tool, sensor, or agent uses the same scoped contracts.

ALM authenticates a participant's session. For an actor, that is the actor's
own session; the host process beside it is the actor's local concern, and the
attachment between host and actor is a trust boundary the actor product owns,
not a path ALM sees or vouches for.

This makes several flows possible without creating a workflow engine:

| Flow                             | Publication participation                        | Appropriate delivery                           |
| -------------------------------- | ------------------------------------------------ | ---------------------------------------------- |
| Sensor to dashboard              | Sensor publishes telemetry; dashboard subscribes | Paced latest value, short expiry               |
| Device control                   | Operator publishes commands; device subscribes   | Receipted command plus an application result   |
| Mixed native/browser observation | Simulation publishes; observers subscribe        | Bounded recent live values                     |
| Announcements                    | Approved producers publish; members subscribe    | Reliable notification to the admitted audience |
| Application processing pipeline  | A stage subscribes to input and publishes output | QoS chosen independently on each topic         |

An announcement does not imply offline replay. A processing pipeline owns
lineage, loop prevention, idempotent effects, and processing acknowledgements.
Forwarding one envelope and producing a new publication are different actions.

## 2. Evidence and existing boundaries

The runtime observations were checked against repository source on 2026-10-09,
including the merged ALM work at
[`31146e845`](https://github.com/intact-software-systems/ar-eye-hunter/tree/31146e845ae3e7404a98c8fbcdb7c9f6639412dc).
PR #632's actor documents are proposals. Its older ALM descriptions are not
evidence that the merged runtime lacks later audience or ownership work.

| Existing fact                                             | Source and implication                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Administrative roles are owner, admin, and member         | [Group contracts](https://github.com/intact-software-systems/ar-eye-hunter/blob/31146e845ae3e7404a98c8fbcdb7c9f6639412dc/packages/shared/api/group-types.ts). Publication participation must be independent.                                                                   |
| Browser subscriptions register local listeners            | [Message subscriptions](https://github.com/intact-software-systems/ar-eye-hunter/blob/31146e845ae3e7404a98c8fbcdb7c9f6639412dc/packages/shared-web/browser/messages/browser-rallar-message-subscriptions.ts). They are not a remote subscription roster.                       |
| Room audiences come from active members' live sessions    | [WS room authorizer](https://github.com/intact-software-systems/ar-eye-hunter/blob/31146e845ae3e7404a98c8fbcdb7c9f6639412dc/packages/shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts). Principal and fixed-list targeting narrow that audience.              |
| Non-recipients may relay RTC bytes without local delivery | [RTC room admission](https://github.com/intact-software-systems/ar-eye-hunter/blob/31146e845ae3e7404a98c8fbcdb7c9f6639412dc/packages/shared/multicast/rtc-room-snapshot-admission.ts). Application receive permission does not establish confidentiality.                      |
| Ordering tracks use ordering key, sender, and epoch       | [Ordering identity](https://github.com/intact-software-systems/ar-eye-hunter/blob/31146e845ae3e7404a98c8fbcdb7c9f6639412dc/packages/shared/al-contracts/al-runtime.ts). Subscription entry and intentional omissions need explicit handling.                                   |
| Receipts retain a frozen audience                         | [Frozen audience contracts](https://github.com/intact-software-systems/ar-eye-hunter/blob/31146e845ae3e7404a98c8fbcdb7c9f6639412dc/packages/shared/al-contracts/al-frozen-multicast-audience.ts). Current eligibility and historical receipt expectations are different facts. |

ALM already has deadlines, supersedence, congestion policy, bounded resources,
durability choices, and carrier-aware QoS. None alone defines publication
cadence or newest-N retention. Sender staging, receiver history, checkpoint
durability, retransmission storage, and a replay log are separate capabilities.

The merged `exclusive` ownership behavior is a sending session's resource
claim in a room, not a distributed subscriber work queue. This addendum does
not reinterpret it as consumer groups or exactly-once processing.

## 3. Ownership and policy scope

### 3.1 Publication participation

Keep administrative role and publication permissions as independent facts.
The user-facing participation labels derive from two permissions:

| Participation                | May publish application publications | May subscribe to application publications |
| ---------------------------- | ------------------------------------ | ----------------------------------------- |
| Publisher                    | Yes                                  | No                                        |
| Subscriber                   | No                                   | Yes                                       |
| Publisher/subscriber         | Yes                                  | Yes                                       |
| No publication participation | No                                   | No                                        |

The fourth state permits a management-only member without inventing implicit
data rights. A subscriber may still send bounded ACKs, repair and
resynchronization requests, signaling, and membership commands authorized by
their own policies. A publisher receives its delivery results. Permissions
apply to the named application publication surface, not all network traffic.

The canonical permission scope is full `GroupRef`, principal, and exact topic.
A group-wide participation setting may be a construction convenience for a
single-feed group. Its resolution into topic permissions is explicit; there
is no wildcard that silently grants access to future topics. In a telemetry
and commands group, the sensor can publish telemetry and subscribe to commands
without gaining permission to publish commands. Message type and resource
validation remain additional topic policy, not replacements for permission.

New publication topics opt into this policy explicitly. Missing permission on
such a topic denies participation. Ordinary existing room messaging keeps its
independently required membership behavior; it is not an implicit grant on a
new publication topic. No implementation may guess existing participants'
publication rights from admin status or a missing persisted field.

### 3.2 Management and persistence

Authoritative grants belong beside group membership in
`packages/shared-server/rallar-system/group-state`. Shared wire contracts
belong to the owning group/publication feature in `packages/shared`; browser
commands and views belong beside the room facade in `packages/shared-web`.
API-v1 exposes the authenticated command boundary. A future actor consumes
those contracts rather than becoming a second permission authority.

The proposed default governance permits an authorized group owner or admin to
grant or revoke participation within the existing target-governance rules.
Admission policy may assign a declared initial grant. Participants cannot
self-promote by subscribing or reconnecting. Leaving, removal, banning,
rejoining, expiry, and group deletion each have explicit grant-lifetime rules;
rejoining must not resurrect a revoked grant accidentally.

Permission mutations use AppInbox's existing full
`read -> compute -> validate -> write(transaction, computed)` attempt, its
conditional guard, durable result, event, and final outbox writes. Conflicts
return to QueueBox redelivery for fresh authorization. Persisted permissions
and their snapshots are complete, mandatory shapes. They advance causal
authority; implementation decides whether the existing roster revision can
serve the permission boundary without conflating subscription churn with
membership or topology changes.

No broker, generic IAM service, second mutation queue, process lock, or
application-local grant store is introduced. An app can choose policy inputs,
but the server owns the grant decision and ALM enforces the resulting rights.

### 3.3 Active subscriptions

A grant answers who may subscribe. A subscription answers which authorized
session currently elects to receive one exact scoped topic. The two must not
share a lifecycle accidentally.

The proposed subscription contract records session identity and generation,
topic, subscription generation/revision, expiry, and the current permission
authority it was admitted under. An authenticated subscribe/unsubscribe
command has idempotent results and cannot alter grants. Incoming persisted
subscription mutations also use AppInbox. High-frequency subscription churn
does not bump the membership roster or replan RTC topology.

Multiple local listeners share one remote session subscription with reference
counted cleanup. Unsubscribing one listener does not remove another's interest.
Two separately authenticated sessions subscribe independently. Same-session
tabs require an explicit aggregation/ownership rule; one tab's cleanup cannot
cancel another's subscription. Connection generations fence reconnect races,
and a bounded lease removes abandoned interest. A reconnect resumes a logical
subscription only after current membership and permission checks, with a new
connection generation and a declared stream-entry position.

Runtime admission precedes application callback execution. A receipt is never
proof of application processing, even when a remote subscription exists.
Applications needing processing confirmation publish a correlated result.

## 4. Publication pacing as QoS

### 4.1 The three independent controls from PR #632

The actor proposal identifies the right separation:

| Control           | Meaning                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Send cadence      | The maximum frequency of new network-send opportunities for the lane                                            |
| Retention depth N | At most the newest N not-yet-admitted values retained per stream key; N=1 is latest-value conflation            |
| Drain budget      | Maximum selected values and serialized bytes per opportunity; keeping N values does not authorize sending all N |

These are publication policies in ALM's QoS vocabulary, not a second set of
actor transport profiles. They do not own a simulation tick. A 120 Hz host
may publish replaceable samples to a 30 Hz lane while continuing its own
simulation. Cadence is a scheduling target under load, not a guaranteed
packet-arrival interval or latency SLA.

Immediate sends remain available. Immediate means no additional publication
delay; it does not bypass permission, capacity, congestion, expiry, or the
carrier's existing admission policy.

### 4.2 Staging and identity boundary

The paced lane stages replaceable publications before per-envelope ALM
admission. Each staged value captures immutable payload content, full scope,
original target intent, stream key, publication time, absolute deadline, and
outcome identity. Caller mutation after publication cannot change it.

Reuse the existing delivery handle and diagnostics where their semantics fit.
Local retention is observable but must not report durable admission,
transport acceptance, acknowledgement, or completed delivery. Every displaced,
expired, cancelled, refused, or dispatched value has an attributable result;
do not turn overwritten values into unreported success.

At a send opportunity, validate the selected candidate against current
authority and resolve its eligible audience. The first ALM admission freezes
that audience. An unsent staged value has no previously promised recipient
set; an admitted envelope does. Once admitted, the envelope's identity,
payload, deadline, ordering position, and frozen audience are immutable across
retry and fallback. Never reuse a message ID for different content.

Stream identity includes sender/session, full group scope, topic/type,
application stream or resource key, and target partition. Values for two
groups, two entities, or two distinct fixed audiences cannot overwrite each
other merely because their type IDs match. Canonical scope/key construction
must distinguish absent values and delimiter/lookalike values. If the host
replaces its interest set, it explicitly cancels the obsolete partition;
retained bytes are never silently retargeted to the newest member list.

### 4.3 Selection, expiry, and bounds

Retain the newest N candidates in publication order. On count overflow, the
newer value displaces the oldest staged value, which settles superseded. On
byte overflow, evict oldest staged values only within the same stream key;
if the new value alone exceeds the per-value bound, refuse it without evicting
valid retained values. Sender/session-wide exhaustion is a typed capacity
refusal, not permission to evict another group's stream.

Within a key, select retained values oldest first, bounded by the opportunity's
message and byte budgets. N=1 therefore selects the latest value. For example,
five values published before an opportunity with N=4 retain values 2 through
5. A two-value drain sends 2 and 3 and leaves 4 and 5 eligible for the next
opportunity. This example defines policy, not a product default.

Require per-value bytes, per-key count/bytes/age, active-key count, and aggregate
session count/bytes bounds. Staging, admitted work, and transport buffered
bytes each have owners and an overall accounted ceiling. Per-opportunity
budgets are lane-wide, not multiplied by every active key. Bounded fair
selection prevents one continuously hot stream or group starving another.
An indivisible value must fit a full opportunity's byte budget; otherwise
refuse it before it can become a permanently blocked head. Selection can
defer a value when the remaining budget is too small without starving it in
later opportunities. Drain bytes count serialized publications once at
selection. Fanout copies, protocol overhead, relay traffic, and retries have
separate transport accounting; this budget is not a wire-bandwidth cap.

These bounds are per session, sized for one browser tab. An actor that holds
one participant seat across many groups is still one session, but a different
fan-out, so a multi-group actor's stage, ordering and transport budgets are a
re-examined limit, not a one-tab inheritance.

The deadline starts at publication, never first dispatch. Pacing, readiness
waits, fallback, and reconnect do not restart it. Expired values settle without
native submission. Retention depth is not a delivery guarantee and does not
override expiry.

Reuse the existing scheduling owner and its due-work mechanisms; no independent
per-key timer fleet or competing dispatch loop is added. Idle lanes do no
continuous pacing work. A delayed, hidden, frozen, or suspended runtime skips
missed opportunities and resumes with one bounded opportunity, then the next
cadence boundary. It never replays elapsed ticks into a catch-up burst.
Scheduling time uses an injected monotonic clock; absolute expiry uses the
existing deadline clock. Reconfiguration cannot create duplicate dispatch or
renew an old deadline.

### 4.4 Congestion and carrier admission

An opportunity is not a promise that native transport will accept the send.
Existing high/low watermarks, readiness, circuit policy, and session resource
limits remain authoritative. A congestion pause consumes no accumulated
catch-up credit. New replaceable values may displace staged obsolete values
while transport is blocked. An admitted envelope is never overwritten by that
staging policy; its existing lifecycle settles independently.

Fallback is selected under the same publication identity and original expiry,
without a second pacing buffer or wider audience. Permission denial is not a
carrier-fallback trigger. A pacing choice never changes a WS topic's declared
fanout: current routing chooses fanout from topic policy, not QoS.

For the first paced-live capability, a WS route must declare live-only fanout.
A topic that insists on durable outbox fanout is incompatible with this
volatile, lossy lane and is refused typed; it is not silently upgraded or
silently stripped of its outbox. Reliable queue pacing is a separate later
outcome below.

### 4.5 QoS compatibility and configuration

The first paced lane explicitly requests replaceable live state, best-effort
delivery, no receiver receipt, volatile durability, and no contiguous ALM
ordering/repair. Typed command and notification channel defaults remain
reliable; opting into pacing must select a compatible purpose/policy explicitly
rather than weakening those defaults.

| Combination                                                     | Proposed result                                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Replaceable best-effort, volatile, no ACK, unordered live state | Supported paced publication                                                                                                          |
| Reliable command/event with newest-N displacement               | Refused incompatible; no command is conflated                                                                                        |
| Contiguous ALM sequence/repair with intentional displacement    | Refused incompatible; application sample ordinals may still appear in the payload                                                    |
| Per-publication local-outbox/local-inbox with lossy staging     | Refused in the first paced lane; no durable-retention promise is claimed                                                             |
| Local-checkpoint with pacing                                    | Separate outcome requiring coherent staging/ALM recovery and external-visibility proof; existing restrictions continue until adopted |
| Receiver last-N history                                         | Separate receive-side bound; does not configure sender staging or promise replay                                                     |
| Exclusive resource ownership                                    | Independent WS claim semantics; not subscriber load balancing and not implicitly enabled by a publication role                       |

The channel declares its allowed policy; the send requests within it; the
composition root owns scheduling and aggregate resource defaults. Invalid,
unsupported, or incompatible combinations return typed outcomes before
observable delivery. Requested and effective policy are visible, with any
allowed change stated explicitly. Capability negotiation never invents a
compatible fallback or storage migration.

Exact API field names and numeric operational defaults are chosen in the
implementation slice from the current QoS contracts and measured workload.
This plan specifies their semantics. Tests use explicit cadence, N, byte,
age, and drain settings rather than treating illustrative numbers as defaults.
Validate finite positive cadence and bounds, integral counts, per-value versus
drain compatibility, and the initial opportunity/phase behavior explicitly.
Reconfiguration settles candidates that no longer fit; it cannot leave them
waiting forever or silently reset their age.

### 4.6 Publisher policy and subscriber needs

The publisher/channel declares what the feed can offer. A subscription can
request a supported receive policy, but cannot upgrade volatile samples to
durable events, add replay, or change the producer's cadence for every other
consumer. Requested and effective receive policy are explicit. A mismatch is
refused or accepted through a declared negotiation, never quietly weakened.

One common paced feed supplies one selection policy. Consumers needing
different send rates or history may use explicit audience partitions or a
separate supported receive-side policy, with their resource costs accounted.
No per-subscriber staging queue appears implicitly. A slow consumer cannot
force unbounded retention or block unrelated live feeds. Reliable delivery
handles that consumer through its declared bounded wait, backpressure,
expiry, or failure policy; it cannot silently drop a promised event to keep
up. All-recipient receipt latency may be dominated by the slowest eligible
recipient, and is distinct from publication cadence.

Downsampling and newest-N displacement can lose intermediate transitions.
Only the application can declare that its state is replaceable and select a
useful cadence. ALM does not infer replaceability from payload shape or convert
samples into averages. A retained latest value or receive-history cache
requires separate ownership, lifetime, current subscribe authorization, and
snapshot/live handoff; newest-N sender staging alone supplies none of these.

## 5. Pub/sub audience, trust, and lifecycle

### 5.1 Admission and recipient selection

An application publication is admitted only from an authenticated publisher
with active membership and an effective grant for the exact scoped topic.
Receipt, command, and system/control paths retain their own authorization.
The publication audience is the intersection of:

1. active group members and live eligible sessions;
2. effective subscribe permission for the topic;
3. active, generation-valid subscriptions to that topic; and
4. the publication's principal/fixed-list/other permitted targeting and
   exclusions.

Targeting only narrows. Sender echo stays explicit: existing exclusion of the
origin session does not imply exclusion of all other sessions of its principal.
Define self-observation separately if an application needs it. An empty
audience is reported with recipient count zero; a completed receipt for zero
recipients is not labelled as consumer processing. An application requiring at
least one consumer declares that admission requirement.

Server producers need a separately wired publication capability and topic
policy; they do not impersonate an ordinary member or bypass subscriber
eligibility. A server or proxy that transforms a message re-authorizes the
result's topic and scope. Apply the policy to public sends, raw envelopes,
unicast, fixed audiences, server fanout, retries, ordered releases, repair,
and both fallback directions.

### 5.2 Revocation and historical obligations

Freeze the subscription generations and permission observation associated
with recipients at admission. Later joins never widen that envelope's audience.
Later unsubscribe or revocation prevents further application delivery once
the enforcing owner observes the authoritative change. Already delivered data
cannot be recalled. A new subscription generation is not the old receipt's
recipient and cannot inherit its pending obligation.

Keep historical expected recipients in receipt evidence. Do not erase an
unconfirmed revoked recipient to manufacture all-recipient success. Expose the
undelivered/revoked or cancelled obligation through the existing result and
diagnostic vocabulary, extending it only where the distinction is necessary.
ACKs for a previously admitted envelope have a narrow historical authority;
they confer no new publishing or subscribing rights.

Checking a sender-supplied roster floor does not reveal an unseen newer
revocation. The implementation must declare the authority freshness bound,
refresh behavior, and fail-closed outcome when current permission is unknown.
For WS, a revocation-sensitive admission/dispatch must use current durable
authority or a validated freshness contract, not an indefinitely warm cache.
RTC may promise only the bounded freshness it can actually prove. Neither
carrier claims globally instantaneous revocation.

Pending staged publications and admitted retries recheck publishing authority
at their respective submission boundaries. Subscription removal, member
removal, and session expiry also restrict repair responses and buffered local
release. Define leave/rejoin and reconnect behavior independently of durable
message retention; storage does not preserve permission.

### 5.3 RTC delivery, relaying, and confidentiality

Maintain separate decisions for publication origin, application delivery, and
overlay forwarding. A subscriber-only peer can relay, and a publisher-only
peer can carry other publishers' traffic without becoming an application
subscriber. Changing a subscription must not remove an essential relay edge.

RTC must authenticate the original publisher across relays, not merely the
immediate authenticated peer. A sender ID in an envelope and an allowed relay
edge do not alone prove authorship. Before role-restricted publications run
over RTC, require an end-to-end publisher proof bound to publication identity,
immutable payload, target intent, ordering/QoS metadata, resource scope,
session, topic, expiry, and authority generation, with bounded current
authorization. Its issuance and verification belong to explicit existing
auth/session and ALM boundaries; select a proven mechanism rather than invent
cryptography. Slice 3 (§7) provides it for room multicasts: an ECDSA P-256
signature by the publishing session, verified at every relay and receiver
against its own room snapshot. Slice 6 extends the same proof to a listed or
principal room broadcast and a room unicast, each sent as the multicast its
leg admission froze. RTC returns unsupported for an exclusions-only, `world`
or exclusive send, and an allowed WS strategy uses the validated WS path. Slice
8 authenticates the recipient beside the publisher: under a `receiver` or
`leader` receipt every ACK and NACK a counted recipient authors on RTC carries
that session's ECDSA P-256 signature, a relay forwards it as signed, and the
origin counts it only after verifying it against the key it froze for that
recipient when it froze the audience. The publisher of an ordinary room send
stays unauthenticated across relays.

Relays may inspect payload bytes unless a separate confidentiality mechanism
protects them. Applications requiring subscriber-only byte access use a
transport boundary that enforces it, or an explicitly designed encrypted
publication with key rotation and revocation semantics. Encryption is not
claimed by a receive callback filter. Admitted relay copies must not leak
payload through logs, diagnostics, or local application storage contrary to
their declared policy.

### 5.4 Ordered streams and subscription entry

Distinguish transport loss from intentional audience exclusion. A subscriber
receiving sequences 20 and 22 must not repair 21 when it was never entitled to
21. Repair never widens the original admitted audience or reveals restricted
payloads.

An ordered subscription establishes a start position and subscription
generation before release. A latest-state feed may establish a snapshot plus
a fenced live cursor. A reliable event feed may require retained history and
an authorized replay cursor. Selective audiences require separate contiguous
tracks or explicit, non-payload omission evidence that the ordering owner can
validate. Resetting a global track when one subscriber joins would break
existing subscribers and is not an acceptable shortcut.

Multiple publishers have separate sender tracks by default. Ordered delivery
per publisher does not establish one total group order. A feed requiring total
order names a server sequencing authority and its availability/capacity cost.
Rejoin, restore, and process restart cannot reuse an externally visible
position for different content. Paced lossy values carry optional application
sample ordinals for interpolation; ALM does not attempt contiguous repair of
values deliberately displaced before admission.

## 6. Hidden complexity and compatibility decisions

| Risk                                                              | Required decision or safeguard                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A global both-role gives a device unintended command authority    | Exact topic grants or explicitly separate feed groups                                      |
| Permission changes while admission or dispatch is held            | Fresh authorization, causal versioning, bounded failure, no partial grant commit           |
| One tab unsubscribes another tab's session                        | Owned aggregation, reference counts, subscription generations, cleanup fences              |
| Reconnect revives old subscriptions or grants                     | Current authority read, new connection generation, declared stream entry                   |
| Retained values move to a new audience accidentally               | Immutable target partition and explicit cancellation of obsolete interest                  |
| Publisher-only filtering disconnects the tree                     | Forwarding stays independent of application delivery                                       |
| Fallback, repair, server publish, or raw send bypasses permission | One scoped policy and path inventory with semantic tests at owned boundaries               |
| Intentional drops are treated as missing ordered events           | Compatible unordered pacing, or authorized subscription-entry/omission semantics           |
| N per key still permits unbounded memory across keys/groups       | Aggregate keys/count/bytes/age and shared drain/fairness bounds                            |
| Reader requests imply guarantees the producer cannot offer        | Explicit requested/effective policy, compatibility refusal, bounded slow-consumer behavior |
| Missed timers or congestion cause catch-up bursts                 | No accumulated opportunity credit; message and byte budget at resume                       |
| Receipts imply business processing or offline replay              | Explicit protocol-admission evidence; separate processing/replay contracts                 |
| Per-send durability is silently weakened by pacing                | Explicit compatibility validation before retention/admission                               |
| New fields break old exact-shape readers or persisted rows        | Coordinated schema/version change and approved adoption/cutover scope                      |

Before production implementation, the maintainer must adopt the new public and
persisted contracts, explicit initial grants, and rollout behavior. The
existing no-legacy ALM cutover posture is the proposal's starting point, not
permission to delete unrelated data or reset group membership. Group-state
and browser ALM storage are different authorities and require their own safe
cutover decisions. Do not add dual-read codecs, migration fallbacks, or default
grants without explicit approval and a named boundary/lifetime.

During each implementation slice, remove affected obsolete paths and tests
that only protect them. Preserve independently required ordinary room,
command, and durability behavior. Retained production legacy needs the
repository's focused exception process; this proposal creates no exception.

## 7. Delivery horizon

Only the next two implementation slices are concrete. They are proposed
capability increments, not commitments to begin implementation in this PR.
Recover current owners and tests again before implementing each slice.

### Slice 1: bounded publication pacing

Deliver common publication QoS and a browser consumer for an existing room or
fixed-list live feed. Cover cadence, newest-N retention, immutable staging,
expiry, aggregate bounds, fair selection, drain budget, cancellation, and
typed incompatible-policy results. Use current membership authorization;
new pub/sub permissions are the next slice. A fake host publishing faster
than the send cadence is sufficient to prove the protocol without requiring
RallarActor or an engine kit to exist.

Owners: `packages/shared/al-contracts`, the canonical ALM outbound lifecycle
under `packages/shared/alm/outbound`, browser message channels under
`packages/shared-web/browser/messages`, and the existing scheduling/transport
owners. First confirm whether QueueBox's due-work scheduling can express the
cadence without a second loop. Reuse existing bounded collections when their
semantics match; do not create a generic library solely for this slice.

Acceptance: exact native submissions under an injected clock; N=1 and N>1
displacement results; count and byte limits; expiry before dispatch; no burst
after a missed opportunity; isolation across groups/entities/audiences; no
loss of commands; identical identity/deadline under allowed fallback. An
example and a visible browser flow demonstrate the chosen QoS.

As applied (S1-i): a typed channel declared `purpose: 'live'` carries the
policy, `publication: { cadenceMs, retainNewest, drain: { messages, bytes } }`,
with no product default for any field. Each live send names the `resourceId` of
its stream, reads `staged` first, and is paced by `ALOutboundPublicationStage`
(`packages/shared/alm/outbound/publication/`) as one task on the session's
QueueBox engine, scheduled with `wakeAt`, so there is no second loop. Newest-N
retention is `retainNewest` (`packages/shared/cache`) and the cadence
`computeNextCadenceAtMs` (`packages/shared/resilience`), both shared with Rallar
Motion. Unit pins and the `paced-latest`, `paced-newest-n` and `paced-expiry`
cells over `ws`, `rtc` and `rtc-with-ws-fallback` prove displacement under N=1
and N>1, the drain budget, expiry before dispatch, no burst after a late wake
and the typed refusal of incompatible policies; stream-key isolation is pinned
on the key. Decisions D465–D475 are in the roadmap. S1-ii delivered the rest of
the slice: aggregate count and byte bounds, fair selection, cancellation on the
stage, the isolation cells, the example and the visible browser flow, as
applied below.

As applied (S1-ii): the stage counts its streams, staged values and staged
bytes per session against `AL_PUBLICATION_STAGE_LIMITS` (64, 1 000 and 4 MiB)
after retention, and refuses a value that would pass one `capacity` naming the
limit. Each lane serves its streams from a rotating cursor, and lanes stay
independent. `cancel()` settles a staged value `cancelled` on the stage before
any carrier, and a send with a changed policy reconfigures its lane at once:
re-trimmed streams, oversized values refused, the next boundary moved earlier
and never a second dispatch. Each value's outcome is a payload-free
`publication-staging` diagnostic, and `rallar.messages.readUsage().publication`
and the harness's `stats.rallar.alm.publication` report the stage. The WS
server refuses a volatile best-effort latest-wins publication on a topic whose
effective fanout is `outbox` at ingress with the NACK reason `unsupported`,
terminal, since the browser cannot know a topic's fanout. The cells
`paced-capacity`, `paced-fairness`, `paced-cancel`, `paced-isolation-resources`
(two resources of one channel) and `paced-isolation-lists` (two fixed
recipients, three agents) join the S1-i cells at a 2 000 ms cadence over the
three carriers; hosted manifest 18 carries the seven two-agent cells, and
`paced-isolation-lists` is withheld from the three-agent manifest 22.
`examples/room-live-channel/README.md` is the example, and the Recipe Console's
Analyze view shows a paced cell's rows, pinned by
`tests/playwright/rallar-black-box/recipe-console-publication.spec.ts`.
Decisions D476–D482 are in the roadmap, and Slice 1 is complete.

### Slice 2: authorized WS pub/sub

Deliver exact group/topic publication grants, authenticated grant management,
session subscriptions, scoped audience intersection, and WS enforcement.
Prove subscribe/revoke/reconnect behavior with two producers and two consumers,
including a second session or tab of one principal. Expose participant roles
through the room facade while keeping administration independent.

Owners: group-state membership/governance and its AppInbox registration,
shared group/publication contracts, browser room/message boundaries, and the
canonical WS topic/admission/publication owners. Subscription changes do not
replan topology. RTC restricted publications are Slice 3's.

Acceptance: actual persisted grant/readback and event results, optimistic
conflict/retry/idempotency/corruption behavior, principal/session/scope
isolation, subscriber control traffic, no-grant denial, stale authority waits
or refusal, held-dispatch revocation, immutable receipt expectations, and
server/proxy/raw/fallback/repair path coverage. REST changes include black-box
recipes in `packages/shared-test/black-box-runner`.

As applied (S2-i): Slice 2 lands as two pull requests. S2-i makes publication
grants an authoritative group-state fact and enforces them on every WS path;
S2-ii adds session subscriptions, the audience intersection, the browser topic
roles and the two-producer, two-consumer proof. A principal's grant is one row of
`group-state:publication-grants` per exact `GroupRef`, naming up to 64 exact
`app.*` or `room.*` topics, each with `publish`, `subscribe` or both
(`packages/shared/api/group-publication/group-publication-grants.ts`); absence
means no rights, and no grant is a wildcard, implicit or inferred from a role.
Owners and admins grant and revoke through AppInbox (an admin governs regular
members only), with `POST .../publication-grants/{principalId}/grant` and
`.../revoke` under `/requests/{requestId}`; a change-less command is a no-op,
a 65th topic is refused `capacity`, and a spectator is never granted `publish`.
A write compares-and-sets the group row and bumps `snapshotVersion` alone, so
no roster floor trips and nothing replans. Leave, remove, ban and any membership
write out of `active` delete the row in the same write, so a rejoin starts with
none; retirement deletes the rows; an archived, expired or deleted group keeps
them, and every enforcement treats it as holding no grant. Readback is the
group read: `GroupSnapshot.publicationGrants`, its delta and the
`publication-grant-changed` event; the creator may declare its own grant at
creation. A WS topic opts in with `participation: 'granted'` (every other topic
is `members` and unchanged), and one pure `computeRoomPublicationAdmission`
decides socket admission, pending replay, inbox dispatch and `route`, a server
producer's publish (only the producers the topic lists, else
`topic-not-granted`) and a proxy's result (on the original sender's grant): a
session without effective `publish` is refused `no-publish-grant`, terminal,
and the audience is the live sessions of principals holding `subscribe`. Every
outbox dequeue, cluster send, repair and awaited-connection send of a granted topic re-checks the
captured audience against durable state through one version probe in that step,
so a revocation committed before the probe is honoured by that step; the declared
leak window is one in-flight send, and a revoked recipient stays expected and
unconfirmed in the receipt. A dispatch step whose read fails retries the row; one
that finds no current room snapshot completes it with no recipients. The NACK is
sent at socket admission and at `route`; a refusal at a pending replay or an inbox
dispatch drops the message without one, as every refusal there does. A granted
browser channel refuses a send its cached room snapshot grants no `publish`
before any carrier; its RTC carriage is Slice 3's, below. api-v1 installs its
granted topics from `grantedWsTopics` (`RALLAR_GRANTED_WS_TOPICS_JSON`). The
recipes `api-v1-group-publication-grants.json` and its cluster twin prove
persisted readback, idempotency, conflict, the denials and a revocation's WS
refusal across three servers. Decisions D483–D501 are in the roadmap; S2-ii is
next.

As applied (S2-ii): a session elects to receive a granted topic with a leased
subscription, one row of `group-state:subscriptions` per (group, session,
topic) (`packages/shared/api/group-publication/group-topic-subscriptions.ts`),
naming the principal, the asserting `connectionGenerationId`, the lease's end
and the group revision it was admitted at; the 120 s lease is the row's store
expiry. `POST .../sessions/{sessionId}/subscribe` and `.../unsubscribe` under
`/requests/{requestId}` take `{ topicId, connectionGenerationId }`, since the
HTTP request is bound to no socket, and answer `{ outcome }`: `subscribed`,
`renewed` (the same generation again, which extends the lease), `unsubscribed`
or `not-subscribed`; `GET .../sessions/{sessionId}/subscriptions` lists the
session's live rows. All three run under the self-session guard. A subscribe
needs an active member (`member-not-active`) holding effective `subscribe`
(`no-subscribe-grant`), a live client-state session (`no-live-session`) and a generation that is one of
the session's live ones (`stale-generation`); only the generation that holds a
row and is still live releases it. The write is the row alone, guarded by
itself: no event, no group revision, no delta, nothing replanned. A revoke of
`subscribe` and every departure delete the principal's rows in the same write,
and a grant that adds `subscribe` or a write that activates the member deletes
any row a cross-server race left, so a re-grant or a rejoin never revives one.
The server reads the publication authority fresh on every pass, the probed
snapshot plus one statement for the topic's rows and the sessions' live client
generations, never from the cached snapshot: the audience is the live sessions
of active members holding `subscribe` whose lease holds and whose row a live
generation of the session asserted, intersected with targeting and the leader.
Each recipient's generation is captured in the outbound policy and compared at
dequeue, repair and the awaited-connection send, so a reconnected session never
inherits an old obligation; the receipt keeps the frozen set, and an empty
audience is admitted with zero recipients. Live-only sends, the cluster's live
notice and the outbox audience take the same intersection at `route`. In the
browser, `RallarRoomMember.topicGrants`, `RallarRoomSession.topicRole(topicId)`
and `rooms.grantTopic` / `rooms.revokeTopic` expose the roles, and a granted
channel's `subscribe(handler)` returns a `RallarTopicSubscription` token
(`pending`, `active`, `refused`, `lapsed`); one owner per tab counts tokens per
room and topic, renews on the 20 s heartbeat cadence, re-asserts under the new
generation when the socket reopens, sends nothing from a replaced tab and
releases at session end. The local four-role family (two producers, the
receiver and a second session of the first producer's principal) proves
subscribe then publish, two tokens on one page, a revoke while disconnected and
a reconnect over `ws` and `rtc-with-ws-fallback`, and a same-context successor;
the held-dispatch revocation is proven by api-v1's server tests. The recipe
`api-v1-group-topic-subscriptions.json` and the cluster recipe's subscribe
steps prove readback, idempotency, the refusals and revoke and re-grant. No
hosted manifest carries the four-role cells. Decisions D502–D511 are in the
roadmap, and Slice 2 is complete.

### Slice 3: restricted RTC parity

Deliver §5.3 for granted room multicasts: an authenticated original publisher
across relays, bounded authority freshness, separate relay and application
permission, and WS/RTC fallback and repair parity under role churn, with
payload confidentiality declared outside this mode's promise.

As applied (S3-i): a granted room multicast asking no receipt rides RTC under
`rtc` and `rtc-with-ws-fallback`, signed once at RTC carrier admission with a
detached ECDSA P-256 signature (`packages/shared/signature/`) over the
domain-tagged, positional canonical JSON of the envelope's signed fields
(`packages/shared/al-contracts/publication-proof/`), `payload.resource`
included directly; the relay-mutable `forwarding`, `constraints.ttlHops` and
`diagnostics`, and `id.traceId`, `audit` and `proof`, are excluded, and the
envelope version stays 4. The key's public half rides the session's presence
row as `publicationKey` and reaches members on the snapshot and its delta, and
it leaves with the session. Every relay and receiver judges a
granted frame against its own readable room snapshot, at least as new as the
frame's signed `targets.snapshotVersion`, before forwarding or delivering it:
a missing proof, an invalid signature, an unbound target, a publisher without
`publish` or no readable snapshot drop it `unauthorized` with no NACK and no
forward, and an unknown key or a newer authority drop it `not-yet-in-sync`
after one refresh. Relays need membership only, and a session delivers only
with `subscribe` and an active token. A topic is granted at a page when a
typed channel declares it or the cached snapshot grants it, which closes the
raw `messages.rtc.send` lane. Relays may read payload bytes; no diagnostic
carries them, and a forward-only copy never reaches an application.

As applied (S3-ii): the origin freezes a granted publication to the live
sessions whose principal holds effective `subscribe` in its cached snapshot
before it signs, so the signed targets and the receipt's expected set are that
audience, and receipted granted room multicasts ride RTC too. A frozen
recipient without `subscribe` in its own snapshot or without an active token
forwards, delivers nothing, confirms nothing for itself and answers a
`not-subscribed` NACK naming itself as the logical recipient; relays
re-originate it toward the origin per logical recipient, and its hop completes
with the ACK status `subtree-complete-not-subscribed`, which confirms nobody.
The origin records such a recipient in the receipt's
`outsideAudiencePeerIds`, neither confirmed nor unconfirmed, and the receipt
completes once every expected recipient is confirmed or outside and one is
confirmed. A WS copy that reaches a recipient whose RTC copy answered
`not-subscribed` answers the same confirms-nobody status, which the WS server
records outside the receipt's audience; a frozen session that never subscribes
stays expected and unconfirmed on WS. A granted `group-leader` send whose
director holds no `subscribe` is unsupported on RTC, and `ws-then-rtc` keeps
granted messages on WS. Repair, re-plan and dequeue of a stored signed
publication re-check the origin's own `publish` in its snapshot, a revoke
settling the handle `rejected` `no-publish-grant`; a responder repairs only
toward a frozen recipient still holding `subscribe`, and nothing re-signs.
The key pair is the session's, kept in the browser's IndexedDB and shared by the
session's pages, and a presence change that alters only a key fans out the delta
but replans no topology. Receipts stay unsigned. The `granted-rtc` cells, the
relay fixture and the four-role family over `rtc` are the evidence, and no
hosted manifest carries the cells. Decisions D512–D523 are in the roadmap, and
Slice 3 is complete.

### Slice 4: ordered subscription entry

Deliver the live half of §5.4 for frozen-audience ordered room tracks: a
session entering a track starts at the first sequence its ordering authority
sends it, without a stall and without history; a staying subscriber reads a
later exclusion as a validated omission, not loss; repair never serves below a
recipient's entry; and the browser outbound allocates the positions it signs.
Over `ws`, `rtc` and `rtc-with-ws-fallback`, granted and `members` topics
alike. It lands as S4-i and S4-ii.

As applied (S4-i): the authority that finalizes a copy's audience keeps, per
track and recipient, the last sequence it sent, beside the track's ordering
head in its admission store, and states it on the copy as
`ordering.priorSeqByRecipient`, listing only the recipients whose prior is below
`seq − 1` (`0` for none), so a track's first frame carries `{}`. The RTC origin
records the frozen recipients of its own frame and signs the record in its first
admission, the record entering the proof's signing input only when present. The
WS server records at the first dequeue of a tracked row its outbound admitted, a
relayed browser-origin row or its own publication, for the audience its re-check
narrowed, and sends each recipient a copy carrying only that recipient's entry
and no proof; a row whose unrecorded track predecessor is outside its dequeue
batch waits until that predecessor records. A recipient with no position enters
a recorded track at its first copy, delivers a copy whose record names its
position as `omitted`, asks a gap only up to a prior ahead of it, and answers a
recorded frozen copy below its position with a `before-entry` NACK, which
relays carry like `not-subscribed` and the origin records outside the
audience. A frozen recipient that may not deliver witnesses: its position
moves, nothing is buffered and no gap is asked. A relay observes nothing and
forwards a track it never saw. The WS server sends nothing to a recipient whose recorded position is
past the copy's sequence, and, on a relayed browser-origin row with a logical
receipt, records that recipient, and a session its dequeue re-check dropped,
outside the receipt's audience, never unconfirmed, when the session is
connected to the dequeuing instance. A browser room send that names
its ordering key without `seq` is sequenced by its outbound on the durable lane,
from one head per track that both carriers of a session share, so a reload
continues the track; a stated `seq` at or below the head is refused
`unsupported`. The inbound `ordering-position` diagnostic states each entry,
omission, witness and `before-entry`. In S4-i rows a producer writes straight to
the outbox (Relic's round transitions, state-sync) recorded no positions and the
server's own publications recorded no outside class; Slice 5 covers both, below.
In a cluster, positions and the outside class cover sessions on the dequeuing
instance only; a receiver whose entry frame is lost and whose
next frame arrives first enters past it. The cells `subscription-ordered-entry`
and `subscription-ordered-omission` pass over the three carriers on the local
lane. Decisions D524–D537 are in the roadmap.
Under `rtc-with-ws-fallback` a recipient the WS server left out of a WS-leg send
reads a gap the RTC origin cannot serve and its track stalls until resync or
expiry, instead of losing the frame (D525); S4-ii narrows it to three residual
windows, below.

As applied (S4-ii): a reopened socket restores the session's room presence in
the room the page explicitly selected (D506, D531). The restore is main's
`SelectedRoomRecovery` (#785): on a reopen it reads the room, and when the
session is an active member not yet listed under the new connection generation
it connects its presence there under a fresh presence generation and that
connection generation, confirms a write whose reply was lost, retries a failure
that may pass with a bounded backoff on the same socket, and holds a room change
until its write settled. A retained room the page has not selected keeps the
closed presence until the page enters it again. #785's `'server'` room-snapshot
topic reaches a session only on the generation its presence records, so it
depends on the same restore. S4-ii adds the server side: a presence connect
that names a connection generation none of the session's live client-state
rows holds is refused `stale-generation` (403), when the session holds any,
which ends that socket's restore. The decision is read in the AppInbox read and
not fenced at commit, so a connect read before its socket closed can commit
after that socket's cleanup and stay active until lease expiry. A reconnect
therefore reads as an omission: in `subscription-ordered-reconnect`, which replaces the
S2-ii reconnect cell, the reopened sibling receives `p5` `omitted` with
prior 2 on each producer's track, and never `p3` or `p4`, over the three
carriers. A relay re-originates a waited child's gap NACK toward the origin with
its track, expected sequence and missing ranges, writing no row (D534); the
origin admits it from a next hop for a recipient the receipt still owes, checks
the entry floor on that recipient, and sends the repair copy to the relay,
which forwards it down the tree. A relay keeps a row only for a receipted send,
so an `ack: 'none'` ordered track behind a relay still stalls until resync or
expiry. A publisher's minted sequence continues across a reload of its session
and across its carriers, proven over the reopened IndexedDB store.
`rallar.messages.readUsage().ordering` counts a connect's `ordering-position`
events by status. The WS-leg stall is narrowed: the leg's `admitted` receipt
names the recipients the server routed the send to, and the browser records
each at that sequence in the positions both carriers share, while the
room-wide floor keeps only the sequences whose audience no receipt has named,
the highest send that asked no logical receipt and the receipted sends whose
`admitted` receipt has not landed (at most 64, the oldest folded into the
first). A recipient left out of a receipted WS-leg send enters or reads an
omission once that receipt lands. It still stalls when the server's dequeue
drops it after the route captured the receipt's audience, when it is left out
of a send that asked no logical receipt, whose sequence stays a floor until the
row expires, or when the `admitted` receipt arrives after the `complete` one.
`granted-rtc-ordered-relay` passes over `rtc` on the local lane; the relay
fixture is the blocking proof of re-origination, since the lane draws the path
and its runs never put the publish-only session in the middle. The
cross-instance record and outside class, and the server's record under
`rtc-with-ws-fallback` with the lost entry frame, stay later outcomes; positions
for rows a producer writes straight to the outbox are Slice 5's. Slice 4 is
complete.

### Slice 5: producer-row positions

Bring the rows a producer writes straight to the WS outbox, Relic's round
transitions and client-state principal events, into Slice 4's position record:
the row's `(track, seq)` is indexed in the producer's own transaction, its first
dequeue records positions and stamps each copy with its recipient's entry, the
dequeue wait reads every pending predecessor of the track rather than `seq − 1`
alone, and the server records a recipient it skipped or dropped on one of its
own rows outside its own receipt. Cross-instance positions and the fallback
windows stay out. It lands as S5-i.

As applied (S5-i): every `WS_OUTBOX` row whose message names `ordering.seq`
(Relic's round transitions, and client-state principal events, whose sequence
is the principal's `snapshotVersion` on a per-process track) is written with its
track index row: the `ordering-message` key the WS server's outbound admission
already reads, in that admission's namespace, valued with the row's `msgId` and
expiring with the row. Both producers compute it through `computeWsOutboxInsert`
with the namespace their composition resolves once from the WS runtime name
(`toServerWsQBoxALOutboundAdmissionNamespace`); the plain compute refuses an
ordered WS row, and the AppInbox guard re-derives the index row. The shared
writer puts the outbox rows and their index rows in one statement, insert-only:
a live index row under the same key is corruption and rolls the transaction
back, and an expired one is written over. Ordered `APP_OUTBOX` work rows are not
indexed. A producer row records at its first dequeue as a row the WS outbound
admitted does, under the row's own sender version, for its admitted audience
less the sender; account-view and world rows carry no admitted audience and
record nothing. A tracked row past `seq 1` that has not recorded lists its
track's index once and reads the listed lower sequences' stored rows in one
session, from the highest sequence down to the first settled one; a lower
sequence is pending while its stored row is absent (a producer row
before its dequeue) or still has to record. The row follows its batch when every
pending predecessor is in it, is `held` on the nearest one outside it, whose
index row and stored row its 50 ms re-check reads, and passes when none is pending, so a
sequence nobody wrote (a non-contiguous client-state track) and an expired
predecessor hold nothing. A tracked row whose dequeue reaches a terminal
outcome (completed, superseded, refused, or failed for good) without recording
deletes its index row, guarded on its own `msgId`, and its successors release
at their next re-check; a row that recorded keeps its index for repair, and so
does a delivered row that positioned nobody (no durable audience), since no
successor waits on it; a deferred, pending or `no-route` outcome keeps it while
the row retries. On the
server's own rows, its publications and every producer row it sends under its
peer id, a recipient skipped below its position or a session the dequeue
re-check dropped is recorded in `outsideAudiencePeerIds` of the server's own
pending receipt through one fenced commit under the server's sender version,
tried up to three times on a lost fence; a retry then targets only the
unconfirmed recipients, and the receipt completes once every expected recipient
is confirmed or outside and one is confirmed. A mid-round Relic joiner's first
transition is `round-resolved` at `seq 2` with prior 0, read as `entered` with no
missing range, which the Postgres-backed Relic publication unit pins; the WS
server fixture pins the producer-row record, the holds, the release through a
cleared index and the non-contiguous track; and `server-ordered-entry` passes
over `ws` on the local lane, where each session of one principal and a
co-member session enter the principal's client-state event track at their first
copy with prior 0, one of them at `seq 2`, which read as a gap from 1 before.
Limits: in a cluster, positions and the outside class still cover sessions on
the dequeuing instance only; the fallback windows and the lost entry frame are
unchanged; a row whose dequeue keeps answering deferred or pending keeps its
index, so if it never returns its successors wait for its deadline; a failed
index-end write is logged only and leaves successors to that deadline; each
own-row outside commit moves the server's single sender version, and after
three lost fences the recipient stays unconfirmed until the next retry records
it; the producer provenance sidecar's inserts are not folded into the shared
writer; and no browser lane asserts Relic entry, since the gated Relic lanes run
the built preview without the development runtime hook. During a rolling deploy
an older instance dequeues an indexed producer row without recording it, and a
newer instance holds on such a predecessor until its deadline. Decisions
D538–D550 are in the roadmap, and Slice 5 is complete.

### Slice 6: granted unicast, list and principal broadcast over RTC

Carry on RTC the granted shapes Slice 3 left refused: a granted publication
whose sender names a fixed list, a room principal or one room peer rides RTC
under `rtc` and `rtc-with-ws-fallback`, frozen to the grant-narrowed audience
and signed exactly as a granted room multicast is; a granted unicast is frozen
as a multicast of one; the RTC room-limit bound is judged in the granted leg
right after the freeze, so a fallback takes over; and the three copies of the
shape gate become one predicate in the carrier. Receipts stay unsigned and
relay-re-originated; signed receipts, an encrypted publication and native key
custody stay out. It was designed in the Slice 6 design proposal, which is
deleted (git history is the archive), and landed as S6-i (the RTC shapes, two
outbound riders and these documents) and S6-ii (one writer for the provenance
sidecar, the batched CRDT, presence-summary and topology outbox loops and a
shared PGlite statement recorder).

As applied (S6-i): the carrier's leg admission (`admitLeg`) judges the shape
the sender gave by one predicate,
`resolveRtcGrantedPublicationShapeRefusal`: a room multicast, a room broadcast
naming `recipientPeerIds`, a principal broadcast naming its room and a unicast
naming its room are carried, and any other granted shape is refused
`unsupported` with the text `unfrozenAudience` before any freezing work. It
then reads the snapshot and the `subscribe` holders and keeps the leader and
signing refusals as before, translates a room unicast into the one-entry listed
room broadcast of its room (`toRtcGrantedListedLeg`), freezes the leg to the
listed, principal or addressed sessions that hold `subscribe`, at the
snapshot's version, and judges the 256-entry room limit on that frozen set
(`computeRtcFrozenAudienceRefusal`), returning its reason as the leg's refusal.
On the wire a list, a principal broadcast and a unicast are each a frozen,
signed multicast that relays forward along the tree and receivers admit
unchanged; the receipt expects the frozen list, or the one peer. A named
non-holder is frozen out silently, one rule for every shape, and an audience
frozen to nobody owns no children (`resolveALOwnedChildPeerIds`): under
`receiver` the receipt of zero recipients completes at once and nothing is
sent, and under `ack: 'none'` the plan is an `unroutable`/`no-route` fallback
verdict, nothing sent. A granted send whose narrowed audience passes 256 is
refused `unsupported` with the targets its sender gave and handed to the
fallback; 256 still signs. A stored or `enqueueIfAbsent` copy is judged by the
targets its sender gave: a proof on a non-multicast original is refused
`unfrozenAudience`, since only a leg freezes a list, a principal broadcast or a
unicast before its admission signs it. The dispatch copy of the shape gate and
the facade's shape clause are deleted: `isBrowserWsOnlySend` keeps an exclusive
send, and a granted send under `ws-then-rtc`, on WS, so a granted peer, listed,
principal or room send starts on RTC under `rtc` and `rtc-with-ws-fallback`, a
granted peer send under `ws-then-rtc` is admitted on WS, and an exclusions-only
or `world` granted send under `rtc-with-ws-fallback` is refused by the carrier
and reaches WS. The units pin the shapes, the translation, the fold and the
fallback verdicts; the relay fixture signs a receipted granted list at its
origin, a listed holder without an election recorded outside, and an unlisted
subscriber that relays a copy naming only the list delivers nothing. The
harness's `messages.send` names a fixed audience by up to two lane roles
(`recipientPeers`, refused when the two roles resolve to one session) or by
principal ids (`recipientPrincipalIds`), and the granted publish loop takes
that audience. Five cells over `rtc`, local full-scope lane only, pass:
`granted-rtc-unicast-delivered` (two-agent), `granted-rtc-list-delivered` (an
unlisted, subscribed and elected session receives nothing),
`granted-rtc-list-non-holder` (the owner revokes recipient-b's `subscribe`
first, since grants only add and the cells share one room),
`granted-rtc-list-lane-roles` (the receiver directs the room, so the list
resolves through the leader rule) and `granted-rtc-principal-delivered`
(same-principal). The riders: an index end that answers `absent`,
`other-message` or `conflict`, or throws, is one `track-index-end` outbound
diagnostic through the runtime diagnostics, `conflict` reported and not
retried, with no console line; and the outbound admission reads name
`readOrderingMessageId`, the generic value read private again. Limits: an
exclusions-only granted room broadcast stays refused `unsupported` on RTC, and
ordering on a peer send stays refused; receipts are unsigned; a `receiver`
unicast to a non-holder completes with zero recipients over RTC, where WS
answers `unauthorized`, and under `rtc` alone an `ack: 'none'` one settles
`rejected` with `unroutable`/`no-route`; after a hand-over a frozen session that
never
subscribes stays expected and unconfirmed on WS; and the cells run on the local
lane only, with no hosted manifest. Decisions D551–D562 are in the roadmap, and
Slice 6's first pull request is complete.

As applied (S6-ii): the producer's proof is the outbox row's second sidecar row.
`AppOutboxInsert` carries a required `provenance` beside `trackIndex`, `null`
unless the row is proved; `computeWsOutboxInsert` derives it in compute from the
producer's facts (the message, the producer kind, the authorised target and the
expiry) through `computeWsOutboxProvenanceRecord`, still the one value encoding,
and `writeAppOutboxInserts` writes rows, index rows and proofs in the one
`sidecars` CTE. `validateWsOutboxInsert` replaces `isExactAppOutboxInsert` and
runs outside the write: it reports a re-keyed, re-valued, re-expired or missing
proof and a facts expiry the row does not carry. One conflict rule holds for
every proof, absent-or-expired, the index row's: a live proof under the key
rolls the transaction back as corruption, an expired one is written over at
revision 1, and a batch naming one key twice is refused before any statement,
with the same corruption error. Relic is aligned; its former `do nothing` would
have refused that replay. Auth logout, client state, CRDT, the presence summary,
topology and Relic lost their six raw proof writers, and the authorised connect
its proof effect: the connect is one tracked insert returning seven rows (three
outbox rows, the event's index row and three proofs) within the unchanged
in-transaction bound of five. The CRDT, presence-summary and topology commits
went from 2N statements (N outbox rows and N proofs) to one, and a publishing
topology commit (promotion, connects and delivery pages) is one outbox
statement. The CRDT publication-authority check now runs in every CRDT compute.
The shared raw-PGlite recorder `recordPGliteStatements` replaced four private
statement spies, their assertions unchanged. The state-write measurement of
S6-ii's own counters is guidance, reported in its pull request, and the
medium-scale gate passed in CI on every head. Limits: the view-invalidation
producers keep their guarded batch, where an unapplied proof is a retried
conflict (a backlog line), and the singular `writeAppOutboxInsert` stays as a
one-line delegate for five callers outside the slice. Decisions D563–D567 are in
the roadmap, and Slice 6 is complete.

### Slice 7: cross-instance positions and outside class

Judge every captured session of a WS outbox row from durable presence, not from
the dequeuing instance's sockets. The premise is corrected: the Slice 4 and
Slice 5 limits said that in a cluster positions and the outside class cover the
sessions on the dequeuing instance only, but the record gap was real for granted
(frozen-audience) rows only, since every other row records its whole captured
audience, and the receipt gap was real for every receipted server row,
single-instance included: a captured session closed everywhere was judged
outside by no instance, so its receipt stayed unconfirmed until its deadline. A
session with a live connection generation anywhere stays eligible, is recorded
and expected, and is sent by whichever instance holds its socket; one with none
is dropped and recorded outside (a principal row's co-member sessions excepted,
below); the local-socket filter applies only at send, on every instance. No
merge write, row kind, mutation, key family or wire field
is added. It was designed in the Slice 7 design proposal, now deleted (git
history is the archive), from the candidates survey and three surveys at
`2279d4f3b`, and landed as S7-i (the 6b probe, the mechanism, the ordering
cluster proof and these documents, server-only) and S7-ii (the riders:
`buffered-track-drains` over `ws`, the admin-audience append refused at decode
and a `vi`-free statement recorder).

As applied (S7-i): the WS server's one re-check dependency became two named
filters, `capturedRecipientEligibilityFilters: { durable; local }`, and
`readCurrentAudience` takes the presence that judges: `'durable'` from the
dequeue hook and from the receipt retry's repair plan, `'local'` from the held
send. With no filters wired a frozen row sends nobody and any other row keeps
its audience; `'local'` re-checks frozen rows only. api-v1 builds `durable` from
`filterDurablyLiveWsSessionIds` over its existing durable reads: a granted row
keeps the candidates whose live subscription asserts the generation it
captured; a room row the candidates the room's publication authority names in
`liveSessionGenerations`, nobody when the room has no current snapshot or the
read answers for another room; a principal row, through `readPrincipalSessions`
over the principal row and every stored session row of the principal
(`listSessionsForPrincipal`), the principal's own sessions that are live, none
while the principal is not active, and every candidate that is not one of its
stored sessions (a co-member's), and every candidate when no principal row
exists; a row naming neither a room nor a principal keeps its candidates, since
no durable fact names its sessions. `local` stays the socket and grant filter,
at the WS server's sends and at the bridge. `writeOutsideAudience` takes the
judgement: `'durable'` (a dequeue or retry drop) records every listed session
whatever the local socket says, and `'open-here'` (a send-time drop or a skip
below its position) only a session whose socket here is open; a receipt retry
records outside only the drops it still waits on, never a recipient that
confirmed. The bridge's `sendToCapturedLocalTargets` reports
`captured − eligible` beside the skips, judged open-here; an unscoped row, or
one with no re-check wired, reports only its skips. A dequeue whose captured
audience was judged and resolves to no socket on this instance plans a send to
nobody here (`audienceJudgedAtSend`), not `no-route`; the awaited-connection
hold or the retry decides. Three lost fences on an own-row outside commit are
one `outside-audience-commit` outbound diagnostic,
`{ msgId, recipientPeerIds, attempts, outcome: 'conflict' }` plus the message
trace, through the runtime diagnostics and with no console line; an `absent`
answer is the commit's normal one and a thrown commit propagates so the retry
re-judges, so neither is written. The 6b probe
(`ws-tracked-dequeue-statements.test.ts`, on Postgres) counted the tracked
dequeue before and after: the front is unchanged (past `seq 1` the prefix list
returns N rows at depth N, the row's own index row included, and
`readStoredPredecessorsToSettled` makes 3, 4 or N + 1 sequential point reads
with every predecessor settled, the nearest unstored or none stored), and the
completing dequeue gains the durable read, measured as its one authority batch
statement over a constant room snapshot; production reads the current snapshot
before that batch (one statement while the cache keeps it, more when it is
probed), so a room row gains at least two statements, and a principal row's
principal and session-row reads are unmeasured. The ordering cluster proof
(`npm run test:api-v1:black-box:postgres:ordering`, a `postgres-integration`
step beside view push) runs three api-v1 processes on one database with the
dequeuer on plan 0. On the client-state principal track a receiver on plan 1
enters at its first copy and reads the next event in order, and the row's
`sentPositions` names the control session, the receiver, a session about to
close and a co-member's session. On a granted room topic the receiver is
recorded on a frozen row though connected to another instance; the closing
session, captured live and closed durably before it ACKs, is judged outside by
the receipt retry's durable re-check, and the relayed receipt completes with the
receiver confirmed and it outside; and the receiver's omitted copy reads
`omitted`, not a gap. The api-v1 units read a session live on another instance
expected and recorded, one live nowhere outside at the dequeue with the receipt
completing on the other recipient, and one live at the dequeue and gone at the
retry outside after it. This supersedes the Slice 4 and Slice 5 cluster limit
and the Slice 5 three-fence limit: positions and the outside class no longer
cover the dequeuing instance's sessions only, and after three lost fences the
recipient is named in a diagnostic before it waits for the retry. Limits: the
cluster proof proves the record and entry half on client-state principal events
and a granted room topic, and the outside judgement on the receipt-retry path,
because the only way to hold the dequeuer holds every AppInbox mutation too; the
dequeue-time judgement of a session connected nowhere is proved by the api-v1
units, and the server-own receipt half is not proved by the cluster proof, since
principal events carry no receipt; the proof's granted half is browser-origin. A
principal row keeps co-member sessions unjudged, since no durable fact of the
row names their liveness (a durable session-to-principal fact would close it);
an inactive principal's row drops the principal's own sessions and keeps the
co-members'; a closed own session is judged dead until its row is purged, at the
earlier of its logical expiry plus 24 h and its disconnection plus
`clientSessions.disconnectedRetentionMs` (7 days by default), and kept as
unjudged after it, the harmless direction. A room row whose room has no current
snapshot sends nobody. A dequeue with a judged audience and no socket here sends
to nobody here, so an unreceipted principal event to a session that connects
later on a single instance is not retried; the former `no-route` retry held such
a row only when that session was its sole unresolved recipient. A session judged
outside at the dequeue is not resent when it reconnects before the receipt's
deadline (a Relic transition event, say): it reads the sequence as omitted, and
the product's snapshot publication covers its state. The window, a socket closed
whose AppInbox close has not committed and a lease lapsed before the 60 s
presence sweep, is judged at the retry; a send-time drop
of a session live nowhere waits for the retry; after three lost fences the
recipient waits for the retry; and the presence sweep is 60 s and not
configurable.

As applied (S7-ii): a repair hint's paged sequences are charged once per gap.
`toALOutboundRepairGapAttemptIdentity` names the attempt
`['repair-gap', requester, track, seq[, recipient]]`, and only the page loop of
`retransmitFromRepairHint` passes it; a hint with no track or no ranges, and the
`ack-timeout` path, keep the hint's identity. The identity holds for the
message's whole repairable lifetime, a correction to the design: completed send
rows are retained until the message expires on every backend
(`AL_ADMISSION_WORK_COMPLETED_RETENTION`; on Postgres only the admin prune of
expired rows deletes them), so a later report of a gap by the same requester
(for the same recipient) finds the first attempt's sends, charges nothing,
retransmits nothing new and writes no row, and can never exhaust the budget.
Exhaustion is another identity's finding: the WS server hop, whose NACKs the
`ws` sender admits as `hopPeerIds: [serverPeerId]`, or another receiver; its
report finds the budget spent, and the message is settled `repair-exhausted`
once. The outbound exhaustion pins were rewritten that way (the second requester
is the hop, since control admission refuses a NACK from a peer with no retained
obligation), a fallback case was added, and the WS server's ordered-repair suite
reads served repairs by the gap identity. `buffered-track-drains` declares
`['ws', 'rtc']` (observation). The `repair-exhausted` cell, whose two-agent form
induced exhaustion by the same receiver re-reporting the same gap, is a
three-agent cell (D579): the second receiver's report of the held gap finds the
budget spent. It runs over `rtc` and `rtc-with-ws-fallback` only (D580). The
CRDT mutation command codec refuses an `append` with an `admin` response
audience after the envelope is decoded
(`TypeError('CRDT append refuses an admin response audience')`, classed
`app-inbox-malformed-command`), a `compact` with one still decodes, and api-v1's
admin branch states its null publication authority. The PGlite statement
recorder is one `vi`-free `recordPGliteStatements` under `apps/api-v1/test/db/`
with a caller-owned `restore()`, imported by the four Vitest users and the Deno
topology test; `recordResourceInboxInserts` is deleted. Bundle figures
(guidance): `browser/rallar.ts` 297.9 → 298.0 KiB brotli (305,056 → 305,200 B,
48 B over its 298 KiB budget, which was raised to 299 KiB) and the headless
agent 394.705 → 394.516 KiB under its 395 KiB budget. Limits: the `ws` leg of
`buffered-track-drains` is observed locally over `ws` (the full-scope lane; the
gate's observation job runs the smoke scope, which does not run the full-scope
cell). Its earlier local red was the receiver's promotion wait: over `ws` the WS
server is the hop that buffers the track, so only the RTC receiver promotes, and
the wait is now `rtc`-only. Over `ws` the WS server orders the track and is the
one requester of its gaps, so a held frame's repeated reports are one attempt
under the per-gap identity: the sender never states `repair-exhausted` over
`ws`, and the frame arrives on the hold's release; a server repair report per
logical recipient would make a second receiver a second requester there. The
three-agent cell's RTC legs are observation only. A repair planner whose
prepared payload changes with the hint would find the budget spent under the
per-gap identity and state `repair-exhausted` once, as a later report did
before S7-ii, a regression only if `maxRepairs` ever exceeds 1; the RTC overlay
planner is the only such planner in production, and S7-ii does not exercise it.
Decisions D568–D580 are in the roadmap; Slice 7 is complete (S7-i and S7-ii).

### Slice 8: signed receipts on RTC

Authenticate the recipient a receipt control speaks for on RTC, so that
`acknowledged` means one thing on both carriers and at-least-once over peer
relays holds against a misbehaving member, not only against faults. As built,
under `receiver` and `leader`, this holds at the origin and through honest
relays: no peer can confirm, exclude or end a receipt for another recipient,
since a relay forwards every distinct statement a child makes about a recipient
and the origin judges each (S8-ii); a child that floods its relay with distinct
forged statements, and the two of its effects that need no flood, remain the
limits there (below), and under `hop` and
`subtree` a hop can still exclude another hop (a limit below). The premise is
corrected (S8-C0b): the candidates survey said the slice replaces the trust in
an ACK's `fromPeerId`, that the AR Eye games gate proves it and that it is
client-only, and the code corrects all three. No game-lane room relays: below 5
active sessions a room is a `star`, in which every recipient ACKs the origin
directly, and lane rooms hold 2 to 4 sessions, so the games gate runs direct
ACKs only. The defect needs no relay: on RTC the channel binds a control's
`fromPeerId`, but nothing bound its `logicalRecipientPeerId`, so under
`receiver` and `leader` any room peer with a channel to the origin could confirm
another recipient (whose true ACK was then refused as already counted), move one
outside with a forged outside-audience NACK or end everyone's receipt with a
forged terminal NACK, and a relay could drop a copy and forge its ACK, so the
timeout and the WS fallback never fired. It is not client-only: the WS server
decodes the same payloads through its closed decoder and authors three of its
own, though its behaviour does not change. And it is half a guarantee: the
publisher proof covers granted sends only, so an ordinary room send's origin
stays unauthenticated across relays. It was designed in the Slice 8 design
proposal, now deleted (git history is the archive), from the candidates survey
and three read-only surveys at `664ed19d5`, and lands as S8-i (the protocol: the
shapes, the signing, the relay's forward, the frozen keys, the origin's
verification, the cutover, every fixture, the blocking units and these
documents) and S8-ii (the relay's statement rule, the settle of a held send
refused at its dequeue, one shared key import, the observation cells, the
`messages.control` recipient field and the 6f count).

As applied (S8-i): one encoder, `toClassifiedSigningInput(domainTag, sections)`
in `packages/shared/signature/`, builds both signing inputs, and
`ALPublicationProof` is `SignatureProof` with no alias; a granted frame's signed
bytes are pinned unmoved. One test builder,
`packages/tests/al-control-test-payloads.ts`, builds the ACK and NACK fixtures
of 93 test files. The control ids are `al.control.ack.v3` and
`al.control.nack.v3` on both carriers: each payload carries a required nullable
`proof`, whose `null` means the carrier's admission authenticates the sender,
and a NACK a required `originPeerId`, checked against the owner row at a relay
and at the origin; `v2` is refused `unsupported` by the existing id check, the
two wire shims `decodeALNackWirePayload` and `decodeALReceiptWirePayload` are
deleted, a control's proof decodes to the strict ES256 shape of a persisted
message proof (a 43-character key id and an 86-character signature, base64url),
the WS server's receipt observation decodes an ACK through the codec, and five
black-box recipes and the hosted manifests 18 and 22 carry the new ids. The
receipt proof (`al-contracts/receipt-proof/al-receipt-proof.ts`) signs every
field a recipient states and none of the hop fields (`fromPeerId`, `toPeerId`,
an ACK's `carrier`), under the domain tags `rallar-alm-ack-proof-v1` and
`rallar-alm-nack-proof-v1`, so an ACK's signature never verifies as a NACK's.
The RTC planner states `receiptProofKeys`, each counted recipient's
`{ keyId, publicJwk }`, on the plan that freezes the audience: at admission when
the room snapshot is cached, at the dequeue that first has it otherwise; the
sent policy adopts the plan's keys once and never replaces them, and an empty
key record is never stated or stored. A counted recipient is a session the
frozen audience names or the unicast addresses. `computeRtcReceiptKeyRefusal`
refuses that plan's leg `unsupported`, naming the message with its sender's
targets, so the fallback takes it at once: when the origin page holds no
WebCrypto, when a counted session the snapshot names live registered no
publication key, or when a unicast names no room. A counted session the snapshot
does not name live is absent, not keyless: it gets no key and is left to the
planner's verdict; a send whose named room has no cached snapshot is not judged.
One async `signALInboundReceiptControls` runs at the four inbound commit sites
after validation and before the one conditional commit and signs each control
its compute marked: a counted recipient's own ACK or NACK on `rtc`, never a
repair request or a control it forwards. The signer is built by
`WebRtcRxStreamerService` from the session's `publicationCrypto` and reaches
only the inbound runtime, never the multicast manager that application code
holds. A relay forwards a child's stored control through
`toALForwardedReceiptControlMessage`, which keeps every signed field and the
proof and rewrites only `fromPeerId`, `toPeerId` and an ACK's `carrier`, and
authors only its own `accepted`, its terminal ACK and its NACKs about itself.
Outside-audience NACKs join a new `set-control-nacks` history beside
`set-control-acks`, so a retried copy forwards each recipient's control again
with the child's own reason, and the implied `not-subscribed` is the child's own
hop-end, forwarded. The origin admits a forwarded hop-end or a relayed NACK only
from a next hop or an expected repair peer
(`isALOutboundRecipientControlSender`). The compositions state their
authentication: the RTC overlay `signature`, the WS client and the WS server
`carrier`. Under `signature` the origin's control admission verifies, in its
read phase (`readALOutboundRecipientProof` through `RtcReceiptProofVerifier`), a
peer ACK or NACK about a `receiver` or `leader` send that speaks for a recipient
the receipt counts, against the key the sent row froze for it, whichever peer
forwarded it. A refusal (`missing-proof`, `unknown-key`, `key-mismatch`,
`invalid-signature`) is an `unauthorized` issue and a `rejected` admission,
whose `control-admission` diagnostic states `proofRefusal`,
`claimedRecipientPeerId` and `channelPeerId`; nothing is counted, written or
answered, and a true ACK still completes the receipt. A
control that speaks for a peer the receipt does not count is a hop fact the
channel authenticates when it speaks for its own sender, judged by the
validators as before the slice (a non-counted next hop's own hop-end completes
its hop and confirms nobody, and its own terminal NACK is refused as from a peer
the send owes nothing), and is refused `unknown-key` when it speaks for another:
such a peer can complete its own hop's bookkeeping, never confirm, exclude or
end a receipt for a counted recipient. The origin reads a hop-end that names
another recipient as that recipient's `not-subscribed` NACK only under a logical
receipt; under `hop` and `subtree` only a hop's own hop-end stands for its NACK.
A control addressed to another owner than the sent row's is refused for its
address alone, with no proof judged. Whether a recipient is counted is read from
the message's own receipt, never from the plan that refused it, so a counted
recipient's refusal NACKs (`not-yet-in-sync` and its siblings), whose plan
states no receipt, are signed; the full-scope ALM lane found them unsigned, the
only lane that drives a real recipient's refusal to a verifying origin, and a
fixture now pins it (`rtc-receipt-refusal-proof.test.ts`). A replayed first
admission (one whose first commit conflicted) keeps the keys its plan froze, so
its counted recipients' first ACKs and NACKs verify; the full-scope ALM lane
found the replay keyless. A relay's upward audience is the same
counted-recipient rule. A send that counts nobody is not
judged by the key refusal, so a page without WebCrypto still sends one. The
publication proof signs exactly the sections its table classes `signed`: a
section classed `signed` without a builder fails the build. The plan's four
decisions: a stored `v2` control history fails the strict `v3` decode as
`ALAdmissionCorruptionError` until it expires (30 minutes durable; the deadline
plus the receipt grace volatile), with no `AL_ADMISSION_SCHEMA_ID` bump, since a
different schema identity refuses a returning browser's store rather than
resetting it; a control whose sign fails is left out with a `receipt-sign`
inbound diagnostic and nothing unsigned goes in its place, its hop-end included,
so its parent's row stays open and the retry completes it; the origin's verdict
cache holds `verified` only (1,024 entries keyed `keyId|signature|digest`),
because a forger varies the signature for free; and the frozen keys are those of
the plan that freezes the audience, so a later re-plan or dequeue is neither
refused nor re-keyed. Bundle figures (S8-R11): `browser/rallar.ts` 298.0 →
300.024 KiB brotli (307,225 B), its budget raised 299 → 301 KiB, and the
headless agent 394.516 → 396.793 KiB (406,316 B), its budget raised 395 → 397
KiB. Limits: an ordinary (non-granted) publication's origin stays unsigned
across relays, and the receipt binds the message id and the origin, not the
bytes, so a peer adjacent to a recipient can deliver other content under the
origin's id first: the recipient signs a true `delivered` and the origin reads
`acknowledged` (a granted publication is not affected, since its recipient
verifies the publisher); `hop` and `subtree` receipts rest on channel trust,
which is what they count, and a hop can still exclude another hop with an
unsigned outside-audience NACK, as before the slice; a signed terminal NACK from
one counted recipient still ends everyone's receipt, now under its own
signature; a page without SubtleCrypto (an insecure origin) cannot be a counted
recipient or the origin of receipted RTC, and the fallback takes such a leg; a
logically receipted RTC unicast that names no room is refused `unsupported`,
where before the slice it was admitted. A stored-stage `unsupported` refusal was
a silent drop: a send held until its freeze that then met a keyless counted
recipient (or passed the room limit, as before the slice) was neither settled
nor handed to the fallback, and its handle ran to its deadline; settled in S8-ii
(below). A held send whose audience was frozen before it was held adopts its
keys at the dequeue that first sees its room, for each counted recipient the
room keys; one the room does not key there is sent to, reads `unknown-key` and
runs to the retry or the fallback. When a not-subscribed recipient's hop-end
reaches the relay before its NACK, the relay forwards the hop-end and refuses
the later NACK, so the child's reason never reaches the origin, which records
the recipient outside in either order. A forwarded hop-end lost on the
relay-to-origin hop while the relay's terminal ACK arrives strands that
recipient until the deadline, as the relay-authored NACK could before. An honest
relay verifies nothing, and S8-i keyed "already forwarded" and "outside" by the
recipient alone, so a child hop that named another recipient with a proof that
does not verify pre-empted that recipient's true control at the relay; S8-ii
keys them by statement, which closes that, and the flood limit below replaces
it. Decisions D581–D595 and D596–D606 are in the roadmap; Slice 8 is complete.

As applied (S8-ii): a relay keys every receipt fact by statement. Two child
controls are one statement when they name the same recipient and either are
one proof over one signed content (both ACKs or both NACKs, one proof identity
`keyId|signature`, and every field the proof signs equal, compared as its
signing input, `isALSameReceiptProofContent`; D606), or both carry `proof:
null`, whatever their content, or are both that recipient's own word on its
own channel (`fromPeerId === logicalRecipientPeerId`); relays still verify
nothing, and the origin judges each statement as S8-i built it. So a peer that
held a recipient's real proof and alters what it signs makes another statement,
which goes up and is refused `invalid-signature`, and the recipient's true
control forwarded by another child still goes up and is counted. One predicate, `isALSameReceiptStatement` with
`hasALConfirmedStatement` and `hasALOutsideStatement` in `alm/inbound/control/`,
over `isSameSignatureProof` beside `SignatureProof`, applies at every site that
keyed by the recipient: a confirming ACK goes up unless the same statement is
stored, a recipient is owed relative to the incoming control, and the row's
outside list gains a recipient only when it is absent; the ACK admission refuses
a duplicate or an outside recipient, and the NACK admission its two refusals,
only against the same statement; and a retried copy re-forwards the first of
each distinct stored statement. When the history no longer holds any control
that recorded a recipient outside, the recipient alone decides, as before. Since
`null` is one identity, honest `ws`, `hop` and `subtree` flows key as before
(under `hop` and `subtree` on `rtc` a child that attaches distinct non-null
proofs makes distinct statements, no new class, since the upward audience is
undefined there), and no wire or stored shape changed. A retried copy's re-forward is cut to fit its commit
bundle's cap of 256 durable effects (`resolveALInboundBoundedRetriedEffects`):
the relay's own effects always stay, the stored child controls fill the rest
with a recipient's own words chosen first, and the kept ones go in the order the
copy would have sent them. Without the cut a flooded history made the relay
refuse the whole retried copy, its own repeated ACK and retried forward
included. The cut is not a flood effect only: an honest room at the RTC room
limit, 256 recipients below one relay, re-forwards 256 statements beside the
relay's own effects, so one forwarded word is cut, own words being kept first,
where before S8-ii that retried copy was refused whole. The NACK admission's
outside-list capacity check spares a recipient
already on the list, which cannot grow by it. A dequeue now ends an
`unsupported` re-plan (`resolveALOutboundReplanRefusalSettlement` reads the
re-plan's site): the handle reads `rejected`, the receipt row is deleted in the
dequeue's own commit, and the fallback does not take the send, since no
fallback-capable leg is ever held (pinned); the retransmit and the ack-timeout
re-plan keep their behaviour, so the ack-timeout still runs to
`receipt-exhausted`, which the fallback takes, and an `unauthorized` re-plan
keeps its silent drop. The rule reads only the verdict, so it ends every
`unsupported` refusal met at a dequeue: the keyless freeze and the room limit,
and the ACK, ordering, sequence-mint, exclusive and granted-publication
refusals. The two verifiers share one thumbprint-checked key import,
`VerificationKeyCache` in `packages/shared/signature/` (256 entries, keyed
`keyId|JSON(publicJwk)`); each keeps its own order and verdict rules, and no pin
moved. `messages.control` takes an optional `logicalRecipientPeerId`, which may
carry a `{resultCache…}` token; absent, the page's own session stands, applied
where the page knows its session, and `proof` stays `null`. Three observation
cells, all full scope, three-agent and withheld from the hosted manifests (every
hosted manifest is byte-identical): `unsigned-ack-refused` (`rtc`,
`rtc-with-ws-fallback`), whose recipient-b sends a raw unsigned ACK naming its
own session; `forged-recipient-ack` (`rtc`), whose receiver forges an unsigned
ACK naming recipient-b while recipient-b holds its own; and
`receipted-relay-path` (`rtc`), in which the owner reshapes the room into a
three-session path and the sender and the owner each send one non-granted
receipted multicast, so that whenever both sends route on one planned path at
least one is relayed with the far leaf's signed ACK forwarded back. In the two
cells that send an unsigned ACK the sender waits for its outbound `rejected`
control admission with `proofRefusal` `missing-proof`, and in all three every
receipt ends `acknowledged` with both recipients confirmed. The lane's
receipt-role identity assessment joins the receipt the pinned handle ended in,
the sender's last read of it. The 6f count on the real fixtures: a direct
`receiver` room of two recipients signs 2 and the origin verifies 2; through a
counted relay the relay signs 2 and verifies none, the leaf signs 1 and the
origin verifies 3; a `leader` send to a leaf director signs 1 and verifies 1.
The Limit 2 sibling (an unsigned `not-subscribed` NACK under `hop` that names
another next hop) is pinned by a `Limit:` test. The full-scope RTC lane, local
and in-memory, ran the three cells green at `e4d5f3058` (the two cells red
there, `repair-exhausted` and `granted-rtc-ordered-relay`, are red on `main`
too), and `unsigned-ack-refused` green over `rtc-with-ws-fallback` at
`9b23ad0ac`; the only proof refusals in either run were the cells'
`missing-proof`, and in `receipted-relay-path` recipient-b was the middle, so
both origins' receipts confirmed both recipients through one hop. Bundle figures
(S8-R11): `browser/rallar.ts` 300.214 → 300.470 KiB brotli (307,681 B) under its
301 KiB budget, and the headless agent 396.913 → 397.205 KiB, its budget raised
397 → 398 KiB. Limits: a child may send any number of distinct forged statements
about a recipient, and each is stored, forwarded once and refused at the origin
(no refusal bound). Each retried copy re-forwards up to its budget of stored
statements again, and the origin's verifier caches positive verdicts only, so a
stored forgery costs the origin one verify per retried copy that carries it. The flood has three effects. The relay
keeps the last 256 child ACKs and the last 256 outside-audience NACKs per
message, so enough later statements evict a recipient's true control, and a
retried copy no longer re-forwards it; its first forward had gone up. A retried
copy's re-forward is cut to its commit cap with own words first, so at a relay
above the first one, where every statement is a forwarded word, the cut is
arbitrary among them. And a history flood can evict the control that recorded a
recipient outside (a forged hop-end records it from the ACK history, where any
256 later child ACKs, honest ones included, evict it), after which the
recipient alone decides, so its
later true control is refused at that relay at first arrival. Two of these need
no flood: one forged hop-end and 256 later child ACKs, honest ones included,
evict the recording control, and in a room at the RTC room limit the cut falls
anyway, so a few early forged statements can take the place of true forwarded
words in a re-forward. A child that reuses one well-formed proof over up to 256
altered contents makes a relay encode the signed content pairwise: about 90 ms
per retried copy's grouping against about 1.2 ms before, up to about 180 ms
with the NACK history flooded the same way and about 3 ms per admission on a
full history, bounded by the histories, paced by the origin's retries and not
fixed here (D606). In every case the origin counts only what verifies. An unsigned `not-subscribed` NACK under `hop`
still moves another next hop outside (pinned); a forger that is the recipient's
own parent is on its path and can still withhold the copy or its control, which
the origin's timeout, retry and fallback cover; and a recipient's redundant own
NACK after its own hop-end is refused at a relay as the same statement, as
before this slice. A dequeue can re-plan an already-sent message (a reload
between the dispatch commit and the queue row's completion); the keyless freeze
and the room limit cannot newly refuse one, since the audience and its keys
freeze once, and no trigger was found for the other `unsupported` producers.
`forged-recipient-ack` shows `missing-proof` only (a shape-valid garbage proof
stays a unit forgery), and `receipted-relay-path` asserts neither who relays nor
the hop count, since the owner's request only asks for the reshape: two sends
routed under different plans can both go direct and the cell stays green. The
three cells run at the local full scope only: CI's observation job runs the
smoke scope and the hosted manifests withhold them.

### Slice 9: one owner each, then a lane to trust

Slice 9 has two parts. The first, S9-i, folds the duplicated owners the
hygiene and actor-alignment surveys found on the ALM surface, and changes no
behavior: no wire shape, stored shape or OpenAPI document differs from Slice
8's. Where two places held one fact, one place now holds it:

- the session's QoS provider, volatile limits and publication stage limits are
  required construction inputs from `createRallarFacade` down to the carriers,
  and the product root passes `createDefaultBrowserSessionQosInputs()`, whose
  values are today's: an empty QoS input and the frozen shipped limits. No
  layer below the root chooses a default, so another root, such as the actor's,
  passes its own (§4.3). The WS server keeps an absent QoS input;
- `createBrowserSessionMessaging` composes the session's messaging for the
  product root and the black-box root;
- `decodeALVolatileSessionLimits` decodes the volatile limits as the stage
  limits are decoded, with positive safe integers, and `getOwnNumber` reads a
  number field for the three decoders;
- `AL_ACK_STATUSES`, `AL_STORAGE_UNAVAILABLE_CAUSES` and the three delivery
  reason tuples are the runtime lists the codec, the delivery lifecycle and the
  black-box script's safe projection share;
- `HeldSendChain` owns the ordered chain of held sends and the logged failure,
  one chain each for the WS server and the pub/sub bridge;
- `computeUtf8ByteLength` counts the UTF-8 bytes of the ALM and WS paths, and
  `toApiWsUrl` and `toApiMutationRequestPath` build the WS upgrade URL and the
  runner's topology-proof mutation paths;
- `DeadlineAbortScope` and `sleepWithAbort` serve the black-box harness's
  deadline scopes and abortable waits.

The inbound runtime-state stores nothing constructed, six unreferenced queuebox
and resilience values and fifteen file-private runtime exports are deleted.
The second part, S9-ii, is a full-scope lane to trust, designed in its own
plan and pending: the lane's red cells diagnosed, an overrun cancelling its own
recipe, a layout-independent check of the relay path, the two cluster proofs
wired into the Postgres lane and `tests/playwright/**` typechecked.

### Later outcomes

- **Restricted RTC beyond room multicast:** an encrypted publication with key
  distribution, rotation and revocation, and native hosts' publication keys.
  Native publication-key custody outside a browser (a Deno sidecar, a native
  kit) is the actor's gating dependency for RTC parity.
- **Ordered subscription history:** a latest-state snapshot with a fenced
  live cursor (the snapshot/live hand-off), and an authorized replay of
  retained history, with no replay to an unauthorized or newly joined
  historical audience. Live entry and omissions are Slice 4's.
- **Broader QoS:** non-conflating reliable pacing with bounded rejection or
  backpressure; coherent checkpoint recovery where allowed; receiver last-N
  history; requested/effective negotiation for publishers, subscribers, and
  native/browser runtimes.
  Each keeps its independent delivery and durability guarantee.
- **RallarActor integration:** immediate and paced publication on the same
  contract in the host attachment, Unity/Unreal kits, and other native hosts.
  Engine simulation and interest remain application-owned. The actor's ALM
  dependencies are native publication-key custody (above), a re-examined
  per-session budget for a multi-group publishing seat (§4.3), and the local
  attachment trust boundary kept out of ALM's authority (§1). Key custody is a
  composition gap, not missing library code: the `PublicationKeyStore` port,
  the signer and both verifiers are in `packages/shared/signature`, and only
  the IndexedDB store and a 39-line memo are browser-side. The per-session
  stage budget is a construction input resolved at the root (Slice 9), so an
  actor root passes its own. The lane key is `topicId/typeId` with no group
  (`packages/shared/al-contracts/publication/to-al-publication-stream-key.ts`),
  so a multi-group seat shares one lane, one cadence and one stage budget; a
  per-group key or per-group fairness changes semantics and waits for a
  measured envelope.
- **Measured operating envelope:** representative multi-group publishers,
  subscription churn, slow consumers, relay depth, mixed WS/RTC, and sustained
  overload with bounded memory and accurate outcome evidence; server-side
  ordered sends are measured by the 6b probe on room rows (counts in the Release 14
  record; the principal path is unmeasured). The path to it, as outcomes in
  order: a full-scope lane green on every carrier; a fault-step vocabulary for
  the platform; publication figures in the stage with one shared histogram; a
  same-regime baseline protocol; a publication workload family on the scale
  builder; bottleneck probes at the owners; and a first campaign on the
  three-replica fleet.

Full adoption requires those outcomes relevant to the advertised mode. A
temporary typed refusal during staged delivery is not evidence that the whole
pub/sub product is complete. Retained offline logs, consumer groups,
cross-group bridges, and a processing engine require separate proposals if
an application needs them.

## 8. Requirement-to-evidence plan

These are future acceptance requirements, not results from this documentation
PR. Tests protect observable behavior and allow equivalent implementation
structures. Use the existing ALM conformance catalog rather than a second
publication test framework.

| Requirement                                                         | Evidence boundary                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cadence and drain are independent of host publication rate and N    | Injected-clock publications and captured native submissions, including delayed/hidden resume                                         |
| N=1 conflates; N>1 retains exactly the recent bound                 | Returned terminal outcomes and retained candidates read back independently                                                           |
| Byte overflow, aggregate exhaustion, and hot-key load stay bounded  | Oversized/new-key/multi-group workloads; owned memory/work/transport counters and non-starvation observations                        |
| Receive-policy mismatch and slow consumers do not alter other feeds | Explicit negotiation/refusal, independent consumers, bounded waits, and preserved reliable-event outcomes                            |
| Scope, resource, audience, and sender isolate stream keys           | Pairwise collision cases and captured recipient payloads at the real owner                                                           |
| Expiry, cancellation, and reconfiguration cannot revive values      | Held scheduling/submission, original deadline, disposal during wait, and zero late native sends                                      |
| Commands and durability guarantees survive pacing introduction      | Existing command/notification behavior plus typed incompatible requests before submission                                            |
| Permission mutation is atomic and convergent                        | Actual conditional-write conflict, full retry, idempotency race, outbox collision rollback, corruption, final authoritative readback |
| Only eligible subscribed sessions receive a publication             | Public publish/subscribe boundaries with independent producer, subscriber, denied member, and multi-session identities               |
| Cleanup and reconnect do not cancel or revive another subscription  | Two listeners, same-session tabs, separate sessions, stale disconnect, lease expiry, and new generation                              |
| Revocation and receipts preserve truthful outcomes                  | Hold admission/dispatch/repair, revoke, release; inspect exact payload effects and original expected recipients                      |
| No alternative publication path bypasses grants                     | WS, RTC where supported, both fallback directions, unicast/list, raw send, server/proxy, retries, ordered release, repair            |
| RTC distinguishes origin, recipient, and relay                      | Forged origin rejection, valid intermediate forwarding, no unauthorized application delivery, and explicit confidentiality mode      |
| Ordered entry and exclusions do not leak or invent history          | New subscription at a nonzero sequence, intentional omission, snapshot/live race, restart, multi-publisher tracks                    |
| Browser controls expose the actual chosen role and QoS              | Playwright through visible subscribe, role-management, and publication controls, with resulting state/outcomes                       |
| Native attachment preserves protocol and has a measured envelope    | Browser/native interoperation; same immediate/paced semantics across sidecar and any later optimized attachment                      |

Slice 5 adds evidence to two rows. **Revocation and receipts preserve truthful
outcomes:** a recipient the server skipped or dropped on its own row is outside
its own receipt, not unconfirmed: an api-v1 test revokes a subscriber of a
server-producer row before the receipt's retry and reads it outside while the
receipt completes on the other recipient's ACK, and the WS server fixture
retries only the recipient still unconfirmed. **Ordered entry and exclusions do
not leak or invent history:** producer rows (the Relic unit's mid-round joiner
enters at `seq 2`; the fixture's producer row records and a later-admitted
session enters at its first copy), non-contiguous tracks (`3` then `5` with no
hold on `4`; the `server-ordered-entry` cell) and the stuck predecessor (`3`
holds on `1` with `2` unwritten; a predecessor that ends unrecorded or fails for
good releases its successor through the cleared index, not its deadline).

Slice 6 adds evidence to two rows. **No alternative publication path bypasses
grants:** a granted list, principal broadcast and unicast over RTC freeze to
their subscribing sessions before they sign, a listed non-holder left out; the
browser admits a peer and a listed granted send on RTC carrying its origin's
proof; a narrowed audience past the room limit is handed to the fallback with
its sender's targets; and the cells `granted-rtc-list-delivered`,
`granted-rtc-list-non-holder`, `granted-rtc-list-lane-roles`,
`granted-rtc-unicast-delivered` and `granted-rtc-principal-delivered` observe it
on the local lane; and every proof of the six producer paths S6-ii folded is
written in its row's own outbox statement, so a producer row and the proof its
dequeue checks commit together. **RTC distinguishes origin, recipient, and
relay:** the relay fixture's unlisted subscriber relays a frozen list it is not
named in and delivers nothing, while the list's receipt completes at the origin.

Slice 7 adds evidence to two rows. **Revocation and receipts preserve truthful
outcomes:** the dequeue authority's fixture drops a captured session no durable
filter finds live, whatever this instance's sockets hold, and keeps a non-frozen
row's audience with no filter wired; the track-order fixture records a durable
drop outside with no socket open here, needs the open socket for an open-here
drop, and turns three conflicts into one `outside-audience-commit` diagnostic
with no console line; the bridge suite reports the captured sessions its
send-time re-check dropped beside the skips, open-here; the api-v1 units read a
session live nowhere outside at the dequeue, the receipt completing on the other
recipient, and one gone by the retry outside after it; and the ordering cluster
proof's closed session is outside the relayed receipt, which completes.
**Ordered entry and exclusions do not leak or invent history:** the ordering
cluster proof's receiver on another instance than the dequeuer is recorded and
enters at its first copy on the principal track and on a frozen granted row,
and its omitted granted copy reads `omitted`, not a gap; the 6b probe's counts
on Postgres show the dequeue's front unchanged and the durable read added (its
authority batch measured; the snapshot read before it and the principal path
not).

Slice 8 adds evidence to two rows. **RTC distinguishes origin, recipient, and
relay:** on the relay chain fixture, whose sessions each hold their own key, a
recipient's `delivered`, `accepted`, `not-subscribed`, `before-entry` and `gap`
controls reach the origin forwarded by the relay with the recipient's own
status, time and proof, which verifies under the recipient's key and not the
relay's; the origin counts the two ACKs, records the two outside-audience NACKs
outside (`web-rtc-overlay-missing-recipient-repair.test.ts`); on
`rtc-relay-gap-repair.test.ts` the origin verifies a gap NACK the leaf's own
sign step signed and repairs the gap; and the
five forge units, red before the origin verified (`cae77e87b`) and green
since, refuse a direct peer that names another recipient, a relay that forges its
child's ACK, a forged outside-audience NACK, a forged terminal NACK and a true
ACK replayed to another message or origin, with a sixth refusing an unsigned
`forwarded`-status ACK that names a counted recipient. **Revocation and receipts
preserve truthful outcomes:** a refused forgery counts nobody and a true ACK the
origin receives still completes the receipt; and a receipted RTC leg with a
keyless counted recipient is refused `unsupported` at admission and handed to
the fallback, and under `rtc` alone is refused, never admitted to time out.
S8-ii adds to the first row: at an honest relay a child hop's forged ACK, NACK
or hop-end about another recipient no longer pre-empts that recipient's true
control, in either order and through two relays in a row
(`rtc-receipt-forgery.test.ts`), nor does a child that carries the recipient's
real proof over an altered ACK or a NACK while another child forwards the true
ACK, in either order (`rtc-receipt-held-proof.test.ts`), and the full-scope lane's
`receipted-relay-path` cell recorded two relayed signed receipts in a browser
run; to the second: a held send refused `unsupported` at its freezing dequeue
reads `rejected` at once (`rtc-receipt-proof-keys.test.ts`).

Focused shared ALM, browser facade, and server tests run before package
typechecks/builds. Public exports require API snapshots and bundle-boundary
checks. Authoritative group/API changes select the unweakened medium-scale
Postgres black-box gate and the current mutation/concurrency performance gate
under `rallar-testing`; topology replay checks apply only if that surface
changes. Distributed conformance acceptance includes fresh same-regime
evidence for every supported carrier and the chosen scale, not old artifact
hashes or a green unrelated suite.

## 9. Measurement, diagnostics, and adoption

Measure publication-to-selection age separately from ALM admission-to-native
submission and receipt latency. Include actual delivered sample age and
missed opportunity count; averaging only dispatched survivors hides deliberate
loss. Report publications retained, superseded, expired, refused, admitted,
submitted, and delivered/confirmed where that evidence exists. Also report
active keys/subscriptions, retained/admitted/buffered bytes, drain usage,
congestion duration, authority-refresh delay, and cleanup/recovery outcomes.
Diagnostics are payload-free and use bounded metric dimensions; identifiers
belong in approved logs/traces, not metric labels.

The workload varies publication rate above/below cadence, N, drain
message/byte budgets, payload size, key/group/consumer count, subscription and
permission churn, relay depth, loss, browser frame load, and suspension. Prove
correctness with explicit deterministic settings, then publish p50/p95/p99
latency and jitter, sustained throughput, memory bounds, and missed-window
figures under a named environment and same-regime baseline. Never call the
configured cadence a measured delivered rate.

Reuse the plain-page and conformance measurement owners where they exercise
the new boundary. Any future shared-server benchmark first follows
`scripts/platform/perf/README.md`; profiles stay under `tmp/perf/`. A new
benchmark or numeric SLO needs its own representative workload, not a copied
historical figure.

For RallarActor, measure the private attachment end to end, including payload
capture/copy cost and p95/p99 jitter or missed send windows. A sidecar remains
the default; only measured requirements justify a lower-copy or in-process
variant. Such a variant must preserve permission, audience, pacing, expiry,
and delivery outcomes.

Adoption requires the scope/default/cutover decision, a truthful security and
revocation contract, the requirement-to-evidence matrix for the advertised
modes, and current measured capacity. It changes no business price or offer.
The proposal's value is explicit, composable data-flow policy under Rallar's
existing membership and message authorities.
