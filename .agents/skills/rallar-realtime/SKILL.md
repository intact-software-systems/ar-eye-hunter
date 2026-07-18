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

- Prefer `GroupRef` over bare `groupId` when application/workspace scope matters.
- Do not trust warm in-memory presence blindly; check expiry and durable read-through paths.
- Prefer optimistic reconciliation for replicated state. Accept monotonic newer
  observations. Ignore stale observations without failing the consumer, and
  treat equal-revision/different-content data as invariant corruption.
- Plan and recompute outside transactions, then use compare-and-set writes with bounded retries
  at the durable boundary. Create with conditional insert, update with expected
  revision, and delete or expire with an expected revision.
- Re-read and re-run authorization, policy, capacity, lifecycle, and invariants
  on every retry. Never reuse a decision derived from a predecessor that lost
  its compare-and-set race.
- Database row, table, and advisory locks are not the default. Existing lock-based
  client-session, group-presence, topology, publication, or RTT code is
  migration debt rather than precedent. A lock exception requires explicit
  human approval and documented evidence, scope, and removal conditions.
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
