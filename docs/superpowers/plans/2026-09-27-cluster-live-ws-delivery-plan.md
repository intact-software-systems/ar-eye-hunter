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
- On 2026-09-28, the maintainer approved versioned per-row provenance written
  atomically beside direct raw `WS_OUTBOX` rows, fail-closed handling of old
  unproven rows, and a distinct session-global auth-logout authority variant.
  The approved audience freeze uses the producer's authoritative read before
  its write transaction; this read and write are not one serializable snapshot.
  The approved browser bundle ceilings are `<225` KiB for the shared-web facade
  and `<287` KiB for the headless agent, measured as Brotli bundles. This does
  not approve a CRDT command-format change or a generic payload-type bypass.
- On 2026-09-29, after exact-head measurements of 225.419921875 and
  287.8095703125 KiB, the maintainer approved increasing those two strict
  whole-KiB ceilings through this goal. The current ceilings are `<226` KiB
  for the full shared-web facade and `<288` KiB for the headless agent. Keep
  both measurement harnesses and all unrelated entry/dependency checks intact.
- For principal state-sync audiences, first use the existing durable scope-wide
  group read and preserve own plus authorized co-group sessions. Measure the
  representative read cost before changing storage. The existing
  `runtime_state_store_namespace_key_c_ix` already supports the scope prefix;
  do not add a duplicate index. If the scope-wide read misses the performance
  gate, measure the existing scoped membership prefix and exact batched
  principal reads before changing storage; keep the full authorized audience.
  The maintainer permits a distinct additive index only if measurement shows
  the remaining scan is inadequate; this is
  not permission to narrow the audience, change persisted contracts, or add a
  legacy path.
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
  data migration, or legacy path. The sole schema exception is the measured,
  additive principal-audience index above, if needed. Reuse current Postgres
  notifications and outbound QueueBox/receipt machinery.
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

The heartbeat cache-TTL change from `a50ea8044` was replayed into this branch
as `46f68a42f`, with a red-before/green-after regression, 41 focused tests,
and independent review. Subsequent review identified a remaining case: a
same-tuple snapshot can remove a session while renewing a survivor's lease,
yet the browser lifecycle classified it as a renewal and skipped RTC
reconciliation. A red-before/green-after regression now covers that case;
the lifecycle suppresses only renewals that keep the active-session set
unchanged. The focused state-cache suite passes 93/93 tests. This correction
does not replace the pending cross-process proof, E3 evidence, or exact-head
gate.

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
sent policy for prepared/replay delivery. The per-row sidecar, pre-write
audience-freeze point, and session-global auth variant are approved. The
existing synchronous dequeue planner still cannot read that record, so the
first-dequeue integration needs independent review. A CRDT command-format or
public compatibility change remains outside this approval. The sidecar uses
existing runtime-state storage, without a new table or migration. No old
overload, generic payload-type exemption, new queue, retry, or lock is approved. AL
control/receipt remains a separate decoded-control path.

### Approved direct-producer adoption sequence (implementation pending)

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
| Auth logout   | Auth-owner proof of the exact invalidated session under the approved session-global variant; never treat it as a generic unscoped unicast.                                                                                                                                       |
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

The maintainer approved a versioned per-row sidecar bound to the raw row and
its expiry, the pre-write authoritative audience freeze, and the session-global
auth owner variant. Exact encoding and validation are implementation decisions
subject to task review.
The authoritative read is recorded atomically with the outbox row, but is
**not** itself one serializable database snapshot with that write. Design and
tests must acknowledge the read/write interval without inventing stronger
linearization. A CRDT command-format or public compatibility change still
requires a separate decision if implementation cannot carry authenticated
scope through existing owner inputs. The measured `<225` and `<287` bundle
ceilings are approved and should be changed only with their measurement tests.

### Task 3: Apply the approved measured bundle ceilings

**Status:** Complete in `c367362ed`; the focused boundary tests pass 6/6 and
the shared-web measurement check passes at 224.28125 KiB. This does not prove
any cross-process runtime behavior.

**Scope:** Only the shared-web facade and black-box headless Brotli budgets
approved above. Update the matching production measurement script and
independent boundary test together: `packages/shared-web/scripts/measure-browser-bundles.mjs`,
`packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`, and
`packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts`.
Replace the outdated pending-approval comments with the measured combined-tree
values (224.28125 and 286.58203125 KiB) and approved strict `<225` and `<287`
ceilings. Do not relax unrelated entry budgets or dependency exclusions.

**TDD/verification:** First run the two existing focused bundle boundary tests
to preserve the red measurement evidence. Apply the minimal threshold/comment
change, then rerun the same tests and the shared-web measurement script.
Review all three changed files in full under touched-file standards closure;
format/check the diff. The measurements are a budget decision, not proof of
runtime cross-process behavior.

### Task 4: Establish the direct-row first-dequeue proof boundary

**Status:** Complete locally in `b3e88c028` and integrity follow-up
`708e24dc6`; independent spec and code-quality review approved both after the
follow-up. The focused 119-test run, package/test/API typechecks, and changed
style checks pass. This is only a fail-closed read boundary: no producer writes
the sidecar yet, so the two unchanged state-sync product acceptance tests still
fail and no cross-process formation or CRDT delivery is claimed.

**Scope:** Add a narrow asynchronous `readDequeueAuthority` port to the
existing ALM outbound dequeue path immediately before `commitDispatchPlan`.
The WS owner classifies the exact observed row, not its payload type: an
`AL_OUTBOUND_MESSAGE` canonical row requires its existing exact sent-admission
and identity; a raw `WS_OUTBOX` row with sent admission reuses its validated
captured policy; a raw row with identity but missing admission is corruption;
only a virgin raw row reads a producer sidecar. No injected reader means raw
work fails closed. The generic runtime must not acquire a database dependency.

Create one versioned, collision-safe row-bound provenance contract in the
shared-server outbox owner and a read port using existing `runtime_state_store`.
Its lookup key encodes the complete queue key injectively; its digest covers
the exact serialized row resource, full queue key, type, immutable audit
creation/expiry facts, producer kind, and message/target identity. Exclude
mutable queue status, reservation, attempts, and database metadata. Validate
the claimed identities independently, not only the digest. Reject missing,
expired, malformed, unknown-version, mismatched-key/target, and hash-mismatched
proofs. Preserve an explicitly empty frozen audience. The verified proof feeds
the existing synchronous planner and ALM captured sent policy; a concurrent
winner's already-stored policy must take precedence. Do not refresh producer
audience on retry or replay.

For this task, allow the sidecar to authorize only a fully scoped public
unicast with an explicitly frozen target; reject raw broadcast and the
session-global variant until their final-send protections and producer-owned
writers land in later reviewed slices. This is a temporary fail-closed draft
state, not a shipped exemption. Do not add a table, queue, retry, lock,
migration, legacy reader, or generic payload-type exemption. Do not change
any producer yet or claim the Postgres recipes are fixed.

**TDD/verification:** Begin with failing tests at the real WS dequeue boundary:
canonical broadcast lacking sent admission/identity, orphaned raw identity,
raw unicast with missing/tampered/expired/unknown-version proof, and a valid
scoped synthetic row. Prove a captured empty audience and a race where another
admission wins before commit. Verify prepared/replay uses captured policy
after sidecar removal; wrong-scope or replaced-session recipients do not
receive. Add focused sidecar codec/reader tests including complete-key
collision and immutable-versus-mutable row fields. Run affected shared,
shared-server, and API tests/typechecks and review all changed files in full
with recursive support-file closure. The next slice writes this sidecar
atomically with state-sync snapshot pages after the independently exposed RTC
test synchronization gap is repaired; later producer slices extend the
contract to scoped broadcast and approved exact-session auth logout.

### Task 5: Prove the generated RTC recovery test's delivery boundary

**Status:** Complete locally in `3d0f91f48`; independent spec and code-quality
review approved it. A controlled gate reproduced committed admission with
pending owned delivery, then the existing owned-work wait preserved the exact
generated message-ID and payload assertions. The full owner file passed 32
tests and the shared-web suite passed 1,181. This proves that scheduling gap,
not the unobserved cause of the historical CI run.

**Scope:** The exact-head Release Gate at `be8d3c090` had one non-budget unit
failure: `packages/tests/shared-web/state-read/rtc-authority-recovery.test.ts`
asserted the generated supersedence replacement was delivered immediately
after `transferTo`, but the receiver array was still empty. Its focused case
and full file pass locally. `transferTo` awaits native receive/admission;
`ALWorkHandler.committed()` starts owned delivery work without awaiting it.
Nearby recovery cases explicitly assert committed admission and use the
existing condition-based `waitForOwnedQueueWork` before asserting delivery.
The CI log lacks admission/queue facts, so the race is a hypothesis to prove,
not permission to weaken the test.

**TDD/verification:** First make a focused controlled scheduling case expose
the distinction between committed admission and completed owned delivery;
record RED before modifying the assertion. In the generated specimen case,
assert the replacement's committed admission, await the existing owned-work
condition, then retain the exact message-ID and payload delivery assertions.
No fixed sleep, new retry, production timing change, or weakened expectation.
Run the focused case/file, affected shared-web tests/typecheck, and changed-file
style/format checks. Review the entire touched test file and recursively any
support file changed by its remediation. If the controlled evidence instead
shows a refused admission or wrong message, stop this test-only hypothesis and
diagnose the production path before editing it.

### Task 6: Publish client snapshot unicast provenance atomically

**Status:** Correctness implemented locally in `954832106d` and cluster-bridge
follow-up `46a2d2701`; independent review approved the corrected scope. Real
producer/reader/bridge tests cover publisher-local and remote recipient
placement, and PostgreSQL transaction tests prove row/proof visibility and
rollback. The unchanged three-process formation matrix passed 4/4 before the
bridge correction, so it is not exact-head cross-process proof of that
correction. The two group-broadcast product tests remain red. The governed
state-write comparator remains **failed** on hot median transaction duration
(+10.74%); its standard workload writes no unicast sidecars, and a separate
small active-session diagnostic measured one extra insert and one extra read
per proven page. No waiver or no-regression claim is made. Keep the PR draft
until broadcast/direct producers, controlled performance evidence, and the
unchanged distributed/release gates are reconciled.

**Scope:** Restore the first missing real producer family, without treating a
synthetic sidecar as production proof. The client-state mutation's accepted
snapshot and `ComputedClientStateSync` already freeze the active sessions and
materialize both principal broadcast and per-session unicast snapshot pages.
For each unicast snapshot page only, derive the full application/workspace
scope and exact recipient from those validated computed facts, then prepare the
version-1 `state-sync-snapshot` sidecar for its exact `AppOutboxInsert.entry`.
The proof must bind the storage-stable immutable row facts and the frozen
one-session audience; it must not look up current sessions at dequeue. Reject
any computed page/target/scope mismatch before entering the transaction.

Compute hashes and validate the complete write set before the AppInbox owner
opens its existing transaction. In that same transaction insert each sidecar
into the existing `runtime_state_store` and its corresponding raw `WS_OUTBOX`
row; either all commit or none do. Keep one visible client-state mutation owner
and the existing AppInbox retry/CAS behavior. No table, public wire change,
new queue, lock, retry, library, migration, or legacy reader. Leave principal
broadcast, client event, group state-sync, CRDT, auth logout, and topology raw
rows fail closed until their own reviewed producer/final-send slices. Do not
broaden the Task 4 reader based on payload type.

**TDD/verification:** Start with a failing real client mutation and foreign
WS dequeue test, not a hand-inserted proof: the committed snapshot page should
deliver to the frozen authorized session; an uncommitted/rolled-back mutation
must expose neither row nor proof. Test late/replaced sessions, wrong scope,
duplicate command/replay, every snapshot page, no active sessions, sidecar
expiry, and read/write-interval behavior explicitly. Verify PostgreSQL row
codec round-trip of the exact producer-built audit facts. Preserve the two
unchanged group-broadcast product acceptance tests as pending signals rather
than rewriting their expected delivery. Run focused client-state/AppInbox/WS
tests, API composition/typechecks, the relevant three-process formation recipe,
and changed-file standards closure. Because this changes the API-v1 state
mutation path, capture a comparable `perf:api-v1:state-write` baseline and
candidate, run its comparator and the unchanged medium-scale correctness gate;
record transaction duration and SQL counts only from their artifacts. Keep
profiles under ignored `tmp/perf/`. A recipe still failing on other unproven
rows is reported precisely, not called a passing end-to-end result.

For each fix, review and remediate every changed human-authored file in full;
include every support file changed by remediation recursively until closure;
leave independent untouched code outside that closure. No passing focused test,
mergeable Git state, or plan-only commit substitutes for the full readiness
sequence.

### Task 7: Carry verified room-broadcast provenance through durable delivery

**Scope:** Extend the version-1 per-row proof with a `scoped-room-broadcast`
target: exact `GroupRef`, publication-time frozen session IDs, and the existing
immutable row audit. The first-dequeue reader accepts only an exact, valid
sidecar for a scoped direct row; raw broadcasts without proof and broad or
principal broadcasts remain refused. No payload-type shortcut is authority.

The validated durable `ALStoredOutboundMessage.reference.key` distinguishes a
canonical AL publication from a proven direct raw publication on first send,
replay, and repair. Pass that existing key transiently through the AL outbound
planner and repair path alongside its captured policy. A winning stored
admission replaces the observed audience, scope, and key together. Only a
proved direct room row interprets captured IDs as **session** IDs and resolves
them against local authenticated open sockets. Canonical AL room rows retain
their existing peer-ID resolver, receipt/ACK, exclusion, and repair semantics;
never globally reinterpret `admittedAudience`. The cluster bridge preserves
the direct row's captured audience and room scope through the API's final
session eligibility check. Prepared replay must reject an unscoped effect for
a proved direct row. Reuse the existing row reference rather than adding a
persisted discriminator, queue, retry, lock, fence, timer, or legacy planner
overload.

**TDD/verification:** Start RED with the same target/scope/audience but
different canonical versus direct physical keys and deliberately different
peer and connection IDs. Prove canonical receipts and repair stay peer-based,
while a valid direct room proof reaches only its frozen sessions locally and
across the bridge. Cover first dequeue, retry/restart after sidecar removal,
repair, stale scope/generation, late joiner, empty audience, winning stored
admission, forged key without proof, and unscoped replay refusal. Run focused
ALM/WS/bridge/API tests, shared and API typechecks, and full touched-file style
and structure closure. This slice is not a claim that a real room producer is
yet proven.

### Task 8: Publish real group-presence delta proof atomically

**Scope:** The group presence-summary worker owns the actual group-state delta
outbox rows. Use its validated computed summary and accepted active sessions
to prepare one exact room proof per direct `WS_OUTBOX` delta row before the
existing transaction. Insert proof and row in that transaction with the
existing reservation finish; either all commit or none do. A no-op summary may
still emit a delta, so decide from actual computed rows, not summary-write
presence. Keep one worker owner and existing QueueBox/AppInbox retry behavior.
Do not use the synthetic group snapshot tests as proof of this producer, and
do not yet admit client principal broadcast/events, CRDT, auth logout, or
topology rows. Principal state sync currently reaches own and authorized
co-group sessions; preserve that product audience in its later producer slice
unless the maintainer explicitly changes it.

**TDD/verification:** Start RED with a real presence-summary work item whose
committed group delta reaches a different API process's frozen authorized
session; an uncommitted/rolled-back item exposes neither row nor proof. Cover
no-op summary with delta, late join/replaced session, wrong room scope,
duplicate/replay, expiry, row-audit tampering, and no audience. Repair the two
existing group-broadcast tests by retaining their delivery/outcome assertions
but arranging real proved rows and authenticated sockets; do not make the
reader permissive for synthetic raw rows. Run focused group/AppInbox/WS and
API tests, the unchanged medium-scale correctness gate, relevant three-process
formation recipe, package/API typechecks, and touched-file closure. Collect
comparable performance evidence for affected mutation paths; the prior
state-write hot-duration failure remains open, not waived.

### Task 11: Freeze the real principal state-sync audience

**Scope:** For client-state snapshot broadcasts and client events, preserve the
current product audience: the principal's own live sessions plus authorized
live sessions of groups where that principal is an active member. Read group
and client snapshots from durable scope-wide authority before computation;
use the computed successor for the mutated principal's own sessions. Do not
derive membership from process-local caches, a target ID, or delivery-time
state. Extend the exact per-row proof and direct-broadcast send policy for a
principal target, binding each actual `WS_OUTBOX` row to its full scope and
frozen session IDs. Prepare the complete proof before the existing AppInbox
transaction and insert it atomically with the row. No new queue, retry, lock,
fence, migration, legacy reader, or second mutation phase.

**TDD/verification:** Start RED with a real client mutation whose principal
event and snapshot broadcast are absent on a foreign API process today.
Prove own and co-group authorized sessions receive them, while wrong-scope,
inactive-member, late-join, expired, and replaced-session recipients do not.
Prove exact row/proof rollback, replay, no-op, and collision handling; retain
the existing per-session snapshot-page behavior. First use the current
durable `listSnapshots(scope)` reads and the existing composite prefix index.
Measure representative workspace read cost and full state-write performance;
if the full read misses the gate, compare existing scoped membership and
exact batched client reads before considering an additive index. Add a distinct
index only if the observed plan and latency demonstrate need, then rerun the
same workload. Run focused shared-server and API tests, typechecks,
the unchanged medium-scale and relevant three-process recipes, and touched-file
standards closure.

**2026-09-28 read-path checkpoint:** The focused PGlite prefix-plan test proves
the existing composite C-collated index is usable, but it disables sequential
and bitmap scans, so it does not prove the planner naturally selects that index
for a representative production scope. On a local
5-group/100-client diagnostic scope, warm scope-wide group plus client
snapshot reads took roughly 24–35 ms combined; a raw existing-selector batch
was faster, but did not perform the same snapshot assembly or validation.
The first state-write diagnostic became conflict-heavy in its shared workload
and was interrupted, so it is not a governed before/after result. Keep the
existing read path for correctness while obtaining comparable gate evidence;
do not add an index from these non-equivalent diagnostics alone. A natural
PostgreSQL planner choice and comparable full state-write results on the same
representative workload must inform any index decision.

**2026-09-28 unforced PostgreSQL index probe:** On the existing local
PostgreSQL 16.12 development database (41,294 runtime-state rows), the most
populated group scope had 100 groups and a selected client scope had 100
principals. Without disabling sequential or bitmap scans, `EXPLAIN (ANALYZE,
BUFFERS)` chose a bitmap index scan on the existing
`runtime_state_store_namespace_key_c_ix` for each exact C-collated prefix read.
The single-run queries returned 100 rows in 0.553 ms for groups and 1.260 ms
for principals, including the diagnostic scope-selection CTE; the latter had
93 shared-buffer reads. This establishes that the natural planner can use the
existing index for these raw reads. It does not measure complete snapshot
assembly, the full state-write path, a controlled baseline/candidate comparison,
or a production-equivalent workload. Keep the existing index and do not infer
that another index is needed or that the performance gate passes from this probe.

**2026-09-28 implementation/review checkpoint:** Principal state-sync now
captures the durable own-plus-co-group session audience and binds each actual
broadcast row to an atomic proof. The independent review's client proof-key
collision, semantic no-op, and injected read-time clock follow-ups are committed
on this draft branch and passed focused client-state tests. The earlier exact-head
100-client medium-scale mutation workload passed 2,757/2,757 interactions and
the group-lifecycle cluster recipe passed; both formation and medium-scale
cluster matrices still failed two CRDT reply waits. These results support
retaining the existing indexed read for now, but they are not a controlled
latency comparison or a complete branch acceptance. No additive index was
introduced. A separate Release Gate PGlite RTT fixture lacked the newly
required current-connection authenticated scope; its focused test is repaired
and reviewed on this branch, awaiting the next exact-head gate.

**2026-09-29 state-write checkpoint:** A sequential main-versus-PR diagnostic
used the same PostgreSQL development container, separate freshly migrated
databases, and the same `perf:api-v1:state-write` workload. The comparator
failed: uncontended p95 rose from 102.87 to 331.82 ms, shared throughput fell
from 170.32 to 143.39/s, and uncontended serialized SQL result bytes rose
from 25.74 to 132.15 MB. This is not the pinned governed environment, and it
does not identify the causal query by itself. Trace the complete principal
scope-read path and query plan, compare existing scoped membership plus exact
batched client reads against the current scope-wide assembly, and repeat the
same workload. Add an index only if that evidence demonstrates need; neither
the earlier raw-prefix probe nor this aggregate result alone proves one does.

**2026-09-29 artifact cross-check:** Later saved candidate captures at
`b8699239` and `244458a2` used the same declared 100-client/100-group,
10-concurrency, one-warmup/three-run workload. Only test files changed between
those commits, yet uncontended median serialized SQL result bytes differed
98.14 versus 25.84 MB and p95 latency differed 291.91 versus 133.45 ms.
The artifacts do not establish identical database contents or host conditions;
the SQL wrapper reports only aggregate bytes, not bytes by query. Therefore
neither capture attributes the excess to `listSnapshotsForPrincipal`, and a
single candidate/baseline pair is insufficient to accept or reject the read
path. Before a schema change, capture a controlled, order-balanced comparison
on fresh equivalent databases, with query-level attribution for the scope
read and full correctness evidence. Preserve existing development data.

**2026-09-29 hosted order-balanced checkpoint:** The opt-in PR workflow
[run 36540665768](https://github.com/intact-software-systems/ar-eye-hunter/actions/runs/36540665768)
completed all four A-B-B-A captures on one pinned runner/image with matching
environment records. Post-processing exhausted Node's default heap while
deep-cloning four approximately 476 MiB artifacts, so the hosted comparator did
not finish. The allocation fix pooled those retained exact captures locally
under the original heap limit; the unchanged comparator then failed thirteen
performance gates. Uncontended p95 was 187.98→466.29 ms, shared throughput was
87.42→76.77/s, and uncontended median serialized SQL result bytes were
25.75→98.14 MB. This is controlled regression evidence, **not** a hosted green
comparison or branch acceptance. The `profile-instance` operation bears most
of the observed latency increase, while the aggregate wrapper cannot assign
that increase to one SQL statement. A bounded read-only SQL probe showed the
new full-scope group payload is fetched twice; the existing composite index
was selected naturally. Do not add an index from this evidence alone. A
principal-filtered read could avoid unrelated group payloads, but would also
stop an unrelated corrupt group from blocking this principal's publication;
the human decision on that validation boundary precedes implementation.

**2026-09-28 browser fixture checkpoint:** The native ALM timing fixture also
used an unscoped synthetic WS-client source, so the new fail-closed unicast
reader correctly withheld every delivery. The fixture now supplies a matching
authenticated scope. Its eight focused Chromium tests pass, and the main
black-box browser suite passes 70 tests with 60 environment-gated skips. The
separate Recipe Console suite passes 209 tests, skips one, and fails one offline
Fleet assertion because a concurrent full-stack ALM job in another worktree
serves a live empty control snapshot on port 5180; an isolated rerun reproduced
that environment collision. No IndexedDB lock, retry, or index was added.

### Task 12: Publish auth logout's exact-session proof

**Scope:** Use the already approved session-global authority variant for the
auth owner's exact invalidated session. Bind the producer's actual raw
`WS_OUTBOX` reply row to its invalidation fact before the existing write
transaction, insert proof and row atomically, and enforce the invalidated
session and current connection generation at final send. This is not a generic
unscoped-unicast exemption. Old unproven rows remain refused; do not add a
legacy path or a new retry/queue.

**TDD/verification:** Start RED with an authentic logout on process A and the
target socket on B, plus a same-session-ID wrong-generation negative. Prove
one committed exact-session notice, rollback, replay, no unrelated recipient,
and no acceptance of an arbitrary raw logout-shaped payload. Run focused auth,
WS, AppInbox, cross-process, package/API checks and touched-file closure.

**2026-09-28 implementation/review checkpoint:** The exact-session logout
producer proof and local/foreign generation checks are committed on this draft
branch (`bb3183f010d6a504f120aa221d43eff8b51cb0b7`). Independent task
review found no correctness, security, or spec defect. Focused suites passed
1,441 tests, affected package/API checks passed, and a real three-process
Postgres proof observed the one committed notice on B while unrelated C stayed
open without a frame or close. These are Task 12 results, not an exact-head
Release Gate or a proof that CRDT and RTC-topology producers are covered.
The full-branch changed-style comparison remains non-green for warning-tier
metrics in the outbound admission decoder and two WS owners, plus black-box
runner directory density. The reviewers found the Task 12 owners cohesive,
but the exact changed gate still requires reviewed dispositions or coherent
shape corrections before PR readiness.
Whole-tests-project typing also remains non-green on dependency/PGlite type
identity diagnostics outside the touched files. No additive principal index
was introduced or justified by these logout results.

**2026-09-29 CRDT-head checkpoint:** CRDT append reply and room/principal/app
fanout now write versioned per-row proof in the existing AppInbox transaction
(`9c2c3730a`). Focused shared-server CRDT/WS-provenance tests passed 156/156,
API CRDT tests passed 56/56, and WS planning/pub-sub bridge tests passed 32/32;
shared-server TypeScript and API Deno checks passed. At this head, the remote
formation-large, medium-scale, topology-replay, governance, and CodeQL checks
passed, as did the separate ALM conformance observation. Release Gate stopped
at changed-repository-style review before its product suites; seven
touched-file/structure findings remain. These results do not prove
RTC topology first-dequeue delivery or E3 acceptance.

### Task 13: Bind RTC topology pages to their frozen publication

The topology owner already validates `RtcTopologyPublication`, materializes
each deterministic page with the full `groupRef` and frozen
`snapshot.activeSessionIds`, and writes pages through
`writeRtcTopologyPublicationTransaction`. Add a version-1 `rtc-topology`
producer proof for every raw `WS_OUTBOX` page. Bind the exact queue row,
message identity, deadline, full group scope, and the page's existing
recipient IDs; verify that those recipients are the validated publication
audience. Keep proof computation before the domain-owned SQL transaction and
insert each proof atomically with its page and reservation/delivery append.
Existing replay validation must still reject missing or conflicting pages;
first foreign dequeue must accept only the proved row. No payload-type bypass,
receiver inbox, retry, lock, migration, or legacy proof reader is authorized.

- [x] Write a failing producer-to-first-dequeue test and an atomic
      commit/rollback test for a real topology publication, including a
      late-page collision. Retain the existing large-page and stale-topology
      assertions.
- [x] Compute and validate persistence-ready proofs from the accepted
      publication before transaction entry. If asynchronous hashing makes the
      existing work computation asynchronous, carry that change through its
      real callers and tests rather than adding a post-compute preparation
      phase.
- [x] Insert pages and their proofs in the same existing transaction; test
      exact row/collision failures and a wrong-scope or late-joiner negative.
- [x] Run focused topology, WS first-dequeue, API PGlite, and affected package
      checks. Review every touched human-authored file in full and obtain
      independent task spec/quality review before proceeding.

Task 13 landed locally in `0377a8283` with independent task spec/quality
approval. Final focused topology/outbox tests passed 630/630 with five opt-in
skips; shared-server tests passed 2,553/2,553 with 12 opt-in skips. The focused
API PGlite topology file passed 6/6 and the adjacent API topology set passed
23/23. Shared-server TypeScript, API Deno checks, and Task 13 changed-style
and structure checks passed. The test-first producer/dequeue and PGlite
collision cases prove exact proof binding and atomic rollback, not a separate
OS-process recipient or E3 browser result. Full touched-file review was
reported by the implementer; the independent diff reviewer found no blocking
defect and explicitly could not certify every complete file from a contextual
diff. This remains a Task 14 whole-branch review obligation.

### Task 14: Close exact-head evidence and branch review

After Task 13, close this PR against the approved design, not against a subset
of currently green tests. Do not split a test-only proof PR from this draft
implementation PR.

- [ ] Reconcile every direct raw `WS_OUTBOX` producer and the old product tests;
      an unproven row remains fail-closed, never exempted by payload type.
- [ ] Resolve the remaining changed-style/structure findings through
      coherent touched-file remediation or evidence-backed exact dispositions.
      Review every changed human-authored file in full, recursively including
      support files changed by that remediation.
- [ ] Obtain a controlled, environment-matched state-write comparison and
      exact-head cross-process WS/browser evidence, including unchanged E3
      acceptance. Distinguish publication from observed socket delivery.
- [ ] Run focused checks before the exact-head Release Gate and affected app
      gates. Complete whole-branch review and publish one concise PR
      behavior/evidence map. Keep the PR draft until the acceptance evidence
      is green or a genuine blocker has been presented to the maintainer.

CRDT's persisted command format remains unchanged; any future public
compatibility change requires separate approval.

### Task 14a: Make cluster proof entry points navigable

The prior-head style gate reports one test construction forward capture and
24 direct source files in `packages/shared-test/black-box-runner`. The auth
logout proof is currently an unreferenced top-level runnable, while the group
delta proof has a package command. Preserve both proofs as repeatable
acceptance tools, make their command-to-result path visible, and give the
cluster-proof executables a cohesive owner. A direct `cluster-proofs/` owner
with package commands is the preferred shape if full-file review confirms
their imports and lifecycle fit; do not add forwarding wrappers or a folder
solely to game the density threshold. Move the router test's audience
constants before the fixture construction function so the current scope
provider never forward-captures them. No product routing behavior changes.

- [x] Write a failing discovery/structure check for the missing auth proof
      entry point or current root-density fact, then preserve the existing
      group-delta and auth proof behavior after the ownership correction.
- [x] Run the two direct cluster proofs where the required PostgreSQL/API
      services are available; otherwise report that runtime proof as skipped
      and run their Deno check plus focused contract tests. Run the focused WS
      router test and changed-style/structure checks.
- [x] Review every touched file in full, recursively include changed support
      files, and obtain independent task spec/quality review.

Task 14a landed in `f65e0dcf6`: the auth and group-delta commands run the
direct `cluster-proofs/` executables, both are Deno-checked, and the router
fixture no longer forward-captures its audience constants. The implementer
reported passing direct PostgreSQL proofs, 47 router tests, 27 managed-runner
tests, TypeScript/Deno checks, and changed-style review; independent review
found no actionable issue. The runner root has 22 direct source files after
the cohesive move. That directory-density warning is a reviewed KEEP for this
slice, not grounds to move unrelated owners mechanically.

### Task 14b: Close remaining production style owners

The four remaining prior-head cognitive findings are in the WS publisher,
ALM captured-policy validation, WS live delivery, and WS outbound planning.
Recover each owner-to-result path from its entry and tests before choosing a
coherent keep/split/consolidate disposition. Preserve behavior and the frozen
audience/one-attempt semantics. Do not mechanically extract helpers or change
the checker threshold. Run focused tests and full affected package checks,
then independent task review. Exact-head release and performance evidence
follow after the style closure.

### Task 14c: Prove exact-head behavior and review the branch

After coherent style closure, reconcile any remaining direct raw outbox
producers and old product tests without exempting unproven rows. Run the
focused package and API checks, the three-process cluster proofs, unchanged E3
browser acceptance, and an environment-matched state-write comparison. Review
the whole branch against the current merge base, publish a concise behavior and
evidence map in the draft PR, and require a green exact-head Release Gate before
readiness. Do not disrupt an existing PostgreSQL container or erase benchmark
data to obtain the comparison without separate authorization.

**Completed local enabling slices — inbound authority and test contracts.**
The room-unicast addressee projection again runs at the inbound authority
before admission. Addressed and originated receipt fixtures now prove current
authenticated scope, and the addressed live-send fixture uses the current DTO.
The refusal/NACK behavior passed 75 focused tests after independent review.
Six authorizer fixtures now state their required NACK policy, and two RTC
fixtures state their required server-peer field. Thirteen duplicate ingress
delivery cases were removed only after mapping their equivalent setup and
assertions to retained inbound-delivery tests; independent review approved
the mapping. `typecheck:tests` passes. No public overload, production contract
loosening, or retained affected legacy was added. These fixes are not remote
acceptance evidence until checked on the exact PR head.

**Next slice — resolve the measured release, ALM, and performance regressions.**
At the implementation head, the Release Gate passed style, structure,
typecheck, ALM conformance, and 13,157 tests (12 skipped); it failed only the
two then-current strict bundle tests. The local whole suite likewise
passed 13,157 tests and skipped 12 apart from those bundle tests:
`browser/rallar.ts` measured 225.419921875 KiB against `<225` and the headless
agent measured 287.8095703125 KiB against `<287`. The maintainer has since
approved the next whole-KiB strict ceilings, `<226` and `<288`, for this goal.
The two focused tests were rerun RED at the old ceilings before changing them;
the approved ceilings are now committed and both focused bundle tests pass
6/6. The unchanged browser measurement command passes with the full facade at
225.4 KiB under strict `<226`. Retain the exact bundle entry points,
compressor, and dependency exclusions.
The one-millisecond timing failure seen in an earlier whole-suite run did not recur locally, but it did
recur at the later plan-only branch head. That later head also failed the
remote ALM WS replacement observation despite a focused local pass. Treat
both as unresolved until classified with independent evidence. Do not hide
inputs or omit required runtime behavior. Recheck the whole suite on the
current head. In the same slice, investigate the state-write diagnostic regression above before
accepting the principal scope-wide read; compare complete read alternatives
and the measured query plan, then rerun the identical state-write workload.

**Following slice — exact-head distributed and browser evidence.** Once the
local gate is green, run the branch Release Gate and reconcile remaining raw
WS-outbox producers against the approved authority policy. Existing exact-head
three-process group-delta, auth-logout, and CRDT proofs pass; they do not prove
topology first-dequeue or E3 browser acceptance. Three branch E3 retention-100
diagnostics failed at reconnect cycles 4, 2, and 5; none reached the required
100 cycles. In each final capture A remained ready while B and C knew each
other but lacked a ready lane. One side had a fresh peer connection without
descriptions while the other side had completed offer/answer signaling but had
not reached an ICE-connected state. The offerer differed between runs, and the
bounded causal tails cannot identify why the peers were replaced or whether
candidate data belonged to the same native generation. Do not infer a
stale-offer root cause from one run or relax readiness and attempt limits.
The server's existing inbound plan can forward a best-effort RTC signaling
unicast without a local recipient, then treat a zero-recipient send as completed.
Because the PostgreSQL inbound work is shared across API processes, this is a
code-derived loss path when a process without the target socket claims the
row. It predates this branch refactor; the earlier A/C logs are consistent
with it but lack message-ID correlation. Prove the cross-process boundary and
correct it without a new queue, retry layer, lock, or weakened E3 workload.
Gather generation-linked, payload-safe signaling and ICE-state evidence,
identify the failure boundary, then rerun the unchanged E3 case. Run the
remaining required cluster proofs,
obtain a governed environment-matched state-write comparison without
disrupting existing PostgreSQL data, then perform whole-branch standards/legacy
review and update the draft PR evidence map. Keep the PR draft until the
exact-head gate and required acceptance evidence are green.

**2026-09-29 RTC cross-process and gate checkpoint.** The existing Playwright
three-browser matrix now has an opt-in three-API-process PostgreSQL mode; its
ordinary E4 observation topology remains unchanged. On fresh task-owned
databases, the unchanged formation readiness failed before the correction with
socketless forward logs. A callback-only attempt also failed because the
generic inbound plan skipped the reserved RTC callback. The corrected plan
dispatches that admitted callback once and suppresses only RTC's separate
generic forwarding; the callback uses the existing live notice carrier, while
each receiving process attempts a direct scoped local send. Two subsequent
three-process browser runs passed with A/B/C on distinct _bootstrap_ API origins
and real addressed Offer, Answer, and IceCandidate observations. Focused 60/60 tests,
affected checks, independent review, and a scoped clock-injection fix review
passed. The oversized canonical RTC key path now requires matching persisted
authenticated source scope, canonical sender/message/target, expiry, and the
current recipient scope; old unproven sources fail closed. These browser runs
were preliminary signaling evidence, not the unchanged E3-memory 100-cycle
acceptance result.
The browser still emits pre-existing-looking malformed-RTC warnings; heartbeat
frames entering AL admission are a code-derived explanation, but individual
warning payloads were not captured, so do not dismiss them as harmless.

**2026-09-29 browser-proof review correction:** The `rtc.connect` command
still supplied A's global API URL to B/C, potentially moving their actual RTC
sockets back to A after bootstrap. The assertion also pooled signal kinds
across agents, so it did not prove every peer pair. Retract the focused
cross-process proof claim above. Keep PR #566 draft until each agent's connect
and raw-WS commands use its selected API URL, received signaling is tied to
that agent's observed socket origin, Offer/Answer are correlated by peer pair
and offer ID, and the unchanged three-process browser matrix passes again.

**2026-09-29 corrected local browser proof:** The branch now selects one
canonical A/B/C URL per agent for bootstrap, `rtc.connect`, configuration, and
raw WebSocket commands. The existing browser observer records the native socket
origin and a bounded socket-generation identity without retaining payloads;
the matrix checks Offer/Answer per peer pair and offer ID, decoder-valid
received ICE per pair, and recipient socket identity. Duplicate deliveries on
different socket generations are ambiguous rather than falsely attributed to
the old socket. Against three separate API processes and a fresh task-owned
PostgreSQL database, the final focused existing Playwright matrix passed
(`1 passed`, 1.4 minutes, retry disabled) after the observer and matrix edits.
This is corrected **local** cross-process RTC signaling proof on the committed
branch content, not an exact published PR-head result: the remote PR head
remains older. The browser logged malformed-RTC data-channel warnings without
an attributed payload; those are not silently classified as harmless. Publish
and rerun the corrected test on an exact branch head before using it for
readiness.

**2026-09-29 principal-read decision:** The maintainer approved validating
only groups relevant to the principal. Unrelated corrupt group records in the
same scope will no longer block that principal's state-sync publication; every
selected membership, group, and client still requires canonical validation,
and the full authorized audience remains unchanged. This authorizes the
semantic boundary, not an unreviewed query/index design or a performance-pass
claim. A focused design/spec and implementation plan precede the repository
read-selector change; the unchanged hosted comparison remains the acceptance
gate. No additive index is justified by the current evidence.

The exact prior-head Release Gate passed medium-scale, formation-large, ALM,
and earlier stages but failed one Relic storage test. Read-only reproduction
found its handler fixture omitted the room context required by the branch's
intended scope guard. A fixture-only correction passed focused and full Relic
tests and independent review; no production guard was weakened. It has not yet
passed a new exact-head Release Gate.

**Next two slices:** (1) Publish the reviewed corrected browser proof on the
PR branch and rerun the existing three-process matrix on its exact head. The
fresh local pass is not the remote gate. (2) Document and review the approved
principal-relevant validation design, then implement and measure the smallest
read-selector change against the unchanged full authorized audience and
order-balanced state-write comparison. The existing development PostgreSQL
container must remain untouched. Following those slices, correlate E3 signaling, peer
generation, and ICE state without weakening the workload; run unchanged
default, all-scenarios, and retention-100 plus the required same-SHA diagnostic
cohort. The most recent retention run reached cycle 40 but exhausted the
30-minute test deadline, so it is not acceptance. Reconcile any remaining raw
outbox producer, complete whole-branch standards/legacy review, and require a
green exact-head Release Gate before marking the draft PR ready. No diagnostic
artifact is a valid B06 primary or a substitute for later main-stream
publication.

Task 14b's two local commits close the four prior-head style findings through
direct control flow and three exact reviewed warning-tier caps, then propagate
the existing service clock through live delivery and recipient selection. The
focused 262-test set, 51 tooling tests, and follow-up 169-test set pass, as do
shared/shared-server TypeScript and API Deno checks. The full suite is not green:
15 failures reproduce on the exact pre-14b head (two bundle budgets and
relay/receipt expectations), while one full-run timing assertion passes alone.
`typecheck:tests` still reports nine errors in five untouched test files.
These are Task 14c release-readiness inputs, not evidence that Task 14b's
scoped behavioral checks or whole-branch acceptance have passed.

### Earlier investigation and gate checkpoints

**Next candidate after Task 12:** The current CRDT authorization read already
checks a durable client or group snapshot for the actor's active session, but
returns only allow/deny to mutation computation. Investigate carrying that
read's attested full document scope and frozen authorized audience as transient
mutation facts into exact per-row reply/fanout proofs; this may avoid changing
the persisted command. The original socket's authenticated scope is not
recoverable from that command or the unscoped auth session, so verify that
document-scope attestation satisfies the intended publication authority before
implementation. Do not equate an optional document workspace with proof,
claim the CRDT failures fixed, or change the persisted command without the
separate approval above. The two exact-head cluster matrices currently fail at
committed CRDT reply waits, which is consistent with missing direct-producer
proof but does not correlate an individual rejected row in the logs.

**2026-09-28 earlier exact-head gate checkpoint:** The Branch Release Gate
(`393ed0045534e53bc3f310b700556efbae2f8b84`) also failed the ALM
conformance observation lane at `fallback-within-deadline`: the sender's
10-second acknowledged-state observer timed out shortly before the receiver
committed its ACK. The scenario's message TTL is 30 seconds, and the previous
branch head passed the lane. This identifies a possible harness budget mismatch,
not yet a proved product regression or permission to lengthen the test. Review
the fallback timing contract and repeat the focused lane before marking the
failure resolved. Changed-style warnings and both CRDT reply failures also
remain open; the branch is not ready for main.

**2026-09-28 subsequent exact-head checkpoint:** At `da8763c17d0e42596405f191984fc8a632ac7eec`,
the medium-scale and formation-large PostgreSQL jobs passed their respective
primary profiles, then both failed the same two cluster recipes while waiting
for committed CRDT append replies. The durable topology replay job passed,
but that does not prove first-dequeue delivery of every topology page. The
Release Gate stopped at four changed-style findings before its later checks.
The separate ALM observation failed five browser cases, including three-agent
missing receipts and RTC readiness timeouts; its cause is not yet isolated and
no E3 acceptance is claimed. An independent branch review also found that
failed best-effort `NOTIFY` results were discarded by admitted/proxy routing
and normal local socket-send failures lacked a result diagnostic. A focused
red/green correction now reports these failures without changing the
one-attempt contract; its 75 router tests, shared-server type check, and full
unit suite (13,066 tests) pass locally. The correction has not yet run in
remote CI. Keep this PR draft until the producer-proof gaps, style findings,
ALM failures, and acceptance evidence are resolved.
