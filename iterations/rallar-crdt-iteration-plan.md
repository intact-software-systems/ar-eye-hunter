# Rallar CRDT Iteration Plan

Date: 2026-06-01

This plan turns `RALLAR_CRDT.md` into implementation iterations grounded in the current root docs and the code in
`packages/shared`, `packages/shared-web`, and `packages/shared-graph`.

## Current Decision

Do not change `rallar.data.open(...)` into a CRDT store.

The current data facade is a local, durable, latest-value key/value store. It is useful for drafts, settings, local
state, snapshots, pending work, and same-origin tab sync. CRDT behavior should be explicit because it needs update
identity, replica identity, causal metadata, tombstones, merge rules, local pending logs, catch-up, authorization, and
compaction.

Recommended product surface:

```ts
const board = await rallar.crdt.open<RoomBoard>('room-board', {
  scope: { kind: 'room', roomRef },
  transport: 'ws-then-rtc',
  persist: true,
});
```

`rallar.data` remains the storage substrate for browser CRDT snapshots, metadata, and pending updates.

## Sources Checked

Proposal:

- `RALLAR_CRDT.md`

Root docs:

- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `docs/rallar-troubleshooting-checklist.md`
- `docs/rallar-ai-skill.md`
- `docs/rallar-product-and-implementation-evaluation.md`

Implementation anchors:

- `packages/shared/al-contracts/al-contract.ts`
- `packages/shared/al-contracts/al-control.ts`
- `packages/shared/al-contracts/al-policy.ts`
- `packages/shared/alm/*`
- `packages/shared/cache/*`
- `packages/shared/persistence/*`
- `packages/shared/queuebox/*`
- `packages/shared/services/WsQueueBoxClientService.ts`
- `packages/shared/services/WebRtcRxStreamerService.ts`
- `packages/shared/services/WebRtcConnectionService.ts`
- `packages/shared/webrtc/QRtcDataChannel.ts`
- `packages/shared/multicast/*`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/browser/rallar-data.ts`
- `packages/shared-web/browser/middleware.ts`
- `packages/shared-web/browser/api-integration.ts`
- `packages/shared-graph/shared-graph-types.ts`
- `packages/shared-graph/repository/graphs-repository.ts`
- `packages/shared-graph/repository/vivaldi-repository.ts`
- `packages/shared-graph/group-graphs-create-service.ts`
- `packages/shared-graph/graph/graph-props.ts`

## Existing Code Fit

### Useful Existing Primitives

- `ALMessage` already has `msgId`, sender identity, route, type ID, targets, constraints, ordering, delivery, QoS,
  diagnostics, and audit metadata.
- AL QoS already models dedup, ordering, reliability, local inbox/outbox durability, retry, ack, repair, and
  supersedence.
- WebSocket messages can be sent through `rallar.messages.ws.send(...)` and received through `onMessage(...)`.
- RTC app-level messages can be sent through `rallar.messages.rtc.send(...)`.
- Realtime data-channel JSON and binary can be sent through `rallar.realtime`, with lane health and flow-control
  visibility.
- Browser middleware already creates an unordered `realtime` RTC lane with `replace-by-key` flow control.
- `rallar.data` can persist snapshots, pending updates, seen update IDs, actor metadata, and clock metadata.
- `rallar.rooms.replayEvents(...)` and `rallar.people.replayEvents(...)` show an existing browser pattern for paged
  catch-up and dedupe, although only for Rallar state events today.
- `packages/shared-graph` stores versioned graph snapshots and already scopes graphs by `GroupRef`.

### Boundaries To Preserve

- `rallar.data` should stay latest-value and local.
- Authoritative auth, sessions, permissions, group membership, and server-owned presence should stay command-based.
- Realtime data-channel traffic can be an optimization for live peers, but should not be the only source of truth.
- Computed graph snapshots should remain derived data. A CRDT graph document should represent user-authored graph
  observations or edits, then feed graph computation when needed.

### Gaps To Close

- No CRDT operation envelope exists in `packages/shared`.
- No browser CRDT facade exists on `RallarFacade`.
- No local CRDT snapshot/update/pending-store adapter exists on top of `rallar.data`.
- No CRDT message topics or type IDs exist.
- No durable CRDT catch-up API exists.
- No server CRDT update-log contract exists in the root docs.
- No graph CRDT document type exists for collaborative graph editing.

## Proposed V1 Scope

Start with operation-based JSON CRDT support for room-scoped and principal-scoped app documents.

V1 should support a small built-in family rather than a fully generic CRDT universe:

- observed-remove set for collections where independent additions should merge
- map of registers for structured records
- last-writer-wins register only where the field explicitly chooses that policy
- multi-value register for same-field conflicts that the app wants to surface

The initial API should prefer update envelopes and snapshots over arbitrary mutable magic. A draft-like `change(...)`
API can be added once the core update contract is stable.

## Iteration 0: Baseline Contract And Non-Regression Tests

Goal: Lock in what CRDT support must not change.

Likely files:

- `packages/tests/shared-web/rallar-data.test.ts`
- `packages/tests/shared-web/rallar-operation-options.test.ts`
- `docs/rallar-api-reference.md`
- this iteration document

Work:

- Add tests or explicit test cases proving `rallar.data` remains latest-value:
  - `set` replaces the whole value.
  - `BroadcastChannel` still applies `set`, `delete`, and `clear`.
  - `compareAndSet` remains facade-local, not a cross-tab transaction.
- Add a small docs note that CRDT support is explicit and not the default data-store mode.
- Add a compatibility note that existing `rallar.data` users do not get new merge behavior.

Acceptance criteria:

- Existing Rallar Data tests pass.
- No public `rallar.data.open(...)` signature is changed.
- A future reader can tell which behaviors are intentionally not CRDT.

## Iteration 1: Shared CRDT Core Contracts

Goal: Define stable transport and persistence contracts before adding browser behavior.

Likely files:

- `packages/shared/crdt/crdt-types.ts`
- `packages/shared/crdt/crdt-codec.ts`
- `packages/shared/crdt/mod.ts`
- `packages/shared/mod.ts`
- `packages/tests/shared/crdt-contracts.test.ts`

Core types:

```ts
type RallarCrdtDocumentRef = Readonly<{
  applicationId: string;
  workspaceId?: string;
  scope: 'app' | 'principal' | 'room' | 'custom';
  documentType: string;
  documentId: string;
  roomRef?: GroupRef;
  principalId?: string;
}>;

type RallarCrdtUpdateEnvelope<TUpdate = unknown> = Readonly<{
  protocolVersion: 1;
  document: RallarCrdtDocumentRef;
  updateId: string;
  replicaId: string;
  actorId?: string;
  sessionId?: string;
  lamport: number;
  parents: readonly string[];
  schemaVersion: number;
  createdAtEpochMs: number;
  payload: TUpdate;
}>;
```

Work:

- Define document refs, replica IDs, update IDs, clocks, update envelopes, snapshot envelopes, update batch envelopes,
  and validation helpers.
- Add deterministic document-key helpers that match the current `GroupRef`-scoped patterns.
- Add codec helpers that reject malformed update envelopes before they reach merge code.
- Add type IDs and topic helpers:
  - `rallar.crdt.update.v1`
  - `rallar.crdt.snapshot.v1`
  - `rallar.crdt.sync-request.v1`
  - `rallar.crdt.sync-response.v1`
  - default user topic `room.crdt` or `app.crdt`, not reserved `rallar.*`

Acceptance criteria:

- Shared package exports CRDT contracts without importing browser code.
- Type and codec tests cover valid envelopes, invalid envelopes, document key stability, and type/topic helpers.
- No dependency on `packages/shared-web`.

## Iteration 2: Deterministic CRDT Engine V1

Goal: Implement a small, testable CRDT engine in `packages/shared`.

Likely files:

- `packages/shared/crdt/crdt-clock.ts`
- `packages/shared/crdt/crdt-document.ts`
- `packages/shared/crdt/crdt-orset.ts`
- `packages/shared/crdt/crdt-register.ts`
- `packages/shared/crdt/crdt-map.ts`
- `packages/tests/shared/crdt-engine.test.ts`

Work:

- Implement Lamport-clock helpers and deterministic update ordering.
- Implement update dedupe by `updateId`.
- Implement snapshot import/export with seen update IDs and compact metadata.
- Implement:
  - OR-set add/remove semantics with tombstones
  - map keys whose values are CRDT registers or nested sets
  - LWW register with explicit timestamp/actor tie-breaking
  - multi-value register for conflicts
- Add merge tests that apply updates in different orders and verify convergence.
- Add compaction hooks that can remove tombstones only when safe according to retained causal metadata.

Acceptance criteria:

- Same update set converges regardless of order.
- Duplicate updates are ignored.
- Snapshot plus later updates produces the same state as full replay.
- Tombstone behavior is explicit and tested.

## Iteration 3: Browser Local CRDT Store Adapter

Goal: Reuse `rallar.data` for local CRDT implementation artifacts without exposing those artifacts as normal app state.

Likely files:

- `packages/shared-web/browser/rallar-crdt-local-store.ts`
- `packages/shared-web/browser/rallar-crdt-storage.ts`
- `packages/tests/shared-web/rallar-crdt-local-store.test.ts`

Internal stores:

- `crdt:snapshots`
- `crdt:pending-updates`
- `crdt:seen-updates`
- `crdt:metadata`

Work:

- Add an adapter that opens internal `rallar.data` stores under a CRDT-specific key prefix.
- Persist current snapshot, pending local update batches, seen update IDs, replica metadata, and clock metadata.
- Support write-through mode for update log metadata and configurable write-behind for large snapshots.
- Add `flush`, `compact`, `clearDocument`, and `destroyDocument`.
- Ensure logout/session scope cleanup composes with existing `data.closeScope('session')` and `data.closeScope('principal')`.

Acceptance criteria:

- CRDT documents can close and reopen from IndexedDB with no update loss.
- Pending updates survive reload.
- Seen update IDs survive reload and suppress duplicate remote updates.
- The adapter does not require changes to public `RallarDataStore`.

## Iteration 4: Browser CRDT Facade, Local-Only

Goal: Add `rallar.crdt` as a local-first public facade without live sync yet.

Likely files:

- `packages/shared-web/browser/rallar-crdt.ts`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-web/mod.ts`
- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `packages/tests/shared-web/rallar-crdt-facade.test.ts`

Proposed API:

```ts
const doc = await rallar.crdt.open<SharedChecklist>('room-checklist', {
  documentId: roomRef.groupId,
  documentType: 'checklist',
  scope: { kind: 'room', roomRef },
  persist: true,
});

const unsubscribe = doc.subscribe((state) => render(state.value));

await doc.applyLocal({
  kind: 'orset.add',
  path: ['items'],
  value: { id: itemId, text: 'Scan object', done: false },
});
```

Work:

- Add `createRallarCrdtFacade(...)` and expose it as `rallar.crdt`.
- Keep the first public mutation API operation-shaped, such as `applyLocal(update)` or `transaction(ops)`.
- Add subscriptions, `read`, `snapshot`, `pendingUpdates`, `flush`, `close`, `destroy`.
- Generate stable `replicaId` using a persisted CRDT metadata store. Use session identity as actor metadata, not as the
  replica ID itself.
- Add local-only examples for checklist and room board.

Acceptance criteria:

- A browser can open, mutate, subscribe, close, and reopen a CRDT document locally.
- API docs explain that this is local-only until transport is enabled.
- Existing `rallar.data` tests remain green.

## Iteration 5: Same-Origin Multi-Tab CRDT Sync

Goal: Prove update-based synchronization locally before network sync.

Likely files:

- `packages/shared-web/browser/rallar-crdt-tab-sync.ts`
- `packages/tests/shared-web/rallar-crdt-tab-sync.test.ts`

Work:

- Add a `BroadcastChannel` based CRDT update bus separate from the existing `rallar-data:<id>` latest-value channel.
- Broadcast update envelopes, not whole document values.
- Treat each tab as a separate replica unless the stored metadata says otherwise.
- Deduplicate received updates through the shared CRDT engine and local seen-update store.
- Add conflict tests where two tabs mutate the same document concurrently.

Acceptance criteria:

- Two same-origin facades converge after independent local updates.
- Whole-value overwrite never happens during tab sync.
- A tab reload can catch up from local persistence and later BroadcastChannel updates.

## Iteration 6: Live Transport Over Existing Rallar Messages

Goal: Exchange CRDT updates over the existing Rallar message layer.

Likely files:

- `packages/shared-web/browser/rallar-crdt-transport.ts`
- `packages/shared-web/browser/rallar-crdt.ts`
- `packages/tests/shared-web/rallar-crdt-transport.test.ts`

Transport plan:

- WS for server-routed app and room fanout.
- RTC app-level messages for low-latency room peers.
- Realtime data channel only for optional previews or transient cursor-like state, not authoritative CRDT updates.

Work:

- Use user topics such as `room.crdt` and `app.crdt` because the server reserves `rallar.*`.
- Use CRDT type IDs from Iteration 1.
- Add transport strategies:
  - `local-only`
  - `ws`
  - `rtc`
  - `ws-then-rtc`
  - `rtc-with-ws-fallback`
- For room-scoped docs, require `roomRef` where available.
- Use AL message IDs for transport dedupe and CRDT `updateId` for document-level dedupe.
- Use `rallar.messages.ws.onMessage(...)` and `rallar.messages.rtc.onMessage(...)` internally.
- Add status and diagnostics for queued, sent, received, duplicate, merged, rejected, and failed updates.

Acceptance criteria:

- Two browser facades in one room converge over mocked WS.
- Two browser facades in one room converge over mocked RTC.
- Duplicate AL deliveries do not duplicate CRDT updates.
- Closed RTC lanes fall back to WS when configured.

## Iteration 7: Catch-Up And Reconnect Contract

Goal: Define and implement browser-side catch-up behavior, even before durable server support is complete.

Likely files:

- `packages/shared/crdt/crdt-sync-contracts.ts`
- `packages/shared-web/browser/rallar-crdt-sync.ts`
- `packages/tests/shared-web/rallar-crdt-sync.test.ts`
- `docs/rallar-api-reference.md`
- `docs/rallar-troubleshooting-checklist.md`

Work:

- Add sync request/response envelopes:
  - document ref
  - known snapshot version
  - known update IDs or clock summary
  - max update count
  - optional peer/server preference
- Browser behavior:
  - on open, load local snapshot and pending updates
  - subscribe to live messages
  - request missing updates
  - apply sync responses
  - re-send unacknowledged local updates
- Provide a peer-to-peer catch-up path for development.
- Document that robust late-join/reconnect still requires a durable server log.

Acceptance criteria:

- A browser that misses live updates can catch up from another browser in tests.
- Sync responses dedupe already-seen updates.
- Pending local updates are retried after reconnect.
- Docs clearly mark peer catch-up as insufficient for production durability.

## Iteration 8: Shared Graph CRDT Spike

Goal: Prove how CRDT documents should interact with `packages/shared-graph`.

Likely files:

- `packages/shared-graph/crdt/shared-graph-document.ts`
- `packages/shared-graph/crdt/shared-graph-to-graphology.ts`
- `packages/tests/shared-graph/shared-graph-crdt.test.ts`

Important boundary:

`GraphInfoSnapshot` and graph repositories are derived caches. They should not become CRDT storage. A graph CRDT should
store collaborative observations such as nodes, edges, labels, annotations, and layout hints, then derive graphology
graphs or `GraphInfoSnapshot` inputs.

Work:

- Define a `SharedGraphDocument` CRDT schema:
  - OR-set of nodes
  - OR-set of edges
  - map of node labels/annotations
  - map of edge labels/annotations
  - optional layout hints
- Add adapters to produce graphology `WeightedGraph` values.
- Add tests where independent clients add nodes/edges and converge.
- Check how `GroupRef` should scope graph documents.
- Document what remains computed by existing graph services: Vivaldi, core-node selection, tree/mesh construction, and
  overlay routing.

Acceptance criteria:

- Concurrent graph node/edge additions converge.
- Concurrent label conflicts are either LWW by configured policy or multi-value surfaced to caller.
- Derived graph output is deterministic for a given CRDT state.
- Existing graph repositories remain latest-snapshot caches.

## Iteration 9: Server Durable Log Contract

Goal: Prepare the required durable catch-up layer without forcing it into the browser work too early.

This iteration depends on bringing `packages/shared-server` into scope. It is listed here because `RALLAR_CRDT.md`
correctly says robust CRDT sync needs a durable server source of truth.

Likely contract files:

- `packages/shared/crdt/crdt-server-contracts.ts`
- `docs/rallar-api-reference.md`
- a future server implementation plan under `iterations/`

Contract shape:

- append update
- append update batch
- read latest snapshot
- list updates after cursor/clock
- compact document
- authorize read/write by document ref

Work:

- Define HTTP/WS contracts for document update append and catch-up.
- Define server-side idempotency rules by update ID.
- Define server snapshot and update-log retention rules.
- Define authorization hooks for app, principal, room, and custom scopes.
- Define how server fanout relates to `room.crdt` and `app.crdt` topics.

Acceptance criteria:

- Browser sync code has a clear server target contract.
- The contract is compatible with existing room/application/workspace scope patterns.
- The contract can be implemented later without changing browser update envelopes.

## Iteration 10: Server Durable Log Implementation

Goal: Add production-grade late-join and reconnect support.

This is intentionally after the browser and shared contracts because it is storage-heavy and should not block local or
peer-to-peer proof.

Likely future files:

- shared-server CRDT repository interfaces
- Postgres adapter for CRDT update log and snapshots
- route installers or WS topic handlers
- server facade extension such as `server.crdt.defineDocument(...)`

Work:

- Persist update envelopes append-only with unique `(documentKey, updateId)`.
- Persist compact snapshots and update cursors.
- Enforce authorization before append and catch-up.
- Broadcast accepted updates over WS.
- Add compaction by update count or age.
- Add backpressure and max payload limits.

Acceptance criteria:

- A newly joined browser can load server snapshot plus missing updates.
- A reconnecting browser can catch up without another peer online.
- Duplicate update appends are idempotent.
- Unauthorized document updates are rejected and never fanned out.

## Iteration 11: Product Docs And Examples

Goal: Make CRDT support understandable as a product feature.

Likely files:

- `docs/rallar-crdt-guide.md`
- `docs/rallar-api-reference.md`
- `docs/rallar-quickstart-and-recipes.md`
- `docs/rallar-troubleshooting-checklist.md`

Work:

- Add a CRDT concepts page:
  - document
  - replica
  - actor
  - update
  - snapshot
  - tombstone
  - compaction
  - catch-up
- Add examples:
  - collaborative room board
  - shared checklist
  - offline structured report
  - graph annotations
- Add "when not to use CRDT" guidance:
  - auth
  - permissions
  - billing
  - authoritative membership
  - server-owned presence expiry
- Add a decision table:
  - `rallar.data`
  - `rallar.crdt`
  - `rallar.messages.ws`
  - `rallar.messages.rtc`
  - `rallar.realtime`
  - REST/server commands

Acceptance criteria:

- A developer can choose between latest-value local storage, command-based server state, and CRDT documents.
- Docs explain why `rallar.data` is still useful.
- Docs explain what guarantees require server durable log support.

## Iteration 12: Hardening, Observability, And Black-Box Coverage

Goal: Treat CRDT as a realtime product surface, not only a local data structure.

Likely future files:

- CRDT diagnostics in shared-web
- black-box runner recipes and Rallar Black Box UI support
- tests for live browser convergence

Work:

- Add CRDT health snapshots:
  - local replica ID
  - document version/clock
  - pending update count
  - seen update count
  - last remote update time
  - last sync status
  - compaction status
- Emit redacted diagnostics for update rejection, schema mismatch, oversized update, failed persistence, failed send,
  stale sync response, and authorization failure.
- Add black-box recipes for two-browser convergence, offline/reconnect catch-up, duplicate delivery, and conflict
  surfacing.
- Add size and rate limits to protect RTC/WS traffic.

Acceptance criteria:

- CRDT failures are inspectable without reading raw IndexedDB or AL internals.
- Automated tests cover convergence, duplicate delivery, reconnect, and conflict behavior.
- Operators can distinguish local persistence failure from transport failure from server rejection.

## Recommended Order

1. Iteration 0: Baseline Contract And Non-Regression Tests
2. Iteration 1: Shared CRDT Core Contracts
3. Iteration 2: Deterministic CRDT Engine V1
4. Iteration 3: Browser Local CRDT Store Adapter
5. Iteration 4: Browser CRDT Facade, Local-Only
6. Iteration 5: Same-Origin Multi-Tab CRDT Sync
7. Iteration 6: Live Transport Over Existing Rallar Messages
8. Iteration 7: Catch-Up And Reconnect Contract
9. Iteration 8: Shared Graph CRDT Spike
10. Iteration 9: Server Durable Log Contract
11. Iteration 10: Server Durable Log Implementation
12. Iteration 11: Product Docs And Examples
13. Iteration 12: Hardening, Observability, And Black-Box Coverage

## Open Decisions

- Whether V1 should use an existing CRDT library internally or a small Rallar-owned core. Do this as an implementation
  spike before Iteration 2, but keep the Rallar envelope and facade contracts library-neutral.
- Whether the public mutation API should be operation-first forever, or grow a draft-based `change(...)` helper.
- Whether CRDT document type IDs should be fully user-defined or constrained to registered document definitions.
- How much peer-to-peer catch-up should be supported before server durable logs exist.
- How tombstone compaction should prove safety when some replicas may be offline for a long time.
- Whether graph CRDTs are a first product feature or only a validation spike.

## First Useful Slice

The first valuable deliverable is not network sync. It is a deterministic shared CRDT core plus a local browser facade
that persists through `rallar.data`.

That slice proves the product boundary, protects existing Rallar Data semantics, gives UI code a real API, and creates a
stable update envelope that later WS, RTC, server log, graph, and black-box work can all share.
