# ALM publication QoS and pub/sub addendum

Prepared: 2026-10-09. Status: Slice 1 (bounded publication pacing), Slice 2
(authorized WS pub/sub, as S2-i and S2-ii), Slice 3 (restricted RTC parity,
as S3-i and S3-ii), Slice 4 (ordered subscription entry, as S4-i and S4-ii) and
Slice 5 (producer-row positions, as S5-i) are implemented and recorded as
applied in §7; the later outcomes remain a proposed extension, not implemented
behavior or an adopted change to `docs/product.md`.

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
against its own room snapshot. RTC returns unsupported for every other
restricted send, and an allowed WS strategy uses the validated WS path.

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

### Later outcomes

- **Restricted RTC beyond room multicast:** an encrypted publication with key
  distribution, rotation and revocation, ACKs that authenticate their logical
  recipient across relays, granted unicast, fixed-list and broadcast over RTC,
  and native hosts' publication keys. Granted fixed-list over RTC — a named
  member subset that is neither one recipient nor the whole room — is the
  directed delivery an actor's application-paced play needs and is not yet
  carried. Native publication-key custody outside a browser (a Deno sidecar,
  a native kit) is the actor's gating dependency for RTC parity.
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
  dependencies are native publication-key custody and granted fixed-list over
  RTC (above), a re-examined per-session budget for a multi-group publishing
  seat (§4.3), and the local attachment trust boundary kept out of ALM's
  authority (§1).
- **Measured operating envelope:** representative multi-group publishers,
  subscription churn, slow consumers, relay depth, mixed WS/RTC, and sustained
  overload with bounded memory and accurate outcome evidence.

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
