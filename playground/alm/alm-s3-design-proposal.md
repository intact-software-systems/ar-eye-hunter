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
(`use-arena-world-actions.ts:62-95`). The browser has no ALM RTC unicast (every RTC typed send is a
room multicast, `:310-340`), `receiver` on a WS unicast is refused (D42, kept by R-S2c-ii-0), and the
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
  the shared engine. Cleanup and reset learn the memory pair (a reset is a no-op there).
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
   second owner per carrier on the shared engine.
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
