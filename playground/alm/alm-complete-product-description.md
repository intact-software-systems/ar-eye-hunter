# ALM complete product description

Date: 2026-08-29

Status markers in this document describe the current implementation:

- **CURRENT** — the capability exists end to end.
- **PARTIAL** — important behavior exists, but the product guarantee is not
  complete or is transport-specific.
- **MISSING TODAY** — the contract declares the capability or the complete
  product requires it, but the current implementation has no dependable
  end-to-end behavior.

This is a product description and completion contract, not an implementation
plan.

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

1. `rejected` — malformed, unauthorized, unsupported, expired, over budget, or
   has no valid route.
2. `accepted` — admitted under an explicit effective policy.
3. `queued` — durable transport work exists and survives the promised failure
   boundary.
4. `transport-accepted` — RTC/WS accepted the bytes; this is not yet logical
   delivery.
5. `acknowledged` — the requested receiver/hop/subtree/leader audience confirmed.
6. `expired`, `superseded`, `failed`, or `cancelled` — terminal without the
   requested acknowledgement.

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

**PARTIAL — compatibility:** The v2 envelope and strict persisted decoder exist.
The safe decoder is not universal on live/browser boundaries, and size/count
bounds are incomplete.

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

Transport identity is authoritative. An RTC envelope sender must equal the
authenticated peer for that channel. A browser WS sender receives only server-
validated envelopes. Server WS binds sender to the authenticated connection or
an explicitly authorized server/system identity. ACK/NACK/repair payload
identities must agree with the envelope, target, transport peer, and tracked
message audience.

Domain topic registries add payload schema, maximum size, authority, scope,
fanout, and allowed QoS. Unknown topics follow an explicit deny/allow policy;
room-scoped traffic fails closed without a current authoritative room snapshot.

**PARTIAL — server trust boundary:** Server WS has envelope decoding and room
authorization.

**MISSING TODAY — browser trust boundary:** Browser RTC/WS currently cast live
objects. RTC sender mismatch is only a warning, and control payloads use unchecked
casts.

## Logical audiences

### Unicast

One logical recipient. A transport may route through an authorized next hop,
but only the addressed recipient delivers locally.

**CURRENT** for basic RTC and WS routing.

### Multicast

A scoped `GroupRef` names the logical group. Audience selection uses an
authoritative membership snapshot. `membershipEpoch` fences obsolete membership
views; `minSnapshotVersion` prevents a node with stale group state from silently
routing or accepting. The outcome identifies the snapshot/epoch used.

**PARTIAL:** RTC uses current group peers and overlay next hops when its
group/overlay context resolves; WS has room snapshot authorization.

**MISSING TODAY — RTC room authorization:** If RTC cannot resolve the targeted
group/overlay, planning continues without membership and treats the absent set
as permission for local delivery. Missing, stale, mismatched, or removed
authority state must instead fail closed before delivery, forwarding, ACK,
repair, or control mutation.

**MISSING TODAY — RTC fencing:** RTC accepts the fields but does not compare
`membershipEpoch` or `minSnapshotVersion` to the current group/topology state.

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
acknowledgement obligation, attempt history, or terminal outcome.

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

**PARTIAL:** Normalization and provider hooks exist and are well unit-tested.

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

An at-least-once request with `ack: none` is invalid unless the selected
transport/topic defines an equivalent authoritative receipt. A WebSocket frame
accepted by the browser API or an RTC payload accepted by `RTCDataChannel.send`
is not a logical delivery receipt.

### Acknowledgement modes

- `none`: no logical receipt; valid for best-effort only by default.
- `receiver`: the logical receiver confirms admission/delivery.
- `all-logical-recipients`: every member of the frozen audience confirms, or
  expiry produces a partial/failure outcome.
- `group-leader`: the authoritative leader for the admitted epoch confirms;
  leader identity and succession are explicit.

**PARTIAL:** Hop/subtree tracking, durable ACK timeout, NACK, and repair exist.

**MISSING TODAY — truthful at-least-once:** Default browser RTC and WS send paths
request at-least-once with no ACK. WS submission is not a logical receipt, and
the RTC adapter additionally ignores dropped/queued/replaced send results.

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

**CURRENT:** Ordering tracks include key/sender/epoch; gap buffering, NACK/
repair, release, expiry, and restart behavior exist.

**MISSING TODAY — bounded gaps:** Missing sequences are enumerated individually
with no maximum gap/window, allowing unbounded CPU, memory, control payload, and
effect-ID work.

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
even when a dedup/supersedence key is cross-sender.

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

Browser durability uses a fixed schema, not per-session object stores. Indexed
queries are bounded by queue/namespace and due/expiry range. One canonical
record owns durable work; related state references it instead of copying the
full envelope. Ended sessions are purged by indexed range. Quota, eviction,
blocked upgrades, and transaction aborts yield explicit outcomes and safe
downgrade rules.

**PARTIAL:** Atomic admission/effect commit, leases, retries, expiry, idempotent
effect IDs, and restart replay are implemented.

**MISSING TODAY — volatile semantics:** Volatile RTC/WS still persists admission
state and durable effects.

**MISSING TODAY — bounded IndexedDB:** AL prefix reads scan a shared unindexed
store; default durable RTC traverses admission and QueueBox persistence; QueueBox
uses permanent per-session object stores and polling scans.

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
and redelivery; volatile exclusive selection is deterministic and observable.

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

**MISSING TODAY — end-to-end observability:** There is no shared lifecycle event
stream, IndexedDB cost telemetry, trace propagation, or payload-safe logging
contract; RTC currently logs complete received envelopes.

## Resource and abuse limits

The protocol publishes limits for:

- total envelope and payload bytes;
- identifier and correlation string bytes;
- next hops, recipients, exclusions, visited peers, ACKs, and controls;
- fanout and hop TTL;
- ordering gap, buffered messages/bytes, and repair range/page count;
- retries, repairs, acknowledgement deadline, and retention;
- per-topic/per-sender rate, concurrent work, and storage bytes.

Limit violations fail before expensive allocation or persistence and expose a
stable reason code.

**MISSING TODAY — complete bounds:** Payload input validation exists but is not
called by AL builders, persisted/live envelope validation does not impose the
full resource budget, and ordering gaps are unbounded.

## Lifecycle and multi-context behavior

AL runtimes have explicit `start`, `ready`, `drain`, and `dispose` semantics.
Dispose fences new admission, releases or expires claims, stops timers, and
does not resurrect work. Multiple tabs coordinate one durable session through
transactional claims and notifications. Volatile work remains tab-local by
definition.

**PARTIAL:** Outbound dispose fencing, Web Locks, versioned commits, and effect
leases exist.

**MISSING TODAY — inbound disposal:** Inbound dispose only clears its current
timer and does not fence later admission/effect scheduling.

## Public product surface

The public ALM surface provides:

- safe builders for every target mode, action/correlation, trace/session,
  delivery policy, expiry, ordering, and supersedence option;
- the bounded envelope/control decoder;
- typed topic registration and payload decode hooks;
- send with staged lifecycle observation/cancellation;
- receive subscription with ownership scope;
- transport/effective-policy diagnostics;
- explicit volatile/durable storage policy;
- migration/version capability introspection.

**PARTIAL:** Basic builders, policy/runtime types, and services are exported.

**MISSING TODAY — complete safe surface:** Principal/fixed-recipient/correlation/
trace builders are absent, builders bypass `assertValidALMessageInput`, and the
complete persisted-envelope decoder is not exported from `packages/shared/mod.ts`.

## Product completion criteria

ALM is product-complete when all of the following are true:

1. The same scenario suite runs over RTC and WS and produces equivalent logical
   admission, ordering, reliability, ACK, repair, expiry, and terminal outcomes.
2. Every live/persisted envelope and control message is bounded, decoded, and
   identity-bound before state mutation.
3. At-least-once cannot be selected without an effective receipt strategy, and
   data-channel drops cannot be reported as successful sends.
4. Volatile best-effort RTC performs zero IndexedDB work on the common path.
5. Durable messages have one canonical work owner and bounded indexed queries;
   transaction/row/byte budgets do not grow with unrelated messages or old
   sessions.
6. Room multicast fails closed without an authoritative matching group snapshot
   and honors membership epoch and minimum snapshot version on both transports.
7. Every target/ACK mode has one documented, tested semantic, including
   principal/world/fixed audiences and group leader.
8. Ordering, diagnostic, control, retry, repair, and storage work is bounded and
   has clean resync/terminal behavior.
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
indexed admission/repair machinery, not duplicated queue state. Every declared
contract field has a runtime owner, every guarantee has an observable receipt,
and unsupported guarantees are rejected or explicitly downgraded rather than
silently approximated.
