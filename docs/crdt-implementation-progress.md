# Rallar CRDT Implementation Progress

Date: 2026-06-04

## Goal

Implement the CRDT plan from
`plans/rallar-crdt-product-and-implementation-plan.md` in vertical slices:

1. Shared CRDT contracts and validators.
2. Deterministic local CRDT engine.
3. Browser local store adapter using `rallar.data` with `sync: false`.
4. Local-only `rallar.crdt` facade.
5. Same-origin tab sync.
6. Live WS/RTC transport and peer catch-up contracts.
7. Server topic bridge, durable append log contracts, and durable storage.
8. Product docs, diagnostics coverage, and graph CRDT spike.

Then implement the production-hardening companion plan from
`plans/rallar-crdt-production-hardening-companion-plan.md` in vertical slices:

1. Hardening contracts for consistency guarantees, retry/rejection taxonomy,
   admin status, feature flags, rollout state, and namespace isolation.
2. Diagnostics and recovery for debug bundles, hash/integrity verification,
   local corruption handling, and projection rebuild.
3. Rollout and operations controls for feature flags, admin inspection,
   archive/quarantine, metrics, rate limits, and quotas.
4. Scale and disaster recovery for backup/restore bundles, append-sequence
   preservation, large-log pagination/digests, and integrity checks.
5. Domain-specific hardening for AR/spatial metadata conventions, ordered-list
   sequence CRDTs, actor-owned undo/redo metadata, and document-level
   encryption.
6. Remaining-limitations implementation for Black Box health/admin routes,
   principal durable-append fanout, audit events, retention summaries,
   non-destructive compaction, redacted exports, and erasure workflows.
7. Core correctness catch-up for CRDT-state snapshots, opt-in strict path
   ownership, encrypted compaction boundaries, durable WS/HTTP catch-up,
   compact causal frontiers, validation guardrails, and admin authorization.

## Audit Checklist

- [x] Read relevant root Rallar docs in `docs/*.md`, including API reference,
      quickstart, AI implementation guidance, product evaluation, environment,
      troubleshooting, and existing implementation-progress notes.
- [x] Inspected root package scripts and confirmed package tests use Vitest,
      while shared package type checks use `tsc -p`.
- [x] Inspected current Rallar browser facade, Rallar Data facade, server topic
      router, and current test layout.
- [x] Confirmed the CRDT plan preserves current `rallar.data` latest-value
      semantics and keeps authoritative CRDT updates off `rallar.realtime`.
- [x] Confirmed current WS/RTC app-message surfaces support room live sync and
      added principal live fanout only for durable-append-backed server
      sessions.
- [x] Inspected API-v1 server creation, Postgres/PGlite schema bootstrap, shared
      graph repositories, and black-box recipe matrix before adding durable
      server, docs, recipe, and graph slices.

## Milestones

### 0. Baseline Protection

- [x] Keep `rallar.data` as a latest-value browser store.
- [x] Keep CRDT behavior explicit on `rallar.crdt`.
- [x] Preserve existing Rallar Data open option validation,
      `set`/`delete`/`clear`, tab sync, and compare-and-set behavior.
- [x] Verify existing Rallar Data tests.

### 1. Shared CRDT Contracts And Validators

- [x] Add `packages/shared/crdt` contract modules.
- [x] Define document refs, update envelopes, snapshot envelopes, operation
      batches, conflict result types, health/status types, and sync result
      types.
- [x] Add document key helpers.
- [x] Add canonical hash helpers.
- [x] Add codec/validator helpers.
- [x] Export CRDT contracts from `packages/shared/mod.ts`.
- [x] Add shared CRDT contract tests.
- [x] Verify relevant shared typecheck/tests.

### 2. Deterministic Local CRDT Engine

- [x] Add Lamport clock helpers.
- [x] Implement update dedupe by `updateId`.
- [x] Implement OR-set, map, LWW register, and multi-value register behavior.
- [x] Implement atomic operation batches.
- [x] Implement missing dependency detection and repair status.
- [x] Implement snapshot import/export.
- [x] Add deterministic convergence and dependency/order tests.
- [x] Verify relevant shared typecheck/tests.

### 3. Browser Local Store Adapter

- [x] Add local CRDT artifact stores for snapshots, pending updates, failed
      pending updates, dependency-blocked updates, seen updates, and metadata.
- [x] Ensure all internal CRDT artifact stores open through `rallar.data` with
      `sync: false`.
- [x] Persist pending updates and seen update IDs through close/reopen.
- [x] Add `flush`, `clearDocument`, and `destroyDocument` behavior.
- [x] Add browser local-store tests.
- [x] Verify relevant shared-web typecheck/tests.

### 4. Local-Only Browser Facade

- [x] Add `createRallarCrdtFacade(...)`.
- [x] Expose `rallar.crdt` from `RallarFacade`.
- [x] Support `open`, `read`, `subscribe`, `applyLocal`, `snapshot`, `flush`,
      `sync`, `close`, `destroy`, and `health`.
- [x] Add local-only facade tests.
- [x] Verify relevant shared-web typecheck/tests.

### 5. Same-Origin Tab Sync

- [x] Add CRDT-specific `BroadcastChannel` sync using
      `rallar-crdt:<document-key>`.
- [x] Broadcast update envelopes, not snapshots or latest values.
- [x] Verify two same-origin facades converge after independent edits.
- [x] Verify internal Rallar Data artifact stores do not use the normal data
      BroadcastChannel path.
- [x] Add same-origin tab-sync tests.
- [x] Verify relevant shared-web typecheck/tests.

## Verified

- [x] `npx tsc -p packages/shared/tsconfig.json --noEmit`
- [x] `npx tsc -p packages/shared-web/tsconfig.json --noEmit`
- [x] `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
- [x] `npx tsc -p packages/shared-graph/tsconfig.json --noEmit`
- [x] `npx vitest run packages/tests/shared-web/rallar-data.test.ts`
- [x] `npx vitest run packages/tests/shared/crdt-contracts.test.ts packages/tests/shared-web/rallar-crdt.test.ts`
- [x] `npx vitest run packages/tests/shared/crdt-hardening.test.ts`
- [x] `npx vitest run packages/tests/shared/crdt-hardening.test.ts packages/tests/shared-server/rallar-crdt-log-repository.test.ts`
- [x] `npx vitest run packages/tests/shared-web/rallar-crdt.test.ts`
- [x] `npx vitest run packages/tests/shared-server/rallar-crdt-server-topic.test.ts`
- [x] `npx vitest run packages/tests/shared-server/rallar-crdt-log-repository.test.ts`
- [x] `npx vitest run packages/tests/shared-test/recipe-matrix.test.ts`
- [x] `npx vitest run packages/tests/shared/crdt-contracts.test.ts packages/tests/shared/crdt-hardening.test.ts packages/tests/shared-web/rallar-data.test.ts packages/tests/shared-web/rallar-crdt.test.ts packages/tests/shared-server/rallar-crdt-server-topic.test.ts packages/tests/shared-server/rallar-crdt-log-repository.test.ts packages/tests/shared-graph/graph-crdt.test.ts packages/tests/shared-test/recipe-matrix.test.ts`
- [x] `npx prettier --single-quote --tab-width 4 --trailing-comma all --check packages/shared/crdt packages/shared-web/browser/rallar-crdt.ts packages/shared-web/browser/rallar-crdt-local-store.ts packages/shared-web/browser/rallar-crdt-tab-sync.ts packages/shared-web/browser/rallar-crdt-transport.ts packages/shared-server/crdt packages/shared-server/postgres/crdt packages/shared-graph/crdt packages/tests/shared/crdt-contracts.test.ts packages/tests/shared/crdt-hardening.test.ts packages/tests/shared-web/rallar-crdt.test.ts packages/tests/shared-server/rallar-crdt-server-topic.test.ts packages/tests/shared-server/rallar-crdt-log-repository.test.ts packages/tests/shared-graph/graph-crdt.test.ts docs/crdt-implementation-progress.md docs/rallar-crdt-guide.md docs/rallar-crdt-production-hardening-runbook.md docs/rallar-api-reference.md docs/rallar-troubleshooting-checklist.md plans/rallar-crdt-production-hardening-companion-plan.md plans/rallar-crdt-sequence-text-follow-up-plan.md plans/rallar-crdt-document-encryption-follow-up-plan.md packages/shared-test/black-box-runner/examples/rallar-crdt-diagnostics.json packages/shared-test/black-box-runner/examples/rallar-crdt-corruption-recovery.json`
- [x] `npx prettier --tab-width 2 --check packages/shared-test/black-box-runner/recipe-matrix.json`
- [x] `deno test --allow-env --allow-read apps/api-v1/test/db/pglite-sql-adapter.test.ts`
- [x] `deno test --allow-env --allow-read apps/api-v1/test/db/in-memory-schema-bootstrap.test.ts`
- [x] `deno check --config apps/api-v1/deno.json apps/api-v1/src/main.ts`
- [x] `git diff --check`
- [x] `npm run build`

## Verification Notes

- `npx tsc -p packages/tests/tsconfig.json --noEmit` was not a usable CRDT gate
  in the current repo state. It fails before CRDT-specific assertions on
  existing cross-app/test setup issues such as missing `Deno`/`process` globals,
  unresolved `@shared-test/*` app aliases, and pre-existing WebRTC/test fixture
  type mismatches.

## Remaining Limitations

- Room-scoped browser CRDT documents now support local persistence, same-origin
  tab sync, WS/RTC live propagation, peer catch-up for development/tests,
  server topic validation/authorization, durable append ACKs, and Postgres/PGlite
  append-log storage.
- Principal live fanout is supported only after durable append acceptance, with
  the append log remaining the source of truth. Peer RTC catch-up is still not
  principal durability.
- Ordered-list sequence CRDT operations and actor-owned undo/redo operation
  groups are implemented. Rich text and document-wide collaborative undo remain
  follow-up product work.
- Counter CRDT operations, numeric min/max merge operations, strict numeric path
  ownership, browser numeric helpers, and numeric CRDT snapshot state are
  implemented.
- Graph CRDT authoring helpers now emit ordinary Rallar CRDT map/register
  operations for nodes, edges, and properties; computed RTC topology graphs
  remain separate from authored graph documents.
- The Black Box CRDT Health tab and API-v1 admin routes now cover listing,
  integrity, redacted debug export, backup export, projection rebuild,
  compaction, archive, quarantine, and destroy/erasure workflows.
- Document-level encryption now supports AES-GCM encrypted update payloads and
  snapshot bodies, keyring-based client decrypt, encrypted durable
  backup/restore, redacted diagnostics that omit ciphertext, and pure keyring
  descriptor/rotate/revoke helpers. Key rotation automation, revocation UX, and
  deployment key custody remain explicit follow-up work.
- Destructive tombstone garbage collection and automated privacy erasure are
  not folded into normal CRDT delete; erasure is an audited admin workflow.
  Destructive compaction now has an explicit safety evaluator, while repository
  execution remains non-destructive by default.
- Production hardening now adds shared feature policies, metrics, admin
  repository APIs, local corruption quarantine, backup/restore bundles,
  integrity checks, projection rebuild hooks, rate limits, quarantine lifecycle,
  black-box corruption recovery diagnostics, AR/spatial metadata validation, and
  an operations runbook.

## Implementation Milestones 6-12

These milestones track the broader "implement remaining" goal from
`plans/rallar-crdt-product-and-implementation-plan.md`.

### 6. Live Transport Over Rallar Messages

- [x] Add browser CRDT transport adapter over `rallar.messages.ws` and
      `rallar.messages.rtc`.
- [x] Send room-scoped update envelopes on `room.crdt` with CRDT type IDs.
- [x] Subscribe to WS/RTC CRDT updates and apply/dedupe remote envelopes.
- [x] Implement `ws`, `rtc`, `ws-then-rtc`, and `rtc-with-ws-fallback`
      ordering/fallback behavior.
- [x] Keep local pending updates pending until a durable append phase exists.
- [x] Add mocked WS/RTC convergence and fallback tests.
- [x] Verify relevant shared-web typecheck/tests.

### 7. Sync And Catch-Up Contract

- [x] Add sync request/response envelope contracts and validators.
- [x] Request missing updates after open/reconnect for non-local transports.
- [x] Add durable WS catch-up request/response handling backed by snapshots and
      append-log pages.
- [x] Add authenticated HTTP `POST /api/crdt/catch-up` for snapshot plus page
      catch-up.
- [x] Add development/test peer catch-up using live peers.
- [x] Mark peer catch-up as non-production durability in docs/progress.
- [x] Add missed-live-update catch-up tests.
- [x] Verify relevant shared/shared-web typecheck/tests.

### 8. Server Topic Bridge

- [x] Add shared-server CRDT topic helper over `RallarServer.ws.defineTopic`.
- [x] Validate envelopes, operation paths, document refs, and payload size.
- [x] Authorize room-scoped live updates.
- [x] Reject principal live fanout unless durable append and principal session
      resolution are configured.
- [x] Fan out accepted principal updates to resolved active sessions only after
      durable append acceptance.
- [x] Fan out accepted updates without durable CRDT tables.
- [x] Add server bridge tests.
- [x] Verify relevant shared-server typecheck/tests.

### 9. Server Durable Log Contract

- [x] Add durable CRDT log repository interfaces.
- [x] Add append and catch-up contracts.
- [x] Define append sequence and idempotency rules.
- [x] Define lifecycle, retention, redaction, quota, authorization, and
      projection hooks.
- [x] Add contract tests.
- [x] Verify relevant shared/shared-server typecheck/tests.

### 10. Server Durable Log Implementation

- [x] Add Postgres-backed CRDT tables.
- [x] Add Prisma migration and in-memory schema updates.
- [x] Add PGlite/in-memory tests.
- [x] Append updates idempotently and store compact snapshots.
- [x] Serve snapshot plus update pages by append cursor.
- [x] Clear pending updates only after durable append acceptance.
- [x] Add archived/destroyed lifecycle behavior.
- [x] Enforce `maxDocumentBytes` in in-memory and Postgres CRDT repositories.
- [x] Verify relevant server/database tests.

### 10.5 Core Correctness And Production Catch-Up

- [x] Add CRDT-state-preserving snapshot metadata for registers, maps, OR-sets,
      and ordered sequences.
- [x] Keep legacy materialized snapshots importable while new snapshots carry
      replay-equivalent sidecar state.
- [x] Add opt-in strict path ownership validation and surface it through browser
      and server validation options.
- [x] Reject server-created compaction for encrypted logs unless a supplied
      compact snapshot is provided.
- [x] Add compact causal frontier metadata to new local updates while accepting
      legacy parent lists.
- [x] Add safe operation builders for register, map, OR-set, and ordered-list
      position allocation.
- [x] Add operation, parent, path, key, element, blocked-queue, update-byte, and
      document-byte guardrails.
- [x] Add explicit API-v1 CRDT admin authorization hooks and admin-client
      allow-list wiring.
- [x] Document FNV hashes as deterministic checksums and expose SHA-256 helper
      hashing for stronger diagnostics.

### 11. Product Docs And Black-Box Coverage

- [x] Add `docs/rallar-crdt-guide.md`.
- [x] Add API reference entries.
- [x] Add troubleshooting entries.
- [x] Add black-box recipes for convergence, duplicate delivery, reconnect,
      conflict surfacing, dependency repair, and debug replay.
- [x] Add health/diagnostics coverage.
- [x] Verify docs and relevant black-box tests.

### 12. Graph CRDT Spike

- [x] Define shared graph document schema.
- [x] Derive graphology inputs from CRDT state.
- [x] Test concurrent node/edge additions and label conflicts.
- [x] Confirm graph repositories remain latest-snapshot caches.
- [x] Verify relevant shared-graph tests.

## Production Hardening Companion Milestones

These milestones track
`plans/rallar-crdt-production-hardening-companion-plan.md`.

### A. Hardening Contracts

- [x] Add consistency guarantee docs.
- [x] Add shared retry/rejection reason codes.
- [x] Add document health and admin status types.
- [x] Add canonical namespace/key tests.
- [x] Add feature flag and rollout-state types.
- [x] Verify shared contract tests/typecheck.

### B. Diagnostics And Recovery

- [x] Add debug export/import bundle format.
- [x] Add snapshot/update hash verification.
- [x] Add local corruption recovery paths.
- [x] Add server projection rebuild path.
- [x] Add black-box recipes for corrupt snapshot and replay repair.
- [x] Verify diagnostics/recovery tests.

### C. Rollout And Operations

- [x] Add feature flags and kill switches.
- [x] Add admin list/inspect/archive/quarantine APIs.
- [x] Add metrics for append, sync, replay, pending, dependency, and rejection
      behavior.
- [x] Add rate limit and quota enforcement.
- [x] Verify operational control tests.

### D. Scale And Disaster Recovery

- [x] Add backup/restore runbook.
- [x] Add restore tests preserving document IDs and append sequence.
- [x] Add catch-up pagination/digest tests for large logs.
- [x] Add scheduled projection rebuild/integrity checks.
- [x] Verify scale/disaster-recovery tests.

### E. Domain-Specific Hardening

- [x] Add AR/spatial metadata conventions if AR annotations become a CRDT use
      case.
- [x] Add ordered-list sequence CRDT operations, snapshots, replay, browser
      helpers, and tests.
- [x] Add actor-scoped undo/redo operation-group metadata and browser helpers.
- [x] Add document-level encryption helpers for encrypted update payloads,
      encrypted snapshot bodies, keyring-based client decrypt, validation, and
      redacted diagnostics.
- [x] Verify domain-specific hardening tests/docs.

### F. Remaining Limitations Implementation

- [x] Add Black Box CRDT Health tab and API-v1 admin routes.
- [x] Add repository audit sink events for append, reject, export, backup,
      restore, archive, quarantine, destroy, rebuild, and compact.
- [x] Add non-destructive compaction snapshots and redacted debug exports.
- [x] Add explicit erasure/redaction audit workflow helpers.
- [x] Add scheduled retention/stale-snapshot health summary helpers.
- [x] Verify encrypted CRDT replay, durable dedupe, backup/restore, and
      redacted diagnostics.
