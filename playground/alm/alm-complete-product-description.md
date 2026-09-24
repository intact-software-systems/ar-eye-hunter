# ALM complete product description

Review date: 2026-09-05

Reviewed source: `a28e61b61` (`main` after PR #521; markers refreshed 2026-09-08, originally
written against `02d65ac4a`)

Related documents: [current implementation audit](./alm-static-audit.md),
[delivery roadmap](./alm-improvement-plan.md), and
[PR #521 code assessment](./pr-521-code-assessment.md).

Status markers in this document describe the current implementation:

- **CURRENT** — the capability exists end to end.
- **PARTIAL** — important behavior exists, but the product guarantee is not
  complete or is transport-specific.
- **PLANNED — release** — the roadmap's release map owns the remainder; the
  named PR delivers it.

Unmarked normative prose describes the intended complete product. This is a
product description and completion contract; the roadmap owns sequencing. By
roadmap decision D5 every capability declared here is in scope, including the
broader audience, leader, fencing, and ownership features; none waits for a
consumer decision.

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

**PLANNED — S1, result stages:** Transport settlement is truthful since the
first release, but the public send result is still an admission snapshot with
statuses such as `enqueued` and `sent-immediate`, and no observable delivery
lifecycle or cancellation exists. S1 replaces it with the delivery handle.

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

**CURRENT — bounded envelope:** The v2 envelope, one decoder, the resource
ceilings in
[`al-message-resource-limits.ts`](../../packages/shared/al-contracts/al-message-resource-limits.ts)
with UTF-8 byte accounting, and validated control payloads exist since the first
release. Authenticated RTC relay provenance remains PARTIAL (S2). The
membership-epoch field is renamed to the group-state roster version it fences on
in R2, with an envelope version bump and explicit rejection of older versions.

**PLANNED — I1, session and trace identity:** Builders do not populate AL
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

**PARTIAL — live trust boundaries:** Server WS decodes envelopes, authorizes
rooms with and without a snapshot floor, and answers with an advisory NACK;
browser RTC and WS decode live messages once at ingress; control payloads are
validated by
[`al-control-value-codec.ts`](../../packages/shared/al-contracts/al-control-value-codec.ts)
before dispatch; unknown controls cannot create pending work. Relay provenance
for far-origin ACKs and the frozen logical audience land in S2.

## Logical audiences

### Unicast

One logical recipient. A transport may route through an authorized next hop,
but only the addressed recipient delivers locally.

**CURRENT** for basic RTC and WS routing.

### Multicast

A scoped `GroupRef` names the logical group. Audience selection uses an
authoritative membership snapshot. A supplied `targets.minSnapshotVersion` prevents a
receiver or relay with stale group state from silently accepting or forwarding.
The origin requires valid current room and routing authority and preserves the
recipient floor on the message; the floor does not raise the origin's own
snapshot requirement. Membership
fencing must use an authoritative membership epoch; its current field and
ordering use do not establish that guarantee. Until that implementation lands,
requests requiring membership fencing are explicitly unsupported. The outcome
identifies the authority snapshot used. For a
reliable send, the logical audience is frozen at admission: joins do not expand
it, and departures do not silently reduce the success requirement.

**PARTIAL:** RTC uses current group peers and overlay next hops when its
group/overlay context resolves; WS has room snapshot authorization with and
without a supplied floor; a message that lacks fresh authority is retained as
pending work and replayed against current authority rather than dropped.

**PLANNED — S2 and R2, frozen audience and fencing:** The logical audience is
not yet frozen at admission and `expectedPeerIds` are physical next hops (S2).
Membership fencing is explicitly rejected as unsupported today; R2 defines it on
group-state's roster version supplied by the sender's snapshot, never on a
caller-invented epoch.

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

**PLANNED — A1, general scope semantics:** The shared planner treats broadcast
as “not excluded,” does not interpret scope/principal/fixed recipients, and the
public builder cannot create principal or fixed-recipient broadcasts. A1 gives
every scope one semantic with RTC and WS parity; world and all take the WS route
automatically when fallback is allowed and are typed carrier-unsupported over
RTC otherwise.

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

**PARTIAL — one fallback lifecycle:** Since the first release the browser
sender reuses one envelope, identity, and deadline for the fallback carrier, and
fallback fires on `no-route` and `circuit-open` within the deadline. Inbound
stores remain carrier-scoped, so a duplicate through the other carrier is not
yet deduplicated (S2), and fallback on a receipt timeout lands with S3.

**PLANNED — F1, conformance contract:** There is no cross-transport suite or
public outcome model proving that the same QoS request has the same meaning on
RTC and WS. F1 adds the conformance lane; every later PR adds its scenario
family.

## QoS negotiation

A message carries a requested policy. The local transport adapter contributes
capabilities, authorization, and live state. ALM produces an effective policy
and a machine-readable list of defaulting, clamping, upgrading, downgrading, or
unmet requirements.

The effective policy is frozen for an admitted attempt or explicitly revised by
a recorded fallback/repair transition. A transport cannot silently claim an
unsupported guarantee.

**PARTIAL:** Normalization and provider hooks exist.

**PLANNED — S3, production providers:** Browser composition does not install
transport-aware capability, authorization, or live-congestion providers; the
default capability set claims every declared algorithm, and `ack: 'receiver'`
normalizes to the transport `hop` algorithm. S3 installs carrier-aware
capabilities and S2 adds the logical `receiver` algorithm.

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

**PLANNED — S1 to S3, truthful at-least-once:** Default browser RTC and WS send
paths still request at-least-once with no ACK. The RTC adapter now preserves the
structured settlement (`sent`, `dropped`, `superseded`, `expired`, `closed`,
`failed`, `cancelled` with `submissionAttempted`) and WS records its outbox
delivery outcome, but neither reaches the caller as a lifecycle. S1 exposes the
lifecycle, S2 makes the receiver receipt real, and S3 sets the reliable,
receipted, volatile default (roadmap decision D2).

**PLANNED — A2, distinct leader and all-recipient ACK:** Both modes currently
map to the same subtree behavior. A2 defines the leader as the group's appointed
director session and S2 defines all-recipient as the frozen logical audience.

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

**CURRENT — bounded gaps:**
[`compute-al-ordering-observation.ts`](../../packages/shared/alm/compute-al-ordering-observation.ts)
applies the 256-sequence repair window and the 256-message, 1 MiB buffered-track
ceilings and returns `resync-required` without enumerating an oversized gap.

**PLANNED — R1, range repair and resync integration:** Repair controls still
carry individual sequence lists; R1 replaces them with compact ranges and pages
and invokes the topic's declared recovery owner with bounded cursor information.

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

**PLANNED — R1, shared arbitration proof:** Since the first release both
admission stores re-read the dedup and supersedence observations inside the
write transaction and return `conflict` when they changed, so two stale
cross-sender reads cannot both win. The cross-backend proof (memory, IndexedDB,
PostgreSQL, A/B stale-read then sequential-commit schedule with one winner) lands
in R1.

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

**PLANNED — S3, integration:** The data-channel settlement now reaches the
outbound runtime as a queued-then-settled result, but production AL QoS still
receives no live backpressure signal and the caller sees no lifecycle. S1
exposes the lifecycle; S3 feeds channel backpressure into policy.

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

Since the first release one fixed-schema database holds the admission store
and the `alm-work` store; the per-session queue databases and their owner are
deleted; the
[session lifecycle](../../packages/shared-web/browser/session/session-auth-lifecycle.ts)
deletes an ended session's entries by key prefix; admission and QueueBox work
commit in one IndexedDB transaction; outbound messages have one canonical
envelope that sent metadata, recipient actions, and repair work reference.

**PLANNED — S3, volatile semantics:** Volatile RTC/WS still persists admission
state and work because the browser selects the IndexedDB backend whenever it is
supported. S3 routes each channel to one backend by its declared durability.

**PLANNED — F2 and I2, bounded IndexedDB and one durable owner:** Seven
`getAll()` call sites remain in the IndexedDB queue box, browser cleanup scans
the whole AL work range before filtering by session, inbound effects still copy
envelopes, and the server still runs two consumers on one work queue (F2). No
reset mechanism, multi-tab claim, quota, or blocked-upgrade outcome exists (F2,
I2).

## Correlation and actions

`corrId` groups a request lifecycle across retries/transports. `replyToMsgId`
links a response to the exact request. A request can register an optional
response schema, expected sender/audience, deadline, and one/many response mode.
Duplicate replies are deduplicated; late replies receive an explicit late/
expired outcome. Correlation identity and trace identity survive fallback and
repair.

**PLANNED — I1, correlation behavior:** The fields are only decoded and
persisted; there is no builder support, matching, timeout, or reply API. I1
puts `corrId` and `replyToMsgId` on the delivery handle with
`awaitReply({ timeoutMs })` and bridges the AppInbox trace id.

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

**PLANNED — R1, complete resync contract:** `resync-required` exists as an
outcome since the first release, but no generic snapshot/cursor recovery owner is
invoked after repair-window exhaustion, and server/client transport parity is
proven only by the conformance lane (F1 onward).

## Ownership

`shared` means every matching local subscriber may observe the message.
`exclusive` means exactly one registered consumer in the declared ownership
scope may claim it. The scope is explicit: local process, browser session,
principal, group, or server consumer group. Durable exclusive claims use leases
and redelivery from existing QueueBox/ResourceInbox; volatile exclusive selection
is deterministic and observable. Distributed ownership reuses the existing
ResourceInbox reservation with lease, expiry, and redelivery; no generic claim
system is added.

**PARTIAL:** Current services use `exclusive` to select one local callback.

**PLANNED — A2, ownership scope:** The contract does not say whether exclusive
is local or distributed, and no distributed exclusive-consumer claim exists. A2
defines `exclusive` as a claim on the message's resource key backed by the
existing ResourceInbox reservation with lease, expiry, and redelivery, surfaced
as `claimed`, `held-by-other`, or `expired`.

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

**PLANNED — F1, S1, and I1, end-to-end observability:** There is no shared
lifecycle event stream, IndexedDB cost telemetry, trace propagation, or
payload-safe logging contract. F1 adds the AL-owned IndexedDB counter and ALM
metrics in the lanes, S1 the lifecycle events, I1 trace propagation and the
payload-free diagnostics contract.

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

**CURRENT — protocol bounds:** The seven ceilings (64 KiB payload, 128-character
route identifier, 128 KiB envelope, 256-entry collection or page, 64 hops,
256-sequence repair window, 256 messages and 1 MiB per ordered track) live in one
contract and apply to live and persisted envelopes and to control payloads.
Aggregate per-session budgets (count, bytes, age, active tracks) land in S3 and
V1.

## Lifecycle and multi-context behavior

AL runtimes have explicit `start`, `ready`, `drain`, and `dispose` semantics.
Dispose fences new admission, releases or expires claims, stops timers, and
does not resurrect work. Multiple tabs coordinate one durable session through
transactional claims and notifications. Volatile work remains tab-local by
definition.

**PARTIAL:** Outbound disposal, inbound runtime, effect worker, and delivery
owner have disposal fences. Tests cover disposal during commit/read and retry
cancellation. Web Locks, versioned commits, and effect leases also exist.

**PLANNED — S1 and I2, complete lifecycle outcomes:** Disposal fences do not
provide the staged caller-visible result model described above (S1), and
multi-tab claims, quota, eviction, blocked upgrades, and restart have no typed
outcomes (I2).

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

**PLANNED — S1, A1, and I1, complete safe surface:** The delivery handle and
channel purpose (S1, S3), principal and fixed-recipient builders (A1), and
correlation and trace builders (I1) are absent. F1 adds
`browser/rallar-messages.ts` as the narrow entry point that carries them.

## Delivery and compatibility posture

The [delivery roadmap](./alm-improvement-plan.md) is staged, with only its next
two independently verifiable slices detailed. Later stages remain expressed as
product outcomes until current evidence justifies their implementation shape.

The approved transition is a coordinated clean cutover. Repository consumers
move with the new surface, obsolete APIs are removed in the same PR, and
incompatible ALM browser storage is deleted on schema mismatch (roadmap
decision D3). ALM never falls back to an obsolete API, migrates incompatible
records, or keeps a compatibility window (decision D8). Every capability in
this document is in scope (decision D5); the roadmap's release map owns the
order, and the two games are changed wherever that proves a capability in a
real UI (decision D4).

## Current validation baseline

The existing B06 three-browser suite exercises `messages.rtc`; its coverage is
anchored by
[`live-rtc-three-browser-coverage.test.ts`](../../packages/tests/rallar-black-box/live-rtc-three-browser-coverage.test.ts).
The current browser workload is a base for extending ALM storage and lifecycle
instrumentation, not evidence that those completion requirements already pass.
The conformance lane (roadmap F1) becomes the acceptance authority: one scenario
catalog run over both carriers in the per-push Playwright lane, the Release
Gate's Postgres lane, and the Hetzner manifests on `main`.

## Product completion criteria

ALM is product-complete when all of the following are true. Every capability is
in scope by roadmap decision D5.

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
7. Every target/ACK mode, including principal, world, all, and fixed audiences
   and the group-leader mode, has one documented semantic proven by the
   conformance lane over both carriers and exercised by one of the two games. A
   guarantee a carrier cannot provide rejects explicitly.
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
