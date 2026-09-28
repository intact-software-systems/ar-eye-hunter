# Cluster Live WebSocket Delivery Design

Approved by the maintainer on 2026-09-27 for implementation in draft PR #566.

## Problem and scope

An admitted inbound WS message is dispatched by one worker in a shared Postgres
cluster, but socket connections are process-local. A worker on process B can
complete `dispatch-local` while all addressed sockets are on process A. In the
failed three-process API-v1 recipes, the receiving WS connections opened on
the primary process, while the tertiary process logged `no recipients` for
`room.match` and `room.crdt` inside the respective failed-send windows. This
shows a non-socket-owning process attempted local fanout for those topics and
strongly supports the cluster-gap diagnosis. The warnings do not carry message
IDs, so they do not prove that these were the exact failed sends or explain why
this branch changed which process claimed the work. The fix covers
**all** `live-only` WS publications: admitted inbound traffic, proxy/handler
replies, and server-generated messages. It must
not run router handlers or authoritative mutations on every subscriber.

The existing `QueueBoxPubSubBridge` publishes `WS_OUTBOX` keys. It does not
publish `live-only` messages. The current `live-only` branch calls a local
`sendToTargetsWithResult`; neither a healthy QueueBox nor Postgres pub/sub
alone changes that call's process-local reach.

## Selected delivery semantics for implementation review

`fanout` and effective AL QoS are independent. A server-generated game/AI
message can request `at-least-once` and still select `live-only`; a generic
`outbox` selection need not persist a row when the effective durability/retry
policy says not to. Route by the **effective** policy and reject incompatible
combinations (including at-least-once without durable outbound work)
explicitly, rather than silently upgrading or downgrading QoS.

| Effective intent                                           | Cluster carrier                                                                                                 | Receiver behavior                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Best-effort, volatile, no retry                            | One Postgres notification after the sole publisher has finalized the message and its applicable audience policy | Every listening process attempts one direct send to its own eligible open sockets. Room and explicit-peer recipients are fixed at publication; broad `all`/`world` recipients are selected locally when the notice arrives. No receiving QueueBox/inbox row, polling, replay, delivery retry, or handler invocation. |
| At-least-once or otherwise requiring durable outbound work | Existing canonical `WS_OUTBOX` row and its key notification                                                     | Use existing retry/receipt ownership. Remote sends must obey the row's frozen admitted audience, including absent/late sessions.                                                                                                                                                                                     |
| `none`                                                     | No cluster publication                                                                                          | Existing handler-only behavior.                                                                                                                                                                                                                                                                                      |

The publisher must finish admission, authorization, transformation, and expiry
checks once before announcing the final message. For room-scoped,
principal-scoped, and explicit-peer sends, it also freezes authorized addressed session IDs; the
notice carries or identifies that final message and audience, not a room name
to re-resolve later. For broad `all`/`world` best-effort broadcasts, the
notice instead identifies that target mode and each subscriber uses its
existing local target resolver at notice receipt. A socket that
opens in the short publication-to-receipt interval can therefore receive a
broad broadcast. This is accepted best-effort timing behavior, not a frozen
membership promise. Subscribers validate notice version, source, applicable
scope, deadline, targets, and the audience mode. They never execute a topic handler,
proxy, RTC/RTT mutation, admission decision, or database inbox processing. A lost
notification or disconnected listener can lose best-effort delivery. A failed
`NOTIFY` is reported; it is not treated as successful delivery. Retries of the
upstream shared `dispatch-local` effect can re-publish; best-effort is **not**
an exactly-once promise.

Placement review found that `all`/`world` targets do not carry a
`GroupScope`; in particular, the public AI broad publisher has no
application/workspace reference. A broad notice therefore carries its exact
target mode but no invented application/workspace scope. Scoped room,
principal, and peer notices still require an explicit full scope and
send-time connection validation. This discriminant preserves the current
broad-target semantics without treating a placeholder as authority.

For example, process A publishes a broad best-effort message at 10:00:00.000.
A socket opens on process B at 10:00:00.002, and B receives the notification
at 10:00:00.004. That socket may receive the message because it is locally
eligible when B handles the notice. If this were a room message, the socket
would not be added to the publisher's already-frozen room audience. This is a
millisecond-scale boundary choice, not evidence of an additional handler run
or a security issue when the normal scope checks hold.

For best-effort publication, the public result cannot claim a global
`sentCount` or `no-recipients`: a publisher sees only its local socket attempts.
Expose a `cluster-published` status distinct from observed local sends;
it means that publication succeeded, not that remote sockets received the
message. Retain a local-only result only where the caller explicitly requests
local delivery. Callers/tests that use `sentCount` must be audited. The
maintainer approved this public-result change; it is not an internal refactor.

## Size recommendation

PostgreSQL `NOTIFY` has a payload limit below 8,000 bytes; this repository's
bridge already rejects serialized notices at `>= 8_000` bytes. The normal WS
message payload default is 64 KiB, and the envelope plus a large audience can
exceed the notification budget even when the message body does not. Therefore:

1. Measure the **serialized UTF-8 notice**, including message, audience, and
   metadata. Do not advertise an 8 KiB _message_ limit or guess from character
   count. Preserve the existing `<8,000`-byte wire bound: a 7,999-byte notice
   is accepted and an 8,000-byte notice is not sent inline. Tests cover the
   exact boundary.
2. For an admitted inbound best-effort room message that exceeds the inline
   budget, notify by a small key and read the already-retained canonical
   inbound delivery surface on each receiver. The read returns the final
   message with its full `groupRef` and the persisted source with frozen
   `groupRecipientPeerIds`, so a large audience need not be copied into the
   notice. Broad `all`/`world` key reads retain their receipt-time
   local-audience policy.
   This is a read-only carrier lookup, **not** a receiver inbox or a new
   durable-delivery promise. Publish after admission commits; a
   missing/expired row is an observable best-effort miss.
3. The current canonical inbound source does not prove a frozen principal
   audience or the recipient scope for unicast. A key-only notice cannot
   supply its own authority. Until an independently approved persisted proof
   exists, an oversized principal or unicast publication must be refused
   explicitly rather than accepted for a receiver that must drop it. Their
   ordinary inline form remains supported.
4. A server-generated/proxy-created best-effort publication may have no
   canonical inbound row. For the first implementation, reject an oversized
   publication with a typed result/error before claiming success. The caller
   may _explicitly_ choose at-least-once/outbox if that is its intended QoS.
   Never silently persist or upgrade it. The maintainer approved this
   compatibility limit for the first implementation.
5. If that limit is unacceptable, design a separately reviewed large-message
   carrier before implementation. A temporary payload table would be a new
   storage/retention boundary, not merely a larger `NOTIFY`; fragmentation
   would need ordering, loss, and memory bounds. Neither is authorized here.

This approach preserves the 64 KiB inbound room-message allowance while making
the limits on generated, proxy, and other unproven oversized best-effort
messages explicit.
The single-process in-memory and deliberately disabled pub/sub modes also need
explicit behavior: local sockets keep working; the disabled mode must not claim
cluster publication.

## Acceptance and non-goals

- Three API processes sharing Postgres deliver to a socket connected to a
  different process from the sole inbound claimant; the same run covers
  server-generated and proxy replies, and no handler runs twice.
- A late room joiner, unauthorized session, wrong room/application scope,
  expired message, malformed notice, or publisher's own duplicate receive
  causes no extra room/explicit-peer socket delivery. Broad `all`/`world`
  delivery uses locally eligible open sockets when the notice arrives, so a
  just-opened socket may receive it. A disconnected listener is a legitimate
  best-effort miss; at-least-once follows existing outbox retry behavior.
- The relevant API-v1 WS topic, social app-data, CRDT exemption, room isolation,
  and game/realtime tests pass without weakening their workload or deadlines.
- No new library, receiving inbox/queue, retry/fence/lock/timer, migration, or
  legacy path. The existing notification and QueueBox infrastructure remains
  the only cluster carrier. Performance is measured rather than inferred from
  the absence of a receiving write.

The placement of the live cluster publisher, its notice codec, and the
application wiring follows the ownership map in the accompanying approved
plan. This design fixes behavior and boundaries; implementation still chooses
the smallest interfaces consistent with that map.

## Ownership and audience questions found during code review

The current Postgres adapter validates every publication with the
`WS_OUTBOX`-only `decodeQueueBoxPubSubMessage`. Its bridge interface also accepts
only that outbox notice. Live notices therefore need a distinct typed transport
port and codec over the existing database notification connection; merely
adding a `live-only` case to the router cannot make the existing bridge carry
it. Keep the outbox key codec's meaning unchanged.

The admitted inbound `route()` call can pass its captured room audience and
`groupRecipientPeerIds` to `publishToFanout`. In contrast, `publish()` and
proxy `toTargets`/`toPeer`/`toRoom`/`toAll` currently call it without an
audience. A room or principal publication needs a publisher-side authoritative snapshot
of its final targets; a unicast names its peer directly but that ID does not
establish the recipient's application/workspace. The maintainer approved
requiring an explicit full scope at public generic unicast and proxy `toPeer`
publication boundaries, updating verified callers, and deleting the old
unscoped form without an overload. An inbound generic unicast also needs
authoritative recipient-scope proof; an unscoped persisted source is not such
proof and must fail closed. The approved persisted representation captures
authenticated group scope in new WS inbound Source records and explicit public
unicast scope in outbound sent policy for durable replay. Old rows lacking
required proof fail closed without a historical migration, AL wire-target
change, or legacy overload. A proxy may transform
targets after inbound authorization, so it cannot inherit that old audience
without rechecking the final scope. For broad `all`/`world` sends, the
maintainer selected subscriber-local eligibility at notice receipt instead
of a cluster-wide frozen list. The notice must distinguish these modes;
absence of a room audience is never permission to re-resolve a room.

The local `sendToTargetsWithResult(message, recipientSessionIds)` path uses
those explicit IDs and open sockets directly; it bypasses the normal local
target resolver. A cluster receiver using this path must receive a validated,
publisher-authorized list whose scope is bound to the final message, not just
an untrusted list of session IDs. The game publisher also maps the router's
result to its own send result. The reviewed game/Relic sub-slice now maps an
observed `sent-live` to `sent`, `queued-outbox` to `accepted`, and
skipped/duplicate/superseded outcomes to `skipped` without incrementing
publication counts. A new cluster-accepted status must update that exhaustive
consumer and describe publication, not an unobservable global socket-send
count.

The current client room authorizer calls `canSendGroupMessage` with the
message's sender ID as an actor session. It cannot be reused unchanged for a
trusted server-generated room snapshot: Relic's publisher, for example, uses a
server sender ID rather than a room-member session. The publisher needs a
separate authoritative room-audience read that checks the final `GroupRef` and
freezes eligible member sessions without pretending the server is a client
member. A proxy whose final targets differ from its inbound message still
needs authorization against those final targets; it does not inherit the
trusted-server path merely because it runs inside a handler.

Relic's current snapshot publication supplies only `roomId` to
`newALBroadcastMessage`, so its room target has no `groupRef`. The current
scoped room target resolver returns no recipients in that case. Its embedded
server already uses the API-v1 default application and workspace for room
policy reads, so it can construct the full `GroupRef` at publication without
changing the persisted game state. Generic Rallar Game server snapshot/event
publication inputs also make `roomRef` optional. The maintainer approved making
their `roomRef` mandatory, updating every affected caller, and deleting the
optional form without a compatibility overload or fallback. Require the full
`GroupRef` even when the publication selects one peer: that keeps room context
explicit at the single public input boundary. Inbound command/sync handlers
must reject a missing authorised `roomRef` before calling application command
or snapshot handlers, so they cannot mutate truth and then discover they
cannot publish the result. They must not invent application/workspace scope
from `roomId`. Relic's known default scope can supply the full reference at
its publication call. A cluster
notice must never treat a bare room ID as authority for a scoped room audience.

An authenticated WebSocket upgrade records application/workspace scope and
connection generation in API-v1's authorised-connection registry, but
`JsonWebSocketServer.connections` is keyed only by session ID. The same issued
session may reconnect in another scope, replacing its local socket while an
older room publication is in flight. Direct delivery of a frozen room audience
must compare the currently open socket's registered scope and generation with
the notice's room scope before sending. Missing or mismatched local facts mean
no local recipient; they do not cause reauthorization, a receiver inbox, a
retry, or a new delivery fence. This preserves the frozen publication audience
while preventing a same-ID connection in another scope from receiving it.
