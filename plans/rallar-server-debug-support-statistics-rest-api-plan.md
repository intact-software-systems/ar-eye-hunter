# Rallar Server Debug And Support Statistics REST API Plan

Date: 2026-07-08

Status: Follow-on planning document. This plan depends on the admin operations
foundation in `plans/rallar-server-admin-operations-rest-api-plan.md`.

## Goal

Plan a focused debug and support workflow for Rallar Server that helps an
operator answer "what happened to this request, session, room, document, or
message?" without exposing broad admin data to normal users and without forcing
support staff to inspect database tables directly.

This is the third slice after:

1. admin operations
2. SPA product UX statistics

## Users And Scenarios

Primary users:

- platform admins investigating production incidents
- developers debugging realtime/state/CRDT issues
- support operators helping a user or game session recover

Core scenarios:

- A client claims they are online, but the room does not see them.
- A room has members, but WS room fanout is not reaching everyone.
- A REST mutation returned slowly or failed.
- A QueueBox item is stuck, retried, expired, or missing a result.
- A CRDT document is out of sync or needs a redacted debug bundle.
- A topology recompute did not publish the expected overlay.
- A support operator has a request id, session id, group id, document ref, or
  idempotency key and needs a compact explanation.

## Relationship To Admin Operations

The debug/support API should reuse:

- admin auth helpers
- aggregate readers
- queue/result readers
- CRDT admin readers/exporters
- topology management services
- shared operation response contracts

It should not duplicate the broad admin dashboard. Instead, it should expose
targeted "explain" endpoints that gather a bounded diagnostic bundle for one
target.

## Recommended Namespace

Admin-only support diagnostics:

```text
/api/admin/support/*
```

Possible future scoped self-service diagnostics:

```text
/api/state/apps/:applicationId/workspaces/:workspaceId/support/*
```

The first implementation should be admin-only. Scoped self-service support can
come later after redaction rules are proven.

## Endpoint Sketch

### Explain Client

```text
POST /api/admin/support/explain/client
```

Input:

- `applicationId`
- `workspaceId`
- `principalId`
- optional `sessionId`

Returns:

- client snapshot summary
- active session summary
- live WS connection match status
- recent client events
- group presence references where available
- warnings about expired, disconnected, or mismatched sessions

### Explain Group

```text
POST /api/admin/support/explain/group
```

Input:

- `GroupRef`

Returns:

- group snapshot summary
- active sessions and online member count
- topology view summary
- graph diagnostic pointer or summarized result
- recent group events
- room fanout readiness hints
- warnings for stale presence, no active sessions, missing topology, or
  authorization ambiguity

### Explain Request

```text
POST /api/admin/support/explain/request
```

Input can include:

- `requestId`
- `Idempotency-Key`
- queue key
- state scope and target id

Returns:

- matching queue entries
- matching app-inbox results
- timing records only if a timing store exists in the future
- mutation result status where available
- likely next action

Phase 1 can support queue/result lookup by explicit QueueBox key and documented
request-id locations. A historical timing/event store can be a later upgrade.

### Explain CRDT Document

```text
POST /api/admin/support/explain/crdt-document
```

Input:

- CRDT document ref
- optional `includeIntegrity`
- optional `includeRedactedDebugBundle`

Returns:

- document metadata
- lifecycle
- append/update/snapshot counts
- stored bytes
- integrity result when requested
- redacted debug export when requested

Payload redaction remains the default.

### Explain Queue Item

```text
POST /api/admin/support/explain/queue-item
```

Input:

- topic id
- resource id
- context id

Returns:

- inbox row status if present
- result row status if present
- attempts
- age
- next retry time
- expiry
- redacted payload metadata, not raw payload

## Data Contract Principles

Support responses should be shaped as diagnostic narratives:

- `target`
- `generatedAtEpochMs`
- `facts`
- `timeline`
- `warnings`
- `likelyCauses`
- `suggestedActions`
- `rawRefs`

The response should prefer exact facts over guesses. Any inference should be
marked as an inference.

## Safety And Privacy

Support APIs are risky because they cross user, group, and document boundaries.
The first version should be admin-only.

Rules:

- never return bearer tokens or auth tickets
- never return password material
- redact CRDT and queue payload bodies by default
- bound recent events by limit
- require explicit target identifiers
- avoid global searches in phase 1 unless indexed
- log/audit support bundle generation

If scoped self-service support is added later, it must reuse group/client policy
checks and return a smaller payload.

## Phasing

### Phase 1: Admin Explain Endpoints

- Add admin-only support namespace.
- Add explain client, group, queue item, and CRDT document.
- Add request-id/idempotency lookup where existing data supports it cheaply.
- Reuse admin operations contracts and readers.

### Phase 2: Better Timelines

- Add optional durable timing/event collection if needed.
- Correlate HTTP request id, app-inbox request id, QueueBox key, state event id,
  and WS publish result.
- Add timeline assembly helpers.

### Phase 3: Scoped Support UX

- Add scoped self-service endpoints for users to diagnose their own session or
  room membership.
- Restrict payloads with group policy and self-principal checks.
- Expose user-readable suggested actions to SPAs.

## Validation Plan

Tests should cover:

- admin-only authorization
- missing target handling
- redaction defaults
- bounded event lists
- explain group with and without topology
- explain client with and without live WS session
- queue item found/missing/expired/result-only cases
- CRDT document debug export redaction
- clear warnings for partial data

## Open Decisions For Implementation

- Whether support endpoints should emit CRDT audit events or a separate support
  audit event type.
- Whether request explanation should search by request id across multiple
  tables immediately or require callers to provide a more specific key in phase
  1.
- Whether "suggestedActions" should be hard-coded strings or structured action
  descriptors that an admin UI can render.
