# Rallar CRDT Guide

Rallar CRDT is the explicit collaborative document surface for Rallar. Use it
when multiple replicas can edit the same application document independently and
the application can accept deterministic merge semantics.

Use `rallar.crdt`, not `rallar.data`, for mergeable collaboration. `rallar.data`
remains a local latest-value store.

## Durable Mutation Ownership

**AppInbox is mandatory for incoming database mutations.** This includes CRDT
WebSocket append and CRDT admin mutations as well as all other HTTP/WS
client/group/topology, authentication/session/ticket, and mutating admin paths.
AppInbox owns the transaction and retry boundary; waiting for a result never
falls back to a direct CRDT repository mutation.

The `read` phase loads the repository decision surface outside the write
transaction. Only `compute` and `validate` are pure, and they produce computed
persistence data, not a plan. The service `write(transaction, computed)` applies
it: service write receives the transaction and never opens or retries one. It
writes CRDT state, receipt, result, and final `APP_OUTBOX`/`WS_OUTBOX` entries
directly through `ResourceInboxRepository` in the same transaction. There is no
intermediate mutation outbox.

Resource inbox allows 20 total processing attempts, staged from 1, 2, 4, 8,
and 16 ms through seconds capped at 30 seconds with jitter. A separate
best-effort fairness lane claims retries more than 30 seconds overdue. Queue
locks are coordination-only; CRDT document-row and advisory locks are not
queue-claim exceptions. Authoritative persisted/shared CRDT contracts use
mandatory fields by default.

## Source Owners

Start from `packages/shared-server/mod.ts` for the supported server surface. The
direct capability owners are:

- WebSocket registration:
  `packages/shared-server/rallar-system/crdt/realtime/install-rallar-crdt-ws-topics.ts`
- durable command and retry entry:
  `packages/shared-server/rallar-system/crdt/inbox/app-crdt-inbox-service.ts`
- read, compute, validate, and guarded write phases:
  `packages/shared-server/rallar-system/crdt/mutation/create-crdt-mutation-service.ts`
- PostgreSQL conditional mutation writes:
  `packages/shared-server/rallar-system/crdt/persistence/psql-crdt-mutation-repository.ts`
- API administration routes:
  `apps/api-v1/src/crdt/register-crdt-admin-routes.ts`

The colocated package map at
`packages/shared-server/rallar-system/crdt/README.md` describes the complete
runtime paths, including read-only catch-up and optional external audit
delivery.

## When To Use It

Use CRDT documents for:

- shared checklists, notes, annotations, lightweight boards, and authored room
  state
- collaborative counters, min/max operational values, and authored graph state
- offline-tolerant edits that can be retried later
- conflicts that should be preserved or resolved by application UI

Do not use CRDT documents for:

- auth, membership, billing, quota, inventory, or other authoritative server
  commands
- presence expiry, RTC topology, or computed graph overlays
- arbitrary JSON Patch merging, OT streams, or Yjs/Automerge binary updates
- raw binary/blob payloads
- privacy erasure; CRDT delete is a document edit, not log redaction

## Browser API

```ts
const doc = await rallar.crdt.open('room-checklist', {
    documentType: 'checklist',
    documentId: room.group.groupId,
    scope: {
        kind: 'room',
        roomRef: room.group
    },
    transport: 'ws-then-rtc'
});

await doc.applyLocal({
    kind: 'batch',
    operations: [
        {
            kind: 'orset.add',
            path: ['items'],
            elementId: crypto.randomUUID(),
            value: {
                text: 'Inspect north entrance',
                done: false
            }
        }
    ]
});
```

`applyLocal(...)` returns an update envelope. The local document reads the edit
immediately. The update remains pending until the server durable append path
accepts it, or until the document stays local-only.

## Transport Choice

Room-scoped documents support user-selected live transport strategies:

- `local-only`: no network send
- `ws`: server-routed room fanout
- `rtc`: peer-to-peer room fanout when peers are already connected
- `ws-then-rtc`: send over WS and RTC
- `rtc-with-ws-fallback`: try RTC first, then WS if RTC is unavailable

WS is the safest default. RTC can reduce live latency, but it is not a
durability boundary. Late join, reconnect with no peer online, and pending
clearance require the durable server append log.

## Server Path

`installRallarCrdtWsTopics(...)` installs CRDT topics over the existing Rallar
server WS topic router:

- `room.crdt` for room documents
- `app.crdt` is defined so unsupported principal/custom live fanout is rejected
- `rallar.crdt.update.v1`
- `rallar.crdt.sync-request.v1`
- `rallar.crdt.sync-response.v1`
- `rallar.crdt.append-response.v1`
- `rallar.crdt.catch-up-request.v1`
- `rallar.crdt.catch-up-response.v1`

The bridge validates document refs, operation paths, payload shape, payload
size, room target `groupRef`, and document type/version policy. Room messages
also go through the existing room authorizer.

When configured with the durable mutation ingress, the bridge enqueues an
accepted update through `AppCrdtInboxService`; the committed mutation produces
the append response and permitted fanout as final outbox work. Rejected updates
are acknowledged as rejected and are not fanned out. `PSqlCrdtLogRepository`
is the bridge's read-only source for durable catch-up from snapshots plus
append-log pages rather than peer state.

## Durable Log

The durable log stores:

- `crdt_documents`
- `crdt_updates`
- `crdt_snapshots`

Append behavior:

- append sequence is monotonic per document
- `(documentKey, updateId)` is unique
- duplicate appends with the same canonical hash are idempotent
- duplicate appends with a different hash are rejected
- archived or destroyed documents reject writes
- snapshots are compact catch-up artifacts, not the source of truth
- new snapshots include a CRDT-state sidecar for safe replay equivalence
- encrypted logs require a client/key-authorized supplied compact snapshot for
  compaction
- destructive compaction must pass
  `evaluateRallarCrdtDestructiveCompactionSafety(...)` before old updates or
  tombstones are removed

Catch-up uses snapshot plus update pages by append sequence/cursor over WS and
`POST /api/crdt/catch-up`.

## Diagnostics

Use `doc.health()` to inspect:

- pending, failed pending, and dependency-blocked counts
- seen update count
- last server append sequence and ACK time
- selected transport strategy
- live sent, received, duplicate, rejected, blocked, retried, sync request, and
  sync response counters
- corrupt local artifact count when persisted snapshots or updates are
  quarantined during hydration

## Production Hardening

CRDT hardening controls now include:

- shared rollout and feature policies for local, WS, RTC, durable append, and
  durable/peer catch-up behavior
- opt-in strict path ownership validation for registers, maps, OR-sets,
  ordered sequences, counters, and numeric min/max paths
- repository admin listing, debug bundle export, backup bundle export/restore,
  integrity verification, projection rebuild hooks, non-destructive compaction,
  archive, destroy, and quarantine lifecycle
- append rejection taxonomy for validation, authorization, quota, feature,
  rate-limit, lifecycle, and storage failures
- metrics sink events for append latency and append rejections
- repository audit sink events for append, reject, export, backup, restore,
  archive, quarantine, destroy, rebuild, and compact
- local corruption quarantine during browser hydration
- ordered-list sequence operations, actor-owned undo/redo operation groups,
  numeric CRDT operations, graph CRDT authoring helpers, AR/spatial metadata
  validation helpers, retention summaries, redacted debug exports, erasure audit
  helpers, document-level encryption helpers, encryption key lifecycle helpers,
  and destructive-compaction safety evaluation

See
[Rallar CRDT Production Hardening Runbook](./rallar-crdt-production-hardening-runbook.md)
for operational guidance.

## Current Limits

Implemented now:

- JSON operation batches
- map operations
- OR-set operations
- LWW and multi-value registers
- local IndexedDB persistence through internal `rallar.data` stores
- same-origin tab sync
- room WS/RTC live sync
- principal durable-append fanout when the server bridge is configured with a
  durable log and principal session resolver
- server topic validation/authorization/fanout
- durable append log contracts and Postgres/PGlite repository
- durable WS and HTTP catch-up from snapshot plus append-log pages
- browser pending clearance from durable append responses
- feature flags and kill switches for WS/RTC/durable append paths
- app/principal WS live routing, with RTC remaining room-scoped
- ordered-list sequence insert/move/delete helpers
- counter add/increment/decrement helpers and numeric min/max operations
- graph CRDT authoring helpers for nodes, edges, and node/edge properties
- actor-owned undo/redo helpers
- admin debug/backup/integrity/rebuild/compact/archive/quarantine/destroy APIs
- Black Box CRDT Health tab for operator inspection
- backup restore preserving append sequences
- local corruption quarantine during hydration
- AES-GCM encrypted update payloads and snapshot bodies for authorized clients
  opened with an encryption keyring
- encryption keyring descriptors plus pure rotate/revoke helper functions
- deterministic FNV hashes are checksums, with SHA-256 helpers available for
  stronger deployment diagnostics

Still experimental or pending:

- rich-text CRDTs and richer sequence editing beyond ordered lists
- deployment-specific key custody, rotation automation, revocation UX, and
  access-loss recovery for encrypted CRDT documents
- destructive tombstone garbage collection and automated retention erasure
  execution; the safety evaluator exists, but repositories still default to
  non-destructive compaction
- product-facing CRDT health UI; current CRDT health UI is operator-only in
  Rallar Black Box
