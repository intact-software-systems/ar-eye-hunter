# Rallar CRDT Production Hardening Companion Plan

Date: 2026-06-04

Status: Implemented companion plan for CRDT production-hardening controls, with
remaining production rollout and product follow-ups called out explicitly.

Related plan:

- `plans/rallar-crdt-product-and-implementation-plan.md`

Follow-up plans:

- `plans/rallar-crdt-sequence-text-follow-up-plan.md`
- `plans/rallar-crdt-document-encryption-follow-up-plan.md`

## Purpose

This companion plan captures the advanced reliability, operations, safety, and
scale concerns that should shape Rallar CRDT before it is called production
ready for networked collaborative documents.

The main CRDT plan owns the V1 implementation path: explicit `rallar.crdt`,
Rallar-owned operation core, browser facade, message transport bridge, and
durable server append log. This companion plan owns the hardening layer around
that path and now records which controls are implemented versus still deferred
as production rollout or product follow-up work.

## Current Code And Docs Checked

Primary local references:

- `plans/rallar-crdt-product-and-implementation-plan.md`
- `iterations/rallar-crdt-iteration-plan.md`
- `playground/RALLAR_CRDT.md`
- `docs/crdt-implementation-progress.md`
- `docs/rallar-crdt-guide.md`
- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `docs/rallar-ai-skill.md`
- `packages/shared/crdt`
- `packages/shared/crdt/crdt-durable-log.ts`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared-web/browser/rallar-crdt.ts`
- `packages/shared-web/browser/rallar-crdt-local-store.ts`
- `packages/shared-web/browser/rallar-crdt-tab-sync.ts`
- `packages/shared-web/browser/rallar-crdt-transport.ts`
- `packages/shared/al-contracts/al-contract.ts`
- `packages/shared/al-contracts/al-policy.ts`
- `packages/shared/webrtc/QRtcDataChannel.ts`
- `packages/shared-server/rallar-facade/RallarServer.ts`
- `packages/shared-server/rallar-facade/ws-topic-router.ts`
- `packages/shared-server/crdt/RallarCrdtServer.ts`
- `packages/shared-server/crdt/InMemoryRallarCrdtLogRepository.ts`
- `packages/shared-server/postgres/crdt/PSqlCrdtLogRepository.ts`
- `packages/shared-server/app-data/RallarServerAppData.ts`
- `packages/shared-server/postgres/app-data/PSqlAppDataRepository.ts`
- `apps/api-v1/prisma/migrations/20260604170000_crdt_log/migration.sql`
- `apps/api-v1/src/create-rallar-server.ts`
- `apps/api-v1/src/db/in-memory-schema.sql`
- `packages/shared-graph/crdt/graph-crdt.ts`
- `packages/shared-graph/shared-graph-types.ts`
- `packages/shared-test/black-box-runner/examples/rallar-crdt-diagnostics.json`
- `packages/tests/shared/crdt-contracts.test.ts`
- `packages/tests/shared-web/rallar-crdt.test.ts`
- `packages/tests/shared-server/rallar-crdt-server-topic.test.ts`
- `packages/tests/shared-server/rallar-crdt-log-repository.test.ts`
- `packages/tests/shared-graph/graph-crdt.test.ts`

Repo facts this plan relies on:

- Browser storage and server app data are latest-value oriented.
- WS/RTC application messages already have route, target, QoS, ack, and
  diagnostic concepts through AL messages.
- Dynamic server topics can validate and authorize routed WS messages.
- `rallar.realtime` is suitable for ephemeral low-latency state, not durable
  CRDT source-of-truth updates.
- Rallar CRDT now has explicit shared contracts, a deterministic JSON
  operation engine, ordered-list sequence operations, actor-owned undo/redo
  operation groups, browser persistence, same-origin tab sync, WS/RTC room live
  transport, principal durable-append fanout, a server topic bridge, and
  dedicated durable CRDT storage through `crdt_documents`, `crdt_updates`, and
  `crdt_snapshots`.
- Production hardening controls now exist for feature policies, WS/RTC/durable
  append kill switches, quotas/rate limits, admin inspection, corruption
  quarantine, metrics sink events, audit sink events, backup/restore bundles,
  integrity verification, projection rebuild hooks, non-destructive compaction,
  redacted debug export, erasure workflow helpers, Black Box health/admin UI,
  and operational runbooks.
- Remaining production rollout work is deployment-specific wiring and policy:
  metrics backend integration, audit-store retention/review flows, scheduled
  jobs, automated retention/redaction enforcement, rich-text CRDTs, destructive
  tombstone garbage collection, and encrypted-document key custody/rotation
  automation.

## Current Implemented State And Limits

Implemented CRDT state in the repo:

- `rallar.crdt` is explicit and opt-in; `rallar.data.open(...)` remains a
  latest-value browser store.
- Browser documents support `open`, `read`, `subscribe`, `applyLocal`,
  `snapshot`, `flush`, `sync`, `close`, `destroy`, `health`, pending updates,
  failed pending updates, and dependency-blocked updates.
- Shared CRDT operations cover JSON map operations, OR-set operations, LWW
  registers, multi-value registers, and ordered-list sequence insert, delete,
  and move operations.
- Browser documents expose ordered-list helpers plus actor-owned undo/redo
  helpers for operation groups.
- Local CRDT artifacts are stored through internal `rallar.data` stores with
  `sync: false`.
- Same-origin CRDT tab sync uses a CRDT-specific `BroadcastChannel` keyed by the
  document key.
- Room-scoped documents support user-selected `local-only`, `ws`, `rtc`,
  `ws-then-rtc`, and `rtc-with-ws-fallback` strategies.
- The server bridge installs CRDT WS topics, validates envelopes and operation
  paths, authorizes room messages, appends before durable fanout when a log
  repository is configured, and sends append responses.
- Principal-scoped documents can use durable-append-backed fanout when the
  server bridge is configured with a durable log and a principal session
  resolver. Peer RTC catch-up is not principal durability.
- Dedicated CRDT durable-log contracts, in-memory repository, Postgres
  repository, Prisma migration, and API-v1 in-memory schema updates exist.
- Product docs, API reference entries, troubleshooting guidance, a black-box
  diagnostic recipe, and graph CRDT spike tests exist.

Current implemented hardening state in the repo:

- Shared hardening contracts live in `packages/shared/crdt/crdt-hardening.ts`
  and are exported through `packages/shared/crdt/mod.ts`.
- Browser documents accept `policies` and `metrics` through
  `rallar.crdt.open(...)`; policies gate local apply, network send, WS, RTC,
  durable append, and peer catch-up decisions.
- Browser hydration detects corrupt local snapshots and update artifacts,
  excludes invalid artifacts from replay, and reports
  `corruptLocalArtifactCount` through `health()`.
- The CRDT WS topic bridge applies the same policy decisions before accepting
  update and sync envelopes.
- The in-memory and Postgres CRDT log repositories enforce durable append
  policy, lifecycle, max update count, update byte limits, and per-actor update
  rate limits.
- The CRDT log repositories expose admin operations for document listing, debug
  bundle export, backup bundle export/restore, integrity verification,
  projection rebuild hooks, non-destructive snapshot compaction, and lifecycle
  updates including archive, quarantine, and destroy.
- API-v1 exposes CRDT admin routes for listing, integrity, redacted debug
  export, backup export, projection rebuild, compaction, lifecycle, and erasure
  workflows.
- Rallar Black Box exposes an operator CRDT Health tab for document inspection
  and admin actions.
- Shared hardening exports audit sinks/events, retention/stale-snapshot summary
  helpers, redacted debug bundles, erasure audit helpers, and encryption
  validation/helpers.
- Shared tests, browser tests, server tests, PGlite tests, graph CRDT tests,
  black-box recipe-matrix tests, and docs cover the implemented hardening
  controls.

Current limitations that remain after the implemented hardening work:

- Principal live fanout requires durable append acceptance and an explicit
  principal session resolver. It is not peer based and does not use RTC for
  durability.
- Ordered-list sequence CRDTs are implemented. Rich text, cursor-preserving text
  editing, and document-wide collaborative undo remain follow-up product work.
- Actor-owned undo/redo operation groups are implemented for "undo my change".
  Document-wide collaborative undo is out of scope for V1.
- Document-level encryption supports AES-GCM encrypted update payloads and
  snapshot bodies, authorized client decrypt before merge, durable
  backup/restore of ciphertext, and redacted diagnostics that omit ciphertext.
  Key custody, rotation automation, revocation UX, and access-loss recovery
  remain deployment/product follow-up work.
- Non-destructive snapshot compaction and redacted exports exist. Destructive
  tombstone garbage collection and automated retention erasure remain
  deployment/product follow-ups.
- Erasure is represented as an audited admin workflow, not as normal CRDT
  delete. Deployment-specific audit storage and retention-review automation
  still need to be connected.
- The CRDT health UI is operator tooling in Rallar Black Box, not an end-user
  product surface.
- Graph CRDT support is a spike for authored graph state and deterministic
  graphology derivation, not a productized graph collaboration surface.
- Repository-level admin APIs are implemented, but operator-facing UI,
  deployment-specific admin routes, audit review flows, and scheduled
  production jobs are not productized.
- Feature policies, kill switches, rate limits, quotas, metrics events,
  backup/restore bundles, integrity checks, and corruption quarantine are
  implemented library/server controls. Production metrics backend wiring, SLO
  dashboards, alerting, retention jobs, and automated quarantine policies remain
  deployment work.
- App/custom-scope CRDT live support is limited; room scope is the primary live
  collaboration path.
- Raw binary/blob payloads remain out of CRDT update scope and should be stored
  externally as references.

## Consistency Guarantees

Rallar CRDT docs must state the exact guarantees per phase.

V1 local-only guarantees:

- local read-your-writes after `applyLocal(...)` resolves
- deterministic merge for accepted operation sets
- eventual same-origin convergence when all tab messages are delivered or
  replayed from local persistence

Topic-bridge guarantees:

- user-selected live propagation over WS, RTC, or a combined/fallback strategy
  for room-scoped documents
- best-effort or at-least-once transport according to the selected Rallar
  message lane and strategy
- no global total order before durable server append
- duplicate delivery is tolerated through update ID dedupe
- RTC delivery only accelerates live peers and is not a durability boundary

Durable server/log guarantees already present in V1:

- monotonic append sequence per document
- idempotent duplicate append handling
- server-authoritative append metadata
- append responses that allow browser pending updates to clear after accepted or
  duplicate durable append

Durable serving guarantees this hardening plan must preserve and productize:

- late join and reconnect through snapshot plus update-page catch-up
- eventual convergence for authorized replicas that can reach the durable log
  and catch-up path

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
- experimental document types such as graph or rich text

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
- non-destructive compaction/redaction job duration
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
- audit events for append, reject, export, backup, restore, archive, quarantine,
  destroy, rebuild, compact, erase, and redact
- optional encrypted-document key rotation/revocation automation later
- secure debug exports with explicit operator authorization

CRDT delete must be documented as a document edit, not an erasure guarantee.

## Operational Roadmap

Implementation status: Phases A-E are implemented in the current branch for
library/server controls and documented in
`docs/crdt-implementation-progress.md`. The phase structure remains here as the
reviewable plan and acceptance record.

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
- Add admin list/inspect/archive/quarantine/destroy/compact/erase APIs.
- Add metrics for append, sync, replay, pending, dependency, and rejection
  behavior.
- Add audit events for append, reject, export, backup, restore, archive,
  quarantine, destroy, rebuild, compact, erase, and redact workflows.
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
- Add non-destructive snapshot compaction and retention/stale-snapshot summary
  helpers.

Acceptance:

- Restored append logs produce the same document snapshots.
- Large update logs can be paged and verified without unbounded request
  payloads.

### Phase E: Domain-Specific Hardening

Goal: cover specialized document families.

Work:

- Add AR/spatial metadata conventions if AR annotations become a CRDT use case.
- Add ordered-list sequence CRDTs for rich-list shells, kanban columns, and
  paragraph ordering.
- Add actor-owned undo/redo operation-group helpers.
- Add document-level encryption for encrypted update payloads, encrypted
  snapshot bodies, keyring-based client decrypt, backup/restore, and redacted
  diagnostics if sensitive collaborative documents become in scope.

Acceptance:

- Domain-specific documents do not smuggle derived or authoritative state into
  CRDT source-of-truth data.
- Rich text and encrypted-document key operations remain explicit follow-up
  plans, not hidden behavior in the JSON CRDT engine.

## Test Plan

Implemented and retained tests cover:

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
- Production-ready collaboration requires the durable append log, catch-up
  serving path, and the hardening controls in this plan.
- Hardening work has been implemented incrementally, but broad production
  rollout still requires deployment wiring for metrics, audit, admin access,
  retention, scheduled integrity checks, and operator workflows.
- Encrypted-document key operations, rich-text CRDTs, and AR/spatial product
  schemas are conditional follow-up plans unless product scope makes them
  necessary.
