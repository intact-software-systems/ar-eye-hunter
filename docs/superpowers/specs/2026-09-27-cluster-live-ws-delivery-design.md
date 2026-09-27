# Cluster Live WebSocket Delivery Design (proposed)

## Problem and scope

An admitted inbound WS message is dispatched by one worker in a shared Postgres
cluster, but socket connections are process-local. A worker on process B can
complete `dispatch-local` while all addressed sockets are on process A. The
observed three-process API-v1 black-box failures are consistent with that
ownership mismatch; they do not prove why this branch changed which process
claimed the work. The fix covers **all** `live-only` WS publications: admitted
inbound traffic, proxy/handler replies, and server-generated messages. It must
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

| Effective intent | Cluster carrier | Receiver behavior |
| --- | --- | --- |
| Best-effort, volatile, no retry | One Postgres notification after the sole publisher has authorized and frozen its audience | Every listening process attempts one direct send to its own eligible open sockets. No receiving QueueBox/inbox row, polling, replay, delivery retry, or handler invocation. |
| At-least-once or otherwise requiring durable outbound work | Existing canonical `WS_OUTBOX` row and its key notification | Use existing retry/receipt ownership. Remote sends must obey the row's frozen admitted audience, including absent/late sessions. |
| `none` | No cluster publication | Existing handler-only behavior. |

The publisher must finish admission, authorization, transformation, target
resolution, and expiry checks once before announcing the result. The cluster
notice carries or identifies the **final message and frozen addressed session
IDs**, not a room name to re-resolve on subscribers. Subscribers validate
notice version, source, scope, deadline, targets, and audience; intersect that
audience with locally open sockets. They never execute a topic handler, proxy,
RTC/RTT mutation, admission decision, or database inbox processing. A lost
notification or disconnected listener can lose best-effort delivery. A failed
`NOTIFY` is reported; it is not treated as successful delivery. Retries of the
upstream shared `dispatch-local` effect can re-publish; best-effort is **not**
an exactly-once promise.

For best-effort publication, the public result cannot claim a global
`sentCount` or `no-recipients`: a publisher sees only its local socket attempts.
Expose an accepted-for-cluster-publication status/count separate from observed
local sends, retaining a local-only result only where the caller explicitly
requests local delivery. Callers/tests that use `sentCount` must be audited.
This is a public-result compatibility decision, not an internal refactor.

## Size recommendation

PostgreSQL `NOTIFY` has a payload limit below 8,000 bytes; this repository's
bridge already rejects serialized notices at `>= 8_000` bytes. The normal WS
message payload default is 64 KiB, and the envelope plus a large audience can
exceed the notification budget even when the message body does not. Therefore:

1. Measure the **serialized UTF-8 notice**, including message, audience, and
   metadata. Do not advertise an 8 KiB *message* limit or guess from character
   count. Keep an explicit safety margin within the existing `<8,000` parser
   bound; tests must cover the exact boundary.
2. For an admitted inbound best-effort message that exceeds the inline budget,
   notify by a small key and read the already-retained canonical inbound
   message on each receiver. This is a read-only carrier lookup, **not** a
   receiver inbox or a new durable-delivery promise. Publish after admission
   commits; a missing/expired row is an observable best-effort miss.
3. A server-generated/proxy-created best-effort publication may have no
   canonical inbound row. For the first implementation, reject an oversized
   publication with a typed result/error before claiming success. The caller
   may *explicitly* choose at-least-once/outbox if that is its intended QoS.
   Never silently persist or upgrade it. This is a proposed compatibility
   limit requiring maintainer approval before code changes.
4. If that limit is unacceptable, design a separately reviewed large-message
   carrier before implementation. A temporary payload table would be a new
   storage/retention boundary, not merely a larger `NOTIFY`; fragmentation
   would need ordering, loss, and memory bounds. Neither is authorized here.

This approach preserves the 64 KiB inbound message allowance while making the
unavoidable limit on noncanonical generated best-effort messages explicit.
The single-process in-memory and deliberately disabled pub/sub modes also need
explicit behavior: local sockets keep working; the disabled mode must not claim
cluster publication.

## Acceptance and non-goals

- Three API processes sharing Postgres deliver to a socket connected to a
  different process from the sole inbound claimant; the same run covers
  server-generated and proxy replies, and no handler runs twice.
- A late joiner, unauthorized session, wrong room/application scope, expired
  message, malformed notice, or publisher's own duplicate receive causes no
  extra socket delivery. A disconnected listener is a legitimate best-effort
  miss; at-least-once follows existing outbox retry behavior.
- The relevant API-v1 WS topic, social app-data, CRDT exemption, room isolation,
  and game/realtime tests pass without weakening their workload or deadlines.
- No new library, receiving inbox/queue, retry/fence/lock/timer, migration, or
  legacy path. The existing notification and QueueBox infrastructure remains
  the only cluster carrier. Performance is measured rather than inferred from
  the absence of a receiving write.

The placement of the live cluster publisher, its notice codec, and the
application wiring is deliberately a review checkpoint in the accompanying
plan. This design fixes behavior and boundaries; it does not yet bless a file
split or public API shape.
