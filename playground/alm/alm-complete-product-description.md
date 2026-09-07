# ALM complete product description

Review date: 2026-09-05

Reviewed source: `02d65ac4a458b98b92ebda22cf3ff84041027eb9`

Related documents: [current implementation audit](./alm-static-audit.md) and
[delivery roadmap](./alm-improvement-plan.md).

Status markers in this document describe the current implementation:

- **CURRENT** — the capability exists end to end.
- **PARTIAL** — important behavior exists, but the product guarantee is not
  complete or is transport-specific.
- **MISSING TODAY** — the contract declares the capability or the complete
  product requires it, but the current implementation has no dependable
  end-to-end behavior.

Unmarked normative prose describes the intended complete product. The markers
describe the implementation at the reviewed source revision. This is a product
description and completion contract; the roadmap owns sequencing.
Missing capability is not by itself proof of product demand: broader audience,
leader, and distributed ownership features require concrete consumers and a user
scope decision as described in the roadmap. Source facts remain tied to the
reviewed revision; intended behavior below incorporates the later product review.

## Product proposition

ALM is Rallar's transport-neutral application message protocol. An application
describes one logical message and its delivery semantics; ALM validates,
authorizes, routes, admits, sends, observes, repairs, and retires that message
consistently whether its selected transport is RTC or WS.

ALM does not hide meaningful differences between transports. RTC can provide
low-latency peer/overlay delivery and explicit congestion outcomes; WS can
provide server-routed delivery and authoritative audience resolution. ALM owns
the shared meaning of identity, routing, expiry, ordering, reliability,
acknowledgement, repair, deduplication, supersedence, ownership, lifecycle, and
observability.

The product promise is:

> A caller can know what ALM accepted, what transport accepted, what logical
> audience acknowledged, what was retried or repaired, and why a message was
> dropped—without changing semantic meaning between RTC and WS.

Normal operation is optimistic and permissive: valid work can progress with
available authorized routes while delayed observations catch up. Harmless
duplicates and stale replaceable values are no-ops. Missing authority is a
bounded recovery condition, not permission to deliver and not automatically a
permanent denial. A slow participant does not hold up delivery to everyone else.

## Product boundaries

ALM owns:

- the `ALMessage` wire envelope and compatibility version;
- bounded validation and transport identity binding;
- transport-neutral QoS normalization and explicit downgrade/rejection;
- logical audience and route semantics;
- admission, deduplication, ordering, supersedence, and expiry;
- send/queue/acknowledgement/repair lifecycle outcomes;
- volatile and durable delivery state;
- RTC overlay forwarding and WS routing adapters;
- cross-transport conformance and diagnostics.

QueueBox owns queued execution, reservations, redelivery, and scheduling. ALM
supplies message decisions through a visible read/compute/validate/write-or-send
flow: one bounded read owner, pure value-only compute, pure validation returning
the existing `Either`, and an effect boundary that does not mutate the computed
value. Existing QueueBox and transport callbacks remain in the owned shell.
The roadmap's [implementation and reuse guidance](alm-improvement-plan.md#implementation-shape-and-existing-foundations)
defines the concrete library boundaries. No new foundational or third-party
library is currently required; a demonstrated gap is discussed with the user
before introducing one.

ALM does not own:

- game or document authority;
- domain payload validation beyond selecting the registered schema decoder;
- room membership truth or principal truth (it consumes authoritative snapshots);
- simulation state, CRDT conflict resolution, or presentation smoothing;
- a promise that every requested QoS is available on every transport.

## Core experience

```text
construct -> validate -> authorize/normalize -> admit -> dispatch
                                                    |
                                      observe/ack/retry/repair
                                                    |
                                        delivered/expired/failed
```

A caller receives a stable message ID immediately and can observe a staged
result:

1. `rejected` — malformed, oversized, proved unauthorized, or an unsupported required
   guarantee. Missing authority/route and temporary capacity produce distinct
   bounded waiting, recovery, or capacity outcomes; terminal deadlines remain explicit.
2. `accepted` — admitted under an explicit effective policy.
3. `queued` — pending transport work has an owner and the promised volatile or
   durable retention policy; queueing alone does not imply persistence.
4. `transport-accepted` — RTC/WS accepted the bytes. This is terminal success
   only for best-effort; a reliable send remains pending logical acknowledgement.
5. `acknowledged` — the requested logical receiver, frozen complete audience,
   or authoritative leader confirmed. Hop/subtree progress is nonterminal unless
   it proves the full logical acknowledgement obligation.
6. `expired`, `superseded`, `failed`, or `cancelled` — terminal without the
   requested acknowledgement.

Every terminal outcome preserves submitted, confirmed, and unconfirmed evidence.
A lost receipt does not establish non-delivery. Cancellation stops remaining
owned attempts; it does not retract remote delivery or undo application work.
An expired or cancelled room notification can still have confirmed recipients.

**MISSING TODAY — result stages:** The current API uses statuses such as
`sent-immediate` before a durable send effect has necessarily succeeded and does
not expose an observable logical delivery lifecycle.

## Envelope and compatibility

Every message has:

- a version, globally unique message ID, sender timestamp, stable sender ID, and
  optional session/trace identity;
- a mandatory topic/context/resource route;
- an optional logical target and optional forwarding hints;
- hop/time/freshness constraints;
- optional ordering epoch/key/sequence;
- explicit delivery, acknowledgement, ownership, and QoS requests;
- optional request/reply correlation;
- a registered payload type and JSON payload;
- bounded provenance and diagnostics.

Unknown envelope versions and unknown mandatory fields fail closed. Optional
extensions are introduced only through a versioned compatibility rule. All
identifiers, arrays, payloads, gap windows, and total envelopes have documented
byte/count bounds.

**PARTIAL — compatibility:** The v2 envelope and structural decoders exist.
Browser [RTC](../../packages/shared/services/web-rtc-rx-streamer-service.ts) and
[WS](../../packages/shared/services/ws-queue-box-client-service.ts) decode live
objects with `decodePersistedALMessageValue` and queue replay with
`decodePersistedALMessage`. These checks do not yet provide the complete
resource limits, control-payload validation, or authenticated RTC provenance
required by the product.

**MISSING TODAY — session and trace identity:** Builders do not populate AL
`sessionId`/`traceId`, and no end-to-end trace propagation behavior exists.

## Validation, trust, and authorization

ALM validates at every trust boundary:

- builder input before serialization;
- browser RTC objects before policy/admission;
- browser WS objects before policy/admission;
- server WS ingress before routing;
- persisted records before replay;
- control payloads before control-state mutation.

Transport identity is authoritative at each immediate hop. RTC relays preserve
the original `id.senderId`, so equality between that origin and the channel peer
is not a valid relay check. A receiver authenticates the immediate peer and
validates the declared origin, relay, recipient, and route against matching
server-provided room authority. Diagnostics never grant authority. Browser WS
receives only server-validated envelopes, and server WS binds new senders to the
authenticated connection or an explicitly authorized server/system identity.
ACK/NACK/repair identities must agree with the envelope, target, transport peer,
and tracked message audience. Cryptographic signatures by the original sender
are outside the approved roadmap.

Domain topic registries add payload schema, maximum size, authority, scope,
fanout, and allowed QoS. Unknown topics follow an explicit deny/allow policy.
Room delivery requires sufficient matching server-provided authority; it does
not require a new server round trip for every message. Missing/stale evidence
can trigger bounded refresh or authorized alternative routing. Pending intake
cannot deliver, forward, grant authority, or reserve a claimed dedup identity.
Authenticated server state/topology bootstrap has its own explicit authority so
receiving a snapshot does not require already possessing that snapshot.

**PARTIAL — live trust boundaries:** Server WS has envelope decoding and room
authorization, while browser RTC/WS now structurally decode live messages. The
old RTC mismatch warning and full-envelope receive logs are gone. Structural
decoding alone does not authenticate relay provenance or prove room authority.
[Control parsing](../../packages/shared/al-contracts/al-control.ts) still uses
unchecked JSON casts, and inbound control dispatch bypasses the ordinary
planner.

## Logical audiences

### Unicast

One logical recipient. A transport may route through an authorized next hop,
but only the addressed recipient delivers locally.

**CURRENT** for basic RTC and WS routing.

### Multicast

A scoped `GroupRef` names the logical group. Audience selection uses an
authoritative membership snapshot. A supplied `minSnapshotVersion` prevents a
node with stale group state from silently routing or accepting. Membership
fencing must use an authoritative membership epoch; its current field and
ordering use do not establish that guarantee. Until that implementation lands,
requests requiring membership fencing are explicitly unsupported. The outcome
identifies the authority snapshot used. For a
reliable send, the logical audience is frozen at admission: joins do not expand
it, and departures do not silently reduce the success requirement.

**PARTIAL:** RTC uses current group peers and overlay next hops when its
group/overlay context resolves; WS has room snapshot authorization.

**PARTIAL — RTC snapshot admission:**
[RTC snapshot admission](../../packages/shared/multicast/rtc-room-snapshot-admission.ts)
checks a supplied `minSnapshotVersion` against exact scope, active status,
expiry, and version. Unversioned room messages and originating plans bypass the
check, and [shared AL policy](../../packages/shared/al-contracts/al-policy.ts)
still permits local multicast when the resolved member set is empty. Insufficient
authority must prevent delivery, forwarding, success ACKs, and admitted control
mutation; bounded evidence recovery remains possible. Mismatched or known-removed
authority rejects rather than waiting indefinitely. The builder also copies
`membershipEpoch` into `ordering.epoch`; that runtime use must not be mistaken
for an authoritative membership fence.

### Broadcast

Broadcast scopes have distinct semantics:

- `room`: live sessions in one scoped room/group;
- `principal`: the principal's own live sessions plus the explicitly defined
  co-group audience;
- `world`: one product world/application audience;
- `all`: every authorized live connection in the relevant deployment scope.

Exclusions are applied after authoritative audience resolution. A server may
capture immutable `recipientPeerIds` for replayable authoritative work; clients
cannot use that field to expand authority.

**PARTIAL:** Server WS implements room routing and application-specific
principal/state-sync and fixed-topology cases.

**MISSING TODAY — general scope semantics:** The shared planner treats broadcast
as “not excluded,” does not interpret scope/principal/fixed recipients, and the
public builder cannot create principal or fixed-recipient broadcasts.

## Transport selection and parity

ALM supports RTC and WS as first-class carriers.

- RTC is preferred for eligible low-latency room/peer data when a policy-
  compliant data-channel lane and route are ready.
- WS is preferred for server-authoritative routing, offline/durable server work,
  and topics that require centralized authorization.
- A caller may require one transport, prefer one with an explicit fallback, or
  let a topic policy select.
- Fallback never duplicates logical ownership: a message ID has one lifecycle,
  deduplication domain, acknowledgement obligation, and terminal outcome across
  transport attempts.
- A transport switch preserves expiry, ordering, supersedence, correlation, and
  trace identity.

**CURRENT:** Both RTC and WS use the AL envelope and core admission runtimes.

**MISSING TODAY — one fallback lifecycle:** Browser typed channels expose RTC↔WS
fallback, but each carrier attempt constructs a new message ID and admission-like
statuses such as `enqueued`, `sent-immediate`, `skipped`, or `superseded` stop
fallback. Attempts therefore do not share one deduplication domain,
acknowledgement obligation, attempt history, or terminal outcome. Browser RTC
and WS also use separate admission scopes, so merely sharing an outgoing message
ID would not provide cross-carrier receiver deduplication.

**MISSING TODAY — conformance contract:** There is no cross-transport suite or
public outcome model proving that the same QoS request has the same meaning on
RTC and WS.

## QoS negotiation

A message carries a requested policy. The local transport adapter contributes
capabilities, authorization, and live state. ALM produces an effective policy
and a machine-readable list of defaulting, clamping, upgrading, downgrading, or
unmet requirements.

The effective policy is frozen for an admitted attempt or explicitly revised by
a recorded fallback/repair transition. A transport cannot silently claim an
unsupported guarantee.

**PARTIAL:** Normalization and provider hooks exist.

**MISSING TODAY — production providers:** Browser composition does not install
transport-aware capability, authorization, or live-congestion providers; the
default capability set claims every declared algorithm.

## Reliability and acknowledgement

### Best-effort

Best-effort reports transport acceptance or a concrete drop/closed outcome. It
does not retry after transport acceptance and makes no logical-delivery promise.
Volatile best-effort uses bounded memory and performs no browser persistence.

### At-least-once

At-least-once requires an acknowledgement strategy, an expiry/deadline, bounded
retry/repair, and receiver deduplication. It may produce duplicate deliveries;
the same message ID and idempotency contract make duplicates safe.

Reliable typed commands address their responsible receiver and require its
protocol ACK. Reliable room notifications track the complete frozen intended
session audience without waiting for room-wide readiness before dispatch.
An authority command's business completion does not depend on every room
browser answering. Topic/channel policy owns these defaults and the independent
ordering, durability, and transport choices. High-rate realtime stays explicitly
best-effort. A 30-second interactive deadline, 2-second ACK timeout, and 3 receipt
retries are starting defaults with explicit channel/caller overrides.

Retry only missing recipients, combine receipts where their actual confirmation
semantics permit it, and replace obsolete state according to topic policy.
QueueBox processing retries and logical receipt retries have distinct budgets
under one message deadline. Reliable volatile work does not promise crash survival;
durability must be selected separately. Matching duplicate data can repeat its
receipt without redelivery or unbounded history growth. Late receipts are no-ops
once their obligation is terminal.

An explicit at-least-once request with `ack: none` is invalid. A WebSocket frame
accepted by the browser API or an RTC payload accepted by `RTCDataChannel.send`
is not a logical delivery receipt.

### Acknowledgement modes

- `none`: no logical receipt; valid for best-effort only by default.
- `receiver`: the logical receiver confirms protocol acceptance under the
  promised durability policy.
- `all-logical-recipients`: every member of the frozen audience confirms, or
  expiry produces a partial/failure outcome.
- `group-leader`: the authoritative leader for the admitted epoch confirms;
  leader identity and succession are explicit.

A receiver ACK confirms protocol acceptance into the promised volatile or
durable path. It does not mean that the application completed its work; that
requires a separate application reply. Relay-hop receipts are tracked
separately from logical-recipient ACKs.

**PARTIAL:** Hop/subtree tracking, durable ACK timeout, NACK, and repair exist.
Durable replay rechecks snapshot readiness, preserves predecessor order, and
ACKs the admitted upstream relay. Current coverage includes
[durable replay](../../packages/tests/shared/multicast/rtc-snapshot-durable-replay.test.ts),
[room snapshot admission](../../packages/tests/shared/multicast/rtc-room-snapshot-admission.test.ts),
and [snapshot-floor admission](../../packages/tests/shared/rtc-snapshot-floor-admission.test.ts).

**MISSING TODAY — truthful at-least-once:** Default browser RTC and WS send paths
request at-least-once with no ACK. WS submission is not a logical receipt, and
the RTC adapter calls `peer.channel.send(msg)`, returns `sent`, and loses the
structured flow-control result. Typed fallback treats `skipped`, `superseded`,
and `enqueued` as successes while building a separate message per carrier.

**MISSING TODAY — distinct leader/all-recipient ACK:** Both modes currently map
to the same subtree behavior.

## Ordering and gap recovery

Ordering is scoped by ordering key, sender, and epoch. The receiver tracks the
last contiguous sequence and a bounded out-of-order window. Small gaps defer
local delivery and request missing ranges. Gaps beyond count/age/byte limits
produce a clean `resync-required` outcome rather than unbounded buffering.

Repair messages carry compact ranges and are paged. Buffered messages expire,
supersedence can remove obsolete buffered values, and a new epoch closes the old
ordering track.

**PARTIAL:** Ordering tracks include key/sender/epoch; gap buffering, NACK/
repair, release, expiry, and restart behavior exist. Outbound ACK history uses
`appendUniqueALAck`, while inbound ACK history can still append duplicates.

**MISSING TODAY — bounded gaps:**
[`compute-al-ordering-observation.ts`](../../packages/shared/alm/compute-al-ordering-observation.ts)
enumerates missing sequences individually with no maximum gap/window, allowing
unbounded CPU, memory, control-payload, and effect-ID work.

## Deduplication and supersedence

Deduplication explicitly declares its identity domain:

- global message ID;
- sender + message ID;
- a namespaced semantic key.

The compare-and-set domain matches the key's scope, so concurrent senders cannot
both win a global/semantic identity. Retention is at least the maximum retry and
replay horizon.

Latest-wins supersedence declares a namespaced key and optional replaced message
ID. It can coalesce pending transport work and data-channel queued work without
reporting the replaced message as delivered.

**PARTIAL:** Dedup and latest-wins behavior are implemented and persisted.

**MISSING TODAY — shared arbitration:** Optimistic versions are sender-scoped
even when a dedup/supersedence key is cross-sender. Code inspection shows that
two stale cross-sender reads followed by sequential commits can both win. The
IndexedDB revision read at commit start fences a global revision but does not
validate the earlier shared-key decision. This is a code-derived risk, not
measured race evidence.

## Congestion and RTC flow control

RTC data-channel health is live AL policy input: readiness, buffered bytes,
high/low watermarks, queue depth, and overflow outcomes. Topics define priority,
maximum age, and one of:

- reject;
- defer/retry;
- drop low priority;
- replace latest by semantic key;
- bounded queue.

The AL result distinguishes queued from sent. A queued item remains owned by its
AL lifecycle. A dropped or replaced item transitions according to delivery and
supersedence policy. Relay congestion can reduce fanout or trigger an authorized
alternate route without violating audience/epoch constraints.

**PARTIAL:** `QRtcDataChannel` has bounded flow control and counters; AL QoS has
congestion/fanout/supersedence concepts.

**MISSING TODAY — integration:** The legacy `send()` API discards the structured
flow-control result, and production AL QoS receives no live backpressure signal.

## Durability and browser-local storage

Durability has observable meaning:

- `volatile`: bounded memory only; lost on process/tab termination;
- `local-outbox`: the sender persists work until its required receipt or terminal
  outcome;
- `local-inbox`: the receiver persists accepted work until local consumption or
  terminal outcome.

Browser durability uses a fixed schema with bounded database/store counts and
explicitly resets incompatible ALM queues during coordinated cutover. Session
cleanup and abandoned-session recovery are bounded. Indexed ALM queries are bounded by
queue/namespace and due/expiry range. Existing QueueBox/ResourceInbox owns durable
work and its canonical envelope; related admission/receipt state references it
instead of implementing a second queue or copying the full envelope. Atomic
admission and work recording preserve crash safety. Quota,
eviction, blocked opens, transaction aborts, and database enumeration yield
explicit outcomes and bounded cleanup.

**PARTIAL:** Atomic admission/effect commit, leases, retries, expiry, idempotent
effect IDs, restart replay, and global revision fencing are implemented.
[Admission persistence](../../packages/shared/alm/indexed-db-admission-backend.ts)
and [snapshot reads](../../packages/shared/alm/read-indexed-db-admission-snapshot.ts)
use readonly transactions, lower-bound prefix cursors that stop when leaving
the prefix, and an expiry index. Snapshot assembly still uses separate reads,
so it is not one atomic snapshot.

[Browser QueueBox persistence](../../packages/shared-web/browser/queuebox/browser-queuebox-persistence.ts)
creates one database per session queue and validates the current schema instead
of adding stores through upgrades. The
[session lifecycle](../../packages/shared-web/browser/session/session-auth-lifecycle.ts)
deletes the four queue databases for an ended session, and cleanup enumerates
remaining queue databases. `InboxOutboxEngine.wake()` exists and the browser
sender invokes it.

**MISSING TODAY — volatile semantics:** Volatile RTC/WS still persists admission
state and durable effects.

**MISSING TODAY — bounded IndexedDB and canonical durable work:** Effect
selection still lists and sorts every matching effect instead of using a bounded
due-time query. QueueBox still polls and performs full-queue `getAll` reads, and
the default durable path still traverses both ALM admission/effects and
QueueBox, copying full envelopes across the two queues. Bounds for abandoned
session databases and remaining queue databases still need evidence. No current
latency or operation-count measurements support a stronger performance claim.

## Correlation and actions

`corrId` groups a request lifecycle across retries/transports. `replyToMsgId`
links a response to the exact request. A request can register an optional
response schema, expected sender/audience, deadline, and one/many response mode.
Duplicate replies are deduplicated; late replies receive an explicit late/
expired outcome. Correlation identity and trace identity survive fallback and
repair.

**MISSING TODAY — correlation behavior:** The fields are only decoded/persisted;
there is no builder support, registry, matching, timeout, or response API.

## Repair and resynchronization

Repair is receiver-driven and bounded:

- ACK timeout, NACK, or detected sequence gap can request retransmission;
- RTC can retry the same peer or an authorized alternate overlay route;
- WS can redeliver from its durable sent window;
- repair respects original audience, epoch, expiry, dedup, and authorization;
- exhausted repair produces `resync-required`, not silent loss;
- snapshot/cursor resync is a first-class terminal recovery outcome.

**PARTIAL:** Durable ACK timeout, targeted retransmission, ordered-message lookup,
and RTC alternate-parent repair exist.

**MISSING TODAY — complete resync contract:** There is no generic snapshot/cursor
resync outcome after repair-window exhaustion, and server/client transport parity
is not specified.

## Ownership

`shared` means every matching local subscriber may observe the message.
`exclusive` means exactly one registered consumer in the declared ownership
scope may claim it. The scope is explicit: local process, browser session,
principal, group, or server consumer group. Durable exclusive claims use leases
and redelivery from existing QueueBox/ResourceInbox; volatile exclusive selection
is deterministic and observable. Distributed ownership requires a demonstrated
consumer and an explicit product scope decision, rather than a new generic claim system.

**PARTIAL:** Current services use `exclusive` to select one local callback.

**MISSING TODAY — ownership scope:** The contract does not say whether exclusive
is local or distributed, and no distributed exclusive-consumer claim exists.

## Observability and privacy

Each lifecycle emits structured, payload-free diagnostics:

- message/trace/session ID and transport attempt;
- requested/effective QoS notes;
- admission result and reason code;
- queue/effect age, retry/repair attempt, and ACK latency;
- RTC buffered amount and send outcome;
- IndexedDB transactions, cursor rows, bytes, abort/quota/upgrade events;
- final audience counts and terminal outcome.

Visited-peer diagnostics are bounded. Routine logs never include application
payloads. Applications can subscribe to lifecycle events and aggregate metrics
without polling internal stores.

**PARTIAL:** Outbound queue/lock/effect-drain diagnostics and RTC counters exist.
Full RTC envelopes are no longer logged by the receive service.

**MISSING TODAY — end-to-end observability:** There is no shared lifecycle event
stream, IndexedDB cost telemetry, trace propagation, or payload-safe logging
contract.

## Resource and abuse limits

The protocol publishes limits for:

- total envelope and payload bytes;
- identifier and correlation string bytes;
- next hops, recipients, exclusions, visited peers, ACKs, and controls;
- fanout and hop TTL;
- ordering gap, buffered messages/bytes, and repair range/page count;
- retries, repairs, acknowledgement deadline, and retention;
- per-topic/per-sender rate, concurrent work, and storage bytes.

Malformed/oversized protocol input fails before expensive allocation or persistence
and exposes a stable reason code. Temporary capacity exhaustion has a policy-specific
bounded defer, coalesce, or capacity outcome without silently evicting reliable work.

Existing input checks provide a 64 KiB payload ceiling and a 128-character
route-ID limit; they are not yet enforced by every ALM entry path. The initial
shared boundary will reuse them and add ceilings of 128 KiB per envelope, 256
elements per protocol collection/page, 64 visited peers or hops, a 256-sequence
repair window, and 256 messages and 1 MiB per ordering track. The additional
ceilings are planned requirements, not current guarantees.

These are work limits, not a 256-session room limit. Large audiences and system
snapshots use bounded producer/consumer pages without truncation; incomplete
snapshot assembly cannot authorize traffic. Retention also has per-peer/session
aggregate count, byte, age, and active-track budgets. The existing ALM ordering
owner gains bounded sequence-window behavior; no general-purpose message-buffer
library is currently required. Rate-window counters and Motion interpolation
buffers retain their separate responsibilities.

**MISSING TODAY — complete bounds:** Payload input validation exists but is not
called by AL builders, persisted/live envelope validation does not impose the
full resource budget, and ordering gaps are unbounded.

## Lifecycle and multi-context behavior

AL runtimes have explicit `start`, `ready`, `drain`, and `dispose` semantics.
Dispose fences new admission, releases or expires claims, stops timers, and
does not resurrect work. Multiple tabs coordinate one durable session through
transactional claims and notifications. Volatile work remains tab-local by
definition.

**PARTIAL:** Outbound disposal, inbound runtime, effect worker, and delivery
owner have disposal fences. Tests cover disposal during commit/read and retry
cancellation. Web Locks, versioned commits, and effect leases also exist.

**MISSING TODAY — complete lifecycle outcomes:** Disposal fences do not provide
the staged caller-visible result model described above, and polling remains in
browser durable delivery.

## Public product surface

The public ALM surface provides:

- safe builders for each supported target mode, action/correlation, trace/session,
  delivery policy, expiry, ordering, and supersedence option;
- the bounded envelope/control decoder;
- typed topic registration and payload decode hooks;
- send with staged lifecycle observation/cancellation;
- receive subscription with ownership scope;
- transport/effective-policy diagnostics;
- explicit volatile/durable storage policy;
- explicit protocol/capability descriptions and typed unsupported results; no migration framework.

**PARTIAL:** Basic builders, policy/runtime types, services, and canonical
browser/server factories are exported. The canonical factories now construct
admission stores only, and unused legacy hydration is gone from those factory
paths; legacy exports/classes remain. The current outbound owner map is
documented in
[`alm/outbound/README.md`](../../packages/shared/alm/outbound/README.md).

**MISSING TODAY — complete safe surface:** Principal/fixed-recipient/correlation/
trace builders are absent, builders bypass `assertValidALMessageInput`, and the
public surface does not yet provide the complete bounded envelope/control
validation or staged result lifecycle.

## Delivery and compatibility posture

The [delivery roadmap](./alm-improvement-plan.md) is staged, with only its next
two independently verifiable slices detailed. Later stages remain expressed as
product outcomes until current evidence justifies their implementation shape.

The approved transition is a coordinated clean cutover. Repository consumers
move with the new surface, obsolete APIs are removed, and incompatible browser
queues are reset explicitly. ALM does not silently fall back to the obsolete API
or migrate incompatible queue records. Later roadmap outcomes still include
consumer-backed audiences and leader ACKs, correlation, distributed traces,
ownership scope, and further QoS/recovery/diagnostic integration. Basic zero-IDB
volatile handling and practical purpose-specific policy land with slice 2;
later milestones harden them. Prospective capabilities without a demonstrated
consumer return to the user for a scope decision rather than becoming automatic
requirements for a general-purpose messaging system.

## Current validation baseline

The existing B06 three-browser suite exercises `messages.rtc`; its coverage is
anchored by
[`live-rtc-three-browser-coverage.test.ts`](../../packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts).
The current browser workload is a base for extending ALM storage and lifecycle
instrumentation, not evidence that those completion requirements already pass.

## Product completion criteria

ALM is product-complete for the committed consumer scope when all of the following
are true. Unresolved roadmap capabilities still require an explicit user scope
decision; this criterion does not authorize silently dropping them.

1. The same scenario suite runs over RTC and WS and produces equivalent logical
   admission, ordering, reliability, ACK, repair, expiry, and terminal outcomes.
2. Every live/persisted envelope and control message is bounded, decoded, and
   identity-bound before admitted-state mutation. Pure compute/validate and
   immutable write/send candidates preserve the same decisions across carriers.
3. At-least-once cannot be selected without an effective receipt strategy, and
   data-channel drops cannot be reported as successful sends. Partial progress
   and non-delivery uncertainty remain visible, including after cancellation.
4. Volatile ALM send/receive/retry performs zero AL-owned IndexedDB work on the
   common path, including reliable volatile policy when selected.
5. Durable messages have one existing QueueBox/ResourceInbox work owner and bounded indexed queries;
   transaction/row/byte budgets do not grow with unrelated messages or old
   sessions.
6. Room multicast requires matching server-provided room authority, preserves
   bounded evidence catch-up/bootstrap and optimistic room progress, enforces
   authoritative membership fencing when requested and supported, respects required
   snapshot floors, and freezes the reliable intended audience at admission.
7. Every supported target/ACK mode has one documented, tested semantic and a
   concrete consumer. Unimplemented required guarantees reject explicitly;
   principal/world/fixed audiences and leader modes remain subject to that rule.
8. Ordering, diagnostic, control, retry, repair, and storage work is bounded and
   has clean resync/terminal behavior, aggregate memory bounds, and bounded
   audience/snapshot paging without an accidental room-size restriction.
9. One message identity and lifecycle spans transport fallback; correlation,
   tracing, staged outcomes, and payload-safe observability work across retry,
   repair, restart, and every carrier attempt.
10. Runtime disposal, multi-tab claims, quota/eviction, blocked upgrades, and
    restart are deterministic and externally observable.

## Complete-product summary

The complete ALM product is one semantic protocol with two first-class carrier
adapters. RTC remains fast because volatile traffic is not forced through
IndexedDB and because data-channel backpressure is a protocol outcome. WS remains
authoritative and durable where required. Durable RTC and WS share bounded,
indexed QueueBox/ResourceInbox execution and ALM policy/validation. Every supported
contract field has a runtime owner, every promised receipt has observable evidence,
and preferred capabilities can negotiate without silently downgrading required
guarantees. Normal uncertainty leads to bounded recovery and useful progress.
