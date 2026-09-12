# ALM S1 design proposal — delivery lifecycle and handle

Prepared 2026-09-11 against `claude/alm-f2-work-owner` head `6f01cae7d` (F2 plus `main` `bf67bacb9`).
Read-only survey; a proposal for approval or redirection, not a plan and not code.
F2 has since merged as `f8db93762` and F2b as `a336ad41c` with no change to the surfaces named here.
Status: the seven questions of section 4 are settled (D9 to D16, 2026-09-12); the S1 implementation
plan `plans/alm-s1-delivery-lifecycle-handle-implementation-plan.md` argues from them.

## 1. The problem

A caller who sends a typed message receives one value, once, and never hears from the message again.
`toRallarMessageSendResult` (`packages/shared-web/browser/messages/browser-rallar-message-sender.ts:330-342`)
is a field-for-field copy of the admission result, so the public `RallarMessageSendResult`
(`browser/messages/rallar-message-contracts.ts:68-75`) is literally the admission snapshot; its
`status` is `ALOutboundEnqueueStatus` (`packages/shared/alm/outbound/al-outbound-message-runtime.ts:184-195`),
eleven literals mixing an admission verdict (`enqueued`, `accepted`, `duplicate`, `skipped`,
`pending-admission`) with a policy rejection (`rate-limited`, `circuit-open`, `no-route`) and with
terminals only sometimes already true at that instant. Two of those eleven are recovered from free
text: `toALOutboundEnqueueStatusFromReason` (`compute-al-outbound-dispatch.ts:297-326`) sniffs
`plan.dropReason` with `normalized.includes(...)`. Everything the runtime learns afterwards is
computed and then dropped. The clearest instance: the transport settlement
(`ALOutboundSettledSendResult`, seven literals) reaches `computeALOutboundSendDisposition`
(`alm/outbound/al-outbound-message-effects.ts:178-196`), which collapses all seven into an
`ALWorkOutcome` of `completed`/`retry`/`not-ready` and **emits nothing**. The only per-message
terminal transport outcome in the system is a local variable that is thrown away. The product
description names the same gap — the result is "an admission snapshot" with "no observable delivery
lifecycle or cancellation" (`playground/alm/alm-complete-product-description.md:115-119`) — and the
roadmap's matrix carries it as F1, F17, and PC3 open.

S1 blocks three other commitments, and the raw material is thinner than it looks. F1 shipped the
black-box ledger with the nine-state union S1 targets, but it can only write a few of them honestly:
`toDeliveryObservationState` (`black-box-runner/browser/rallar-browser-runtime/messaging-controller.ts:169-188`)
folds admission statuses on the way in, `refreshDelivery` (:725-747) flips `queued → accepted` once by
polling `hasMessageAdmission` at 25 ms, `cancelDelivery` (:749-756) relabels a row without reaching the
transport, `attempts` is hard-coded `1` at both construction sites, `confirmedPeerIds`/`unconfirmedPeerIds`
are literal `[]` (:215-216, :225-226), and **`transport-accepted` and `acknowledged` are never produced
by any path**. S3's delivery-level fallback cannot be written first: `computeFallbackDisposition`
(`browser-rallar-message-sender.ts:319-327`) fires only on `no-route`/`circuit-open`, decided at
admission. D4's authority client has nothing to await. Critically, **F2 did not leave a settlement
stream to consume.** Its outbound diagnostics union has six variants
(`al-outbound-message-runtime.ts:122-178`); only `commit-phases` carries `msgId`/`typeId`/`origin`, it
fires exactly once per admission commit (`al-outbound-dispatch-admission.ts:126`), and it reports
`commitOutcome` (`committed|conflict|expired|not-attempted`) — not the enqueue status, never the
transport settlement. `readiness-probe`, `effect-drain`, `sender-queue-wait`, and the two lock events
carry no message identity. Inbound `admission-outcome` carries `msgId` but is ingress-side only. And
the sink itself is a single constructor-injected function (`ALOutboundRuntimeDiagnosticsSink`,
:180-182) with no multiplexing, no unsubscribe, and a no-op default in the browser
(`browser/connection/rallar-diagnostics-ports.ts:32-38`) — a diagnostics tap, not a delivery channel.
S1's first job is therefore to _create_ the per-message settlement stream, not to project an existing
one. The consolation is that the consumer side is far smaller than the roadmap's "apps updated
together" implies: of 22 files referencing `RallarMessageSendResult`, exactly one outside
`packages/shared*` is non-test (`apps/rallar-black-box/src/direct-rallar-operations.ts:48,721`) and it
never reads `.status`; both games reference the type zero times; real status branching lives in three
shared files (`browser-rallar-message-sender.ts`, `browser/director/browser-director-relay-transport.ts:122`,
`game/match/match-capability.ts:76-81`). The status union is not even a shared-web public export.

## 2. Approaches

All three deliver the same ten states and handle verbs, and all three must build the settlement
stream. They differ in where per-message state lives — which decides reload behaviour, storage cost,
and how many times the states get declared.

### A. Lifecycle projected into a handle owned by the messaging controller

**State.** A new in-memory owner under `packages/shared-web/browser/messages/`, keyed by msgId with
bounded retention, constructed by `createBrowserMessagingComposition`
(`browser/composition/browser-communication-composition.ts:69`). Nothing persists.

**Feeds.** A new multiplexed per-message event channel beside the existing single diagnostics sink
(overloading that sink would collide with the server's `formation-metrics.ts:189-198` consumer and
the harness's `alm-observation-snapshot.ts`, which already drops `msgId`). Both carrier runtimes,
reached through `RallarBrowserMiddleware` (`rallar-connection-facade.ts:38-46`), emit into it; the
browser owner reduces the stream.

**cancel().** Smaller than it appears: `QRtcDataChannel` already accepts a per-send `AbortSignal`
(forwarded at `multicast/web-rtc-overlay-multicast-manager.ts:732` as `lifecycle.signal`), and ALM is
the layer that collapses it — one runtime-wide `sendAbortController` aborted only in `dispose()`
(`al-outbound-message-runtime.ts:274,355`), so `status: 'cancelled'` today means exactly "the runtime
was disposed". S1 narrows an existing seam rather than adding one.

**Terminal promise and subscription.** No new primitive. `onEvent(listener): RallarUnsubscribe`
mirrors `rtc.onLifecycle` (`rallar-rtc-facade.ts:215`); `wait(options?: RallarWaitForOpenOptions)`
mirrors `rtc.waitForOpen` and `RallarCallHandle.wait()`, reusing `{ timeoutMs, signal }` (:37-40).

**Reload and reconnect.** On reload the registry is empty and the handle is gone — but the _message_
is not. ALM storage is namespaced by the persisted session (`browser-al-runtime-identity.ts:12-32`),
so a reload keeping the same `AuthSession` re-derives the same namespaces, and `ALWorkHandler.ready()`
runs one cold batch (`alm/work/al-work-handler.ts:143-153`) that re-claims `RESERVED` rows whose
10 s lease expired with the previous page life. **The work resumes; only the observation is lost.**
A handle that resolved `failed` on reload would therefore be a lie of the exact kind the product
forbids ("no receipt means unconfirmed, not proof of non-delivery"). The middleware is per-connection
while the controller outlives it, so the subscription is re-established at every connect and
old-connection events must be epoch-fenced; the harness already assumes this shape
(`resetDeliveryLedger` in `#cleanupRuntimeSubscriptions`: "Handles are per-connection").

**Late events.** A terminal guard in the reducer: once terminal, a later event becomes evidence and
never changes state.

**Public surface, cost, size.** `send()` returns the handle; `RallarMessageSendResult` leaves
`rallar.ts`, `rallar-core.ts`, `rallar-messages.ts`; the ledger becomes an event projection. Zero new
IndexedDB operations. Large, concentrated in the event stream rather than the consumers.

### B. Durable per-message lifecycle row in the admission store

**State.** A persisted lifecycle record in the ALM admission store. Less exotic than it sounds: the
key layout already has a per-message delivery-state row, `${namespace}:pending-ack:${msgId}`
(`outbound/admission/al-outbound-admission-keys.ts:15-17`), so this is an eleventh mutation kind on
`ALOutboundStateWrite` (`al-outbound-admission-mutations.ts:35-85`) — `ALStoredOutboundMessage` has
no status field today — plus a schema-id bump from `rallar-alm-2026-09-f2`
(`open-indexed-db-admission-database.ts:17`), which F2's delete-on-mismatch already handles.

**Feeds and cancel.** Each settlement writes the row, ideally inside an existing admission
transaction; those with none today (RTC send settlement, ACK arrival) each acquire one. `cancel()`
becomes a durable `cancel-requested` fact the work handler observes — B's one genuine advantage:
cancellation survives reload and works across tabs.

**Terminal promise and subscription.** Still needs the event stream for liveness; a promise cannot be
composed from a row without polling. **B is A plus persistence, not an alternative to it.**

**Reload and late events.** The handle survives — `messages.observe(msgId)` after `agent.reload`
returns real state — with the strongest fencing available: compare-and-set on the observed terminal
state, the repo's existing convergent-write pattern rather than a new one.

**Storage cost.** Where it fails. D2 fixes the default typed send as volatile — "kept in memory
only", durability an explicit per-channel opt-in — and PC4/S3 must prove _zero_ AL-owned IndexedDB
operations on a volatile scenario; a row on the default path contradicts both. Quantitatively worse:
F2 Task 13 existed to cut the admission read chain (from "7+ sequential round trips under the lock"
pre-fix to one readonly transaction per decision surface; the committed fixtures now pin
`readOperationCount` at 9 per commit), and Task 14 fixed the hosted runner's boundary at **< 30 ms
per operation passing, ≥ 35 failing** (green head median 24.06 ms, red head 36 ms). Three to five
extra writes per message re-opens exactly the regression F2 just closed and pushes the lane further
from returning to `test:ci`. The store is also not cheap per message already: the standard workload's
snapshot keeps 216 outbound rows (72 messages × 3 recipients) and every payload, because supersedence
retains all eight updates until their deadline.

**Size.** Largest: store schema, write paths at every settlement, cross-backend parity (memory,
IndexedDB, PGlite/Postgres), plus everything in A.

### C. Hybrid — one lifecycle vocabulary in `packages/shared/alm`, volatile projection in the browser, durable sink as a named seam

**State.** The state union, the settlement-event union, the evidence shape, and the pure reducer
(`computeDeliveryLifecycle(previous, event)`) live in `packages/shared/alm/` — runtime-agnostic, so
the browser handle, the WS server path S2 needs, and the black-box ledger consume _one_ definition
instead of three. The live registry is in-memory and browser-owned exactly as in A. Persistence is a
declared sink with one volatile implementation in S1; the durable one lands with durable channels
(S3/I2).

**Feeds, cancel, promise, subscription, fencing.** As A, with the event union and reducer shared, so
the terminal guard is expressed once in a pure function every consumer uses.

**Reload.** Volatile messages become _unobservable_, not failed: a distinct non-accusatory outcome
naming lost observation, consistent with D2 ("crash survival requires the durable choice") and with
the rule that a missing receipt is not proof of non-delivery. Durable channels get B's survival later
through the same seam without a rewrite.

**Public surface.** As A, plus one real consolidation: `BlackBoxRallarDeliveryObservation`
(`black-box-rallar-operation-contracts.ts:270-287`) stops redeclaring the states and imports the
shared union — "one canonical name per type" applied to a contract that is currently duplicated and
already carries two states nothing can produce.

**Cost and size.** Zero new operations on the default path, as A. Marginally larger than A (the union
and reducer move package; the harness contract converges), materially smaller than B.

|                                                          | A                      | B                             | C                                 |
| -------------------------------------------------------- | ---------------------- | ----------------------------- | --------------------------------- |
| Handle survives reload (the _work_ resumes in all three) | no                     | yes                           | no (unobservable; seam for later) |
| New IndexedDB ops per default send                       | 0                      | 3-5                           | 0                                 |
| Honours D2's volatile default                            | yes                    | no                            | yes                               |
| States declared once                                     | no (browser + harness) | yes                           | yes                               |
| Cross-tab / post-reload cancel                           | no                     | yes                           | no                                |
| Cross-backend test burden                                | none                   | memory + IndexedDB + Postgres | none                              |

## 3. Recommendation

**C**, with the durable sink explicitly out of S1's scope.

1. **D2 makes B a decision violation, not merely a cost.** A durable-by-default lifecycle row
   contradicts the agreed volatile default and puts S3's zero-IndexedDB proof out of reach.
2. **F2's measurements make any new default write a lane regression.** The lane sits on a
   30-35 ms/operation knife edge on the hosted runner and is a non-blocking observation job because
   of it. S1 should remove polling, not add writes.
3. **The product text already specifies the projection.** "Applications can subscribe to lifecycle
   events and aggregate metrics without polling internal stores"
   (`alm-complete-product-description.md:553-555`), and it assigns "the lifecycle events" to S1 by
   name. The ledger's 25 ms poll is the anti-pattern being removed.
4. **Since the event stream must be built regardless, C's extra cost over A is near zero** — and it
   buys S2's server ACK path and the harness a shared union instead of a third declaration.
5. **C keeps B's only real advantage as a seam rather than discarding it.** If reload survival is
   later required it is a second sink implementation, not a redesign.

Three constraints whichever approach wins. The handle must exist _before_ admission resolves — the
product promises "a stable message ID immediately" (:92-93) while `send()` awaits
`enqueueOutboxIfAbsent`. The lifecycle must key on msgId with _per-carrier attempt_ evidence, because
fallback re-sends the same envelope on the other carrier (`browser-rallar-message-sender.ts:191`).
And the registry stays an _observation_ store with bounded retention: the outbound README forbids
settlement introducing "no additional queue, pending-work registry, or timer", so it must never
become a second source of retry truth.

## 4. Maintainer decisions (2026-09-12)

The seven questions this section carried were settled with the maintainer on 2026-09-12, together
with the slice's sequencing; the roadmap's decision record holds them as D9 to D16, and the S1
implementation plan argues from them.

1. **Handle evidence is hop-level and honest (D9).** The handle carries the admission result and
   each carrier's transport settlement per attempt; `confirmedPeerIds` and `unconfirmedPeerIds` are
   filled from what the hop saw, under names that say hop. Logical receipts and the frozen audience
   stay S2.
2. **`pending-authority` is the authority wait only (D10).** It names the bounded wait for room or
   group authority (`not-yet-in-sync`, `minSnapshotVersion`, the retained-until-refresh case F2
   carried in). A retained admission conflict awaiting replay is not a public state: the handle keeps
   its initial pre-admission state, `submitted`, until the replay yields `accepted`, `rejected`, or
   `pending-authority`. `submitted` joins the state list; `pending-admission` leaves the public
   vocabulary.
3. **The WS ordering block lands in S2 (D11).** `RallarWsSendInput` gains `seq` and `orderingKey`
   with S2's session-logical namespace; S1's lifecycle matrix records that WS has no ordering
   settlements.
4. **AR Eye Hunter migrates in S1, Relic in S3 (D12).** The match capability's WS send consumes the
   handle as S1's consumer proof; Relic's REST-to-`command` move lands in S3 beside the durable
   outbox and receipts it needs.
5. **No reload survival in S1; a lost handle is `unobservable` (D13).** Approach C as recommended:
   volatile projection, no lifecycle row, zero new IndexedDB operations on the default send. After a
   reload the work resumes from storage and the lost observation resolves to a distinct
   `unobservable` outcome, never `failed`. Durable survival remains a named sink seam for S3 or I2.
6. **The public result goes first; the internal union goes before the plan finishes (D14).**
   `RallarMessageSendResult` and its browser exposure are deleted when the handle arrives.
   `ALOutboundEnqueueStatus` does not survive S1 either: a late task re-types the server WS router's
   and RTC signaling admission's outcomes onto the shared lifecycle vocabulary, so no legacy union is
   retained (D8).
7. **`RallarGameSendResult` converges on the handle; `realtime` does not (D15).** The game result
   carries the handle instead of wrapping the removed result; `rallar.realtime` stays the volatile
   lane without a handle, because a handle there would promise receipts it cannot have.

Sequencing (D16): S1 starts from `main` in parallel with F2c, the inbound fence and batched releases;
F2c merges first and S1 merges `main` in before its final gate.

## 5. Acceptance evidence S1 would carry

- **A conformance scenario per state, per carrier.** The family is generated, not authored:
  `createAlmConformanceRecipes` over `ALM_CONFORMANCE_CARRIERS` currently yields 4 scenarios → 22
  recipes. S1 extends the table using F1's fault ports: drop an ACK (terminal without `acknowledged`,
  evidence naming the unconfirmed hop), close a lane, partition a peer, delay past the deadline,
  supersede key, cancel mid-flight, plus the full `accepted → queued → transport-accepted →
  acknowledged` walk. Landed as one PR — three shared registries mean recipe PRs conflict pairwise,
  and only a combined run finds cross-recipe limits.
- **The ledger transitioning for real**: the 25 ms poll deleted, records written from handle events,
  `transport-accepted` and `acknowledged` produced for the first time, `attempts` counting, peer-id
  lists no longer constant-empty, `cancelDelivery` actually cancelling.
- **A late-event fence proof**: a settlement after a terminal state leaves the state unchanged and
  increments the recorded late count. Paired with an `agent.reload` scenario proving the reload
  answer of decision 5 (D13) — the lane can already reload an agent with its IndexedDB intact.
- **`storage.counters` unchanged per typed send** against F2's baseline — the "no new default write"
  claim proven, not asserted — plus the standard-workload storage snapshot.
- **Public API snapshots** for `rallar.ts`, `rallar-core.ts`, `rallar-messages.ts`, `game/mod.ts`
  updated in the same commit; `shared-web-browser-bundle-boundaries.test.ts` re-measured — note
  `rallar-messages.ts` sits at 1.699 KiB brotli against a deliberately tight 3 KiB budget, so a
  handle that drags runtime code into that entry will show up there.
- **`test:repo-governance`** (harness contracts change), **`deno task check` for api-v1** (a shared
  type moves; the only gate seeing the server surface), **`test:deno`** (the only run covering
  `apps/*/test/**`), and **no new `file.cognitive-load` pin under `packages/shared/alm`**, which
  F2's acceptance established and S1 must not regress.

## 6. Rough task decomposition (for sizing only)

1. **Lifecycle vocabulary and reducer** — the ten-state union, settlement-event union, evidence shape,
   and the pure transition function with its terminal guard, in `packages/shared/alm`.
2. **The per-message settlement stream** — the largest task: a multiplexed event channel beside the
   existing single diagnostics sink, and an emission at every settlement that currently discards its
   outcome, starting with `computeALOutboundSendDisposition`.
3. **Lifecycle registry** — the in-memory observation owner, bounded retention, keyed by msgId, fed by
   both carrier runtimes.
4. **Per-message cancellation** — narrow the runtime-wide `sendAbortController` to a per-message
   signal reaching the transport's existing per-send `AbortSignal`.
5. **The public handle** — `state`, `onEvent`, `wait`, `cancel`, built from `RallarUnsubscribe` and
   the existing wait-option convention; returned before admission resolves.
6. **Composition and connection-epoch fencing** — construction in the messaging composer,
   re-subscription across connect/reconnect without reopening terminal states.
7. **Send-result removal** — delete `RallarMessageSendResult`, draw the `ALOutboundEnqueueStatus`
   boundary decided in decision 6 (D14), update entry points and snapshots.
8. **Shared-web consumer cutover** — the three real status branches, call signaling, the director
   relay, and `RallarGameSendResult`.
9. **Game consumer proof** — AR Eye Hunter's match capability shows pending, confirmed, and failed
   from the handle (Relic's scope per decision 4, D12).
10. **Black-box operations and ledger** — `messages.observe`/`cancel`/`receipts` against the handle;
    the ledger becomes a projection and imports the shared state union.
11. **The S1 conformance scenarios** — the state matrix added to the generator, landed together.
12. **Measurement, budgets, and navigation** — counter delta, storage snapshot, bundle figures, the
    inbound/outbound READMEs, and the `sent-immediate` drift in `docs/rallar-api-reference.md`.

**Size.** Large, the same weight class as F2, consistent with the release map's own "large" — but the
weight sits differently than the roadmap text suggests. The cutover is _cheaper_ than "apps updated
together" implies (one non-test app file, zero app references to the type, three real status
branches); the lifecycle stream is _dearer_, because F2 left a diagnostics tap rather than a delivery
channel and the transport settlement is currently discarded. Roughly 45-65 files: ~10 new, ~20
carrying the removal, ~6 in the harness, plus the generator and the test rewrites it obliges. Tasks
1-6 are the irreducible core and would stand alone as a medium PR; 7-12 are the cutover D8 requires.

**Verification note.** Claims were checked against this checkout. The surface map was accurate on the
send path and the ledger but wrong twice: it implied F2's typed events already carry every settlement
per message (only `commit-phases` does, once, at admission), and it overstated the app-side blast
radius (both games reference the send-result type zero times). `outbound/README.md:223` already states
the gap: "The application-facing delivery handle … remain roadmap work."
