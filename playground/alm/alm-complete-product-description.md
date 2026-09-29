# ALM complete product description

Review date: 2026-09-05

Reviewed source: `a28e61b61` (`main` after PR #521; markers refreshed 2026-09-08, originally
written against `02d65ac4a`)

Related documents: [current implementation audit](./alm-static-audit.md),
[delivery roadmap](./alm-improvement-plan.md),
[persistence and performance QoS plan](./alm-qos-product-plan.md), and
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

**CURRENT — S1, result stages:** `send()` returns a delivery handle before
admission resolves. Its states are `submitted`, `rejected`, `pending-authority`,
`accepted`, `queued`, `transport-accepted`, `acknowledged`, `expired`,
`superseded`, `failed`, `cancelled` and `unobservable`. `cancel()` stops the
remaining owned attempts. The admission-snapshot send result is deleted (D14).

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
before dispatch; unknown controls cannot create pending work. An ACK names the
message's origin and the logical recipient it speaks for (`al.control.ack.v2`,
S2c-i), and RTC peer ingress refuses a room multicast that carries no frozen
audience (S2c-ii).

## Logical audiences

### Unicast

One logical recipient. A transport may route through an authorized next hop,
but only the addressed recipient delivers locally.

**CURRENT** for basic RTC and WS routing. **CURRENT — S3c-i, addressed WS sends:** a unicast may name its room; the
room's authority admits it and the room's router delivers it, and a `receiver` unicast's receipt is its addressee's
own ACK, aggregated by the server over one member (D53, D71). A client addresses the server itself with a unicast to
the server peer id `/api/config` names; the server's own ACK is that receipt, meaning the server admitted the
message, not that the application applied it (D76). **CURRENT — S3c-ii, addressed sends on every carrier:** a typed
send names one peer with `{ peerId }`; on RTC the unicast travels directly to its addressee and is never relayed,
and on `rtc-with-ws-fallback` it is handed to WS inside the deadline (D75). A send to the server peer id travels WS
only. `ws-then-rtc` does not take a peer (V1).

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

**CURRENT — S2, frozen audience:** A room multicast's logical audience is frozen
at admission on both carriers and travels with the message as `recipientPeerIds`
at the room's `snapshotVersion`: the RTC origin freezes it from the sessions its
room authority admits, the WS server at its admission stamp, and a message that
falls back from RTC to WS keeps its frozen set narrowed to what the server
authorizes. A `receiver` receipt expects exactly that audience; joins do not widen
it, and a session that leaves stays expected and reads unconfirmed.

**PLANNED — R2, fencing:** Membership fencing is explicitly rejected as
unsupported today; R2 defines it on group-state's roster version supplied by the
sender's snapshot, never on a caller-invented epoch.

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
- A transport switch preserves expiry, correlation, and trace identity; ordering and
  supersedence tracks are per carrier runtime, so a message handed to another carrier leaves its
  track on the first.

**CURRENT:** Both RTC and WS use the AL envelope and core admission runtimes.

**CURRENT — one fallback lifecycle (S3b):** the browser sender reuses one envelope, identity, and
deadline for the fallback carrier. At admission it falls back on every `unroutable` reason (`no-route`,
`circuit-open`, `rate-limited`) and on `refused/unsupported`. After admission an `rtc-with-ws-fallback`
message whose RTC leg settles `not-ready` three times in a row, spends its `not-yet-in-sync` budget or runs
out of receipt retries is handed to WS once, inside its unchanged deadline: the RTC owner ends its work
without a `cancelled`, the same envelope is admitted on WS, and the handle records a `carrier-fallback`
evidence row; receipts of the left carrier no longer move the handle (D56, D63–D66). One inbound store
per session is shared by both carriers (D20, D54), so the second copy meets its first admission, and
every member of the frozen audience, relay or leaf, sends its own ACK again over WS: the receipt the WS
leg needs (R-S3b-1, R-S3b-21). Limits:
`ws-then-rtc` falls back at admission only, and a durable RTC message resumed after a reload has no handle
and never hands over (D64).

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

**CURRENT — S3a, the purpose table and carrier capabilities:** A typed channel
declares `purpose: 'command' | 'notification'` (required), and the purpose table
in `al-contracts`
([`AL_CHANNEL_SEND_DEFAULTS`](../../packages/shared/al-contracts/resolve-al-channel-send-defaults.ts))
fixes the channel's send defaults (D52):

| Purpose        | Reliability     | Ack                      | Deadline | Durability |
| -------------- | --------------- | ------------------------ | -------- | ---------- |
| `command`      | `at-least-once` | `receiver`               | 30 s     | `volatile` |
| `notification` | `at-least-once` | `all-logical-recipients` | 30 s     | `volatile` |

The two acks are one frozen-audience algorithm (D41). A `world` or `all`
broadcast names no logical audience, so it keeps `ack: 'none'` until A1. The
2-second ACK timeout and three receipt retries are the at-least-once
normalization defaults these fields select. A channel may declare `durability`,
and a send may override each field, durability through `qos.durability`. `realtime` is refused at a typed channel and
the colliding `'realtime'` typed-send strategy is retired. Each carrier — the WS
client, the RTC overlay and the WS server — owns its capability declaration
([`al-carrier-capabilities.ts`](../../packages/shared/al-contracts/al-carrier-capabilities.ts):
the default set plus `receiver`), and its composition root installs it under the
application's QoS provider, whose own capabilities override the carrier's. The
`unsupported` ack refusal reads the carrier's own declaration.

**PARTIAL — S3c-ii, the first live provider:** the browser installs a
per-session QoS provider that reports `overloaded` while the session's volatile
budget is at or over a limit (D78). Under the default policy that drops
best-effort RTC sends and best-effort arrivals on both carriers, never an
at-least-once message; the WS outbound path does not consult it. Transport-aware
authorization, the other budgets and fairness are V1's.

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
once their obligation is terminal. A receipt whose retry budget runs out, or that a hop refuses for good,
ends the message `failed` with a `receipt-exhausted` settlement that keeps the confirmed and unconfirmed
recipients; on `rtc-with-ws-fallback` inside the deadline it hands the message to WS instead (D63).

The default is receipted. An explicit at-least-once request with `ack: 'none'`
retries without a receipt: S3a removed the default of that shape and adds no
validation, because the receipt-less RTC carry relies on an explicit shape (S3a
ruling 6; the director relay's WS unicast is gone since S3c-ii). A per-send
`reliability: 'best-effort'` that names no `ack` resolves `ack: 'none'`, since a
receipted best-effort send is a contradiction; with an explicit `ack` the
caller's ack wins (R-S3a-2). A WebSocket frame accepted by the browser API or an
RTC payload accepted by `RTCDataChannel.send` is not a logical delivery receipt.
A director command can reach the director twice after a fallback, because AL
dedup is per carrier lane: relay commands are at-least-once, and the game's
sequence tracker refuses the copy (S3c-ii, R-S3c-ii-4). The relay reports a
command `sent` only when the director's receipt arrives, waiting at most 30 s,
and a refused command is a `failed` result.

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
Since S2 `receiver` and `all-logical-recipients` are one logical algorithm over
the frozen audience on both carriers: the WS server answers the origin with its
receipt (`al.control.receipt.v1`), RTC relays forward each recipient's ACK toward
the origin, an RTC retry goes only through the hops that may still lead to a
missing recipient, and the handle carries the expected, confirmed and unconfirmed
recipients beside the hop lists. A WS live-only room topic keeps no copy to
retry, so its receipt ends timed out naming the recipients it did not confirm.
Durable replay rechecks snapshot readiness, preserves predecessor order, and
ACKs the admitted upstream relay. Current coverage includes
[durable replay](../../packages/tests/shared/multicast/rtc-snapshot-durable-replay.test.ts),
[room snapshot admission](../../packages/tests/shared/multicast/rtc-room-snapshot-admission.test.ts),
and [snapshot-floor admission](../../packages/tests/shared/rtc-snapshot-floor-admission.test.ts).

**CURRENT — S3a, truthful at-least-once:** A typed send with no options is
at-least-once, receipted and volatile (D2): its channel's purpose picks the
receipt, and the handle's `receiptAlgo` is the receipt its admitting carrier
tracks. A WS room send asking `hop` or `subtree`, which the WS client does not
track, ends terminal at `transport-accepted` with the downgrade in the handle's
evidence (R-S3a-4); the WS server's hop ACK as a real receipt is S3b's (D56).
Durability is decoupled from reliability, so a lane send (`messages.rtc.send`,
`messages.ws.send`) that names no durability is volatile too; CRDT sync keeps its
own HTTP/WS catch-up.

**CURRENT — S3c-i, the WS hop receipt:** when the server names its peer id, a WS `hop` or `subtree` send tracks the
server as its one hop, so it is receipted by the server's own ACK and no longer ends at `transport-accepted` with a
downgrade (R-S3a-4 closed). The
server's own room notifications carry `receiver` receipts over the room's live sessions frozen at publish, and cluster
delivery honours that audience (D58, D77).

**PLANNED — A2, distinct leader ACK:** `group-leader` still maps to the subtree
behavior; all-recipient is the frozen logical audience since S2. A2 defines the
leader as the group's appointed director session.

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

**PLANNED — I2a, dedup retention:** The default dedup window is a fixed 60 s
that ignores the message deadline. A replay of a longer-lived message that
arrives after 60 s is therefore admitted again. I2a makes the retention at least
the deadline plus the receipt grace for every durability tier (D85).

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

**PARTIAL — S3c-ii:** the caller sees the lifecycle (S1) and the session's
volatile budget is the first `overloaded` producer (D78). Channel backpressure
as a policy input is V1's.

## Durability and browser-local storage

Durability has observable meaning:

- `volatile`: bounded memory only; lost on process/tab termination;
- `local-checkpoint`: the sender admits and dispatches from memory and
  checkpoints its recoverable state; after a restart it resumes from the last
  checkpoint, may lose admissions made after it and repeats work finished after
  it;
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

**CURRENT — S3a, volatile semantics:** Each browser outbound carrier runtime
holds a memory and an IndexedDB store pair, and the session's inbound store keeps
one pair per backend shared by both carriers (D54). An outbound admission goes to
the pair its effective durability names; an inbound message goes to IndexedDB
only when the sender's channel declared `local-inbox`, carried on the envelope.
The memory pair is its runtime's own: session cleanup and a storage reset never
reach it, and each lane over it evicts its expired rows on its own work round, at
most once a minute, with no timer. The volatile proof (D55) is zero `al-admission`
and zero non-probe `al-work` IndexedDB operations: a unit pin per direction, and
the `volatile-default` conformance scenario on both pages of every carrier over a
reset window, with the durable owners' idle probes (`work-page`, `work-probe`)
reported beside the zero. The `durable-opt-in` scenario shows the opt-in pays for
storage; one durable send still spends 10 `al-admission` and 15 `al-work`
operations, and the storage snapshot's durable figures are unchanged while the
volatile default adds 0 rows. A volatile admission reads no IndexedDB and takes no
Web Lock, so it completes within the caller's microtask turn: a burst loop of
awaited volatile sends yields no task turn until it ends and should yield or
batch (R-S3a-7). A literal total zero (lazy owner start and stop) is I2a's; the
volatile store's per-session count and byte bound is S3c's (D59).

The tiers are ordered by strength: `volatile` < `local-checkpoint` <
`local-outbox` < `local-inbox`. When a store cannot honour a channel's tier, the
send is refused typed `storage-unavailable` or, where the channel allows it,
degraded to `volatile` with a note on the handle. It is never weakened silently.

**PLANNED — P1, I2a, and I2b, the storage tiers:**

- P1 lowers the durable tiers' pinned storage cost without weakening them. Today
  a durable send spends 10 `al-admission` and 15 `al-work` operations, and a
  durable inbound admission spends 8. The first levers are taking the Temporal
  polyfill off the storage hot path and cutting a durable send's 14 sequential
  transactions (D90).
- I2a gives every durable tier one owner per session store across tabs. It
  replaces today's silent memory fallback when IndexedDB is missing with the
  typed outcome, and adds typed recovery outcomes and one storage-health
  vocabulary.
- I2b adds `local-checkpoint` behind the D89 gate.

The [persistence and performance QoS plan](./alm-qos-product-plan.md) holds the
contract and its evidence.

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
Full RTC envelopes are no longer logged by the receive service. The WS server records, per process and for its 256
most recently updated receipted messages, who confirmed each receipt and whether it ran out, on
`/api/admin/operations/realtime` (S3c-i, D61, D73). A failed delivery states a typed `evidence.failure` beside its prose
reason: the refusal reason, the unroutable reason, or whether a receipt ran out of budget or was refused by a hop
(S3c-ii, D75).

**PLANNED — F1, S1, and I1, end-to-end observability:** There is no shared
lifecycle event stream, IndexedDB cost telemetry, trace propagation, or
payload-safe logging contract. F1 adds the AL-owned IndexedDB counter and ALM
metrics in the lanes, S1 the lifecycle events, I1 trace propagation and the
payload-free diagnostics contract.

**PLANNED — I2a, storage health:** In production the storage-reset sink does
nothing, and no storage-health or recovery event exists. I2a puts the following
on the public diagnostics sink:

- storage health: `healthy`, `delayed` or `failing`;
- the age of the oldest unsaved change;
- the last saved recovery point;
- the typed recovery outcomes.

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

**CURRENT — S3c-ii, the volatile bound:** one session holds at most 1 000
volatile messages and 4 MiB of envelopes at a time, sent and received together.
A sent message is counted until its deadline, a received one until the earlier
of its deadline and 30 s after its arrival; a message whose sender named no
deadline is not counted. Over the bound the next send is refused `capacity`, and
a received message is counted, never refused (D74, D78). The bound is shared
with the platform's own state sync received on the volatile pair: a lane agent
that leaves and rejoins a room holds about 26 KB of it, under one per cent of
the production limits (R-S3c-ii-6, R-S3c-ii-7).

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

**PLANNED — P1 and I2b, storage budgets:** Each durability tier has a recorded
storage budget (D87):

- no storage operation on the send path for `volatile` and `local-checkpoint`;
- at most one readwrite transaction per checkpoint, and none while the lane is
  clean;
- durable pins that may only fall.

## Lifecycle and multi-context behavior

AL runtimes have explicit `start`, `ready`, `drain`, and `dispose` semantics.
Dispose fences new admission, releases or expires claims, stops timers, and
does not resurrect work. Multiple tabs coordinate one durable session through
transactional claims and notifications. Volatile work remains tab-local by
definition.

**PARTIAL:** Outbound disposal, inbound runtime, effect worker, and delivery
owner have disposal fences. Tests cover disposal during commit/read and retry
cancellation. Web Locks, versioned commits, and effect leases also exist.

**PLANNED — I2a, complete lifecycle outcomes:** Multi-tab claims, quota,
eviction, blocked upgrades, and restart have no typed outcomes:

- a browser without IndexedDB silently gets memory stores for its durable pairs;
- login over an existing session leaves the old session's rows until they
  expire.

I2a adds one durable owner per session store, the typed `storage-unavailable`
outcome, the recovery outcomes, and one purge across memory, storage, and
checkpoint.

## Public product surface

The public ALM surface provides:

- safe builders for each supported target mode, action/correlation, trace/session,
  delivery policy, expiry, ordering, and supersedence option;
- the bounded envelope/control decoder;
- typed topic registration and payload decode hooks;
- send with staged lifecycle observation/cancellation;
- receive subscription with ownership scope;
- transport/effective-policy diagnostics;
- an explicit durability tier per channel and send (`volatile`,
  `local-checkpoint`, `local-outbox`, `local-inbox`), the channel's
  storage-unavailable policy, and per-store persistence settings;
- explicit protocol/capability descriptions and typed unsupported results; no migration framework.

**PARTIAL:** Basic builders, policy/runtime types, services, and canonical
browser/server factories are exported. The canonical factories now construct
admission stores only, and unused legacy hydration is gone from those factory
paths; legacy exports/classes remain. The current outbound owner map is
documented in
[`alm/outbound/README.md`](../../packages/shared/alm/outbound/README.md).

**PLANNED — A1, I1, I2a, and I2b, complete safe surface:** The delivery handle
(S1) and the channel purpose (S3a) exist. They are exported by
`browser/rallar-messages.ts`, the narrow entry point F1 added. Four parts are
absent:

- principal and fixed-recipient builders (A1);
- correlation and trace builders (I1);
- the channel's storage-unavailable policy (I2a);
- `local-checkpoint` with its per-store settings (I2b).

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
   common path, including reliable volatile policy when selected, and a
   `local-checkpoint` send performs none on its send path.
5. Durable messages have one existing QueueBox/ResourceInbox work owner and bounded indexed queries;
   transaction/row/byte budgets do not grow with unrelated messages or old
   sessions, and each durability tier meets its recorded storage budget.
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
    restart are deterministic and externally observable. Recovery reports its
    outcome and freshness, and no tier degrades without a typed outcome or a
    note on the handle.

## Complete-product summary

The complete ALM product is one semantic protocol with two first-class carrier
adapters. RTC remains fast because volatile traffic is not forced through
IndexedDB and because data-channel backpressure is a protocol outcome. WS remains
authoritative and durable where required. Durable RTC and WS share bounded,
indexed QueueBox/ResourceInbox execution and ALM policy/validation. Each
durability tier has a recorded, falling storage budget. A channel chooses its
tier by the loss and replay it can accept. Every supported
contract field has a runtime owner, every promised receipt has observable evidence,
and preferred capabilities can negotiate without silently downgrading required
guarantees. Normal uncertainty leads to bounded recovery and useful progress.
