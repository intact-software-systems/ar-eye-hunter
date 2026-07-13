---
name: rallar-realtime
description: Use when changing Rallar rooms, GroupRef/scoped identity, group/client state, WS/RTC routing, multicast, graph topology, presence, state sync, or reconnect/cold-cache behavior.
---

# Rallar Realtime

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
- Keep browser ergonomics, but diagnose ambiguity where string room IDs can cross scopes.
- Use `rallar.rooms.createAndSwitch(...)` for browser flows where creating a new
  room should leave the previous current room. Plain `rooms.create(...)` keeps
  the previous membership.
- Use `rooms.waitForPresence(...)` and RTC `expect` options when a flow needs a
  bounded number or exact set of active sessions/peers.
- Prefer `rallar.realtime.room<T>(...)` for app/game room traffic before wiring `rtc.waitForRoomLane`, `readyPeerIds`, and `realtime.sendJson` manually.
- Prefer `rallar.messages.room<T>(...)` when important room-scoped messages need typed RTC/WS fallback behavior.
- For RTC tests, distinguish signaling readiness from actual data-channel readiness.
- For inbound RTC peer creation, group state is eventually consistent. Prefer
  optimistic/tentative admission under caps and attempt budgets; keep hard
  rejects for malformed, self, wrong-target, exhausted, or cap-blocked peers.
- Browser RTC enables the initial connection-attempt budget by default. The
  shared service exposes `connect-exhausted`; browser facade waits report
  exhaustion as `failed` with reason `rtc-connect-attempt-budget-exhausted`.
- Game and motion traffic are reliability consumers of the realtime layer, not separate demos.

## Validation

Run focused tests in `packages/tests/shared-web`, `packages/tests/shared-server`, `packages/tests/shared-graph`, and relevant game tests. For restart/cold-cache work, include server routing tests and at least one reconnect scenario.
