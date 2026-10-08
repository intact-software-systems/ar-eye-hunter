# ALM A2b design proposal: exclusive ownership as a claim on the resource key

Release 6, slice A2b of [alm-improvement-plan.md](alm-improvement-plan.md). Written from a code survey of
`main` at `94e72f482` (A2a merged, #647). A2a took the leader ACK and the per-player private event; this
proposal takes the second mechanism the A2 row names, exclusive ownership: `ownership: 'exclusive'` as a
claim on the message's resource key, surfaced as `claimed`, `held-by-other` or `expired`. Completion
criterion 7 asks for one documented semantic per ACK and target mode, proven by the conformance lane and
exercised by a game; PC7 lists exclusive ownership as the last such semantic open.

## 1. The problem

- `ownership` is on the wire (`ALDelivery.ownership`, "pubsub vs queue-like semantics"), on every builder,
  on the browser send base, normalized, authorized and persisted in the handling plan as
  `ownership: { algo, exclusive }`. Its only reader is local callback selection on the three receivers:
  an `exclusive` message reaches its typed callback or, failing that, the wildcard, never both. On the
  production WS server the only general consumer is the router, an observer that `exclusive` never
  suppresses, so a client's `exclusive` changes nothing observable there. No claim vocabulary exists.
- The product description promises more: exactly one consumer in a declared scope may claim an
  exclusive message, durable claims use leases and redelivery, and A2b defines the claim on the message's
  resource key with `claimed`, `held-by-other` and `expired`. The contract never says whether exclusive
  is local or distributed.
- AR Eye Hunter has the contention the claim is for and arbitrates it by accident. A pickup intent goes
  to the director with a fresh random `resourceId` and `ownership: 'shared'`; the winner is whichever
  intent's handler runs first on the director's event loop, no clock or sequence takes part; the loser's
  send reads `sent`, the app discards the result anyway, and the loser has already played the pickup
  impact, sound and haptic at send time. No refusal reaches it.
- Every browser send defaults `resourceId` to a fresh UUID, so a claim on the resource key is trivially
  won unless the sender names the resource. The harness `messages.send` cannot name one and only the
  sender role sends, so no conformance cell can put two claimants on one key.

What exists and is reused: the inbound admission transaction and its dedup key (read beside the message,
decided in the planner as a drop with a NACK of the same reason, written as a mutation with an expiry);
the planning observations (`dedupSeen`) and `resolveMessageDrop`; the drop-reason codes and the NACK
effect; the trusted-server relay rejection and its handle state; the A1 world short-circuit that sends a
world broadcast over WS under every strategy but `rtc`, and the RTC origin's `unsupported` scope refusal
that a fallback carrier takes over; the browser validator's issue list; the director relay's typed send
statuses; the lane's three-agent roles, receipt window and verdict commands; the message `ttlMs` and
`constraints.expiresAtMs` lifetime.

## 2. The design, per concern

### 2.a The claim is the sender's, on the room-scoped resource key, at WS admission (D171)

An `ownership: 'exclusive'` send that the WS server's room authorizer admits claims its resource key for
the sender's session: the key is the room's `GroupRef` scope with the route `topicId`, `contextId` and
`resourceId`. The first exclusive send on a free key is `claimed`: admitted and delivered as the same send
with `shared` would be. An exclusive send from a different session on a key whose claim is live is dropped
`held-by-other` and NACKed with that reason; nothing is delivered. The holder's own later exclusive send on
the key is admitted and the claim's expiry moves to that message's. A `shared` send never consults or
takes a claim: ownership is between exclusive senders. The key includes the application scope because the
same group id can exist in different scopes (A1's rule for audiences).

### 2.b The lease is the message's lifetime (D172)

The claim expires when the admitted message does: `constraints.expiresAtMs`, the send's `ttlMs` or the
channel default. No lease constant and no renewal call: a holder renews by sending again. Once the claim
has expired the key is free, and the next exclusive send is admitted and delivered, which is the
redelivery of the A2 exit evidence. A claimed message that expires without its receipt ends `expired`, as
any send does today; the claim lapses with it.

### 2.c The claim lives in the admission store, decided in the planner (D173)

The claim is a new admission-store key family beside dedup, `${namespace}:claim:<scope>/<route>`, whose
value is the holder's session id and the expiry. `readIncomingMessage` reads it with the dedup key; the
read becomes a planning observation beside `dedupSeen`; `resolveMessageDrop` returns the drop code
`held-by-other` when the message is exclusive and the claim is held by another session; `planNack` carries
the same reason, so the NACK effect, the drop and the claim write commit in the one admission transaction
that already commits dedup, ordering and the ACK rows. An admitted exclusive message writes a `set-claim`
mutation with its expiry. The browser admission stores never read a claim, so the observation is absent
there and a browser never drops for it. Every API process shares the WS runtime's admission namespace, so
the claim is cluster-wide. The roadmap's "ResourceInbox-backed" wording is corrected: the resource inbox
holds worker rows, and the claim is an admission-store key with the insert-if-absent-or-expired semantics
the dedup key already has.

### 2.d Exclusive is WS-only; RTC refuses it (D174)

No server stands on the RTC path and the origin reads only its own snapshot, so nothing there can
arbitrate two claimants. An exclusive send takes the WS route under every strategy but `rtc`, exactly as a
world broadcast does; the RTC origin refuses an exclusive message `unsupported`, the refusal a fallback
carrier takes over and the verdict of an `rtc`-only send. The browser validator refuses before either
carrier: `exclusive-requires-resource` when the sender names no `resourceId` (a fresh id per send claims
nothing), and `exclusive-requires-room-audience` for `scope: 'world'`; a principal send without a room is
refused by the existing room checks before the claim rule runs.
Every send the room authorizer admits may be exclusive: a room multicast, a room broadcast, a principal or
listed audience in the room, a leader send and a room unicast.

### 2.e Surfacing: `claimed` is the admission, `held-by-other` a typed rejection (D175)

A claimed send is one that is admitted: its receipt's `admitted` phase and its delivery are the claim;
no separate claim event is added. `held-by-other` is a trusted-server `relay-rejected` reason on the
handle, as `no-leader` is on WS: with a receipt-bearing `ack` the handle ends `rejected` at
`failure.rejection.reason`; without one the late NACK lands in `evidence.relayRejection`. It is not a
fallback trigger (`AL_DELIVERY_FALLBACK_REFUSAL_REASONS` stays `['unsupported']`): a claim held by another
is a decision, not a carrier failure. `expired` is the existing lifetime failure. There is no release
call: a claim ends with its message.

### 2.f The AR Eye consumer: pickup intents claim the pickup (D176)

A pickup intent is the one-winner action in AR Eye, and it names its resource already (`pickupId`). The
game relay runtime's `sendIntent` takes the claim as input (`{ resourceId }`), the relay session and
transport send it as `ownership: 'exclusive'` with that `resourceId`, over WS by D174, with the director's
ACK still the receipt. The loser's send now ends `held-by-other` before it reaches the director: the
relay's send status and the game's send status gain `held-by-other`, the arena stops discarding the
pickup result and records the loss as its own activity headline through the existing active-event path.
The winner's path is unchanged: the director's rules still decide, and `pickup-unavailable` still refuses
a late intent after the claim has expired. The director's own pickups are routed locally and claim nothing.

### 2.g The proof (D177)

A `claim` lane family on the three-agent roles. `claim-first-wins` over `ws` and `rtc-with-ws-fallback`:
the sender's exclusive room broadcast on a named resource is acknowledged by both recipients;
`recipient-b`, once it has received that message, sends its own exclusive message on the same resource
and reads `rejected` with `failure.kind` `relay-rejected`, `relay` `trusted-server`, `reason`
`held-by-other`, one sent attempt, carrier `ws`. `claim-expires-reclaims` over `ws`: the sender claims with
a short `ttlMs`; `recipient-b` waits past the expiry and its claim is acknowledged. `claim-refused-on-rtc`
over `rtc`: the sender's exclusive send is `refused` `unsupported` with no attempt. The harness
`messages.send` gains `ownership` and `resourceId`, and a recipient role may send on its own connection.
The cells are withheld from hosted manifests 18 and 22, which stay byte-identical. Unit pins: the
planner's drop and NACK, the admission store's claim read and write on the memory and PGlite backends,
api-v1 Deno end-to-end cases (two claimants, the holder's re-send, expiry and reclaim, a shared send on a
claimed key), the browser validator, the RTC refusal and the WS route choice, the relay and game statuses,
the arena's loss headline, and the four IndexedDB pins unchanged.

### 2.h Docs, corrections and carries (D178)

The API reference gains an `ownership` section (the claim, the key, the lease, the three outcomes, the
WS-only rule and the validator issues); the inbound and outbound READMEs state the claim key and the drop;
the product description's Ownership paragraph becomes CURRENT with this meaning and the scope sentence is
reduced to the room scope; the roadmap's A2 row is marked delivered at the close. Carried: server
publications claim nothing (they bypass the inbound authority); the receivers' local callback selection
stays as it is; no claim release or explicit claim event; the other scopes the product description listed
(process, browser session, principal, server consumer group) are not defined by this slice; Relic is
unchanged, its pickup is already arbitrated by the server's per-game rule.

## 3. Decisions (2026-10-07)

- **D171** An `exclusive` send the WS room authorizer admits claims the room-scoped resource key
  (`GroupRef` scope + route) for the sender's session; the first claimant is admitted and delivered; another
  session's exclusive send on a live claim is dropped `held-by-other` and NACKed; the holder's re-send is
  admitted and moves the expiry; `shared` sends are untouched.
- **D172** The claim's lease is the message's lifetime (`constraints.expiresAtMs`); no lease constant or
  renewal call; an expired claim frees the key for the next claimant; an unconfirmed claimed message ends
  `expired`.
- **D173** The claim is an admission-store key family read beside dedup, decided in the planner as the drop
  code `held-by-other` with a NACK of the same reason, and written as a mutation in the admission
  transaction; browsers never read one; the "ResourceInbox-backed" wording is corrected.
- **D174** Exclusive is WS-only: the WS route under every strategy but `rtc`, `unsupported` on the RTC
  origin; validator issues `exclusive-requires-resource` and `exclusive-requires-room-audience`.
- **D175** `claimed` is the admission; `held-by-other` is a trusted-server relay rejection on the handle,
  not a fallback trigger; `expired` is the existing lifetime failure; no release call.
- **D176** AR Eye pickup intents send exclusive on `pickupId` through the relay; `held-by-other` becomes a
  relay and game send status and the arena shows the loss; the director's own pickups claim nothing.
- **D177** The `claim` lane family (`claim-first-wins`, `claim-expires-reclaims`, `claim-refused-on-rtc`)
  with `ownership` and `resourceId` on `messages.send` and a sending recipient role; withheld from hosted
  manifests; unit, Deno and browser pins.
- **D178** Docs and corrections as in 2.h; carries: server publications, local selection, release, other
  scopes, Relic.

## 4. Corrections to the roadmap and the product description

- The A2 row's "ResourceInbox-backed claim" becomes "a claim in the WS server's admission store, the
  insert-if-absent-with-expiry the dedup key already uses".
- The product description's Ownership paragraph becomes CURRENT with the A2b meaning at delivery; its scope
  list is reduced to the room scope, the only one defined; "exactly one registered consumer may claim it"
  becomes "exactly one sending session holds the key".
- The AR Eye consumer row's "pickup-style actions use exclusive ownership" is made concrete: pickup intents
  claim the pickup; the loser reads `held-by-other`.

## 5. Carries: what A2b does not do

Claims by server publications; a claim release or an explicit `claimed` event; scopes other than the room;
a claim on the RTC carrier; a change to the receivers' local callback selection; reply correlation (I1);
any change to Relic.
