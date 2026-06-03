# Rallar CRDT Production Hardening Companion Plan

Date: 2026-06-03

Status: Companion planning document for advanced and production-hardening CRDT
work after the V1 product and implementation plan.

Related plan:

- `plans/rallar-crdt-product-and-implementation-plan.md`

## Purpose

This companion plan captures the advanced reliability, operations, safety, and
scale concerns that should shape Rallar CRDT before it is called production
ready for networked collaborative documents.

The main CRDT plan owns the V1 implementation path: explicit `rallar.crdt`,
Rallar-owned operation core, browser facade, message transport bridge, and
durable server append log. This companion plan owns the hardening layer around
that path.

## Current Code And Docs Checked

Primary local references:

- `plans/rallar-crdt-product-and-implementation-plan.md`
- `iterations/rallar-crdt-iteration-plan.md`
- `playground/RALLAR_CRDT.md`
- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `docs/rallar-ai-skill.md`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared/al-contracts/al-contract.ts`
- `packages/shared/al-contracts/al-policy.ts`
- `packages/shared/webrtc/QRtcDataChannel.ts`
- `packages/shared-server/rallar-facade/RallarServer.ts`
- `packages/shared-server/rallar-facade/ws-topic-router.ts`
- `packages/shared-server/app-data/RallarServerAppData.ts`
- `packages/shared-server/postgres/app-data/PSqlAppDataRepository.ts`
- `apps/api-v1/src/db/in-memory-schema.sql`
- `packages/shared-graph/shared-graph-types.ts`

Repo facts this plan relies on:

- Browser storage and server app data are latest-value oriented.
- WS/RTC application messages already have route, target, QoS, ack, and
  diagnostic concepts through AL messages.
- Dynamic server topics can validate and authorize routed WS messages.
- `rallar.realtime` is suitable for ephemeral low-latency state, not durable
  CRDT source-of-truth updates.
- Production durable CRDT sync requires storage beyond `app_data_store`.

## Consistency Guarantees

Rallar CRDT docs must state the exact guarantees per phase.

V1 local-only guarantees:

- local read-your-writes after `applyLocal(...)` resolves
- deterministic merge for accepted operation sets
- eventual same-origin convergence when all tab messages are delivered or
  replayed from local persistence

Topic-bridge guarantees:

- best-effort or at-least-once transport according to the selected Rallar
  message lane
- no global total order before durable server append
- duplicate delivery is tolerated through update ID dedupe
- RTC delivery only accelerates live peers and is not a durability boundary

Durable server guarantees:

- monotonic append sequence per document
- idempotent duplicate append handling
- server-authoritative append metadata
- late join and reconnect through snapshot plus update-page catch-up
- eventual convergence for authorized replicas that can reach the durable log

Non-guarantees:

- CRDT delete is not privacy erasure.
- Client-supplied actor/session/principal metadata is not trusted authority.
- Peer catch-up is not production durability.
- Rallar CRDT does not serialize authoritative business commands.

## Error And Retry Taxonomy

Define typed error/retry categories shared by browser and server:

- `retryable.transport`: transient WS/RTC/network failure.
- `retryable.server`: temporary server or storage failure.
- `permanent.authorization`: actor no longer has read/write access.
- `permanent.schema`: unsupported protocol, schema, or operation version.
- `permanent.validation`: invalid document ref, illegal path, malformed payload,
  raw blob payload, or unsupported operation.
- `permanent.quota`: document, update, rate, or pending-queue limit exceeded.
- `blocked.dependency`: update references unseen parents, observed add IDs, or
  update IDs.
- `corrupt.local-state`: snapshot hash mismatch, local IndexedDB artifact cannot
  be decoded, or replay fails from persisted state.
- `corrupt.server-state`: append log, snapshot, or materialized projection fails
  integrity checks.

Browser behavior:

- Retry retryable failures with bounded backoff.
- Keep dependency-blocked updates visible in document health and trigger sync
  repair.
- Move permanent failures to failed pending state.
- Quarantine corrupt local state before destructive recovery.

Server behavior:

- Reject permanent failures with stable reason codes.
- Never accept an update that fails validation or authorization.
- Quarantine documents only through explicit admin policy.

## Rollout, Feature Flags, And Kill Switches

CRDT should be gateable by:

- application ID
- workspace ID
- document type
- scope kind
- server topic bridge
- durable append log
- RTC acceleration
- peer catch-up
- experimental document types such as graph or sequence/text

Required controls:

- disable network send while leaving local documents readable
- disable RTC acceleration while keeping WS sync
- disable durable append for a document type before public rollout
- reject new appends while allowing read-only catch-up
- force archived/read-only mode for a document type or document ID

Rollout labels:

- `experimental-local`: local-only facade and tests.
- `experimental-live`: WS/RTC bridge without durable production catch-up.
- `durable-beta`: server append log and catch-up enabled for selected document
  types.
- `production`: durable log, diagnostics, recovery, quotas, and operational
  runbooks are in place.

## Admin And Inspection Tooling

Add admin/debug capabilities for CRDT operators:

- list documents by app, workspace, scope, document type, lifecycle state, and
  update-log size
- inspect document health, append lag, snapshot age, last append sequence, and
  rejected update counts
- export snapshot plus update pages for black-box reproduction
- rebuild materialized snapshots/projections from append log
- archive a document
- mark a document read-only
- quarantine malformed documents
- view failed append/rejection reasons without exposing sensitive payloads by
  default

These tools can start as server APIs and black-box diagnostics before becoming
UI features.

## Corruption Recovery

Browser local recovery:

- Verify snapshot and update hashes during import/replay.
- If local snapshot is corrupt, fall back to the last valid snapshot or durable
  server catch-up.
- If local pending updates are corrupt, isolate them in failed pending state and
  expose export/debug data.
- Never silently clear corrupt local state unless the caller explicitly chooses
  reset/destroy.

Server recovery:

- Treat append log as authoritative over snapshots and projections.
- Rebuild snapshots/projections from append log.
- Verify append sequence continuity per document.
- Detect duplicate update IDs with mismatched payload hashes.
- Support restoring append logs and snapshots into a new environment without
  changing document IDs unless explicitly forking/importing.

## Disaster Recovery And Backup

Production deployments need a backup/restore story for:

- `crdt_documents`
- `crdt_updates`
- `crdt_snapshots`
- materialized projections or indexes
- document lifecycle metadata

Restore requirements:

- preserve document keys and append sequences
- preserve trusted server append metadata
- allow projections to be rebuilt after restore
- support environment migration where app/workspace IDs remain stable
- document how to intentionally fork/import into new document IDs

## Tenant And Namespace Isolation

Document keys must be canonical and collision-resistant across:

- application ID
- workspace ID
- scope kind
- room ref
- principal ID
- custom scope
- document type
- document ID

Rules:

- Do not use raw `groupId` alone when a `GroupRef` is available.
- Include workspace/application context where available.
- Validate that document refs match the authenticated message context.
- Do not allow custom scope strings to collide with room/principal/app keys.
- Keep derived storage keys URL/IndexedDB safe through explicit encoding.

## Metrics And SLOs

Track metrics for:

- local apply latency
- merge/replay duration
- convergence latency across tabs/browsers
- pending update age
- failed pending update count
- dependency-blocked update count
- server append latency
- append rejection rate by reason
- sync request/response size
- catch-up page count
- snapshot size and age
- update-log growth
- compaction/redaction job duration once implemented
- RTC acceleration success/fallback rate

Initial production SLO candidates:

- p95 local apply stays below a UI-safe threshold for V1 document sizes.
- p95 server append latency stays below the configured collaboration target.
- no document has unbounded pending queue growth.
- snapshot rebuild from append log succeeds in CI and scheduled production
  checks.

## Abuse, Spam, And Quarantine

Malicious or broken clients can generate infinite valid updates. Add:

- per-actor update-rate limits
- per-document update-rate limits
- max pending updates per replica
- max update bytes and max batch bytes
- max document bytes
- max dependency-blocked update count
- automatic rejection for raw blob payloads
- document quarantine when append/replay failures exceed policy
- operator-visible rejection and throttle reason codes

Throttle and quota decisions are server-authoritative. Browser hints can improve
UX but cannot be trusted.

## AR And Spatial Data Conventions

If Rallar CRDT supports AR annotations or spatial collaboration, document
schemas should model:

- coordinate frame IDs
- coordinate frame version
- anchor references
- calibration version
- sensor/source metadata
- transform provenance
- confidence/accuracy fields
- behavior when anchors are deleted, moved, or recalibrated

Spatial transforms and calibration results should be treated carefully:

- user-authored annotations can be CRDT-owned
- authoritative calibration, safety constraints, and security-sensitive spatial
  permissions remain command/server-owned
- derived spatial projections are rebuildable views, not CRDT source of truth

## Security And Privacy Hardening

Hardening work should cover:

- payload redaction in logs and diagnostics
- document type declarations for sensitive fields
- retention policies for append logs and snapshots
- audit events for append, reject, archive, destroy, and export
- optional document-level encryption later
- secure debug exports with explicit operator authorization

CRDT delete must be documented as a document edit, not an erasure guarantee.

## Operational Roadmap

### Phase A: Hardening Contracts

Goal: make operational states typed before production rollout.

Work:

- Add consistency guarantee docs.
- Add error/retry reason codes.
- Add document health and admin status types.
- Add canonical namespace/key tests.
- Add feature flag and rollout-state types.

Acceptance:

- Browser and server can report the same rejection/retry categories.
- Docs define guarantees and non-guarantees per rollout label.

### Phase B: Diagnostics And Recovery

Goal: make failures observable and recoverable.

Work:

- Add debug export/import bundle format.
- Add snapshot/update hash verification.
- Add local corruption recovery paths.
- Add server projection rebuild path.
- Add black-box recipes for corrupt snapshot and replay repair.

Acceptance:

- A corrupt local snapshot does not silently lose pending work.
- Server snapshots/projections can be rebuilt from append log in tests.

### Phase C: Rollout And Operations

Goal: support controlled production rollout.

Work:

- Add feature flags and kill switches.
- Add admin list/inspect/archive/quarantine APIs.
- Add metrics for append, sync, replay, pending, dependency, and rejection
  behavior.
- Add rate limit and quota enforcement.

Acceptance:

- CRDT can be disabled per document type without deleting data.
- Operators can identify unhealthy documents and failed append patterns.

### Phase D: Scale And Disaster Recovery

Goal: harden large and long-lived deployments.

Work:

- Add backup/restore runbook.
- Add restore tests preserving document IDs and append sequence.
- Add catch-up pagination/digest tests for large logs.
- Add scheduled projection rebuild/integrity checks.

Acceptance:

- Restored append logs produce the same document snapshots.
- Large update logs can be paged and verified without unbounded request
  payloads.

### Phase E: Domain-Specific Hardening

Goal: cover specialized document families.

Work:

- Add AR/spatial metadata conventions if AR annotations become a CRDT use case.
- Add sequence/text CRDT plan if ordered text or rich lists become a product
  requirement.
- Add document-level encryption plan if sensitive collaborative documents become
  in scope.

Acceptance:

- Domain-specific documents do not smuggle derived or authoritative state into
  CRDT source-of-truth data.

## Test Plan

Add tests for:

- consistency guarantee examples for local-only, topic bridge, and durable log
- retryable vs permanent failure handling
- dependency-blocked updates triggering repair
- feature flag disabling RTC while WS continues
- feature flag forcing read-only/archive behavior
- local corrupt snapshot recovery
- duplicate update ID with mismatched payload hash rejection
- canonical document key isolation across app/workspace/room/principal/custom
  scopes
- append log backup/restore preserving append sequence
- projection rebuild from append log
- rate limit, quota, and quarantine behavior
- metrics emitted for append, sync, replay, rejection, and pending queue age
- AR/spatial coordinate-frame validation if spatial CRDT documents are added

## Assumptions

- The main CRDT plan remains the source of truth for V1 implementation order.
- Production-ready collaboration requires the durable append log and catch-up.
- Hardening work should be incremental, but feature flags, typed errors,
  metrics, and corruption recovery are required before broad production rollout.
- Encryption, sequence/text CRDTs, and AR/spatial CRDT schemas are conditional
  follow-up plans unless product scope makes them necessary.
