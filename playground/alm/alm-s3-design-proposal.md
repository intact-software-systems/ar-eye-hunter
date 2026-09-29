# ALM S3 design proposal — defaults, fallback, volatile path, consumer proofs

Prepared 2026-09-26 against merged `main` `d8e72dca5` (S2c-ii, PR #595). Read-only survey and proposal;
section 4's questions are open and their answers are the maintainer's. The code survey behind
sections 1 and 2 cites `main` at that commit; every path below is on it.

## 1. The problem

S3's roadmap outcome (`alm-improvement-plan.md:782-788`, the consumer table row "3 S3", the
conformance-lane sentence "S3 volatile counters, fallback within the deadline, budgets") names the D2
default chosen by a channel purpose, carrier-aware capabilities in the composition, a memory and an
IndexedDB backend per carrier runtime, delivery-level fallback within the deadline, aggregate budgets,
a zero-IndexedDB volatile proof, and two game proofs. Grounding those against this checkout produced
five findings; the first two decide the slice's shape, the fourth redirects both game proofs.

### 1.1 The default typed send is neither receipted nor volatile, and nothing carries a purpose

No `purpose` exists: a typed channel definition is `{ topicId?, typeId }`
(`packages/shared-web/browser/messages/rallar-message-contracts.ts:106-109`), a room channel adds
`roomId?`/`roomRef?`. A send with no options builds a room multicast over `rtc-with-ws-fallback` with
`ttlMs` 30 000, `reliability: 'at-least-once'`, `ack: 'none'`
(`browser-rallar-message-sender.ts:181-199`, `:328-332`); normalization derives `retry: exp-backoff ×3`,
`repair: retransmit ×1` and **`durability: local-outbox`**
(`packages/shared/al-contracts/normalize-al-qos-policy.ts:158-181`). The handle seeds `ackMode` from
`delivery.ack` and is terminal at `transport-accepted` when that is `none`
(`browser-rallar-delivery-registry.ts:154`; `packages/shared/alm/delivery/al-delivery-lifecycle.ts:279-283`).
So the default is at-least-once, unreceipted, persisted — the opposite of D2 on two of three counts,
and the product description's own rule "an explicit at-least-once request with `ack: none` is
invalid" (`alm-complete-product-description.md:337`) describes today's default.

Volatile is not reachable by request either: `shouldPersistOutbox(effective)` is true whenever
`retry.algo !== 'none'` (`packages/shared/al-contracts/al-policy.ts:392-395`), `alignRequestedDurability`
only ever raises durability (`normalize-al-qos-policy.ts:693-715`), and the plan's `persist` flag
decorates the verdict but gates no write — every admission commits the canonical entry, the owner row,
the sent snapshot, ordering mutations, one `send-prepared` effect per prepared message and, with ack
tracking, the pending row and `ack-timeout` work (`packages/shared/alm/outbound/compute-al-outbound-dispatch.ts:55-106`).
Inbound decodes `localDelivery.persist`/`forwarding.persist` and never reads them
(`packages/shared/alm/inbound/decode-al-inbound-plan.ts:107-116`). The pins agree: one default send is
10 `al-admission` + 15 `al-work` IndexedDB operations, one inbound admit-and-deliver is 8
(`packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts:196-263`), and the lane's
`delivery-baseline` asserts `storage.counters.total > 0`
(`packages/shared-test/rallar-bb-test/conformance/alm/scenarios/delivery-baseline.ts:57-67`).

The production composition installs no policy provider (`qosProvider: undefined`,
`packages/shared-web/browser/composition/create-rallar-facade.ts:167`); "capabilities" are one default
constant claiming every algorithm but `receiver`, two per-carrier wrappers that add `receiver`, and
two refusal functions (`validate-al-ack-support.ts:26-72`, `web-rtc-overlay-frozen-audience.ts:64-77`).
There is no registry, no carrier declares durability or congestion support, and nothing produces the
`overloaded` live state, so the congestion aspect never fires.

### 1.2 Delivery-level fallback has no event to key on

`rtc-with-ws-fallback` is a dispatch strategy over two carrier runtimes, not a runtime
(`browser-rallar-message-dispatch.ts:76-116`). It falls back on exactly three admission verdicts —
`unroutable/no-route`, `unroutable/circuit-open`, `refused/unsupported` (`:194-203`) — re-admits the
RTC admission's returned envelope on WS with `canFallback: false`, and ends. `unroutable/rate-limited`
(20 enqueues per second, `web-rtc-overlay-multicast-manager.ts:229-238`) does not fall back and fails
the handle.

After admission nothing can trigger WS: a dropped, closed or unattempted RTC submission maps to
`not-ready` with `retryAfterMs: 50` and the owner retries on RTC until the deadline
(`packages/shared/multicast/rtc-outbound-submission.ts:110-114`); a receiver's `not-yet-in-sync` NACK
schedules an RTC `nack-retry` (`al-outbound-repair-admission.ts:145-173`); and when the receipt budget
runs out the repair owner **logs and states no settlement** (`:196-199`) — the handle reads `expired`
only when the deadline passes. The one place that sees every settlement of a message from both
carriers is `BrowserRallarDeliveryRegistry.record` (`browser-rallar-delivery-registry.ts:109-119`); the
dispatch that owns today's fallback decision is fire-and-forget and finishes with the admission leg.
The observation has no per-attempt carrier (`decode-alm-runtime-result.ts:125-146`) and the only RTC
fault, `drop`, holds a send rather than ending it, so the lane cannot show which carrier delivered.

There is no "remaining budget" value to hand a second carrier: one absolute deadline
(`constraints.expiresAtMs`), a per-row `attempts/maxAttempts` on the pending-ACK snapshot, the
`retry.maxAttempts` budget for `not-yet-in-sync`, and QueueBox's 20 processing attempts. Cancelling one
carrier's owned work exists (`cancel(msgId)`, `al-outbound-message-runtime.ts:468`; both carriers via
`browser-delivery-composition.ts:12-19`), and receivers already dedup across carriers on
session-logical keys (inbound README `:45-48`), so a second admission of the same msgId is safe.

### 1.3 The volatile proof is neither implemented nor measurable

Storage is chosen once for the whole browser runtime — IndexedDB when supported, memory otherwise
(`packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts:93-135`). An outbound runtime
binds exactly one `{ admissionStore, workQueue }` at construction
(`al-outbound-message-runtime.ts:152-155`); inbound is one session store shared by both carriers (D20,
`initialise-browser-middleware.ts:193`), so "per carrier runtime" does not describe the inbound side.
The in-memory backend and factories exist (`packages/shared/alm/al-runtime-stores.ts:80-125`;
`al-admission-backend.ts`) and pass the three-backend parity tests; `InMemoryQueueBox` has no
capacity bound.

The lane counter is one observer per agent read with `reset: false` everywhere
(`alm-conformance-message-commands.ts:207-214`), and while any IndexedDB-backed owner is alive its
idle probes spend `work-page` operations without a send (4 per 10 s outbound, up to one per engine
round inbound; `al-indexeddb-operation-counts.test.ts:128-159`, `:268-280`). A per-scenario zero is
not observable with today's harness, and the harness has no browser memory mode.

### 1.4 Both game proofs are aimed at code paths that do not exist as described

**AR Eye Hunter.** "The authority client awaits receipts and consumes the handle" — the authority
client (`RallarGameAuthorityClient.sendCommand`, `rallar-game-authority-client.ts:128-142`) already
consumes the handle up to admission, has **no app caller** (only `authority-match-support.ts:65`,
which nothing calls), and is not imported by AR Eye Hunter. Its match commands are director-relay
intents whose first leg is the **non-ALM** `rallar.realtime` targeted lane
(`browser-director-relay-transport.ts:73-78`); only the fallback is ALM, a best-effort WS unicast
(`:150-172`, `browser-rallar-message-sender.ts:104-129`), and the UI discards the result
(`use-arena-world-actions.ts:62-95`; fixed by S3c-ii, §11). The browser has no ALM RTC unicast (every RTC typed send is a
room multicast, `:310-340`; fixed by S3c-ii, §11), `receiver` on a WS unicast is refused (D42, kept by R-S2c-ii-0), and the
fallback strategy accepts room targets only (`validateRoomFallbackInput`, `:343-362`). A `command`
channel "with a real director receipt" over `rtc-with-ws-fallback` therefore needs three things the
code lacks: an RTC unicast, a unicast fallback, and a receipt for a WS unicast.

**Relic Hunters.** Commands POST `/api/relic/games/:gameId/commands` and the response carries the new
snapshot or the rule error (`apps/relic-hunters-v1/src/game/api.ts:47-71`;
`apps/relic-hunter-server-v1/src/main.ts:120-146`). The server side of a WS command already exists —
topic `room.relic.command`, `fanout: 'none'`, handler `applyCommand(payload, senderId)`
(`relic-game-service.ts:137-159`) — and the browser never sends on it, because no ALM target addresses
the server: `ALTargets` is `unicast | multicast | broadcast` (`al-contract.ts:30-58`) and "no client
learns a server id" (outbound README `:237`; the id is `wsRuntimeName ?? 'default-qbox-server'`). A room
`receiver` send on a `fanout: 'none'` topic is aggregated over the room with the server's own ACK
withheld and times out. Snapshots are `live-only`, `ack: none`, `senderId: 'relic-hunter-server'`
(`relic-game-service.ts:95-121`); a server-originated outbox publish carries no frozen audience
(`publish-rallar-server-ws-message.ts:110-115`), receivers address ACKs to the origin id, which is not
the server peer id, so the aggregator would refuse them
(`ws-queue-box-server-receipt-aggregation.ts:198-205`), and the server's settlement sink is
`undefined` (`create-rallar-middleware-infrastructure.ts:44`). This also means S2's Relic row —
"server events become a room notification with per-session confirmation visible in server
diagnostics" — was not delivered by S2; S3 inherits it.

### 1.5 Ceilings exist, aggregates do not, and no typed capacity outcome exists

`AL_MESSAGE_RESOURCE_LIMITS` bounds the envelope, payload, collections (256), visited peers (64),
hops, repair window, buffered messages and bytes per track
(`packages/shared/al-contracts/al-message-resource-limits.ts:7-22`); the RTC breaker, rate limiter,
data-channel queue, delivery registry (512), store TTLs, the receipt window and QueueBox's 20 attempts
each bound one resource. Nothing counts per-session messages, bytes, age or active tracks; no intake
limit exists on RTC ingress or the WS server; `ALDeliveryAdmissionVerdict` has no capacity kind
(`al-delivery-lifecycle.ts:58-77`) although the admission policy requires "queue capacity and deadline
exhaustion have distinct outcomes". The roadmap assigns aggregate budgets to both S3 and V1 (matrix
row F13; V1 "per-session aggregate count, byte, age, and active-track budgets") without a split.

## 2. The slice as three PRs

The five findings order themselves: the receipted, volatile default (1.1, 1.3) is what fallback (1.2)
retries and what the proofs (1.4) consume; budgets (1.5) bound the volatile store the default creates.

### 2.1 S3a — purpose, the D2 default, and the volatile path

- **Purpose on the channel.** `RallarTypedMessageChannelDefinition.purpose: 'command' | 'notification'`
  (required; `realtime` is refused at a typed channel — it belongs to `rallar.realtime`, and the
  typed-send strategy named `'realtime'` today routes to the ALM RTC send,
  `browser-rallar-message-sender.ts:185-187`). One purpose → default-policy table in
  `packages/shared/al-contracts/` per the roadmap's "Purpose at the channel": `command` — at-least-once,
  volatile, 30 s, `receiver` from the addressed receiver, 2 s ACK timeout, three receipt retries;
  `notification` — at-least-once, volatile, 30 s, `receiver` over the frozen audience. A send option
  still overrides per call (D2).
- **The default becomes receipted.** The envelope's `delivery.ack` defaults from the purpose, not to
  `'none'`; the handle's `ackMode` derives from the effective policy (a receipt requested only through
  `qos.ack` no longer leaves the handle terminal at `transport-accepted`). The receipt-less RTC send
  carry (R-S2c-ii-5a) dissolves for default sends.
- **Durability decoupled from retry.** `shouldPersistOutbox` reads durability alone; `volatile` is
  honoured, `local-outbox`/`local-inbox` are the per-channel opt-in (`durability` on the channel
  definition, overridable per send). `alignRequestedDurability` stops raising.
- **Two stores per runtime, one chosen per message.** Each outbound carrier runtime holds a memory
  and an IndexedDB `{ admissionStore, workQueue }` pair and routes each admission by its effective
  durability; the inbound session store becomes a memory and an IndexedDB pair, still one per session
  shared by both carriers (D20 kept; the roadmap's "per carrier runtime" is corrected), routed by the
  receiving channel's declared durability (default volatile). Work handlers register once per pair on
  the shared engine. Cleanup and reset learn the memory pair (a reset is a no-op there). **As applied
  (S3a):** routed by the sending channel's durability carried on the envelope as `qos.durability`; a
  receiver-side declaration does not move a message.
- **The volatile proof.** The harness counter gains a per-scenario `reset: true` and a by-owner,
  by-kind read; the S3 lane pin is **zero `al-admission` operations and zero non-probe `al-work`
  operations** between reset and read for a volatile scenario, with `work-page` probes reported
  beside it (the durable owners' idle cost, not the send's; see Q4). `delivery-baseline`'s `> 0` pin
  becomes the durable opt-in scenario's pin; the storage pins are re-baselined deliberately: a volatile
  default leaves no rows.
- **Capabilities installed in the composition.** A `ALCarrierCapabilities` object per carrier (WS
  client, RTC overlay, WS server) replaces the default constant plus wrappers, passed through the one
  seam that exists (`qosProvider`, `create-rallar-facade.ts:167` → `initialise-browser-middleware.ts:251`,
  `:319`); the `unsupported` refusal reads it. No behaviour change beyond ownership.
- **The combined Hetzner recipes order each scenario (D62).** Manifests 18 and 22 run every role's
  scenarios back to back in one recipe, so nothing ordered one role's scenario against another's. Two
  races followed: a recipient armed scenario N's fault after the sender had sent N (#599 made it unlikely
  with 3 s of sender pacing), and recipient-b armed scenario N+1's ACK hold while its own ACK for N was
  still owed (manifest 22, run 4). Two recipe barriers per scenario replace the pacing:
  `<scenario>-start` once every role finished the previous scenario, then `<scenario>-armed` once every
  role armed its faults; the sender sends only after it. The control server releases every run agent
  together or fails the barrier typed.

### 2.2 S3b — fallback within the deadline

- **Declared retryable outcomes**, one list in `packages/shared/alm/delivery/`: an RTC attempt
  settled `not-ready` (dropped/closed) beyond a bound of consecutive attempts, `unroutable/rate-limited`,
  the `not-yet-in-sync` retry budget exhausted, and the receipt budget exhausted — which first becomes a
  settlement (`receipt-exhausted`, carrying the confirmed and unconfirmed recipients) so every receipt
  end settles (also closing the carried `hop`-mode delete-without-settlement path).
- **A fallback controller on the registry**, the only convergence point: on a retryable settlement
  for a `rtc-with-ws-fallback` message it cancels the RTC runtime's owned work, re-admits the same
  envelope (same msgId, frozen audience, the unchanged `expiresAtMs`) on WS with `canFallback: false`,
  and records a `carrier-fallback` evidence row with the reason. Receivers dedup the second copy.
  Non-room targets stay refused until S3c lifts the room-only constraint for unicast.
- **Harness.** The observation carries each attempt's carrier; an RTC fault that ends an attempt
  (`closed`/`failed`, beside today's `drop`); scenarios `fallback-within-deadline` (RTC post-admission
  failure → WS delivery inside the original deadline), `receipt-exhausted-fallback`, and the negative
  `no-fallback-after-deadline`.

**As applied (S3b, PR #604):** no RTC fault kind was added (the `drop` fault's `not-ready` run is D65's
trigger); the harness shows each attempt's carrier as `attemptCarriers`; `no-fallback-after-deadline`
expires inside the RTC receipt budget (C7); `receipt-exhausted` reads `failed` when no fallback carrier
remains (C1).

### 2.3 S3c — consumer proofs and the volatile bound

- **AR Eye Hunter.** Match intents (pickup, match start, combat) move from the realtime targeted lane
  to one `command` channel unicast to the director session over `rtc-with-ws-fallback`, which needs the
  ALM RTC unicast in the browser sender, the unicast fallback (the room-only constraint lifted for a
  unicast to a session), and the `receiver` receipt on a WS unicast (Q2). The arena shows the command's
  receipt state beside the S2c-ii "Match delivery" row; the app test pins zero `al-admission`
  operations for an intent. The director keeps receiving on `messages.ws`/`messages.rtc`.
- **Relic Hunters commands.** A server-addressed unicast: a `server` target kind whose id the client
  learns from the WS connection state (Q6); receipt = the server's own ACK as the logical recipient
  (S2c-i Task 4 already keeps it); the UI shows the delivery outcome and the applied snapshot's
  arrival; the correlated application reply stays I1's `awaitReply`. The REST route stays for one
  release as the documented alternative (no migration is needed; both call `applyCommand`).
- **Relic Hunters snapshots.** `fanout: 'outbox'` with `ack: 'receiver'` (`notification` purpose); a
  server-originated publish freezes the room's current sessions at publish; the game id becomes a
  route attribute and the sender id is the server peer id so ACKs reach the aggregator's live
  aggregate; a server settlement sink feeds the server diagnostics with per-session confirmation (the
  undelivered S2 row). Cluster delivery honouring the carried audience is the precondition for a
  correct receipt there (Q7).
- **The volatile bound (the S3 share of budgets).** A per-session count and byte bound on the memory
  pair with a typed `refused/capacity` admission verdict, and that bound as the first producer of the
  congestion aspect's `overloaded`; track, intake, age budgets and fairness stay V1 (Q8).

**As applied (S3c-i, PR #605):** a room unicast names its room (`groupRef`, schema bump — the server target needs no
envelope bump, D76); the WS `hop` receipt tracks the server; the snapshot sender is the server peer id and the sink a
per-process recorder; the typed-channel `peerId` target landed WS-only for the Relic cutover (Q11's RTC half is
S3c-ii's).

**As applied (S3c-ii, PR #606):** the RTC unicast is a sender path over the existing direct plan; the fallback leg
re-admits the same room-naming envelope; `capacity` ends `rejected`; the director accepts intents out of order. The
decisions, choices and rulings are in §11.

## 3. Recommendation

**S3a, then S3b, then S3c, as three medium PRs.** S3a first because fallback and both proofs consume
the receipted, volatile default and the per-message store routing; S3b second because its trigger set
needs S3a's `receipt-exhausted` settlement and its scenarios need the volatile counter; S3c last
because it is the consumer cutover and carries the two wire-visible additions (unicast fallback, the
server target).

Constraints that bind all three:

- **No migration** — reset-on-mismatch is the only lever (D3, D17). S3a bumps `AL_ADMISSION_SCHEMA_ID`
  if the captured policy's persisted shape changes (a `purpose` or `durability` field on the persisted
  qos would); S3c bumps the envelope version for the `server` target kind. **No new third-party
  dependency** (D8).
- **No new timer, queue or registry beyond what the outcome needs.** S3a adds the memory pair (the
  backend exists) and no timer; S3b adds one controller on the existing registry and no timer; S3c
  adds the server target and the settlement sink. Anything else needs a waiver in the plan.
- **Harness budgets fixed** (`CONNECT_READINESS_TIMEOUT_MS` 30 000, `CONFORMANCE_DEADLINE_MS` 18 000,
  `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000, `EXPIRY_TTL_MS` 7 500, regimes 30/35 ms). The IndexedDB pins
  move only where a volatile default leaves nothing to count, with the new figures recorded.
- **Bundle ceilings** 220 KiB facade (measured 219.8 — 0.2 KiB headroom, so S3a will raise it under
  the next-whole-KiB rule with the measured figure recorded) and 281 KiB headless (measured 280.05).
- **Public surfaces.** `purpose` is a new required field on the typed channel definition (every
  in-repo caller is updated in S3a; there are no external callers); the `'realtime'` typed-send
  strategy name is retired with the purpose table (Q1). `rallar.realtime` stays untouched (D15).
  `ALDeliverySettlement` grows additively (`receipt-exhausted`, `carrier-fallback`).
- **S3 pre-empts nothing.** A1 owns principal, world, all and fixed audiences; A2 owns leader ACK and
  exclusive ownership; I1 owns correlation, `awaitReply` and trace; I2 owns durable lifetime across
  tabs; V1 owns fairness and the remaining budgets.

## 4. Maintainer decisions (2026-09-26)

Settled with the maintainer on 2026-09-26: every question took its recommended answer, recorded in
the roadmap's decision record as D52–D61 in this order. The recommended answer is first in each case.

1. **Purpose surface.** (a) `purpose` required on every typed channel definition, in-repo callers
   updated, `realtime` refused at typed channels and the `'realtime'` send strategy retired; (b)
   `purpose` optional, defaulting `notification` for room channels and `command` for unicast, strategy
   names unchanged. (a) makes D2 a compile-time fact and removes the name collision; (b) keeps the
   public surface but leaves an unreceipted-looking default that is now receipted.
2. **Receipt for a WS unicast.** (a) Lift D42's refusal for a unicast addressed to a session: the
   logical audience is that one session, frozen trivially; the server aggregates a one-member
   audience and the receiver's own ACK is the receipt; (b) keep it refused and make `command`
   channels RTC-only, the WS leg typed-refused. (a) is what the `command` purpose row requires over
   `rtc-with-ws-fallback`; it amends D42/D49's scope, not their reasoning.
3. **Store routing shape.** (a) One runtime per carrier holding a memory and an IndexedDB pair,
   choosing per admission by effective durability; inbound one memory and one IndexedDB session
   store shared by both carriers (D20 kept), routed by the receiving channel's declared durability;
   (b) two runtimes per carrier (volatile and durable), each bound to one pair as today. (a) keeps
   one owner and one work handler set per carrier; (b) keeps runtimes untouched at the cost of a
   second owner per carrier on the shared engine. **As applied (S3a):** routed by the sending
   channel's durability carried on the envelope as `qos.durability`; a receiver-side declaration
   does not move a message.
4. **What "zero IndexedDB" pins.** (a) Zero `al-admission` operations and zero non-probe `al-work`
   operations over a reset window per volatile scenario, with the durable owners' idle `work-page`
   probes counted and reported beside it; (b) a literal total of zero, which requires the IndexedDB
   owners to start lazily and stop when no durable work exists. (a) is measurable in S3a and states
   whose cost the probes are; (b) is an engine lifecycle change better owned by I2 (durable lifetime).
5. **The retryable-outcome set and its bound.** (a) `not-ready` beyond N consecutive RTC attempts
   (N a named constant, proposed 3), `unroutable/rate-limited`, the `not-yet-in-sync` budget
   exhausted, and `receipt-exhausted`; (b) only `receipt-exhausted` and `rate-limited`. (a) covers the
   carried-in F2 cases by name; (b) leaves a dropped RTC send retrying on RTC until the deadline.
6. **The Relic command address.** (a) A `server` target kind on the wire, the id learned from the WS
   connection state, receipt = the server's own ACK, UI shows delivery outcome plus the applied
   snapshot; (b) defer Relic commands to I1 and do only the snapshots in S3. (a) delivers the row now
   with the application reply left to I1; (b) shrinks S3c and leaves the REST path.
7. **Server-originated outbox with receipts.** (a) Freeze the room's current sessions at publish,
   sender id = server peer id, a server settlement sink for diagnostics, and cluster delivery
   honouring the carried audience (the carried S2c-ii limitation, fixed here because the receipt is
   wrong without it); (b) the same without the cluster fix, stated as a limitation. (a) makes the
   receipt honest in the deployed shape; (b) is smaller.
8. **The budgets split.** (a) S3 owns the volatile pair's per-session count and byte bound, the typed
   `refused/capacity` verdict and the first `overloaded` producer; V1 owns track, intake, age and
   fairness; (b) all of "aggregate memory, track and intake budgets" in S3. (a) bounds the store S3
   creates and leaves scale work to the scale release.
9. **AR Eye Hunter scope.** (a) All match intents move to the `command` channel and the realtime
   targeted first leg is removed for intents; (b) only match start moves, the rest stay on the
   realtime lane. (a) gives one command path to reason about; (b) is a smaller cutover with two paths.
10. **The undelivered S2 Relic row.** (a) S3c owns it as part of the snapshot move (the settlement sink
    and per-session confirmation in server diagnostics); (b) it is recorded as an S2 gap and routed to
    a later slice. (a) is the natural place since the snapshot receipts need the same sink.

## 5. Acceptance evidence

- **Lane family S3**, over `ws`, `rtc`, `rtc-with-ws-fallback`: `volatile-default` (a default send on
  each carrier is receipted and leaves zero `al-admission` operations), `durable-opt-in` (the channel
  that opts in counts and survives reload as `delivery-reload` does today), `fallback-within-deadline`,
  `receipt-exhausted-fallback`, `no-fallback-after-deadline`, `capacity` (the volatile bound refuses
  typed); the S2 three-agent family unchanged and green.
- **Consumer proofs.** AR Eye Hunter: an intent's receipt state in the arena diagnostics, the app test
  pinning zero `al-admission` operations per intent. Relic: a command over WS applied by the server
  with the outcome shown, snapshot receipts with per-session confirmation in the server diagnostics.
- **Pins** re-baselined with figures recorded: `al-indexeddb-operation-counts` (the volatile default),
  `al-storage-snapshot` (no rows for a volatile message), the public API snapshots, both bundle
  ceilings by the next-whole-KiB rule.
- **Gates**: the per-task set, the medium-scale Postgres gate for the WS server changes (S3b's
  settlement, S3c's server target and outbox publish), hosted smoke on both-normal runners per PR; a
  hosted full read best-effort (D51).

## 6. Rough task decomposition (for sizing only)

- **S3a** (7 tasks): purpose and the policy table; the receipted default and the handle's `ackMode`;
  durability decoupled from retry; the memory/IndexedDB pair per outbound runtime; the inbound pair;
  the counter reset and the volatile pins; capabilities in the composition and docs.
- **S3b** (5 tasks): `receipt-exhausted` and the retryable list; the fallback controller; attempt
  carrier in the observation and the RTC ending fault; the three scenarios; docs.
- **S3c** (7 tasks): RTC unicast and unicast fallback; the WS unicast receipt; AR Eye Hunter intents
  and the arena row; the `server` target and Relic commands; the server outbox publish, sender id and
  settlement sink; the volatile bound and `refused/capacity`; the Relic UI, manifests and docs.

## 7. Corrections to the roadmap and product description

To fold into `alm-improvement-plan.md` and `alm-complete-product-description.md` with the decisions:

1. The S3 bullet's "authority client" is not AR Eye Hunter's command path and has no caller (1.4).
2. "Today the carrier falls back only when the RTC admission itself is refused (`no-route`,
   `circuit-open`)" — it also falls back on `refused/unsupported` (D42, R-S2c-ii-13), `no-route` was
   widened by R-S2c-ii-9a, and `rate-limited` does not fall back (1.2).
3. "An admitted RTC send that is later dropped, rejected `not-yet-in-sync`, or never receipted" — a drop
   is `not-ready` and retries on RTC; `not-yet-in-sync` is a NACK that retries on RTC; exhaustion
   produces no settlement (1.2).
4. "One memory and one IndexedDB backend per carrier runtime" — inbound is one session store for both
   carriers (D20); the proposal keeps D20 and corrects the text (1.3).
5. The purpose table's `realtime` row says it "stays on the existing direct `rallar.realtime.room`
   lane" while the typed-send strategy `'realtime'` routes to the ALM RTC send (Q1).
6. Matrix rows F1 ("`receiver` normalizes to `hop`") and F4 ("carrier-scoped inbound stores") and the
   product description's `:300-304` describe pre-S2 code.
7. The product description's `:337` rule describes today's default, not an invalid request (1.1).
8. "Queue capacity and deadline exhaustion have distinct outcomes" — no capacity verdict exists (1.5).
9. S2's Relic consumer row was not delivered (1.4); the S3 row inherits it.
10. `delivery-baseline`'s `total > 0` pin encodes the opposite of PC4 and moves to the durable opt-in.

## 8. Carries S3 routes or refuses

From the S2c-ii plan's "Carried out of S2c-ii": in S3 — the receipt-less RTC send refusing its
receiver hop's NACK (dissolves with the receipted default), cluster delivery ignoring the outbox
audience (Q7), the `hop`-mode completion-at-dispatch deleting the row without a settlement (S3b's
"every receipt end settles"), the relay-row retention measurement (the volatile bound needs the
figure). Not in S3 — scenario 5 and a harness-pinnable relay, publishing `nextHopsBySessionId`, the
visited-cap topology bound, the `acknowledgement-under-transport-hold` flake, the stale-snapshot reopen
(unless S3c's arena work touches `onSnapshot`), the Playwright tsconfig, the dead-peer race (PR #593),
the heartbeat frames reaching admission (noted: it adds noise to any fallback diagnosis), the silent-page
lane hardening (useful for the S3 family; not required), the `subtree` lost-terminal recovery (A2
owns `group-leader`), the two round-2 nits, and the both-normal hosted full read (process).

## 9. S3b execution questions and decisions (2026-09-27)

Written after S3a merged (461b54cfe, #597), from a fresh code survey of the fallback, receipt and
registry paths (session scratchpad `s3b-code-survey.md`; 15 corrections to §1.2/§2.2, the material
ones folded into the questions). The recommended answer is first in each case. **Settled 2026-09-27: the maintainer took every recommended
answer, Q1–Q12** (roadmap: D56 "As applied", D63–D66); the S3b plan is written under them.
**Delivered by PR #604** (branch `claude/alm-s3b-fallback-within-deadline`); the rulings R-S3b-0
through R-S3b-21 live in the plan's "Rulings during execution".

**What the survey changed in §2.2's picture**

- Two fallback strategies share the admission-time path (`ws-then-rtc` and `rtc-with-ws-fallback`);
  D56 names only the second.
- Nothing counts consecutive `not-ready` RTC attempts: QueueBox refunds them and each retry reuses the
  row's attemptId, so the lifecycle keeps one overwritten attempt row per send-prepared row (one row per
  next hop).
- `unroutable/rate-limited` is an admission verdict, not an attempt settlement; today it ends the send
  `attempts-exhausted` instead of falling back.
- The registry (`BrowserRallarDeliveryRegistry.record`) holds no envelope, middleware context or epoch;
  the dispatch does. `cancel(msgId)` states a terminal `cancelled`, so it cannot be the hand-over.
- Six receipt ends settle nothing today, not two: budget exhaustion (`console.warn`, row kept to the
  message expiry so a late ACK can still complete it), completion at a re-plan dispatch (RTC `replace`
  retries under `receiver` as well as `hop`), orphaned-receipt cleanup, terminal NACKs other than
  `resync-required`, the WS server's `timed-out` receipt, and a `qos.ack` timeout of 0 (a tracked
  receipt no row tracks).
- The RTC `drop` fault already ends each attempt `not-ready` (resubmitted after 50 ms); with
  `remaining: 'until-cleared'` it produces D56's consecutive run, so no new fault kind is needed.
- The lifecycle already carries each attempt's carrier; only the page projection drops it.
- On WS re-admission the server narrows its **current** room to the frozen audience; a member who left
  after the RTC freeze is absent from the WS receipt's expected set rather than read unconfirmed.
- The WS server already ACKs `hop`/`subtree` room sends itself; the missing piece is client-side
  tracking with a hop the origin can name — which no client learns until S3c's D57.
- The medium-scale Postgres gate runs one HTTP group-state churn recipe and touches no ALM receipt path;
  no S3b candidate change is an AppInbox mutation. The server's settlement sink is `undefined` until S3c.
- Five existing two-agent cells on `rtc-with-ws-fallback` drive the new triggers through their RTC
  holds (`deadline-expiry`, both `not-yet-in-sync` variants, `delivery-lifecycle` holds,
  `delivery-reload`'s hold); `frozen-audience-membership` sits within ~0.5 s of the ≈8 s receipt budget.
- Bundle ceilings after S3a: facade 222 KiB (221.8 recorded), headless 284 KiB (283.62 recorded).
  `AL_ADMISSION_SCHEMA_ID` is still `rallar-alm-2026-09-s2c-ii`. S3c-i (PR #605) bumps it to
  `rallar-alm-2026-09-s3c-i` (C1).

**Questions**

- **Q1 — Which strategy gets post-admission fallback?** Recommended: `rtc-with-ws-fallback` only
  (RTC → WS), as D56 says; `ws-then-rtc` keeps admission-time fallback alone. Alternative: both
  directions. Cost of the recommendation: a WS-first sender whose WS delivery stalls after admission
  is not moved to RTC in S3b.
- **Q2 — Where does the fallback controller live?** Recommended: the dispatch registers a fallback
  candidate (msgId → the RTC admission's returned envelope with its frozen audience, the middleware
  context, the epoch) for every `canFallback` RTC-first send, and one hook on the registry's `record`
  consults it — the registry stays the one convergence point (§2.2) and the dispatch stays the one
  place that admits; the candidate is released when the lifecycle ends or the fallback fires once.
  Alternative: a controller subscribing to per-handle lifecycles from the dispatch (a second
  observer per send).
- **Q3 — What is the hand-over?** Recommended: a settlement-free `handOver(msgId)` on the outbound
  runtime and send controls (abort the live attempt, complete every later effect of the msgId silently,
  **end the RTC pending-ACK row** with a delete commit) — no `cancelled` is stated, and the reducer
  ignores acknowledgements from a carrier the handle has left, so a late RTC ACK cannot overwrite the
  WS receipt evidence. The WS re-admission carries `canFallback: false`, the same msgId and
  `expiresAtMs`, and a `carrier-fallback` evidence row `{ from: 'rtc', to: 'ws', reason }`.
  Alternative: reuse `cancel` and filter the `cancelled` settlement in the registry (keeps the reducer
  dishonest about what happened).
- **Q4 — "Consecutive not-ready" and its constant.** Recommended: counted per message in the registry
  hook as `attempt-settled not-ready` facts across the message's send-prepared rows, reset by any
  `sent`/`acknowledgement`; `AL_FALLBACK_NOT_READY_ATTEMPTS = 3` beside the retryable list in
  `packages/shared/alm/delivery/`. Alternative: count per send-prepared row (a two-hop room send would
  need six).
- **Q5 — `rate-limited`.** Recommended: it joins the admission-time fallback verdicts (one case in
  `isFallbackVerdict`); the post-admission controller never sees it. Cost: a rate-limited RTC burst
  moves to WS at once instead of failing.
- **Q6 — `receipt-exhausted` where no fallback remains (plain `rtc`, plain `ws`, or the WS leg after a
  hand-over).** Recommended: a **terminal** settlement carrying `confirmedPeerIds`/`unconfirmedPeerIds`
  — the roadmap's typed rejection letter — and the pending-ACK row is deleted in the same commit, so
  exhaustion settles exactly once across replays and reloads with no persisted marker (no schema
  bump). Cost: a late ACK inside the remaining deadline no longer completes the message (the budget
  ends ≈8 s into a 30 s TTL). Alternative: non-terminal `receipt-exhausted` state, row kept to the
  deadline, late ACKs still complete — exactly-once then needs a persisted marker (schema bump
  `rallar-alm-2026-10-s3b`).
- **Q7 — The WS `hop`/`subtree` receipt (R-S3a-4 carry).** Recommended: **deferred to S3c behind
  D57** — the origin cannot name the server hop until a client learns a server id; S3b keeps the
  downgrade evidence. Alternative: a trusted-server alias counted from `source === 'trusted-server'`
  now (a new `ackTracking` field → schema bump).
- **Q8 — The frozen audience on WS.** Recommended: accept the server's narrowing of its current room
  to the frozen set (D43 holds per carrier; a leaver drops out of the WS receipt) and record it as
  applied on D56. Alternative: the WS server adopts the frozen set verbatim and reads leavers
  unconfirmed (a server change; the sink to report it is S3c's).
- **Q9 — Durable RTC messages resumed after a reload.** Recommended: no fallback — a resumed
  `local-outbox` message has no live handle; post-admission fallback is for the page's own handles.
  Stated as a limitation in the README and the product description. Alternative: a resumed-message
  candidate rebuilt from the sent snapshot (needs the context and epoch persisted → schema bump).
- **Q10 — The five existing fallback cells.** Recommended: their scenario expectations stay
  (delivered / expired as today) and only their evidence moves (arrival carrier `ws` after a
  hand-over, the attempt carriers); every moved pin is named in the PR body with the figure. The plan
  re-reads them in the scenario task, not before.
- **Q11 — Gates.** Recommended: the medium-scale Postgres gate runs once only if a
  `ws-queue-box-server/**` file changes (none is planned); the per-task set, the full lanes, hosted
  smoke and ≤2 hosted full reads (D51) as in S3a.
- **Q12 — Harness.** Recommended: no new RTC fault kind; `messages.observe` gains `attemptCarriers`
  beside `attemptOutcomes`; the three scenarios `fallback-within-deadline` (RTC `drop` until cleared →
  WS arrival inside the deadline), `receipt-exhausted-fallback` (receiver holds its RTC ACK → hand-over
  after the budget → WS receipt) and `no-fallback-after-deadline` (a short TTL that ends before the
  third not-ready → `expired`, no WS arrival) on the `rtc-with-ws-fallback` cell of the two-agent
  family; manifest 18 regenerated.

**Task cut under the recommendations** (six tasks): every receipt end settles; the retryable list, the
constant and the hand-over; the fallback controller; harness evidence (attempt carriers); the three
scenarios and the five re-reads; docs and the D56 record.

## 10. S3c execution questions and decisions (2026-09-28)

Written after S3b merged (bdb3ecd8b, #604), from a fresh code survey of the unicast, server-target, server
publish, volatile-store and game-intent paths (session scratchpad `s3c-code-survey.md`; 20 corrections to
§1.4/§2.3, the material ones folded into the questions). The recommended answer is first in each case. **Settled 2026-09-28: the maintainer took every recommended
answer, Q1–Q13** (roadmap: D57 "As applied", D70–D78); the S3c-i plan is written under them.

**What the survey changed in §2.3's picture**

- The RTC carrier already plans a direct unicast to a directly ready peer; a relayed RTC unicast is refused
  at the receiver. What is missing is the sender and typed-channel path; the fallback dispatch and
  controller are target-agnostic, only `sendRoomWithFallback`'s room gate is sender-side.
- Room-topic WS unicasts are never delivered on the Rallar server today (`forwardsRoomScopedMessages:
  false`; a client-to-client unicast on a `room.*` topic is admitted but neither forwarded nor delivered to
  the router) — this includes the director relay's WS fallback. D53 and D60 need it fixed first.
- "The server aggregates a one-member audience" is not a flag flip: aggregation requires an authorizer
  room audience, `toFrozenAudience` expects the whole room, an out-of-audience addressee completes
  vacuously, and the addressee's ACK is refused at server ingress.
- No connection state carries a server id: the server peer id is the constant `'default-qbox-server'` on
  every cluster instance; Relic's snapshots use `'relic-hunter-server'`. A `unicast` to the server id
  already reaches the router as a local delivery with no wire change; a `server` mode + envelope v3 touches
  two decoders, seven constructors and ~73 `targets.mode` sites.
- The server withholds its own ACK for every room-scoped message, so a `room.relic.command` to the server
  would be aggregated over the room unless exempted; "receipt" from the server means admitted to its inbox,
  not applied (rule errors throw through the handler today and are retried).
- Relic snapshots are room broadcasts without `groupRef` and cannot go through `fanout: 'outbox'` as built;
  "freeze the room's current sessions at publish" cannot reuse the room authorizer (it checks the sender's
  membership); cluster delivery drops the audience in two places, not one.
- The volatile pair keeps sent snapshots and owner rows for `max(deadline, now + 60 min)`; a count or byte
  bound over the raw pair measures retention, not load. A congestion drop becomes `skipped/planner-drop`;
  no `capacity` refusal reason or drop code exists.
- Match start never travels a carrier (director-local); only pickup, the two combat intents and
  `requestSync` (which shares the transport) move. The director's RTC subscriptions exclude the intent type
  ids. The zero-`al-admission` intent pin cannot live in the app tests (mocked facade).
- An S3a pin (`sendWsUnicast` best-effort with no `delivery`, "until S3c") flips.

**Questions**

- **Q1 — One PR or two?** Recommended: **two** — S3c-i "addressed sends and server receipts" (D53, D57,
  D58, D61; the Relic cutover as its proof; ~5 tasks) then S3c-ii "the director command and the volatile
  bound" (RTC unicast + unicast fallback, D60, D59, the lane scenarios; ~5 tasks). S3c-ii depends on
  S3c-i's WS unicast delivery and receipt. Alternative: one PR of ≥10 tasks.
- **Q2 — The `server` target's shape (D57).** Recommended: **a `unicast` to the learned server id** — no
  envelope version bump, no new mode, reaches the router as a local delivery today; the server-side
  exemptions (keep the server's own ACK, open no aggregate for a server-addressed message) are the same
  either way; D57 recorded "as applied". Alternative: `mode: 'server'` + envelope v3 as decided (~35 files
  gain a case; both decoders accept {2, 3}; a schema bump if v3 persists). Cost of the recommendation: no
  type-level "this goes to the server" marker on the envelope.
- **Q3 — How a client learns the server id.** Recommended: **a field on `/api/config`** (the id is a
  cluster-wide constant today). Alternatives: a server-to-client frame on open (D57's "connection state"
  wording; needed only once the id becomes per-instance), or the auth/ticket response.
- **Q4 — Room-topic WS unicast delivery.** Recommended: the server becomes a logical recipient of an
  authorized room-topic unicast so the **router publishes it per topic fanout** (router-owned, like every
  other room delivery). Alternative: allow forwarding for unicasts only.
- **Q5 — D53 aggregation rules.** Recommended: `toFrozenAudience` gets a unicast case (the addressee
  alone); a `receiver` unicast on a non-room topic is **refused** (no second aggregate source in S3c); an
  addressee outside the authorized audience is refused, not completed; the client plans
  `expectedPeerIds: []` and the server's `admitted` receipt names `[toPeerId]`.
- **Q6 — Relic command semantics.** Recommended: the WS handler catches rule errors (no inbox retry
  loop), the server derives `username` from the session instead of the payload, REST stays one release
  as the fallback, and the UI's rule-error text (the "no review to continue" branch) is a stated
  regression until a reply channel exists; per-game serialization stays process-local (recorded).
  Alternative: keep REST for the commands that need the rule-error text.
- **Q7 — The snapshot publish (D58).** Recommended: `groupRef` added, `senderId` = the server peer id,
  `ack: 'receiver'` at-least-once, the audience frozen from a server-side live-sessions read passed as the
  admitted audience; the 15 s TTL stays. Alternative: raise the TTL to the notification default.
- **Q8 — The settlement sink (D58/D61).** Recommended: a **bounded in-memory per-process recorder**
  beside the formation metrics, exposed on `/api/admin/operations/realtime` (already process-local): per
  msgId the confirmed/unconfirmed sessions, the last settlement kind, `receipt-exhausted`. No durable row,
  no migration. Alternative: a Postgres row (a migration and an AppInbox path).
- **Q9 — The volatile bound (D59).** Recommended, in order: (1) **shorten the volatile pair's retention
  to the message deadline plus the receipt grace** (closes the 1 h carry); (2) one per-session counter
  shared by the two outbound pairs and the inbound pair, counting admissions and envelope bytes, controls,
  receipts and ACKs exempt, named constants `AL_VOLATILE_SESSION_MAX_ADMISSIONS = 1_000` and
  `AL_VOLATILE_SESSION_MAX_BYTES = 4 MiB` (tunable; the lane lowers them through a connect field); (3) a
  new refusal reason `capacity` + drop code `refused/capacity` surfaced as the `carrier-refused` end
  settlement — **not** a fallback trigger; (4) `overloaded` through `qosProvider.liveForMessage`; the
  relay-row retention figure recorded in the same task. Alternative: keep the 1 h retention and count only
  rows inside their deadline.
- **Q10 — D60 scope.** Recommended: pickup, the two combat intents **and `requestSync`** move to the
  `command` channel unicast to the director (they share `transport.sendIntent`); match start stays
  director-local (it never travels). The director's RTC subscriptions gain the intent and sync-request
  type ids; the director's handlers already dedup by msgId (a 30 s at-least-once replay of a stale pickup
  is verified idempotent in the task). Alternative: `requestSync` stays on the realtime lane.
- **Q11 — The typed-channel unicast surface.** Recommended: a **per-send target option `{ peerId }`** on
  the existing typed channel (purpose defaults with a logical audience), no new channel factory; public
  API snapshots move. Alternative: a `unicast(peerId)` channel factory.
- **Q12 — Carries in or out.** Recommended: IN S3c-i — leavers read unconfirmed on the WS leg (cheap once
  the sink exists); IN S3c-ii — the empty-audience volatile pin, and a typed `evidence.failure`
  discriminator (with `refused/capacity` a third failure meaning would otherwise be read from prose); OUT
  (V1) — post-admission fallback for `ws-then-rtc` and for a resumed durable message.
- **Q13 — Gates.** Recommended: the medium-scale Postgres gate runs once in S3c-i (server mutation paths:
  the router-published unicast, the server outbox publish, the sink) and only on a
  `ws-queue-box-server/**` change in S3c-ii; hosted smoke on both PRs; ≤2 hosted full reads each (D51).

**Delivered** by PR #605 (`claude/alm-s3c-consumer-proofs-volatile-bound`); the rulings recorded during execution,
R-S3c-i-0 through R-S3c-i-33, live in the plan's "Rulings during execution"
(`plans/alm-s3c-i-addressed-sends-and-server-receipts-implementation-plan.md`).

## 11. S3c-ii execution choices and rulings (2026-09-28)

Written after S3c-i merged (`322c50854`, #605), on the branch of PR #606, from the post-S3c-i code survey. The
decisions are the maintainer's of 2026-09-28 (D60, D70, D74, D75, D78; §10 Q9–Q13). The survey found fourteen
corrections to §10 and eleven questions those decisions leave open; the plan answered them as choices C1–C17, each
the survey's recommended option (R-S3c-ii-0). The maintainer reviews them with the PR and may overturn any of them.
The texts below are the plan's, kept here because the pull request that finishes the plan deletes it
(`plans/active/alm-s3c-ii-director-command-and-volatile-bound.md`); roadmap D91–D94 record the outcome.

### 11.1 The survey's corrections to §10

1. The rows the volatile pair keeps for an hour are the sent-message and message-owner rows (reference, captured
   policy, ids), not the envelope, which expires at the message deadline. A count bound over the raw pair measures
   retention; a byte bound mostly does not. The budget therefore counts admissions by their own envelope bytes and
   releases them at their own deadline (C4), and the retention rule is fixed first (C5, Task 2).
2. An RTC room unicast is also checked at dispatch against the server topology edge. An addressee that is
   RTC-connected but not the origin's overlay next hop settles `not-ready` on every attempt and falls back after
   `AL_FALLBACK_NOT_READY_ATTEMPTS` (3); it does not read `no-route` at admission.
3. An RTC unicast on a `room.*` topic without `groupRef` is refused `unauthorized` at admission, which is no fallback
   trigger. The RTC unicast names its room.
4. `carrier-refused` is never an end settlement. It is evidence of a hand-over. A refusal outside the fallback list is
   an `admission` settlement that ends `rejected`, and its typed reason is dropped today (C1, C2).
5. The director does not dedup by message id. The game layer refuses a lower sequence as `stale-sequence` across all
   intents of one sender, so a retried or fallback-reordered intent is dropped while its receipt reads `acknowledged`
   (C10).
6. Under default QoS `overloaded` drops only best-effort messages, the WS outbound path never consults it, and the
   product facade installs no provider (C13 states the limits).
7. The "relay row" is the RTC relay peer's inbound pending-ACK row in the browser, kept until the message deadline; no
   figure for it is recorded anywhere (C14).
8. "One `command` channel" needs two typed channels, because a channel fixes one `typeId` (C12). The
   `GAME_DIRECTOR_*_TYPE_ID` constants are unused.
9. The public API snapshots pin export names only, so `peerId` on an existing input moves no snapshot.
10. The medium-scale gate runs in CI on any `packages/shared/**` change; the `ws-queue-box-server/**` rule of Q13 is
    plan policy for the local run.
11. The director relay's WS fallback is refused by authorization (it names no room), and the relay still reports
    `sent` (C15).
12. Without a subscription for the intent type ids on the ALM RTC inbox, an RTC command is acknowledged and then
    parked until it expires (Task 5).
13. The lane cannot name a peer, and no connect field lowers a setting (C11).
14. N1, "refuse a peer send whose `contextId` differs from its room at the sender", was parked in the S3c-i re-review
    and is recorded nowhere in the repository (C8).

### 11.2 Choices the plan made inside those answers

| Choice | What it decides                                                                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1     | `capacity` joins `ALDeliveryRefusalReason` and `ALOutboundDropReasonCode`; a refused admission ends `rejected`; `capacity` stays out of the fallback lists; D78's "as `carrier-refused`" is recorded as applied "`rejected` with `evidence.failure`". |
| C2     | `evidence.failure` is the discriminated union `ALDeliveryFailure`, set by the reducer; `receipt-exhausted` states a typed cause at its two producers.                                                                                                 |
| C3     | The budget is created per session in `initialise-browser-middleware.ts`, handed to the three volatile pairs, and read by a per-session QoS provider that wraps the application's.                                                                     |
| C4     | The budget counts data admissions the session originates or receives; controls, receipts, ACKs, NACKs, repairs, retransmissions and relay forwards are exempt; each is released at its own message deadline.                                          |
| C5     | Volatile retention is a rule in the row writers: deadline plus `AL_RECEIPT_DEADLINE_GRACE_MS`. Durable rows keep today's rule.                                                                                                                        |
| C6     | Only the sender's outbound admission refuses over the bound; an inbound admission is counted, never refused.                                                                                                                                          |
| C7     | `RallarRtcSendInput` is unchanged; `peerId` is accepted on the typed `send` for `ws`, `rtc`, `rtc-with-ws-fallback`; `ws-then-rtc` with a `peerId` stays refused (V1).                                                                                |
| C8     | A peer send whose `contextId` differs from its room is refused at the sender, for every strategy (N1).                                                                                                                                                |
| C9     | A peer send to the server id is refused `unsupported` on `rtc` and `rtc-with-ws-fallback`; the server-unknown refusal also covers `rtc-with-ws-fallback`.                                                                                             |
| C10    | The director accepts client intents out of order: an equal sequence is a duplicate, a lower one is accepted. Director outputs keep the stale rule.                                                                                                    |
| C11    | The lane names a peer by role (`toPeer`: `server` or `receiver`, as amended by R-S3c-ii-2); a lane-only connect field lowers the volatile bound, never a public connect option.                                                                       |
| C12    | Intents and sync requests use two typed `command` channels on the existing derived type ids.                                                                                                                                                          |
| C13    | `overloaded` is true while the budget is at or over either limit; its stated limits are correction 6. R-S3c-ii-8 narrows it to the session's own outbound data.                                                                                       |
| C14    | The relay-row retention figure is measured by a test and recorded in the inbound README and the roadmap.                                                                                                                                              |
| C15    | `sendWsUnicast` and the realtime targeted leg for intents are deleted; the S3a pin is replaced.                                                                                                                                                       |
| C16    | No persisted shape changes; the schema id stays.                                                                                                                                                                                                      |
| C17    | Envelope bytes come from the existing walk, exported as `computeALMessageEnvelopeBytes`.                                                                                                                                                              |

### 11.3 Alignment with the QoS plan (PR #606, D83–D90)

- **One vocabulary.** `capacity` is a refusal reason read through `evidence.failure`. I2a's `storage-unavailable`
  becomes one more reason on the same union; no second failure surface is added.
- **One retention rule.** `computeALReceiptRetentionExpiryMs`
  (`packages/shared/alm/delivery/compute-al-receipt-retention-expiry-ms.ts`) is the rule "deadline plus the receipt
  grace". I2a's dedup retention (QoS plan §5) reuses it.
- **The bound is the checkpoint basis.** `AL_VOLATILE_SESSION_MAX_ADMISSIONS` and `AL_VOLATILE_SESSION_MAX_BYTES` are
  the figures the QoS plan's H4 measured a checkpoint at. They stay named constants behind `ALVolatileSessionLimits`,
  so I2b can extend the budget to `local-checkpoint` admissions without a second counter.
- **`onStorageUnavailable: 'volatile'`** (I2a) admits into the volatile pair, so such a send counts against the budget.
- **Storage budgets.** The volatile zero pin (D55, D87) is extended to the director intents (Task 5) and the
  empty-audience send (Task 2).
- **Sequencing.** The QoS plan's §10.3 holds: it lands no ALM code beside S3c. S3c-ii is the one active slice; P1 and
  I2a start from `main` after it merges.

### 11.4 Rulings during execution

- **R-S3c-ii-0 (pre-execution, 2026-09-28).** D60, D70, D74, D75 and D78 stand as decided. The eleven questions the
  post-S3c-i survey found open are answered by C1–C17, each the survey's recommended option, without a question round:
  the maintainer asked for the plan to be written and executed on PR #606, and had taken the recommended option on all
  twenty-five earlier S3b and S3c questions. Cost if wrong: the maintainer overturns a choice in review and the task
  that applied it is reworked; C10 (the director accepts intents out of order) and C1 (D78 as applied) are the two
  that change stated behaviour, and the PR body leads with them.

- **R-S3c-ii-1 (plan writing, 2026-09-29).** D74's retention covers every row of the volatile pair that carries a
  message deadline: the owner and sent-message rows, the inbound owner row, the outbound control-history rows, a
  completed receipt row and the relay's inbound ACK-history row. Two rows keep their lifetime, and Task 2 says why: the
  per-origin version row (one row per origin, it fences every commit of that origin, shortening it allows ABA) and the
  ACK-history row of a relay row whose message named no deadline. Cost if wrong: a late control inside the old window
  and outside the new one is dropped as unknown instead of answered.
- **R-S3c-ii-2 (plan writing, 2026-09-29).** C11 is amended: `toPeer` is `'server' | 'receiver'`. The room roster
  carries no role, the three-agent lane starts both recipients in parallel and hosted agents may share one user, so
  nothing in the page tells the two recipients apart; the four scenarios run on two agents and manifest 22 does not
  change. Manifest 18's `recommendedTerminalTimeoutSeconds` rises from 300 to 1 200: the receiver's absence windows
  alone take 530 s in the generated manifest (360 s of `messages.received` windows and 170 s of absent `wait`s; the
  plan stated 513 s), so 300 s never held (the concern PR #604 carried). R-S3c-ii-9 raises it to 1 800 s.
  Cost if wrong: a hosted run that hangs is cut off later.
- **R-S3c-ii-3 (plan writing, 2026-09-29).** Inbound data counts toward the same session limit as outbound data (C4,
  C6), so a busy receiver can have its own volatile sends refused `capacity`: at the 30 s default deadline that starts
  above about 33 messages a second, in and out combined. A counted send whose commit admits nothing stays counted until
  its deadline (the ledger has no release call). A message without a deadline (RTC signalling) is not counted. The RTC
  circuit breaker does not count a `capacity` refusal as a failure, or repeated refusals would open it and leak
  over-bound sends to WS as `circuit-open`. Cost if wrong: the limits are named constants behind
  `ALVolatileSessionLimits`; raising them is one line.
- **R-S3c-ii-4 (plan writing, 2026-09-29).** The director relay reports `sent` only when the director's receipt
  arrives (it waits for `acknowledged`, at most 30 s); that is the only reading under which a refused command stops
  reading `sent`. The arena-join sync request, the one awaited caller, becomes a best-effort task so a slow receipt
  does not hold the join. Call signalling, the second caller of `sendWsUnicast`, moves to
  `messages.ws.send({ scope: 'all', peerId, contextId: callId, reliability: 'best-effort' })`. AL dedup is per carrier
  lane, so a relay command can arrive twice after a fallback: relay commands are at-least-once and the game's sequence
  tracker refuses the duplicate. Cost if wrong: intents report later than today; the wait bound is one constant.
- **R-S3c-ii-5 (pre-flight scan, 2026-09-29).** The four addressed scenarios run as their own two-agent family in the
  Playwright lane, one test per carrier under the fixed `CARRIER_TEST_TIMEOUT_MS`. Added to the baseline family they
  bring the `rtc-with-ws-fallback` cell to about 465 s of 480 s, which leaves no margin on a slow page. Cost if wrong:
  the full scope runs three more tests, and the hosted observation job, whose 30-minute timeout already does not fit
  the full scope on slow runners, takes longer still.
- **R-S3c-ii-6 (Task 3 review, 2026-09-29).** An inbound admission is counted until the earlier of its deadline and
  30 s after its arrival (`AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS`); an outbound admission keeps its own
  deadline. The inbound deadline is the sender's clock and the sender's choice, so a peer whose clock runs ahead, or who
  names a far deadline, must not keep this session's own sends refused `capacity`; the envelope is delivered at once
  and only small rows stay. Cost if wrong: long-lived inbound messages are undercounted, and they are never refused
  anyway (C6).
- **R-S3c-ii-7 (Task 6 review, 2026-09-29).** The session's volatile bound is shared with the platform's own traffic.
  State sync the WS inbound runtime admits on the volatile pair (`group-state.event`, `client-state.snapshot`,
  `client-state.event`) is a data admission the session receives (C4), so it counts, for at most 30 s (R-S3c-ii-6). A
  lane agent that leaves and rejoins a room holds about 26 KB of it. At the production limits that is under one per
  cent, so it is a stated limit and the code stays. Exempting platform topics from the application's bound is the
  maintainer's decision; the PR body names it. Cost if wrong: an application close to its bound is refused slightly
  earlier than its own traffic alone would cause.
- **R-S3c-ii-8 (final review, 2026-09-29; amends C13).** `overloaded` is reported only for the session's own outbound
  data originations: never for a control, a receipt, an acknowledgement, a repair, a relay forward or an inbound plan.
  At the RTC origin the handling-plan drop `overloaded` maps to the drop code `capacity`, so every send over the bound,
  best-effort or not, on either carrier, ends `rejected` with `failure` `{ kind: 'refused', reason: 'capacity' }` and is
  never handed to a fallback. As first built, the signal reached every planner: a session at its bound stopped
  acknowledging over RTC, a relay dropped other sessions' best-effort forwards, and best-effort arrivals were held back.
  Cost if wrong: none for delivery; the congestion aspect's other policies are V1's.
- **R-S3c-ii-9 (final review, 2026-09-29; amends R-S3c-ii-2).** In manifest 18 the `capacity` blocks run last on each
  carrier. The scenario waits 31 s after its lowered-limit reconnect, so the platform's state sync admitted at the
  rejoin has left the budget before the first send. The manifest's terminal timeout is 1 800 s. Hosted agents keep
  their pages and share a long-lived room, which the local lane does not reproduce. Cost if wrong: a hosted run that
  hangs is cut off later.
- **R-S3c-ii-10 (final review, 2026-09-29).** Source comments state a non-obvious invariant, an external constraint or
  a deliberate tradeoff, and nothing else. They name no plan, choice or ruling id, because the plan file is deleted
  before the merge; a roadmap decision id may stay where it names the reason for an invariant.
- **R-S3c-ii-12 (hosted read, 2026-09-29).** The first hosted run of the regenerated manifest 18 failed in its reload
  block because the control server fell behind the agents: on every incoming diagnostic it re-segmented the full
  recipes, and the `capacity` filler had doubled the manifest. The filler shrinks to 12 000 bytes against a limit of
  36 000, and the control server recomputes dispatchable commands only on register, result, heartbeat and barrier
  events and keeps each root's reload segments. A timeout is therefore noticed at the next heartbeat, at most 10 s
  late. Cost if wrong: a failure is reported later, never a success.
- **R-S3c-ii-14 (hosted read, 2026-09-29).** Manifest 18 withholds `delivery-reload` on `rtc` and
  `rtc-with-ws-fallback`. With the control server no longer lagging, the RTC redial gap of issue #594 shows on every
  hosted run: recovery after a reload takes the 30 s establishment timeout, longer than the scenario's 27 s wait. A
  redial of the kept peer was tried and reverted, because a peer that returns under the same session id still receives
  the old offer late, and its answer then lands on the new connection. The complete fix is an offer and answer
  correlation on the wire, which is the maintainer's decision. `deadline-expiry` held its message back with a fault
  counted in frames, which a fast agent used up inside the lifetime; its faults now hold until released. Cost if
  wrong: hosted runs do not cover a reload over RTC until issue #594 is fixed; the local lane still does.

### 11.5 What was built and measured

- **Retention (R-S3c-ii-1).** On the volatile pair the owner row, the sent-message row, the inbound owner row, the
  outbound control-history rows, a completed receipt row and the relay's inbound ACK-history row expire at the
  message deadline plus the receipt grace. The per-origin version row keeps its hour (one row per origin; it fences
  every commit of that origin), and the ACK-history row of a relay row whose message named no deadline keeps its 30
  min (`controlHistoryTtlMs`). An RTC relay holds 5 rows for one relayed volatile message after admission and 6 once
  its child's ACK adds the ACK-history row (C14; the inbound README).
- **The bound (R-S3c-ii-3, -6, -7).** An outbound admission counts until its own deadline, an inbound one until the
  earlier of its deadline and 30 s after its arrival (`AL_VOLATILE_SESSION_INBOUND_COUNTED_LIFETIME_MS`). Inbound
  data counts toward the same limit, so a receiver above about 33 volatile messages a second, in and out combined,
  has its own sends refused `capacity` at the 30 s default deadline. A message without a named deadline is not
  counted; a counted send whose commit admits nothing stays counted until its deadline; the RTC circuit breaker does
  not count a `capacity` refusal as a failure. The platform's state sync received on the volatile pair
  (`group-state.event`, `client-state.snapshot`, `client-state.event`) shares the bound: about 26 KB for a lane
  agent that leaves and rejoins a room, under one per cent of the production limits. Exempting platform topics is
  open for the maintainer.
- **`overloaded` (R-S3c-ii-8).** It is reported for the session's own outbound data originations only; a control, a
  receipt, an acknowledgement, a repair, a relay forward and an inbound plan never read it, so a session at its bound
  still acknowledges, forwards and delivers. At the bound every send, best-effort or not, on either carrier, reads
  `capacity`: it ends `rejected` with `{ kind: 'refused', reason: 'capacity' }` and is never handed to a fallback. The
  RTC rate limiter spends its token before the plan, so a burst of refused sends can hand a later send inside the bound
  to WS as `rate-limited`; the shared budget admits it there.
- **The director command (R-S3c-ii-4).** The relay reports `sent` only when the director's receipt arrives, waiting
  at most 30 s; a command the typed send refuses (`RallarValidationError`) is a `failed` result, not a throw, and any
  other error from the send still propagates. After a
  fallback a relay command can reach the relay's `onIntent` twice (at-least-once) and the game's handler once,
  because the game's sequence tracker refuses the duplicate. The game accepts client intents out of order: per key, a
  sequence it has seen is a duplicate, and one 1 024 or more below the highest it accepted is stale.
  Call signalling travels `messages.ws.send` with `scope: 'all'` and needs a server that names its peer id.
- **The lane (R-S3c-ii-2, -5).** `toPeer` is `server` or `receiver`, and `toPeer: 'server'` is a WS-only target. The
  four addressed scenarios run as their own two-agent family, and manifest 22 is unchanged. Manifest 18 runs the three
  `capacity` blocks after every other block, and the scenario waits 31 s after its lowered reconnect before it sends
  (R-S3c-ii-9); it runs `delivery-reload` on `ws` only (R-S3c-ii-14). The generated manifest's receiver absence
  windows sum to 496 s and the sender's three waits to 93 s; summed over its 37 blocks, the larger role's command
  budgets come to about 6 890 s, so the 1 800 s terminal timeout is a typical-case budget, not a worst case. The director orchestration spec (`npm run test:rallar:full-stack:memory:director`) was stale on
  `main` (it used retired group routes and is in no CI lane); S3c-ii revived it and it passes, which is the
  end-to-end proof of the receipt-gated `sent`.
- **Figures.** Bundle ceilings after S3c-ii: facade 226 KiB (225.2333984375 measured), headless 289 KiB (288.51171875
  measured); before the slice 224 and 286. Every volatile send, the director intents and the empty-audience send
  included, spends 0 `al-admission` and 0 non-probe `al-work` operations; no durable pin moved.
  `AL_ADMISSION_SCHEMA_ID` stays `rallar-alm-2026-09-s3c-i` (C16).
