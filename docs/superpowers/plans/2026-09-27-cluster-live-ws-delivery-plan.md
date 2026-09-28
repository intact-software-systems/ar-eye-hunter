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
- The maintainer subsequently approved explicit application/workspace scope
  for public generic unicast and proxy `toPeer` publication. Update verified
  callers and delete the unscoped overload; a peer ID or bare route context
  cannot establish recipient scope. Inbound generic unicast also fails closed
  unless its source proves recipient scope.
- On 2026-09-28, the maintainer approved the narrow persisted-scope contract:
  new WS inbound Source records capture authenticated group scope and public
  unicast's outbound sent policy retains full scope for durable replay. Old
  rows without required proof fail closed; no historical migration, AL
  wire-target change, or legacy overload is authorized.
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
- A generic public unicast or proxy `toPeer` without explicit full scope:
  refuse before publication; do not send to a same-ID socket in another scope.
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
proposed signatures against the smallest existing ports. Codec/transport,
receiving, notice-contract correction, and scoped game/Relic publication are
reviewed sub-slices; the sole publisher and effective-QoS routing remain open.

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

Execute this integration as reviewed sub-slices on the same draft PR: the
receiving/local-eligibility boundary, notice-contract correction, and scoped
game/Relic callers are complete; the sole publisher, effective-QoS/result
selection, and remaining composition follow. Review each sub-slice before building on it; the acceptance
checks below apply to the completed Task 2, not to an intermediate commit.

The receiving/local-eligibility sub-slice is complete in `1a1c0803d` and
`54073b04c`: its focused shared-server and API tests and typechecks passed,
and independent review cleared the touched construction functions. The
notice-contract correction is complete in `05394f2de`; independent task
review found no blocking issue. Neither sub-slice alone proves publisher or
cross-process delivery behavior.

The scoped game/Relic publication sub-slice is complete in `4eeebcf77` and
review correction `f92793225`. Public game snapshot/event inputs require
`roomRef`; missing or mismatched inbound room context stops application work,
and Relic accepts WebSocket commands only in its default application/workspace
before emitting a fully scoped snapshot. Game results now distinguish an
observed local send (`sent`) from durable admission (`accepted`), while
skipped/duplicate/superseded outcomes do not inflate publication counts.
Focused game and Relic tests, both game builds, the full unit suite, style,
and independent re-review passed. This does not prove cluster publication.

The approved public generic-unicast scope change was attempted but not
committed. The existing AL unicast target stores only a peer ID. Public
`outbox` publication would therefore lose an explicit application/workspace
scope during durable replay, and a guard on the common router path would also
reject previously admitted inbound unicast before its persisted Source can
prove scope. The interim edits were removed. This is a persisted-contract
decision, not permission to silently downgrade durable delivery or retain an
unscoped overload. The maintainer approved capturing authenticated scope in
new WS inbound Source records and public unicast scope in the outbound sent
policy; old rows without scoped proof fail closed only where that proof is
required. No historical migration or AL wire-target change is authorized.
Implement the public API and common publisher atomically with tests for durable
replay and admitted inbound unicast.

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
- [x] Make the Rallar Game server snapshot/event input require `roomRef`, guard
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

The captured-audience correction is implemented in `d5d8cf313`: local and
remote `WS_OUTBOX` sends read the same validated ALM admission policy, preserve
an admitted empty audience, and filter captured room sessions against the
current authenticated socket scope/generation. The existing receipt and
requeue behavior remains in place. Focused Vitest (70) and Deno (7) tests,
affected typechecks, and independent review passed. This does not yet prove
the cross-process PostgreSQL path: the three-process acceptance slice must
exercise a shared admission store, a late joiner, and receipt completion after
reconnect. Effective-QoS routing for `live-only` remains open.

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

## Scope-contract sequence and current status

### Task 2d: Capture authenticated WS scope in inbound provenance

The API-v1 ingress already holds a generation-fenced authenticated socket
scope. Inject a narrow synchronous scope-read port into the existing WS
admission owner, capture it after the current post-authorization socket check
and before the next asynchronous boundary, and reject ingress when that proof
is absent, expired, or from a replaced connection. Compare it with an explicit
room or principal target scope before admission. Do not derive scope from a
peer ID, bare route context, or optional document workspace.

Persist the proven scope on new `ws-client` Source records in pending work and
the message-owner row. Strictly decode any present full scope; absent scope
means unproven, not a default or migration. Keep old room/broad work available
under its existing independent authority checks, but fail closed for generic
client unicast at admission and every stored delivery/forwarding/buffered
release surface so already queued unscoped work cannot bypass the router.
Classify internal AL control unicast separately from public client unicast.

Write red tests first for generation-current capture/readback, missing or
replaced proof, malformed stored scope, target-scope mismatch, and old
unscoped client-unicast pending/admitted replay. Retain positive room/broad
tests. Run focused AL inbound, shared WS service/router, and API-v1 ingress
tests and affected shared/shared-server/API typechecks. Review every touched
file in full and obtain an independent task review before Task 2e.

### Task 2e: Make public unicast scope survive planning and replay

As one coherent change, require explicit full scope at public generic
`publish` and proxy `toPeer`/unicast boundaries; remove the old unscoped
overload and update verified callers and examples. Carry the authenticated
Source scope into inbound proxy context, including CRDT catch-up; never infer
workspace from an optional CRDT document field. Refuse server-generated
unicast lacking a verified explicit scope before send or enqueue.

Capture that scope in the outbound sent policy and scoped recipient prepared
effect, without changing AL wire targets. On durable claimant and remote
replay, read the validated persisted scope together with captured audience;
on prepared local sends, require proof at decode and compare the current
authenticated socket's scope, expiry, and generation immediately before
native send. Old public-unicast rows/effects lacking required proof fail
closed. Preserve the separate internal control/receipt path and current
QueueBox retry/receipt owner; add no queue, lock, retry, migration, or legacy
overload.

Write red tests first for missing/malformed scope, public API rejection,
persisted policy and prepared-effect readback, claimant and remote same-ID
cross-scope reconnection, CRDT catch-up with optional document workspace,
and send-time eligibility. Run affected shared/shared-server/API tests,
typechecks, examples, and focused Deno checks. Review every touched file and
obtain independent task review before connecting the sole effective-QoS
publisher or claiming cross-process proof.

Task 2d is locally implemented and independently review-clean in
`3bc5297df..3120d8666`; API-v1 ingress captures authenticated scope, stored
client-unicast replay requires it, and direct sends check current socket
scope/generation. The branch-gate fixture/evidence repair in
`e3adaddbe..48a6adac7` and the authenticated lifecycle fixture and
schedule-insensitive composite test correction in `1767be0e8` are also
locally review-clean. Task 2e's public API, captured outbound policy,
prepared effect, claimant/remote guard, and lower-level live-send guard are
locally implemented in `024b57698`, `72de53202`, and `1de6a1c6a`. Two
independent fix re-reviews found no remaining Critical or Important issue in
their scoped diffs. The last fix carries validated peer-notice scope through
middleware to native send; its integrated red/green test covers matching,
wrong-scope, and broad notices. These commits were pushed to draft PR #566
through `d420fb0a4`; none by itself proves the sole effective-QoS publisher,
cross-process WS delivery, or RTC-B06 E3.

The latest `main` ALM S3b change was merged locally in `119af2c59` to repair
PR #566's real source conflict. Post-merge focused live-notice/unicast tests
pass 110/110 and shared/shared-server typechecks pass. Bundle checks remain
red on the combined tree: the browser facade measures 224.28125 KiB against
`<223`, and headless measures 286.58203125 KiB against `<286`. The measured
next whole-KiB ceilings (`<225` and `<287`) await maintainer approval; do
not call the merge or branch gates green while those checks fail. The older
request to raise the facade limit to `<224` is superseded by this measurement.

Task 2f is implemented locally in `b787e8169`, `6f8e186f7`, and
`1fefc6c6e`, with an independent clean re-review of the final recipient and
deadline corrections. The common publisher routes effective best-effort
`live-only` through one typed Postgres notice and keeps durable-required
messages on the existing outbox. It freezes scoped audiences, uses current
authenticated socket/scope/principal and generation checks at both local and
remote final sends, and reports `cluster-published` only for a successful
notice publication. For best-effort QoS, even an explicit `fanout: 'outbox'`
does not force durable work: `fanout` retains the requested preference while
`status`, `entries`, and `verdict` report the actual live publication. This
is the approved QoS-first contract, not a missing outbox insert.
Provider-aware expiry is carried through both send paths; malformed or
unauthorized room work is refused. Focused validation on
the local head passed 112 shared-server, 67 shared QueueBox, and 32 API Deno
tests, typechecks, changed-style, structure, and formatting. This does **not**
replace the pending real three-process Postgres proof. The two bundle tests
were rerun on the Task 2f head and still measure 224.28125 and 286.58203125
KiB against their unchanged `<223` and `<286` ceilings; they remain red.

Task 2e placement found a separate class of raw `WS_OUTBOX` producers outside
the router's outbound sent-admission path. The read-only inventory now covers
CRDT AppInbox replies/fanout, auth logout, state-sync client snapshots/events
and group-presence deltas, and RTC topology pages. ALM-owned canonical and
receipt rows are not foreign producers. Task 2e covers the router/proxy
catch-up boundary, captured AL sent policy, prepared effects, and replay; it
does not prove these direct producers. CRDT's actor command lacks authenticated
application/workspace scope; optional document workspace is not recipient
proof. State-sync snapshot unicast has no captured recipient scope and can be
refused at first foreign dequeue, plausibly contributing to the initial WS
snapshot CI failure, though exact attribution remains unproved. State-sync
broadcast and RTC topology pages can pass the unicast guard without a verified
frozen audience; a passing guard is not admission proof. Auth logout lacks an
exact session-global persisted authority variant and currently refuses on
both new admission and old prepared effects. The three broad shared CRDT
unicast failures remain real; do not restore any producer through a generic
payload-type exemption.

Direct-producer adoption requires a separate focused design and reviewed
slice on this same draft PR before readiness. A candidate is an owner-specific
provenance record written atomically with each raw outbox row, verified against
the complete row and expiry on first foreign dequeue, then captured in ALM's
sent policy for prepared/replay delivery. This is **proposed, not approved**:
the existing synchronous dequeue planner cannot read that record, and the
authoritative audience-freeze point and auth session-global policy still need
review. Any CRDT command/persisted-format or compatibility decision, new
sidecar schema, or auth authority variant requires explicit maintainer
approval before implementation. No migration, old overload, generic
payload-type exemption, new queue, retry, or lock is approved. AL
control/receipt remains a separate decoded-control path.

### Proposed direct-producer adoption sequence (approval pending)

Task 2f and this design status were published to draft PR #566 through
`0311f9675`. The first exact-head gate was not green. Focused local repair
of its unscoped historical test fixtures and the removed positional public
`publish()` call is committed in `880aeae7f` and `8e9fe8485`; a new
exact-head gate has not yet validated the correction. They do not prove the
Postgres path.

The failed `prod-in-memory` ALM observation does **not** use the Postgres live
notice bridge. It exposed a separate effective-QoS regression: ordinary typed
room sends default to at-least-once, while the router passed its implicit
`live-only` default as if explicitly requested. The new durable-policy check
refused that send before socket delivery, although the original inbound
admission receipt succeeded. Commit `6fc27bc21` preserves omitted fanout
until effective QoS is known, selects the existing outbox for implicit
durable-required work, and retains explicit `live-only` refusal and configured
`none`. Its focused admitted-room red-to-green test includes receiver delivery
and completed receipt. An initial local `prod-in-memory` ALM WS browser smoke
reused services on the default ports from a different checkout, so that run
cannot prove this branch. A follow-up on isolated API, SPA, and control ports
reproduced zero receiver messages and timed-out sender receipts. Temporary
router diagnostics, removed after the run, showed two admitted peers and two
authorized sessions; the implicit durable publication then threw PGlite SQL
`22001` because a value exceeded `resource_inbox.created_by`'s 16-character
limit. The follow-up correction applies the existing
`toAppQueueCreatedBy` transform only to the server's physical `WS_OUTBOX`
entry audit; the serialized AL identity remains unchanged. Its long-browser-
session regression was red before the change and green after it, with a
receipt enqueue test and 27 adjacent WS service tests passing. The full
two-agent WS smoke family then passed on fresh isolated API, SPA, and control
ports (six scenarios, 2.4 minutes; normal page regime). This is local browser
proof for that family, not Postgres cross-process proof or unchanged E3
acceptance evidence.

The touched WS service also carried a pre-existing cognitive-load warning.
Inbound authority and inbound delivery now have separate private owners, while
the service retains public composition and the synchronous final socket/scope
check immediately before admission. A reconnect-during-authorization test
guards that boundary. The touched ingress test was split into a delivery suite
and shared fixture to close its own warning. Seven focused WS suites pass 70
tests, and an independent review found no new correctness defect. The raw
`unknown` socket value is decoded at the existing public service boundary;
authority receives only the typed result. No touched file remains in a metric
warning tier. The post-split isolated browser smoke passed again (six
scenarios, 2.4 minutes); the exact-head remote gate is still pending.

The exact-head Postgres formation artifacts identify a concrete direct-row
gap: principal state-sync snapshots generate per-session unicast `WS_OUTBOX`
pages and the first foreign dequeue has no captured recipient scope. The
logged outbound planner drop then leaves initial authorization without its
expected snapshot. Medium-scale CRDT mutations commit and their fanout can
reach a remote process, but their direct unicast reply rows lack the same
proof and the append reply is not observed. The warning lacks a row ID, so
the reply-row attribution follows the producer and planner path rather than
a direct per-row log correlation. Both producer families must be covered by
any approved provenance design; retaining a generic unscoped bypass is not a
remedy.

The following direct-producer slice is a design candidate, not authorization
to change a persisted contract. Its boundary is the four inventoried server
producers, not all ALM traffic:

| Producer      | Proof required before foreign dequeue                                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRDT AppInbox | Authenticated full application/workspace scope, final reply or fanout target, and the authorized room/principal audience frozen from the mutation's authoritative read. Optional document workspace is not proof.                                                                |
| Auth logout   | Auth-owner proof of the exact invalidated session, explicitly session-global if approved; never treat it as a generic unscoped unicast.                                                                                                                                          |
| State-sync    | Full aggregate scope and the audience frozen from the authoritative client/group snapshot. Bind each per-session snapshot page, principal broadcast, client event, and group-presence delta to its own row; a target ID or current delivery-time cache is not publication proof. |
| RTC topology  | Full GroupRef, validated publication/delivery-log identity, and each page's already-frozen recipient IDs. The existing replay check does not substitute for first-dequeue admission.                                                                                             |

1. In each existing owner transaction, write one versioned provenance record
   beside each raw `WS_OUTBOX` row. A common storage mechanism may use the
   existing transaction-bound runtime-state repository, but proof creation
   and validation stay with the producer that owns the authority. Identify
   the record by a collision-safe encoding of the complete queue key; bind
   the raw row hash, message/target identity, producer kind, and expiry.
   Do not repurpose `resource_inbox` or alter the AL wire target.
2. Add a narrow asynchronous provenance read before the existing ALM
   `commitDispatchPlan` on a _foreign_ first dequeue. The current synchronous
   planner cannot perform this read. Reject missing, expired, mismatched, or
   unknown-version proof; do not fall back to current room/client cache or a
   payload-type exemption. Feed only verified scope and frozen audience to the
   existing planning/captured-policy path. Prepared effects, retries, remote
   pub/sub, and replay must consume that same captured policy, not repeat an
   authoritative audience read. Auth requires a separate narrow
   session-invalidation authority variant across those paths.
3. Use red-to-green tests for each producer's local and foreign dequeue,
   prepared/replay send, late joiner, wrong scope, stale/replaced session,
   tampered/missing/expired sidecar, and duplicate row. Prove initial
   state-sync snapshot, CRDT reply/fanout, logout, and topology delivery in
   the three-process Postgres recipes. Preserve normal QueueBox retry and
   receipt behavior; no new receiving inbox, queue, lock, or retry layer.
4. Verify focused package/API tests and typechecks, full touched-file
   standards closure, bundle budgets, unchanged E3 acceptance evidence, and
   exact-head release gate before branch review. Existing rows without the
   new proof fail closed; no migration or legacy decoder is planned.

Before dispatching this slice, obtain explicit maintainer decisions on the
versioned persisted CRDT command and provenance format/expiry, freezing the
audience from the authoritative read that precedes its write transaction
(rather than from later foreign dequeue), and the session-global auth owner
variant. The authoritative read is recorded atomically with the outbox row,
but is **not** itself one serializable database snapshot with that write;
review whether stronger linearization is required. The Task 2f bundle
remeasurement above leaves the proposed `<225` and `<287` ceilings pending
explicit approval, not an automatic threshold change.

For each fix, review and remediate every changed human-authored file in full;
include every support file changed by remediation recursively until closure;
leave independent untouched code outside that closure. No passing focused test,
mergeable Git state, or plan-only commit substitutes for the full readiness
sequence.
