---
name: rallar-realtime
description: Use when changing Rallar rooms, GroupRef/scoped identity, group/client state, WS/RTC routing, multicast, graph topology, presence, state sync, or reconnect/cold-cache behavior.
---

# Rallar Realtime

Use `building-rallar-apps` when deciding how realtime fits into a whole new
app. `rallar-realtime` remains authoritative for rooms, scope, messages,
WS/RTC, identity, routing, and readiness.

## First Pass

Inspect both runtime sides before editing:

```bash
rg -n "GroupRef|groupRef|groupId|roomId|createAndSwitch|createAndJoin|joinRoom|waitForPresence|RallarReadinessExpectation|state-sync|WebSocket|RTC|topology|presence|realtime\\.room|messages\\.room|peerConnectionAttemptBudget|connect-exhausted" packages/shared packages/shared-web packages/shared-server packages/shared-graph apps/api-v1 apps/ar-eye-hunter-v1 apps/relic-hunters-v1
```

## Core Areas

- Browser compatibility facade: `packages/shared-web/browser/rallar.ts`.
- Narrow browser entry points: `packages/shared-web/browser/rallar-core.ts`, `rallar-realtime.ts`, `rallar-data.ts`, `rallar-crdt.ts`, and `rallar-media-calls.ts`.
- Browser room helpers: `rallar.realtime.room<T>(...)` for room-scoped RTC JSON sends and `rallar.messages.room<T>(...)` for typed room messages with RTC/WS options.
- HTTP API calls: `packages/shared-web/browser/api-integration.ts`.
- Server room/group services: `packages/shared-server/rallar-system/services`.
- State sync routing/publication: `packages/shared-server/rallar-system/state-sync-*`.
- WS topic routing: `packages/shared-server/rallar-facade/ws-topic-router.ts` and `packages/shared-server/rallar-system/ws-system-topics.ts`.
- RTC topology/graph: `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts` and `packages/shared-graph`.

## Rules Of Thumb

- Authoritative shared fields are mandatory except documented input or
  migration exceptions.
- Prefer `GroupRef` over bare `groupId` when application/workspace scope matters.
- Do not trust warm in-memory presence blindly; check expiry and durable read-through paths.
- Prefer optimistic reconciliation for replicated state. Accept monotonic newer
  observations. Ignore stale observations without failing the consumer, and
  treat equal-revision/different-content data as invariant corruption.
- Plan and recompute outside transactions, then use compare-and-set writes with bounded retries
  at the durable boundary. Runtime-state creation, update, and deletion use
  `insertIfAbsent`, `upsertIfRevision`, and `deleteIfRevision`.
- Re-read and re-run authorization, policy, capacity, lifecycle, and invariants
  on every retry. Never reuse a decision derived from a predecessor that lost
  its compare-and-set race.
- Keep group and summary convergence human-readable as direct named read,
  compute, validate, and write statements: `read`, `compute`, `validate`, then
  `write`. The `compute` and `validate` phases are pure; only `write` opens the
  transaction, its conditional guard is first, and a conflict restarts at
  `read`. The implemented retry boundary is
  `DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS` (`[0, 2, 8]` ms),
  `waitForRuntimeStateWriteRetry`, and `RuntimeStateRetryExhaustedError`.
  Record phase timing around each direct statement with transaction timing
  separate.
- State, idempotency receipt, insert-only outbox intent, and event commit in one
  authoritative transaction. `StateMutationOutboxRepository` makes the outbox
  rows atomic with the guarded write. An outbox collision is a typed rollback
  failure and must not load a winner. Winner loading is only for an explicitly
  non-authoritative/read path. The compact `MutationReceipt` family and
  `GroupStateCausalRevision` carry replay and group/presence authority.
- Preserve omitted public random/time inputs as mandatory `null` command fields
  when hashing idempotent intent. After hashing, validate the ledger before any
  random, clock-default, verifier, or other volatile materialization. Only a
  ledger miss may capture immutable facts; matching replay and conflicting key
  reuse invoke no volatile callbacks. Keep the winning code, expiry, verifier,
  receipt, and metadata unchanged across retry and replay.
- Group user mutations fail closed: the durable service requires a real issued
  auth session or exact command-bound proof. Never add an optional authority
  repository, missing-authority fallback, legacy payload bypass, or test-shaped
  production overload.
- Keep server maintenance as a separately wired narrow capability. Do not add
  expiry or socket-cleanup methods to `GroupStateService`, middleware runtime,
  or `AppGroupInboxService`; do not accept caller-supplied maintenance actor,
  reason, or bypass flags. Derive cleanup identity from the persisted session.
  Derive a collision-safe request identity from the complete semantic command,
  including operation, full scope, principal/session/generation identity,
  observed predecessor values, and every timestamp; exclude only the
  command/request identity being derived. Do not use raw delimiter
  concatenation. Different scans then rebase/no-op instead of colliding under
  one incomplete idempotency key.
- Presence summaries are optimistic materialized views, not authority. Compute
  them from entry-aware group/member/admission/session reads, validate their
  exact persisted shapes, CAS the exact summary predecessor, and exclude
  sessions whose member is no longer active even if a stale session row remains
  live. Snapshot assembly captures one observation time and also intersects the
  summary with current group status/expiry: archived, deleted, or expired groups
  report zero active sessions and online members while preserving causal
  revisions. Newer source mutations enqueue follow-up convergence work.
- A liveness-filtered current-authority projection that preserves the summary
  causal tuple is not a canonical summary-cache observation. Return it without
  observing, evicting, rewriting, or synthetically advancing the monotonic
  cache; only canonical summary convergence with an advanced tuple updates that
  cache. Never report committed authoritative success as failure because an
  optional cache observation conflicts.
- Group presence uses its per-session guard and does not contend on the group
  row. Group metadata and roster operations use the aggregate group guard.
- Treat storage-key/value/command relationships as part of those persisted
  shapes. A shape-valid row in the wrong actor, target, owner, director,
  principal-admission, session, summary, or idempotency slot is corruption and
  must fail validation before the first authoritative write. Expected slot
  identity comes only from the trusted command and aggregate metadata, never
  from the candidate row itself.
- Scoped realtime storage-key encodings must also be injective over absence and
  every valid explicit identifier. Escaping a string does not encode its
  presence type; URI encoders may leave sentinel-looking values unchanged.
  Test group/member/session/admission/summary/idempotency keys plus delimiter,
  percent, prefix/list, and real repository isolation. Preserve a legacy
  namespace only when value identity proves its scope; use conditional
  migration and fail closed on ambiguity or destination conflict.
- Group-state direct, prefix-list, page, event, and compact-receipt reads must
  decode canonical storage identity and validate the complete requested scope
  and entity/request slot. The trusted request or decoded key supplies expected
  identity, never the stored value. Any mismatch fails the entire read with a
  typed invariant-corruption error; do not return a miss, filter the row,
  rewrite it, or guess.
- Shape-valid effects can still describe the wrong operation. Canonically
  recompute and exactly compare operation-specific guards, dependent rows,
  events, receipts, and outbox intents before the first authoritative write.
- Database row, table, and advisory locks are not the default. The implemented
  client, group, topology-config, topology publication/execution, and RTT paths
  no longer use `lockKey`. Historical lock-based versions remain a warning,
  not precedent. A lock exception requires explicit human approval and
  documented evidence, scope, and removal conditions.
- Optimistic and permissive does not mean weak contracts. Require causal fields
  on snapshots and durable work; reserve hard rejection for malformed or
  wrongly scoped data, authorization failures, invariant corruption, resource
  caps, and exhausted retry or connection-attempt budgets.
- Keep browser ergonomics, but diagnose ambiguity where string room IDs can cross scopes.
- Use `rallar.rooms.createAndSwitch(...)` for browser flows where creating a new
  room should leave the previous current room. Plain `rooms.create(...)` keeps
  the previous membership.
- Use `rooms.waitForPresence(...)` and RTC `expect` options when a flow needs a
  bounded number or exact set of active sessions/peers.
- Prefer `rallar.realtime.room<T>(...)` for app/game room traffic before wiring `rtc.waitForRoomLane`, `readyPeerIds`, and `realtime.sendJson` manually.
- Prefer `rallar.messages.room<T>(...)` when important room-scoped messages need typed RTC/WS fallback behavior.
- Room handles scope sends, peer selection, and readiness; their receive
  callbacks remain topic/type or lane listeners and are not automatically
  room-filtered. Validate message targets from `message.raw.targets` with
  `isSameGroupRef`. A realtime payload must carry the full `roomRef` and the
  receiver must validate it, unless the lane is unique to that room.
- For RTC tests, distinguish signaling readiness from actual data-channel readiness.
- For inbound RTC peer creation, group state is eventually consistent. Prefer
  optimistic/tentative admission under caps and attempt budgets; keep hard
  rejects for malformed, self, wrong-target, exhausted, or cap-blocked peers.
- Browser RTC enables the initial connection-attempt budget by default. The
  shared service exposes `connect-exhausted`; browser facade waits report
  exhaustion as `failed` with reason `rtc-connect-attempt-budget-exhausted`.
- Game and motion traffic are reliability consumers of the realtime layer, not separate demos.

## Validation

Run focused tests in `packages/tests/shared-web`, `packages/tests/shared-server`, `packages/tests/shared-graph`, and relevant game tests. For restart/cold-cache work, include server routing tests and at least one reconnect scenario. For shared database writes, prove overlapping conflicts, rebasing, retry exhaustion, idempotency, stale expiry safety, and deterministic final convergence; do not treat lock acquisition or waiting as the acceptance criterion.
