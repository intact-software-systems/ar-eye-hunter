# Rallar CRDT Product And Implementation Plan

Date: 2026-06-04

Status: Implementation-ready V1 plan for an explicit Rallar CRDT product
surface.

Companion plan:

- `plans/rallar-crdt-production-hardening-companion-plan.md`

## Purpose

This plan turns `iterations/rallar-crdt-iteration-plan.md`,
`playground/RALLAR_CRDT.md`, the current Rallar docs, and the current Rallar
code shape into a decision-complete implementation plan.

The core product decision is:

> Do not turn `rallar.data.open(...)` into a CRDT store.

Rallar should support collaborative, conflict-tolerant application documents,
but CRDT behavior must be explicit and opt-in. The product surface is
`rallar.crdt`, not hidden inside `rallar.data`.

## Current Code And Docs Checked

Primary local references:

- `iterations/rallar-crdt-iteration-plan.md`
- `playground/RALLAR_CRDT.md`
- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `docs/rallar-ai-skill.md`
- `docs/rallar-product-and-implementation-evaluation.md`
- `packages/shared/mod.ts`
- `packages/shared/al-contracts/al-contract.ts`
- `packages/shared/al-contracts/al-policy.ts`
- `packages/shared/webrtc/QRtcDataChannel.ts`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared-server/rallar-facade/RallarServer.ts`
- `packages/shared-server/rallar-facade/ws-topic-router.ts`
- `packages/shared-server/app-data/RallarServerAppData.ts`
- `packages/shared-server/postgres/app-data/PSqlAppDataRepository.ts`
- `apps/api-v1/prisma/migrations/20260506200000_app_data_store/migration.sql`
- `apps/api-v1/src/db/in-memory-schema.sql`
- `packages/shared-graph/shared-graph-types.ts`
- `packages/shared-graph/repository/graphs-repository.ts`
- `packages/tests/shared-web/rallar-data.test.ts`

Repo facts this plan relies on:

- `rallar.data` is a browser-local latest-value store with IndexedDB persistence
  and same-origin tab sync through `BroadcastChannel`.
- `rallar.messages.ws` and `rallar.messages.rtc` send AL messages with
  `topicId`, `typeId`, payload, routing, delivery, and diagnostics.
- Server dynamic WS topics already support topic/type selectors, payload
  validation, room authorization, max payload size, fanout modes, and NACKs.
- `rallar.realtime` is a low-latency RTC data-channel facade and is not the
  right default for authoritative CRDT updates.
- Server app data and graph repositories are latest-value/snapshot oriented, not
  append-only CRDT logs.

## V1 Decisions

V1 commits to:

- A small Rallar-owned CRDT engine in `packages/shared/crdt`.
- Operation-first public mutation API through `applyLocal(...)`.
- Generic JSON map/register/OR-set operations plus a checklist example.
- Room documents as the first live WS/RTC collaboration scope, with principal
  documents guaranteed for local-first and durable server catch-up once the CRDT
  log exists.
- User-selectable live transport strategies for room CRDT documents: `ws`,
  `rtc`, `ws-then-rtc`, and `rtc-with-ws-fallback`.
- Browser facade in `packages/shared-web/browser`, exposed on `RallarFacade` as
  `rallar.crdt`.
- Internal CRDT local artifacts stored through `rallar.data` with `sync: false`.
- Same-origin CRDT tab sync through a separate `rallar-crdt:<document-key>`
  `BroadcastChannel`.
- Peer catch-up only for development and tests.
- Production-ready network collaboration only after the durable server append
  log, snapshots, and catch-up are implemented.

V1 explicitly excludes:

- Making `rallar.data.open(...)` CRDT-aware.
- Draft-style `change(...)` as the primary public API.
- Document-wide collaborative undo/redo.
- Rich-text CRDTs for character/mark-level editing. Ordered-list sequence CRDTs
  are now implemented separately.
- Destructive compaction of updates or tombstones.
- Raw binary/blob payloads inside CRDT updates.
- Server authority for auth, membership, billing, quota, inventory, or other
  command-owned state.

## Product Boundary

Rallar CRDT is for application-owned collaborative documents:

> Rallar CRDT lets room documents and principal-owned documents accept
> independent edits from multiple replicas, merge them deterministically, and
> synchronize them through Rallar transports appropriate to each scope.

Product language:

- `rallar.data`: local latest-value browser storage.
- `rallar.crdt`: collaborative durable mergeable documents.
- `rallar.messages.ws`: server-routed application messages.
- `rallar.messages.rtc`: peer-to-peer application messages.
- `rallar.realtime`: ephemeral low-latency peer state such as cursors and
  previews.
- Rallar Server CRDT log: durable catch-up and late-join source of truth.

Do not add CRDT behavior to:

- `rallar.data.open(...)`
- Rallar auth/session state
- authoritative room membership
- billing/quota/security decisions
- server-owned presence expiry
- authoritative game state, inventory, or command workflows
- graph snapshot repositories

Recommended browser API shape:

```ts
const doc = await rallar.crdt.open<SharedChecklist>('room-checklist', {
    documentId: roomRef.groupId,
    documentType: 'checklist',
    scope: { kind: 'room', roomRef },
    transport: 'ws-then-rtc',
    persist: true,
});

const unsubscribe = doc.subscribe((snapshot) => {
    render(snapshot.value);
});

await doc.applyLocal({
    kind: 'orset.add',
    path: ['items'],
    elementId: crypto.randomUUID(),
    value: {
        text: 'Inspect north entrance',
        done: false,
    },
});
```

Recommended server API later:

```ts
rallar.crdt.defineDocument({
    documentType: 'checklist',
    scope: 'room',
    authorizeRead: isRoomMember,
    authorizeWrite: canEditRoomDocument,
    maxUpdateBytes: 16 * 1024,
});
```

## Shared Contracts

Add shared CRDT contracts in `packages/shared/crdt` and export them from
`packages/shared/mod.ts`.

Initial files:

```text
packages/shared/crdt/crdt-types.ts
packages/shared/crdt/crdt-codec.ts
packages/shared/crdt/crdt-clock.ts
packages/shared/crdt/crdt-document-key.ts
packages/shared/crdt/crdt-hash.ts
packages/shared/crdt/crdt-operations.ts
packages/shared/crdt/mod.ts
```

Core document reference:

```ts
export type RallarCrdtDocumentScope = 'app' | 'principal' | 'room' | 'custom';

export type RallarCrdtDocumentRef = Readonly<{
    applicationId: string;
    workspaceId?: string;
    scope: RallarCrdtDocumentScope;
    documentType: string;
    documentId: string;
    roomRef?: GroupRef;
    principalId?: string;
    customScope?: string;
}>;
```

Room documents are the first live transport scope because current browser WS
send options are room/world/all and server dynamic topic scopes are
app/room/world. Principal documents are still first-class local and durable-log
documents. Principal live fanout is supported only when the server bridge has a
durable log and principal session resolver; durable append remains the source of
truth. App and custom scopes may exist in shared contracts, but full server
support is deferred unless explicitly implemented.

Core update envelope:

```ts
export type RallarCrdtUpdateEnvelope<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        protocolVersion: 1;
        document: RallarCrdtDocumentRef;
        updateId: string;
        replicaId: string;
        actorId?: string;
        sessionId?: string;
        lamport: number;
        parents: readonly string[];
        schemaVersion: number;
        operationVersion: number;
        createdAtEpochMs: number;
        payload: TPayload;
        hash?: string;
    }>;
```

Core snapshot envelope:

```ts
export type RallarCrdtSnapshotEnvelope<TValue = unknown> = Readonly<{
    protocolVersion: 1;
    document: RallarCrdtDocumentRef;
    snapshotId: string;
    schemaVersion: number;
    createdAtEpochMs: number;
    maxLamport: number;
    includedUpdateIds: readonly string[];
    updateClock?: RallarCrdtClockSummary;
    value: TValue;
    metadata: RallarCrdtSnapshotMetadata;
    hash?: string;
}>;
```

Default topics and type IDs:

```ts
export const RALLAR_CRDT_ROOM_TOPIC_ID = 'room.crdt';
export const RALLAR_CRDT_APP_TOPIC_ID = 'app.crdt';

export const RALLAR_CRDT_UPDATE_TYPE_ID = 'rallar.crdt.update.v1';
export const RALLAR_CRDT_SYNC_REQUEST_TYPE_ID = 'rallar.crdt.sync-request.v1';
export const RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID = 'rallar.crdt.sync-response.v1';
export const RALLAR_CRDT_SNAPSHOT_TYPE_ID = 'rallar.crdt.snapshot.v1';
```

Topic IDs use `room.*` and `app.*` because server topic IDs beginning with
`rallar.*` are reserved. Type IDs can use `rallar.crdt.*` because type IDs are
payload schema identifiers, not WS topic routing domains.

### Operation Payloads

V1 operation payloads are explicit JSON operations:

```ts
export type RallarCrdtOperationBatch = Readonly<{
    kind: 'batch';
    operations: readonly RallarCrdtOperation[];
}>;

export type RallarCrdtOperation =
    | RallarCrdtOrSetAddOperation
    | RallarCrdtOrSetRemoveOperation
    | RallarCrdtRegisterSetOperation
    | RallarCrdtMapSetOperation
    | RallarCrdtMapDeleteOperation;

export type RallarCrdtPath = readonly string[];
```

Required V1 operation shapes:

- `orset.add`: `path`, `elementId`, `value`.
- `orset.remove`: `path`, `elementId`, `observedAddUpdateIds`.
- `register.set`: `path`, `value`, `policy: 'lww' | 'multi'`.
- `map.set`: `path`, `key`, `value`.
- `map.delete`: `path`, `key`, `observedUpdateIds`.

Deterministic rules:

- Dedupe by `updateId`.
- OR-set add tags use update IDs.
- OR-set remove only removes observed add tags.
- LWW register ties sort by Lamport, then created time, then replica ID, then
  update ID.
- Multi-value registers preserve concurrent values so applications can display
  and resolve conflicts.
- A batch is atomic for one document: validate the whole batch before applying
  any operation.

### Validation And Schema Evolution

Shared validators must reject:

- unknown protocol versions
- unknown operation versions
- invalid document refs
- illegal operation kinds
- illegal paths
- oversized values
- operation payloads that do not match the document type policy

Document schema version and operation payload version are separate. Old updates
must remain replayable after app upgrades. Snapshot import must verify schema
compatibility or use an explicit migration. Unknown future protocol versions are
rejected.

### Canonical Hashing

Define canonical JSON serialization for:

- document keys
- update hashes
- snapshot hashes
- debug export bundles

Hashes are for integrity checks, dedupe diagnostics, snapshot verification, and
black-box reproductions. Compression and transport batching must not change
canonical update identity.

## CRDT Engine V1

Implement a Rallar-owned deterministic engine in `packages/shared/crdt`.

V1 supports:

- observed-remove set
- map of registers and sets
- last-writer-wins register for explicitly configured fields
- multi-value register for fields where conflicts should be surfaced
- atomic operation batches
- dependency-pending queue for updates that reference unseen parents or observed
  add/update IDs
- snapshot import/export
- ordered-list sequence insert/delete/move operations

V1 supports ordered lists, kanban columns, outlines, and paragraph ordering
through sequence operations. It does not support rich-text character/mark
editing; text annotations that need editor semantics require a later rich-text
CRDT instead of fragile array overwrite semantics.

Engine requirements:

- Deterministic merge.
- Dedupe by `updateId`.
- Per-tab replica IDs.
- Lamport-clock helpers.
- Missing dependency detection and repair status.
- Apply updates in any order and converge once dependencies are available.
- Keep tombstone behavior visible and tested.
- Allow snapshots for faster load.
- Do not destructively compact updates or tombstones in V1.

Recommended internal engine API:

```ts
export type RallarCrdtDocument<TValue, TPayload> = Readonly<{
    ref: RallarCrdtDocumentRef;
    read(): TValue;
    apply(update: RallarCrdtUpdateEnvelope<TPayload>): RallarCrdtApplyResult;
    applyLocal(payload: TPayload): RallarCrdtUpdateEnvelope<TPayload>;
    snapshot(): RallarCrdtSnapshotEnvelope<TValue>;
    importSnapshot(snapshot: RallarCrdtSnapshotEnvelope<TValue>): void;
    seenUpdateIds(): ReadonlySet<string>;
    dependencyState(): RallarCrdtDependencyState;
}>;
```

## Browser Implementation

Suggested files:

```text
packages/shared-web/browser/rallar-crdt.ts
packages/shared-web/browser/rallar-crdt-local-store.ts
packages/shared-web/browser/rallar-crdt-tab-sync.ts
packages/shared-web/browser/rallar-crdt-transport.ts
```

Browser facade responsibilities:

- Open CRDT documents by document ref.
- Generate a per-tab `replicaId`; actor/principal/session are metadata only.
- Apply local operation batches.
- Receive and dedupe remote updates.
- Store snapshots, pending updates, seen updates, failed pending updates,
  metadata, and dependency-blocked updates through internal `rallar.data`
  stores.
- Open all internal CRDT artifact stores with `sync: false`.
- Subscribe UI listeners to merged snapshots.
- Expose diagnostics and document health.
- Support chunked replay so large local logs do not block the browser UI.

Internal Rallar Data stores:

```text
crdt:snapshots
crdt:pending-updates
crdt:failed-pending-updates
crdt:dependency-blocked-updates
crdt:seen-updates
crdt:metadata
```

Browser document API:

```ts
export type RallarCrdtDocument<
    TValue,
    TPayload = RallarCrdtOperationBatch,
> = Readonly<{
    ref: RallarCrdtDocumentRef;
    read(): TValue;
    subscribe(listener: RallarCrdtSnapshotListener<TValue>): RallarUnsubscribe;
    applyLocal(payload: TPayload): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
    pendingUpdates(): readonly RallarCrdtUpdateEnvelope<TPayload>[];
    failedPendingUpdates(): readonly RallarCrdtFailedPendingUpdate[];
    dependencyBlockedUpdates(): readonly RallarCrdtDependencyBlockedUpdate[];
    snapshot(): RallarCrdtSnapshotEnvelope<TValue>;
    flush(): Promise<void>;
    sync(options?: RallarCrdtSyncOptions): Promise<RallarCrdtSyncResult>;
    close(): Promise<void>;
    destroy(): Promise<void>;
    health(): RallarCrdtDocumentHealth;
}>;
```

Document health should include:

- replica ID
- pending update count
- failed pending update count
- dependency-blocked update count
- last server append sequence
- last server ack time
- last sync error
- snapshot age
- update-log lag
- quota state
- replay duration

Pending update lifecycle:

- Local-only: pending means locally produced and durably persisted.
- WS/RTC bridge: transport enqueue/send result is diagnostic only.
- Durable server phase: pending clears only after server append-log acceptance.
- Unauthorized, schema-invalid, or quota-rejected local updates move to failed
  pending state and do not retry forever.

## Same-Origin Tab Sync

Use a CRDT-specific `BroadcastChannel`:

```text
rallar-crdt:<document-key>
```

Broadcast update envelopes, not document snapshots or latest values.

Requirements:

- Each tab/document instance has a separate replica ID.
- Updates are deduped through the CRDT engine and seen-update store.
- Concurrent tab edits converge.
- Reloaded tabs load local persistence before accepting live tab messages.
- Internal `rallar.data` stores must not also sync through the Rallar Data
  BroadcastChannel path.

## Transport And Sync

Browser transport strategies:

```ts
export type RallarCrdtTransportStrategy =
    | 'local-only'
    | 'ws'
    | 'rtc'
    | 'ws-then-rtc'
    | 'rtc-with-ws-fallback';
```

Transport guidance:

- `local-only`: useful for first slice and offline tests.
- `ws`: default for room documents that need server-routed fanout.
- `rtc`: useful only when active peers are available and late-join durability is
  handled separately.
- `ws-then-rtc`: send to WS for server path, use RTC to accelerate live peers.
- `rtc-with-ws-fallback`: useful for small rooms when server fanout is
  expensive, but pending still clears only after durable append once the server
  log exists.

The application chooses the live transport strategy when opening a CRDT
document. Rallar CRDT must support both WS and RTC live propagation for
room-scoped documents, plus combined/fallback strategies. These strategies are
delivery choices, not durability levels:

- WS gives server-routed live distribution and is the safest default.
- RTC gives low-latency peer propagation when room peers are currently active.
- Combined strategies can use WS for the server path and RTC to accelerate live
  peers.
- Late join, reconnect with no peer online, and production pending-queue
  clearance still require the durable server append log.

Avoid using `rallar.realtime` for authoritative CRDT updates in V1. Use it for
ephemeral awareness state such as cursors, selections, typing state, hover, drag
previews, and low-value optimistic previews.

Sync requirements:

- Sync request carries document ref plus known update IDs for small documents or
  cursor/clock summary for durable server catch-up.
- Sync response returns optional snapshot plus an update page.
- Missing dependencies trigger sync repair.
- Peer catch-up exists only for development and tests.
- Production catch-up comes from the durable server log.
- Transport may batch multiple updates for efficiency; batching must preserve
  update identity.

## Server Implementation

There are two server layers.

### Server Topic Bridge

Use existing dynamic WS topics early:

- define `room.crdt` first, and use `app.crdt` only for app-wide/admin documents
  where the existing app/world topic semantics are appropriate
- validate CRDT update envelopes and document refs
- authorize room-scoped live messages; principal-scoped fanout requires durable
  append acceptance plus explicit principal session resolution
- derive trusted actor/principal/session from authenticated message context
- enforce max payload size
- fan out accepted updates

This can be a thin adapter over the current `RallarServer.ws.defineTopic(...)`
surface.

### Durable CRDT Log

Production CRDT sync needs append-only storage.

Suggested contracts:

```ts
export type RallarCrdtUpdateLogRepository = Readonly<{
    append(input: RallarCrdtAppendUpdateInput): Promise<RallarCrdtAppendResult>;
    appendBatch(
        input: RallarCrdtAppendBatchInput,
    ): Promise<RallarCrdtAppendBatchResult>;
    listAfter(input: RallarCrdtListUpdatesInput): Promise<RallarCrdtUpdatePage>;
    readSnapshot(
        ref: RallarCrdtDocumentRef,
    ): Promise<RallarCrdtSnapshotEnvelope | undefined>;
    writeSnapshot(input: RallarCrdtWriteSnapshotInput): Promise<void>;
    updateDocumentLifecycle(
        input: RallarCrdtLifecycleInput,
    ): Promise<RallarCrdtDocumentMetadata>;
}>;
```

Server append result metadata:

- authoritative append sequence
- accepted time
- authoritative actor/principal/session
- authorization scope
- accepted update hash
- rejection reason when rejected

Storage requirements:

- unique `(documentKey, updateId)`
- append-only updates
- document metadata with lifecycle state: `active`, `archived`, `destroyed`
- compact snapshots for faster catch-up
- append sequence or cursor-based catch-up
- authorization before append and read
- idempotent duplicate append handling
- retention and redaction policy
- materialized latest snapshots or indexes only as derived rebuildable data

Postgres can back this with:

```text
crdt_documents
crdt_updates
crdt_snapshots
```

Do not try to make `app_data_store` serve as the only CRDT storage. It can hold
snapshots, but not the authoritative update log.

When adding Postgres support, update:

- Prisma migrations under `apps/api-v1/prisma/migrations`
- `apps/api-v1/src/db/in-memory-schema.sql`
- PGlite/in-memory database tests
- `packages/shared-server/mod.ts` exports

## Document Lifecycle And Access

Server durable phase must support document metadata and lifecycle state:

- create
- open
- list
- archive
- destroy
- optional ownership transfer later

V1 browser API may start with `open`, but server-backed documents need
discoverable metadata.

Lifecycle rules:

- Active documents allow authorized reads and writes.
- Archived documents allow authorized reads and reject writes.
- Destroyed documents follow the declared retention/redaction policy.
- Offline edits produced after access is lost are rejected during reconnect and
  moved to failed pending state.
- CRDT delete is a merge operation, not privacy erasure.

## Conflict, Attachments, And Large Documents

Multi-value registers must expose conflicts in `read()` and snapshot output so
applications can render, preserve, or resolve them. Conflict resolution is a
normal CRDT operation, not local value overwrite.

V1 supports whole-document sync for small and medium JSON documents. Large
boards, reports, and graphs should use subdocuments or section keys later.

CRDT payloads must not store raw large blobs. Store attachment references,
metadata, ordering, and captions. Blob upload, scanning, deletion, storage, and
access control remain outside CRDT.

## Privacy, Retention, And Redaction

Append-only logs retain old values and tombstones. Document type definitions
must declare whether sensitive payloads are allowed. Redaction/deletion requires
a separate policy; CRDT delete does not erase historical log entries.

Document-level encryption now supports encrypted update payloads and encrypted
snapshot bodies for clients opened with a CRDT encryption keyring. Policies must
declare whether sensitive payloads require encryption and which metadata remains
server-visible.

## Graph CRDT Boundary

Current graph repositories are latest snapshot caches. Keep them that way.

A graph CRDT may later store authored collaboration data:

- nodes
- edges
- labels
- annotations
- layout hints
- observations

Adapters can derive graphology or `GraphInfoSnapshot` inputs from CRDT state. Do
not store Vivaldi results, core-node selection, tree/mesh routing, or computed
overlay results as CRDT source-of-truth data.

## Implementation Roadmap

### Phase 0: Baseline Protection

Goal: lock the product boundary.

Work:

- Add docs note: CRDT is explicit and not `rallar.data`.
- Add or preserve tests proving `rallar.data` remains latest-value:
    - `set` replaces whole values
    - tab sync applies `set/delete/clear`
    - incompatible open options still throw
    - `compareAndSet` is not a distributed lock

Acceptance:

- No public `rallar.data.open(...)` signature change.
- Current Rallar Data tests remain green.

### Phase 1: Shared CRDT Contracts

Goal: define contracts and validation before behavior.

Work:

- Add `packages/shared/crdt`.
- Define document refs, update envelopes, snapshot envelopes, lifecycle
  metadata, sync request/response envelopes, operation batches, conflict result
  types, quota error types, and trusted append metadata.
- Add document key helpers.
- Add canonical hash helpers.
- Add codec/validator helpers.
- Export from `packages/shared/mod.ts`.

Acceptance:

- Contract tests cover valid/invalid envelopes, document key stability,
  operation validation, schema-version rejection, and hash stability.
- No browser/server dependencies in shared CRDT contracts.

### Phase 2: Deterministic Engine V1

Goal: ship local deterministic merge behavior.

Work:

- Implement Lamport clock helpers.
- Implement update dedupe.
- Implement OR-set, map, LWW register, and multi-value register.
- Implement atomic operation batches.
- Implement missing dependency queue and repair status.
- Implement snapshot import/export.
- Add compaction hooks, but no destructive compaction.

Acceptance:

- Same update set converges regardless of order.
- Duplicate updates are ignored.
- OR-set add/remove and observed-tag behavior are tested.
- LWW tie-breaks are deterministic.
- Multi-value conflicts surface in snapshots.
- Snapshot plus later updates equals full replay.
- Randomized convergence/fuzz tests pass.

### Phase 3: Browser Local Store Adapter

Goal: persist CRDT artifacts through Rallar Data without changing Rallar Data.

Work:

- Add internal stores for snapshots, pending updates, failed pending updates,
  dependency-blocked updates, seen updates, and metadata.
- Open internal stores with `sync: false`.
- Persist per-tab replica metadata for the tab/document instance.
- Persist pending updates through reload.
- Add `flush`, `clearDocument`, and `destroyDocument`.

Acceptance:

- Documents close and reopen with no update loss.
- Pending updates survive reload.
- Seen updates survive reload.
- Internal stores do not sync through the Rallar Data BroadcastChannel path.

### Phase 4: Browser Facade Local-Only

Goal: expose useful local `rallar.crdt`.

Work:

- Add `createRallarCrdtFacade(...)`.
- Add `rallar.crdt` to `RallarFacade`.
- Support `open`, `read`, `subscribe`, `applyLocal`, `snapshot`, `flush`,
  `close`, `destroy`, `sync`, and `health`.
- Add checklist example and migration guidance from existing `rallar.data`
  latest-value state into an initial CRDT document.
- Add chunked replay.

Acceptance:

- A browser can open, mutate, subscribe, close, and reopen a document locally.
- Failed pending/dependency-blocked state is observable.
- Existing Rallar Data tests remain green.

### Phase 5: Same-Origin Tab Sync

Goal: prove update-based sync before network transport.

Work:

- Add CRDT-specific `BroadcastChannel`.
- Broadcast update envelopes.
- Add concurrent-tab convergence tests.

Acceptance:

- Two same-origin facades converge after independent edits.
- No whole-value overwrite occurs during tab sync.
- Each tab has a separate replica ID.

### Phase 6: Live Transport Over Rallar Messages

Goal: synchronize browser documents over existing Rallar WS/RTC messages.

Work:

- Use `room.crdt` for room live sync and `app.crdt` only for app-wide/admin
  documents that match existing app/world topic semantics.
- Use CRDT type IDs.
- Support user-selected WS and RTC app-message lanes.
- Add transport strategy and fallback handling.
- Add update batching without changing update identity.
- Add diagnostics for sent, received, duplicate, merged, rejected, failed,
  blocked, and retried updates.

Acceptance:

- Two browsers converge over mocked WS when `transport: "ws"` is selected.
- Two browsers converge over mocked RTC when `transport: "rtc"` is selected.
- Combined/fallback strategies use the configured WS/RTC order.
- Duplicate AL deliveries do not duplicate CRDT updates.
- Closed RTC lanes fall back to WS where configured.
- Dependency-blocked updates trigger sync repair.

### Phase 7: Sync And Catch-Up Contract

Goal: define missing-update behavior before durable server implementation.

Work:

- Add sync request/response envelopes.
- On open: load local snapshot, subscribe, request missing updates.
- Retry unacknowledged local updates after reconnect.
- Add peer catch-up for development and tests only.

Acceptance:

- A browser that misses live updates can catch up from another browser in tests.
- Docs clearly mark peer catch-up as insufficient for production durability.

### Phase 8: Server Topic Bridge

Goal: validate, authorize, and fan out CRDT updates through Rallar Server.

Work:

- Add server CRDT topic helper over `RallarServer.ws.defineTopic`.
- Validate envelope, operation paths, document ref, and payload size.
- Authorize room-scoped live updates and reject principal live fanout unless
  durable append and trusted principal session resolution are configured.
- Stamp trusted actor/session/principal metadata in diagnostics.
- Fan out accepted updates.

Acceptance:

- Invalid CRDT updates are rejected.
- Unauthorized room updates are rejected, and principal live fanout is rejected
  unless it is durable-append backed.
- Oversized updates and raw blobs are rejected.
- Accepted updates are fanned out without requiring durable CRDT tables yet.

### Phase 9: Server Durable Log Contract

Goal: prepare production durability.

Work:

- Add repository interfaces.
- Add HTTP/WS contracts for append and catch-up.
- Define append sequence and idempotency rules.
- Define lifecycle, retention, redaction, and quota policies.
- Define authorization hooks.
- Define materialized view/projection hooks as derived data.

Acceptance:

- Browser sync has a stable server target.
- Contract supports room and principal scopes through durable append/read and
  catch-up.
- Contract leaves explicit extension points for app/custom scopes.

### Phase 10: Server Durable Log Implementation

Goal: support late join and reconnect without another peer online.

Work:

- Add Postgres-backed CRDT tables.
- Add Prisma migration and in-memory schema updates.
- Add PGlite/in-memory tests.
- Append updates idempotently.
- Store compact snapshots.
- Serve snapshot plus update pages by append cursor.
- Broadcast accepted updates.
- Add lifecycle metadata and archived/destroyed behavior.

Acceptance:

- New browsers can load snapshot plus missing updates.
- Reconnecting browsers can catch up from server.
- Duplicate appends are idempotent.
- Pending updates clear only after durable append acceptance.
- Offline updates after access loss become failed pending updates.

### Phase 11: Product Docs And Black-Box Coverage

Goal: make CRDT usable and observable.

Work:

- Add `docs/rallar-crdt-guide.md`.
- Add API reference entries.
- Add troubleshooting entries.
- Add black-box recipes for convergence, duplicate delivery, reconnect, conflict
  surfacing, dependency repair, and export/debug replay.
- Add CRDT health and diagnostics display to Rallar Black Box later.

Acceptance:

- Developers can choose between `rallar.data`, `rallar.crdt`, messages,
  realtime, and server commands.
- Failures can be diagnosed without inspecting raw IndexedDB.
- Exported snapshot plus update log can reproduce document state.

### Phase 12: Graph CRDT Spike

Goal: prove shared graph authoring without corrupting graph caches.

Work:

- Define shared graph document schema.
- Derive graphology inputs from CRDT state.
- Test concurrent node/edge additions and label conflicts.

Acceptance:

- Concurrent graph edits converge.
- Derived graph output is deterministic.
- Existing graph repositories remain latest-snapshot caches.

## First Useful Slice

The first useful implementation slice is:

```text
shared CRDT contracts
  -> deterministic local engine
  -> browser local store adapter
  -> local-only rallar.crdt facade
```

Do not start with server durable logs or graph CRDTs. They are valuable, but
they will slow down the product proof.

This first slice proves:

- the product boundary
- the update envelope and operation schema
- local persistence through `rallar.data`
- convergence semantics
- conflict surfacing
- a real API that UI code can use

## Recommended Near-Term File Plan

First implementation pass:

```text
packages/shared/crdt/crdt-types.ts
packages/shared/crdt/crdt-codec.ts
packages/shared/crdt/crdt-clock.ts
packages/shared/crdt/crdt-document-key.ts
packages/shared/crdt/crdt-hash.ts
packages/shared/crdt/crdt-operations.ts
packages/shared/crdt/crdt-orset.ts
packages/shared/crdt/crdt-register.ts
packages/shared/crdt/crdt-map.ts
packages/shared/crdt/mod.ts
packages/shared-web/browser/rallar-crdt-local-store.ts
packages/shared-web/browser/rallar-crdt.ts
packages/tests/shared/crdt-contracts.test.ts
packages/tests/shared/crdt-engine.test.ts
packages/tests/shared/crdt-fuzz.test.ts
packages/tests/shared-web/rallar-crdt-local-store.test.ts
packages/tests/shared-web/rallar-crdt-facade.test.ts
```

Later implementation passes:

```text
packages/shared-web/browser/rallar-crdt-tab-sync.ts
packages/shared-web/browser/rallar-crdt-transport.ts
packages/shared-server/crdt/RallarCrdtServer.ts
packages/shared-server/crdt/CrdtUpdateLogRepository.ts
packages/shared-server/postgres/crdt/PSqlCrdtUpdateLogRepository.ts
packages/shared-graph/crdt/shared-graph-document.ts
```

## Deferred Decisions

- Draft-style `change(...)` helper.
- Rich-text CRDT support beyond ordered-list sequence operations.
- Document-wide collaborative undo/redo beyond actor-owned operation groups.
- Destructive server-authorized compaction and garbage collection.
- Key custody, rotation automation, revocation UX, and access-loss recovery for
  encrypted CRDT documents.
- App/custom scope server support.
- Peer catch-up as a supported fallback.
- Optional package extraction from `packages/shared-web`.
- Graph CRDT productization.

## Test Plan

Required coverage:

- `rallar.data` latest-value behavior remains unchanged.
- Shared CRDT validators reject invalid document refs, protocol versions,
  operation versions, operation paths, oversized payloads, and unsupported raw
  blob payloads.
- CRDT engine convergence holds across reordered, duplicated, dropped, and
  replayed updates.
- OR-set add/remove, LWW tie-breaks, multi-value conflicts, atomic batches, and
  missing dependency repair are deterministic.
- Browser local stores persist pending, failed pending, dependency-blocked,
  seen, metadata, and snapshot artifacts without using Rallar Data tab sync.
- Same-origin CRDT tab sync converges with separate per-tab replica IDs.
- WS/RTC room live sync dedupes duplicate AL deliveries and reports fallback,
  rejection, dependency, and retry diagnostics.
- User-selected `ws`, `rtc`, `ws-then-rtc`, and `rtc-with-ws-fallback`
  strategies use the configured live path.
- Principal documents sync through local persistence and durable append/read.
  Principal live fanout happens only after append acceptance when the server
  bridge has a principal session resolver.
- Durable server append, idempotency, append cursor catch-up, lifecycle state,
  retention/redaction policy, and Postgres/in-memory schema migrations are
  covered.
- Debug export of snapshot plus update pages reproduces document state.

## Assumptions

- The first useful slice is local/browser-only and is allowed to ship before the
  durable server log.
- Networked CRDT collaboration is not production-ready until durable append,
  trusted server metadata, snapshots, and catch-up exist.
- Current Rallar message APIs provide room/app/world topic semantics, not a
  principal live routing scope.
- `rallar.realtime` remains ephemeral and is not used for authoritative CRDT
  updates.
- CRDT delete is not privacy erasure.
- Graph CRDT productization, rich text, encrypted-document key operations,
  destructive compaction/garbage collection, and custom-scope server support
  need follow-up plans or explicit V1 expansion.

## Recommendation

Proceed with the first useful slice, keeping the initial product promise narrow:

> Local-first collaborative JSON documents for Rallar apps, with explicit CRDT
> semantics, deterministic operation merge, room live sync, principal durable
> documents, and later Rallar transport/server catch-up.

Treat local-only and topic-bridge phases as useful but not production-ready for
networked collaboration. Production-ready collaboration requires the durable
server append log, trusted append sequencing, snapshots, and catch-up.
