# Rallar CRDT Production Hardening Runbook

This runbook documents the production controls that sit around the implemented
`rallar.crdt` surface.

## Durable Mutation Ownership

**AppInbox is mandatory for incoming database mutations**, including CRDT
WebSocket append/admin plus all HTTP/WS client/group/topology,
authentication/session/ticket, and mutating admin paths. AppInbox owns the
transaction and retry boundary. The `read` stage loads the repository decision
surface outside the write transaction. Only `compute` and `validate` are pure,
and they produce computed persistence data, not a plan. Service
`write(transaction, computed)` applies it: service write receives the
transaction and never opens or retries one.

CRDT state, receipt, result, and final `APP_OUTBOX`/`WS_OUTBOX` rows commit in
the same transaction. Final queue rows go directly through
`PSqlResourceInboxRepository`; there is no intermediate mutation outbox. Resource
inbox permits 20 total processing attempts, beginning at 1, 2, 4, 8, and 16 ms,
then rising through seconds capped at 30 seconds with jitter. A distinct
best-effort fairness lane claims retries more than 30 seconds overdue.

Queue locks are coordination-only. CRDT document-row and advisory locks are not
approved queue-claim exceptions; use conditional insert/update/delete fencing.
Authoritative persisted and shared contracts use mandatory fields by default.

## Rollout Controls

Use `RallarCrdtDocumentTypePolicy` for document-type rollout:

- `rollout: 'disabled'` rejects CRDT operations covered by the policy.
- `flags.networkSend: false` keeps local documents readable but disables live
  sends.
- `flags.ws: false` disables WS sends.
- `flags.rtc: false` disables RTC sends while WS can continue.
- `flags.durableAppend: false` disables durable appends.
- `flags.readOnly: true` rejects local/network writes while preserving read and
  catch-up use cases.

Browser documents accept policies through `rallar.crdt.open(..., { policies })`.
The server topic bridge and CRDT log repositories accept the same policy shape.

## Admin Inspection

API-v1 exposes CRDT administration as admin-only routes. Reads go through the
Postgres CRDT log repository:

- `POST /api/crdt/admin/documents/list` filters by application, workspace,
  scope, document type, and lifecycle.
- `POST /api/crdt/admin/documents/debug-export` creates a
  `rallar.crdt.debug-bundle.v1` artifact for diagnosis and black-box
  reproduction. Payloads are redacted unless the request sets
  `redactPayloads: false`.
- `POST /api/crdt/admin/documents/backup-export` creates a
  `rallar.crdt.backup-bundle.v1` artifact preserving document key, metadata,
  append sequence, updates, and snapshot.
- `POST /api/crdt/admin/documents/integrity` checks document key, update
  hashes, append hashes, and append sequence continuity.

Mutations commit through AppInbox. Each takes the request id in the path:

- `POST /api/crdt/admin/documents/rebuild-projection/requests/{requestId}`
- `POST /api/crdt/admin/documents/compact/requests/{requestId}`
- `POST /api/crdt/admin/documents/lifecycle/requests/{requestId}` changes the
  lifecycle, for example to `quarantined`, and the retention, quota, and
  projection-id settings.
- `POST /api/crdt/admin/documents/erase/requests/{requestId}`

`/api/admin/operations/crdt/*` offers the same integrity, debug-export,
compact, lifecycle, and erase operations for the admin console.

## Backup And Restore

Backup requirements:

- Export from the durable append log, not from derived snapshots alone.
- Preserve `documentKey`, document ref, trusted append metadata, and append
  sequence.
- Include the newest compact snapshot when available.
- Verify the bundle before storing and after restoring.

API-v1 has no restore route, and the Postgres CRDT log repository has no
restore operation. `restoreBackupBundle(...)` exists only in the in-memory
repository used by tests and local tools. A production restore is a manual
database operation. It must meet these requirements:

- Restore `crdt_documents`, `crdt_updates`, and `crdt_snapshots` together.
- Preserve append sequence values exactly.
- Rebuild projections after restore.
- Do not overwrite an existing document unless the operator explicitly chooses
  `overwrite: true`.

## Corruption Recovery

Browser local recovery:

- Persisted snapshots and update artifacts are validated during hydration.
- Invalid local artifacts are not replayed.
- `doc.health().corruptLocalArtifactCount` reports quarantined local artifacts.
- Recovery must not silently erase pending work; operators can export debug data
  before reset/destroy.

Server recovery:

- Treat the append log as authoritative over snapshots and projections.
- Use `verifyIntegrity(...)` before projection rebuild or backup restore.
- Quarantine documents that repeatedly fail validation or replay.

## Metrics

`RallarCrdtMetricName` declares fourteen metric names. Code records these:

- In the browser, through the `metrics` option of `rallar.crdt.open(...)`:
  `crdt.local.apply.ms`, `crdt.merge.replay.ms`, `crdt.pending.age.ms`,
  `crdt.pending.failed.count`, `crdt.dependency.blocked.count`, and
  `crdt.sync.bytes`.
- In the in-memory CRDT log repository only: `crdt.server.append.ms` and
  `crdt.server.append.rejected.count`.

The Postgres repository and the AppInbox append path record no metrics. No code
records `crdt.convergence.ms`, `crdt.catchup.page.count`,
`crdt.snapshot.bytes`, `crdt.snapshot.age.ms`, `crdt.update_log.count`, or
`crdt.rtc.fallback.count`.

Connect a browser `RallarCrdtMetricsSink` to the application's metrics backend
and alert on sustained pending growth. Watch integrity failures through the
integrity route, and snapshot age through `summarizeRallarCrdtScheduledHealth(...)`.

## Audit And Retention

Connect `RallarCrdtAuditSink` to the deployment audit store before exposing CRDT
admin routes outside local operator tooling. Repository and route events cover
append, reject, export, backup, restore, archive, quarantine, destroy, rebuild,
compact, erase, and redact workflows.

Use `summarizeRallarCrdtScheduledHealth(...)` from `@shared/crdt/mod.ts` for scheduled
retention and stale-snapshot status summaries. Treat privacy erasure as an
audited admin workflow; do not represent it as a normal CRDT delete.

Use `evaluateRallarCrdtDestructiveCompactionSafety(...)` before any repository
implementation removes old updates or tombstones. The evaluator requires a
state-preserving snapshot boundary, contiguous append records, and explicit
encrypted-log authorization. Repository compaction remains non-destructive until
that gate is wired into a deployment-specific destructive GC workflow.

## Domain Follow-Ups

Ordered-list sequence CRDTs are implemented for kanban columns, paragraph
ordering, and rich-list shells. Rich text remains a separate product plan; do
not model rich text as unordered map/register state.

Counters and numeric min/max operations are implemented for collaborative
finite-number state. Authored graph CRDT documents can use the graph helper
operations for nodes, edges, and properties; computed RTC topology graphs remain
server-owned routing state, not collaborative graph documents.

Document-level encryption supports AES-GCM encrypted update payloads and
snapshot bodies for authorized clients opened with a CRDT encryption keyring.
Server durable append and backup/restore preserve ciphertext without requiring
plaintext access, redacted diagnostics omit ciphertext, and keyring descriptor,
rotate, and revoke helpers exist for lifecycle metadata. Deployment-specific key
custody, rotation automation, revocation UX, and access-loss recovery remain
follow-up operational work.

AR/spatial CRDT documents must include coordinate frame IDs, frame versions,
anchor references, calibration versions, provenance, confidence, and accuracy.
Authoritative calibration, spatial safety constraints, and security-sensitive
permissions remain command/server-owned.
