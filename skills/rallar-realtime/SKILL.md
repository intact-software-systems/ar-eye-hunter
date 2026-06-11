---
name: rallar-realtime
description: Use when changing Rallar rooms, GroupRef/scoped identity, group/client state, WS/RTC routing, multicast, graph topology, presence, state sync, or reconnect/cold-cache behavior.
---

# Rallar Realtime

## First Pass

Inspect both runtime sides before editing:

```bash
rg -n "GroupRef|groupRef|groupId|roomId|createAndJoin|joinRoom|state-sync|WebSocket|RTC|topology|presence" packages/shared packages/shared-web packages/shared-server packages/shared-graph apps/api-v1
```

## Core Areas

- Browser rooms and message APIs: `packages/shared-web/browser/rallar.ts`.
- HTTP API calls: `packages/shared-web/browser/api-integration.ts`.
- Server room/group services: `packages/shared-server/rallar-system/services`.
- State sync routing/publication: `packages/shared-server/rallar-system/state-sync-*`.
- WS topic routing: `packages/shared-server/rallar-facade/ws-topic-router.ts` and `packages/shared-server/rallar-system/ws-system-topics.ts`.
- RTC topology/graph: `packages/shared-server/rallar-system/services/rallar-rtc-topology-service.ts` and `packages/shared-graph`.

## Rules Of Thumb

- Prefer `GroupRef` over bare `groupId` when application/workspace scope matters.
- Do not trust warm in-memory presence blindly; check expiry and durable read-through paths.
- Keep browser ergonomics, but diagnose ambiguity where string room IDs can cross scopes.
- For RTC tests, distinguish signaling readiness from actual data-channel readiness.
- Game and motion traffic are reliability consumers of the realtime layer, not separate demos.

## Validation

Run focused tests in `packages/tests/shared-web`, `packages/tests/shared-server`, `packages/tests/shared-graph`, and relevant game tests. For restart/cold-cache work, include server routing tests and at least one reconnect scenario.

