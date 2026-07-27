# Rallar CRDT Production Hardening Runbook

This runbook documents the production controls that sit around the implemented
`rallar.crdt` surface.

## Durable Mutation Ownership

**AppInbox is mandatory for incoming database mutations**, including CRDT
WebSocket append/admin plus all HTTP/WS client/group/topology,
authentication/session/ticket, and mutating admin paths. AppInbox owns the
transaction and retry boundary. The pure read/compute/validate stages produce
computed persistence data, not a plan; service `write(transaction, computed)`
applies it: service write receives the transaction and never opens or retries
one.

CRDT state, receipt, result, and final `APP_OUTBOX`/`WS_OUTBOX` rows commit in
the same transaction. Final queue rows go directly through
`ResourceInboxRepository`; there is no intermediate mutation outbox. Resource
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

CRDT log repositories expose admin operations:

- `listDocuments(...)` filters by application, workspace, scope, document type,
  and lifecycle.
- `exportDebugBundle(...)` creates a `rallar.crdt.debug-bundle.v1` artifact for
  diagnosis and black-box reproduction.
- `exportBackupBundle(...)` creates a `rallar.crdt.backup-bundle.v1` artifact
  preserving document key, metadata, append sequence, updates, and snapshot.
- `verifyIntegrity(...)` checks document key, update hashes, append hashes, and
  append sequence continuity.
- `rebuildProjection(...)` verifies the append log before marking a projection
  rebuild.
- `updateDocumentLifecycle(..., { lifecycle: 'quarantined' })` quarantines a
  malformed or unsafe document.

## Backup And Restore

Backup requirements:

- Export from the durable append log, not from derived snapshots alone.
- Preserve `documentKey`, document ref, trusted append metadata, and append
  sequence.
- Include the newest compact snapshot when available.
- Verify the bundle before storing and after restoring.

Restore requirements:

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

The shared metrics sink records:

- append latency
- append rejection count by code
- pending age/count
- dependency-blocked count
- replay duration
- sync/catch-up payload sizes
- snapshot age/size
- update-log growth
- RTC fallback count

Production deployments should connect `RallarCrdtMetricsSink` to their metrics
backend and alert on sustained pending growth, rejection spikes, integrity
failures, and stale snapshots.

## Audit And Retention

Connect `RallarCrdtAuditSink` to the deployment audit store before exposing CRDT
admin routes outside local operator tooling. Repository and route events cover
append, reject, export, backup, restore, archive, quarantine, destroy, rebuild,
compact, erase, and redact workflows.

Use `summarizeRallarCrdtScheduledHealth(...)` from `@shared/crdt` for scheduled
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
