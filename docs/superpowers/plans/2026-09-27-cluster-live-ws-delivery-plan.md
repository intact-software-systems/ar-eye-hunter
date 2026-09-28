# Cluster Live WebSocket Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`
> to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver every eligible `live-only` WS publication to addressed
process-local sockets throughout an API-v1 Postgres cluster without changing
its requested effective QoS.

**Architecture:** The one authoritative publisher finalizes the message and
freezes room/explicit-peer audiences, then announces best-effort work over the
existing Postgres notification port. Broad `all`/`world` best-effort
broadcasts use each subscriber's locally eligible open sockets at notice
receipt. Each process sends directly without a receiver inbox. Work
requiring durable outbound delivery uses the existing `WS_OUTBOX` path, corrected
to honor the frozen audience on remote processes. An oversized canonical
inbound message uses a key-only read; an oversized noncanonical best-effort
publication fails explicitly pending approval of a different carrier.

**Tech Stack:** Existing TypeScript, ALM/QueueBox, PostgreSQL `LISTEN/NOTIFY`,
Vitest, Deno API-v1, and Rallar black-box recipes; no new dependencies.

**Spec:** [Cluster live WS delivery design](../specs/2026-09-27-cluster-live-ws-delivery-design.md).

## Global Constraints

- The maintainer approved the revised written spec, this plan, and the
  proposed ownership map on 2026-09-27. That approval includes oversize
  refusal, the `cluster-published` result, subscriber-local broad-broadcast
  audience policy, and a mandatory full `roomRef` on public Rallar Game
  server snapshot/event inputs without a compatibility path.
- `live-only` covers admitted inbound, proxy/handler replies, and
  server-generated messages; `none` remains handler-only.
- Decide routing from effective QoS, not the `fanout` label alone. Never
  silently change best-effort into durable outbox, or at-least-once into one
  untracked local send.
- Preserve one authoritative handler/mutation execution and the admission-time
  room or principal audience. Broad `all`/`world` best-effort broadcasts use locally
  eligible open sockets at notice receipt; each subscriber may only perform
  a direct local socket send.
- Do not add a library, receiving inbox/queue, retry, fence, lock, timer,
  migration, or legacy path. Reuse current Postgres notifications and outbound
  QueueBox/receipt machinery.
- Review and remediate every changed human-authored file in full. Recursively
  include every support file changed by remediation. Leave independent
  untouched code outside closure; delete affected obsolete code.
- Work on the existing non-default PR branch. Main may move; repair real
  conflicts, but do not rebase a mergeable PR for `BEHIND` alone.

## Review Focus

- A 7,999-byte notice versus an 8,000-byte notice: the former is accepted and
  the latter fails or switches to an eligible canonical key; never truncate.
- A 64 KiB inbound payload with a large room audience: key-only lookup still
  delivers to the frozen audience without creating receiver work.
- A generated/proxy payload over budget with no canonical row: typed refusal,
  never false success or implicit durable persistence.
- An oversized canonical principal or unicast message whose persisted source
  lacks the frozen scoped recipient proof: typed refusal, never a key notice
  that a safe subscriber must discard.
- A late room joiner or same session ID in another scope: no unauthorized
  receipt on any process, including the existing outbox path. For the same-ID
  case, reconnect the authenticated socket in a different application or
  workspace after the publisher freezes the room audience but before a
  subscriber sends.
- A `NOTIFY` listener restart or upstream dispatch retry: loss/duplicates are
  classified according to best-effort; no hidden replay or second handler run.
- A single-process local or disabled pub/sub configuration: local delivery
  works and no result falsely reports cluster publication.
- A proxy that changes room targets must authorize and freeze the final room
  audience. A proxy `toAll` or server-generated broad publication selects
  local eligible sockets at notice receipt; a just-opened socket may receive
  that best-effort broad broadcast without widening room authority.
- A server-generated room broadcast with only a bare `roomId` cannot infer an
  application/workspace. It fails explicitly; public Rallar Game server
  snapshot/event inputs require `roomRef`, and inbound command/sync handlers
  reject missing scope before application work. Relic's default-scope caller
  supplies a full `GroupRef` and then reaches a different-process room socket. No optional
  public overload, bare-ID fallback, or migration path remains.

---

## Approved ownership map

The current call trace identifies these ownership seams. New files and
signatures remain subject to placement review during implementation. Do not bury
live publication in `apps/api-v1` or extend the `WS_OUTBOX` codec with a
misleading second meaning just to avoid a file:

- `packages/shared-server/rallar-system/websocket/router/` owns effective-QoS
  selection, final audience mode, and the honest result. `route()` supplies its
  admitted audience; `publish()` and proxy paths establish authority for their
  final targets. The existing publisher and router contracts are the entry
  points.
- A focused live-notice contract and bridge beside the shared-server
  `queue-pubsub` files own bounded encoding, decoding, and direct local sends.
  They use a separate typed port; `WS_OUTBOX` remains key-only.
- `apps/api-v1/src/db/create-postgres-queue-pub-sub-bridge.ts` and
  `api-v1-queue-pubsub-bridge.ts` carry notices on the existing
  `ApiV1DatabaseNotificationPort`. Their local/disabled equivalents own the
  corresponding non-cluster behavior.
- The existing inbound admission store's `readDeliverySurface` owns canonical
  key lookup for oversized inbound messages and returns the persisted source,
  including frozen `groupRecipientPeerIds`; no receiver inbox or new table.
- API-v1 room-authority composition freezes a room audience at publication.
  A narrow local-eligibility port reads the current authenticated socket's
  scope and generation from `authorised-ws-connection-registry.ts` before a
  shared-server subscriber sends. Shared-server never imports that registry.
- The existing QueueBox pub/sub bridge and outbound captured-policy reader
  own remote durable-outbox audience correction, preserving their retry and
  receipt boundary.
- `packages/shared-server/game/install-rallar-game-authority-server.ts` and
  `to-rallar-game-authority-server-publication.ts` own mandatory scoped game
  publication. Update Relic's `relic-game-service.ts` and affected tests and
  examples; add no compatibility overload.
- Existing shared-server middleware composes the ports. Neighboring
  shared-server and API-v1 tests plus API-v1 black-box recipes prove behavior.

During implementation, finish tracing result consumers (including RTC
signaling, RTT, game, Relic, AI, and custom topic examples), and check these
proposed signatures against the smallest existing ports. The first two
implementation slices are codec/transport and publisher routing; later slices
remain outcome-shaped until those interfaces are validated.

### Placement findings from the current code

- `apps/api-v1/src/db/create-postgres-queue-pub-sub-bridge.ts` accepts only
  `WS_OUTBOX` keys, and its `QueueBoxPubSubBridge` contract has the same narrow
  type. A live notice needs a separate typed bridge/codec sharing the existing
  `ApiV1DatabaseNotificationPort`, not a second meaning for an outbox key.
  `apps/api-v1/src/db/local-queue-pubsub-bridge.ts` and the disabled mode need
  corresponding explicit local/no-cluster behavior.
- `RallarServerWsRouter.route()` passes captured audience to default fanout;
  `publish()` and proxy publications do not. The existing room authorizer reads
  a durable group snapshot and can provide a room audience. `toAll` and
  server-generated broad broadcasts instead use locally eligible sockets at
  notice receipt. The notice must carry an explicit room/peer/broad audience
  mode; absent room authority never falls through to broad resolution.
- `WsQueueBoxServerLiveDelivery.sendToTargetsWithResult` uses explicit session
  IDs with local open-socket lookup, bypassing target resolution. Scope must
  be bound and validated before those IDs are accepted by a subscriber. The
  remote outbox path currently calls this method without the admitted list;
  its fix belongs to the later durable-outbox outcome.
- `apps/api-v1/src/routes/ws-routes.ts` records authenticated connection scope
  and generation in `authorised-ws-connection-registry.ts`, while the generic
  socket map is keyed only by session ID. The listener's direct room send must
  read those current local facts and match the frozen room scope and socket
  generation; an absent or different scope is a local miss, not a reason to
  recompute the audience or enqueue receiver work. Keep this read behind a
  narrow injected port rather than importing the API application registry
  into `packages/shared-server`.
- `createGroupRoomWsAuthorizer` applies client sender-membership policy, so
  calling it unchanged for server-generated game or Relic snapshots would
  reject legitimate publication. A trusted server publication instead reads
  current room authority to freeze active member sessions for its final
  `GroupRef`; a proxy changing targets remains subject to final-target client
  authorization. Do not conflate those two publisher origins.
- `apps/relic-hunter-server-v1/src/relic-game-service.ts` currently builds a
  room broadcast without `groupRef`; the existing scoped room target resolver
  returns no recipients for it. The embedded Relic server already knows its
  API-v1 default application/workspace, so construct the full publication
  `GroupRef` at this call site without a persisted game-state migration.
  `packages/shared-server/game/install-rallar-game-authority-server.ts`
  exposes optional `roomRef` on public snapshot/event inputs. The maintainer
  approved making it mandatory, including unicast publications, without an
  overload or fallback. Guard inbound command/sync processing before the
  application handler if its authorised context lacks `roomRef`; update all
  verified consumers and tests.
- `packages/shared-server/game/install-rallar-game-authority-server.ts`
  translates `sent-live` and `queued-outbox` into a game `sent` result. Review
  that exact consumer, Relic snapshot publication, AI result publication, and
  the public router result contract when defining cluster-accepted semantics.
- `packages/shared-server/rallar-ai/rallar-server-ai-result-publication.ts`
  returns the router publication result without reclassifying its status.
  `packages/shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.ts`
  instead calls `sendToTargetsWithResult` directly and uses `sent-live` to
  classify a local replay send. Keep that separate local-only result contract;
  a cluster publication acknowledgment must not make replay claim a local
  delivery it did not observe.

### Task 1: Bound and validate best-effort cluster notices

**Candidate files:** New focused live-notice codec beside
`packages/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts`;
new neighboring Vitest module; existing Postgres adapter tests in
`apps/api-v1/test/db/postgres-queue-pubsub-bridge.test.ts`.

**Interface to settle at placement review:** A discriminated live notice with
`publisherId`, version, final AL message or canonical inbound key, explicit
room/principal/peer/broad audience mode with frozen IDs where required, a
full scope for scoped modes, and a logical deadline; a pure decoder returning a
validated notice or `undefined`; a UTF-8 encoder returning inline, key-only,
or typed oversize refusal. The existing `WS_OUTBOX` notice remains key-only.

- [x] Write failing codec tests for malformed/spoofed scope, expiry, exact
      serialized-byte boundaries, non-ASCII payloads, large audience, and a
      noncanonical oversize publication.
- [x] Run those focused Vitest tests and confirm the intended failures.
- [x] Implement the smallest codec/adapter change with the existing `<8,000`
      bound. The focused shared-server Vitest command passed 34/34; the
      API-v1 Deno adapter test, which root Vitest does not select, passed 6/6;
      shared-server typecheck passed.
- [x] Review the changed files for touched-file standards closure; commit the
      independently testable codec slice on the PR branch (`2c706f9fe`,
      `53597fb3b`). Independent fix re-review found both issues addressed.

### Task 2: Publish once and send locally on each listener

Execute this integration as reviewed sub-slices on the same draft PR: first
the receiving/local-eligibility boundary, then the sole publisher and
effective-QoS/result selection, then the scoped game/Relic callers and
composition. Review each sub-slice before building on it; the acceptance
checks below apply to the completed Task 2, not to an intermediate commit.

The receiving/local-eligibility sub-slice is complete in `1a1c0803d` and
`54073b04c`: its focused shared-server and API tests and typechecks passed,
and independent review cleared the touched construction functions. The
notice-contract correction is complete in `05394f2de`; independent task
review found no blocking issue. Neither sub-slice alone proves publisher or
cross-process delivery behavior.

Placement review after Task 1 found one notice-contract correction needed
before publisher wiring: `all`/`world` AL targets have no application/workspace
scope. Amend the codec and its focused tests so genuinely broad notices omit
scope instead of inventing one. Room, principal, and peer notices remain
explicitly scoped. In the same focused correction, prevent key-only
principal/peer publication from claiming success when the canonical source
cannot prove a frozen principal audience or recipient scope. That correction
was separately reviewed before publisher wiring.

**Candidate files:** `packages/shared-server/rallar-system/websocket/router/publish-rallar-server-ws-message.ts`,
`rallar-server-ws-router-contracts.ts`, neighboring router tests,
`packages/shared-server/rallar-system/middleware/` composition, and a focused
live bridge beside the current QueueBox pub/sub bridge.

**Interface to settle at placement review:** The publisher accepts the final
message, effective policy, audience mode, and optional canonical inbound
reference; the listener accepts only a validated notice and a local-send port.
The result distinguishes cluster publication from locally observed sends.

- [ ] Write failing two-process fake-bridge tests: the publisher has no socket,
      a different process owns the addressed socket, and exactly one authorized
      local send occurs; a subscriber never invokes the router handler.
- [ ] Add failing tests for generated and proxy publications, wrong scope, late
      room joiner, a frozen principal audience, a same-ID authenticated socket reconnected under another scope,
      bare-room-ID refusal, a scoped Relic publication, broad just-opened socket,
      expiry, duplicate/self notice,
      absent canonical row, listener loss,
      upstream dispatch retry, and local/disabled bridge modes. Pin the proposed
      result semantics at the public boundary rather than asserting an unknowable
      global `sentCount`.
- [ ] Make the Rallar Game server snapshot/event input require `roomRef`, guard
      inbound command/sync handling before application work when that
      reference is absent, and update Relic and every affected caller/test.
      Delete the optional path; run the
      focused game and Relic tests plus shared-server typecheck.
- [ ] Run the focused router/bridge tests red; implement QoS-aware publication
      after sole-owner authorization, then direct local listener sends with no
      receiving inbox. Run
      `npx vitest run packages/tests/shared-server/rallar-system/rallar-server-ws-router.test.ts packages/tests/shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.test.ts apps/api-v1/test/db/local-queue-pubsub-bridge.test.ts`
      green and `npx tsc -p packages/shared-server/tsconfig.json --noEmit`.
- [ ] Review all result consumers and affected examples; commit this slice
      after the focused behavior and type checks pass.

### Later outcome: durable live publications use the existing outbox

An at-least-once `live-only` publication must either create canonical durable
outbound work or explicitly refuse an incompatible effective policy. A remote
outbox listener must honor the captured audience, excluding late or
unauthorized sessions while retaining current retry and receipt behavior. No
parallel durable carrier is selected. Choose the exact code and test slice
from Task 1–2 evidence before implementing this outcome.

### Later outcome: prove three-process API behavior and branch readiness

Behavior-named black-box recipes must prove a sole claimant on one API process
delivers to an addressed socket on another, without a second handler run or
scope widening. Cover admitted, proxy, and generated best-effort publications
and durable at-least-once behavior. The unchanged standard and medium-scale
Postgres profiles, affected shared-server and API checks, representative size,
read-rate, latency and listener-loss measurements, exact-head Branch Release
Gate, and independent branch review determine readiness. Classify failures
from all three API logs; keep profiles under `tmp/perf/`, not in Git. Select
specific commands and files from the then-current implementation and
`rallar-testing` guidance rather than precommitting a later work batch now.

## Approval and rollback gates

The maintainer approved the revised design, plan, and ownership map on
2026-09-27, including (1) noncanonical best-effort oversize refusal, (2)
the `cluster-published` result instead of global send counts, (3)
subscriber-local eligibility for broad `all`/`world` best-effort broadcasts,
while room authority remains frozen at the publisher, and (4) mandatory full
`roomRef` for Rallar Game server snapshot/event publication without legacy.
If implementation evidence changes a decision, revise both artifacts first.
Rollback is a normal PR revert of the new publication path;
`WS_OUTBOX` remains the existing durable carrier. A green single-process test
or mere successful `NOTIFY` is not evidence of cluster delivery.

## PR #566 readiness boundary

Keep the PR draft. Resolve and prove cross-process WS behavior, address the
known heartbeat cache-TTL edge,
obtain the unchanged 100-cycle E3 acceptance evidence, and require a green
exact-head Branch Release Gate and independent review before marking the whole
branch ready for `main`. The WS correction alone does not satisfy the RTC-B06
evidence gate; the [committed-work plan](2026-09-12-alm-committed-work-progress-plan.md)
and [RTC baseline plan](2026-08-06-rallar-rtc-performance-baseline-plan.md)
continue to own those other outcomes.

The heartbeat cache-TTL edge is addressed in `a50ea8044`, with a red-before/
green-after regression, 41 focused tests and independent review. It does not
replace the pending cross-process proof, E3 evidence, or exact-head gate.

For each fix, review and remediate every changed human-authored file in full;
include every support file changed by remediation recursively until closure;
leave independent untouched code outside that closure. No passing focused test,
mergeable Git state, or plan-only commit substitutes for the full readiness
sequence.
