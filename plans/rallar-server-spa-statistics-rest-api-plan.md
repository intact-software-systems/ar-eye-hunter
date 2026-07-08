# Rallar Server SPA Statistics REST API Plan

Date: 2026-07-08

Status: Follow-on planning document. This plan depends on the admin operations
foundation in `plans/rallar-server-admin-operations-rest-api-plan.md`.

## Goal

Plan a scoped, read-only statistics surface that helps browser SPAs show useful
Rallar state to normal authorised users without exposing platform-wide admin
operations data.

The SPA statistics surface should make product experiences better:

- room lobby occupancy
- online people summaries
- connection and realtime readiness hints
- lightweight activity counts
- safe "what is happening in this workspace or room?" views

It should not become an admin dashboard.

## Audience

Primary consumers:

- `packages/shared-web` browser facades
- app SPAs such as AR Eye Hunter and Relic Hunters
- future admin UI components that need scoped non-dangerous reads

Primary viewers:

- a logged-in user
- a group member
- a group owner/admin
- a workspace-level user where workspace concepts exist

## Recommended Namespace

Use the existing state API shape:

```text
/api/state/apps/:applicationId/workspaces/:workspaceId/stats/*
```

Room-scoped routes should use `GroupRef` path structure:

```text
/api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/stats
```

This keeps SPA statistics near the state resources they summarize and allows
the existing `/api/state/*` bearer-auth gate to apply.

## Authorization Model

SPA stats must be scoped and policy-aware.

Rules:

- require normal API auth
- client-level stats about "me" require self-principal checks
- group stats require `canReadGroupSnapshot(...)`
- owner/admin-only stats can use `canUpdateGroupSnapshot(...)` if they expose
  management-sensitive details
- no global platform stats for normal SPA users
- no queue, runtime-state, app-data, auth-session, or CRDT storage pressure
  stats for normal users

## Endpoint Sketch

### Workspace Summary

```text
GET /api/state/apps/:applicationId/workspaces/:workspaceId/stats/summary
```

Returns:

- visible group count
- joined group count
- online people count visible to the actor
- actor online/session summary
- recent visible activity count
- generated timestamp

This should be safe for dashboards and lobbies.

### People Summary

```text
GET /api/state/apps/:applicationId/workspaces/:workspaceId/stats/people
```

Returns:

- online people visible to the actor
- presence buckets: online, away, busy, offline where available
- active session count for the actor
- optional top active groups if policy allows

The endpoint should not reveal hidden users or users in private groups the actor
cannot read.

### Group Summary

```text
GET /api/state/apps/:applicationId/workspaces/:workspaceId/groups/:groupId/stats
```

Returns:

- member count
- online member count
- active session count
- group status
- actor role
- topology kind and overlay version when safe
- recent group event count
- generated timestamp

This is the core room/lobby product endpoint.

### My Realtime Status

```text
GET /api/state/apps/:applicationId/workspaces/:workspaceId/stats/me/realtime
```

Returns:

- actor principal id
- current session id
- whether the current auth session has a live WS connection on this server, if
  detectable
- active client sessions for the actor
- groups where this session has active presence
- warnings for missing WS, expired presence, or stale heartbeat

This should help SPAs show connection repair prompts.

## Browser Facade Direction

After server routes exist, `packages/shared-web` can expose narrow helpers:

- `rallar.stats.workspace.summary()`
- `rallar.stats.people.summary()`
- `rallar.rooms.stats(groupRefOrId)`
- `rallar.connection.readMyRealtimeStatus()`

The facade should keep responses typed and scoped. It should not expose admin
operations through the normal browser package.

## Response Contract Principles

Responses should include:

- `generatedAtEpochMs`
- `scope`
- `actor`
- compact counts and small lists
- `warnings` for partial visibility or stale data

Responses should avoid:

- raw event payloads
- raw queue or CRDT data
- global server identifiers unless needed
- exact session ids for other users
- unbounded member/client lists

## Data Sources

Likely data sources:

- client state service snapshots
- group state service snapshots
- group policy helpers
- existing topology read view for a group
- recent state event counts from state-event repositories
- live WS status only for the current actor/session where safe

The implementation should avoid expensive global list-and-filter operations for
large workspaces. If a first version must use them, responses should include a
warning and implementation should follow with aggregate/indexed readers.

## Phasing

### Phase 1: Scoped Read Routes

- Add workspace summary.
- Add group summary.
- Add my realtime status.
- Add route tests for auth and group policy.

### Phase 2: Browser Facade Helpers

- Add typed `packages/shared-web` helpers.
- Add app-level usage in one SPA or black-box workbench as a proving ground.
- Add browser workflow tests.

### Phase 3: Product Polish

- Add people summary once visibility rules are settled.
- Add caching hints or ETags if stats are polled.
- Add optional field selection if payloads grow.

## Validation Plan

Tests should cover:

- unauthenticated request denial
- self-principal access
- group member read access
- non-member denial for private group stats
- owner/admin expanded group details if included
- no leakage of other users' session ids
- stable empty-state responses
- browser facade request path construction

## Open Decisions For Implementation

- Whether workspace summary should count only groups the actor can read or all
  groups in the workspace for workspace admins.
- Whether topology kind is safe for all group members or should be owner/admin
  only.
- Whether people summary needs a first-class workspace membership model before
  it is useful.
- Whether polling should be supported directly or left to SPAs to schedule.
