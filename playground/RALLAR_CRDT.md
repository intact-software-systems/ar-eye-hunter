# Rallar CRDT Support

This note analyses whether `rallar.ts` should expose conflict-free replicated
data types through `rallar-data.ts`.

The short version: Rallar should support CRDT-style application data, but it
should not make the existing `rallar.data.open(...)` key/value store behave like
a CRDT by default. The current data API is a local durable latest-value store.
CRDT support should be an explicit layer on top of it, with its own merge,
transport, snapshot, and server-log semantics.

## Current Boundary

The browser facade already exposes:

- `rallar.data` from `packages/shared-web/browser/rallar-data.ts`
- typed application messages over WebSocket and RTC through `rallar.messages`
- realtime room-oriented transport helpers through `rallar.realtime`
- auth-aware data scopes such as `app`, `principal`, and `session`

`rallar.data` is useful for app-owned local storage. It provides memory caching,
IndexedDB persistence, schema migration, TTL, validation, write-through and
write-behind durability, and same-origin tab sync through `BroadcastChannel`.

That is not the same as a CRDT. The current store model writes a whole value for
a key:

```ts
const notes = await rallar.data.open<Note>('notes');

await notes.set('room-1', {
    title: 'Plan',
    body: 'Initial text',
});
```

Cross-tab synchronization applies remote `set`, `delete`, and `clear` events to
other open tabs. It does not preserve operation identity, actor identity,
causal ordering, tombstones, per-field merges, or a durable update log.

The server-side app-data facade is also latest-value oriented. It persists rows
to `app_data_store` and increments a `revision`, but that revision is not
currently a distributed merge primitive. There is also no automatic browser
subscription path such as "replay CRDT updates since update N".

## Why Not Make `rallar.data` A CRDT Store

Changing `rallar.data.open(...)` into a CRDT-backed API by default would blur an
important boundary.

`rallar.data` currently answers a simple question: what is the latest local
value for this key? That model is useful for caches, drafts, local preferences,
snapshots, and single-writer app data. CRDTs answer a different question: how do
we merge independently produced operations from several actors without a central
lock?

CRDT support needs additional concepts that should be visible in the API:

- stable actor or replica IDs
- operation or update IDs for deduplication
- causal metadata or version vectors
- merge functions tied to the data type
- delete/tombstone behavior and compaction
- snapshot plus update-log persistence
- authorization boundaries for which peers may read or write a document
- transport rules for RTC, WebSocket, reconnect, and offline replay

Adding those concepts invisibly to all `rallar.data` stores would make simple
storage more complicated and could create surprising behavior for callers that
expect normal `set`, `get`, `update`, and `delete` semantics.

## Recommended Shape

Keep `rallar.data` as the local durable storage and cache layer.

Add an opt-in CRDT layer beside it:

```ts
const board = await rallar.crdt.open<RoomBoardDocument>('room-board', {
    scope: `room:${roomId}`,
    transport: 'rtc-or-ws',
    persist: true,
});
```

An alternative is to keep the surface under `rallar.data`, but still make the
mode explicit:

```ts
const board = await rallar.data.openCrdt<RoomBoardDocument>('room-board', {
    scope: `room:${roomId}`,
    transport: 'rtc-or-ws',
});
```

The important part is that CRDT behavior is opt-in and explicit. The underlying
implementation can still reuse `rallar.data` for local snapshots and pending
updates.

## Proposed Responsibilities

### Browser CRDT Facade

The browser layer should own:

- opening a document in a scope
- assigning the local replica ID
- applying local transactions
- emitting compact updates to peers or the server
- receiving and deduplicating remote updates
- persisting snapshots and unacknowledged updates through `rallar.data`
- exposing subscriptions so UI state can react to merged changes

Example:

```ts
const doc = await rallar.crdt.open<SharedChecklist>('checklist', {
    scope: `room:${roomId}`,
    storeName: 'room-checklists',
});

const unsubscribe = doc.subscribe((value) => {
    renderChecklist(value);
});

await doc.change((draft) => {
    draft.items.add({
        id: crypto.randomUUID(),
        text: 'Check north entrance',
        done: false,
    });
});

unsubscribe();
```

### Local Storage

`rallar.data` should store implementation artifacts, not expose them as normal
latest-value app state:

- compact snapshots
- pending local updates
- seen update IDs
- actor metadata
- document clock metadata

Example storage layout:

```ts
await rallar.data.open<CrdtSnapshot>('crdt:snapshots', {
    scope: `room:${roomId}`,
});

await rallar.data.open<CrdtPendingUpdate>('crdt:pending-updates', {
    scope: `room:${roomId}`,
});
```

### Transport

Rallar already has useful primitives for CRDT update exchange:

- WebSocket is appropriate for server-routed durable fanout.
- RTC is appropriate for low-latency peer-to-peer room updates.
- `rallar.realtime` can decide which lane is available for a room.
- reconnect handling should ask the server for missing updates.

The CRDT layer should treat live peer messages as an optimization. A reconnecting
or newly joined client still needs a durable source of truth: either a server
snapshot, an update log, or both.

### Server Support

The current `app_data_store` table is not enough by itself for robust CRDT sync
because it stores the latest value for a key. CRDT sync needs either:

- an append-only update log plus periodic snapshots
- a snapshot row plus a separate durable update-log table
- a server-managed document repository that owns both of the above

A useful server shape could be:

```ts
server.crdt.defineDocument({
    documentType: 'room-board',
    scope: 'room',
    authorizeRead: isRoomMember,
    authorizeWrite: canEditRoomBoard,
});
```

The server should enforce authorization, persist updates, deduplicate updates by
ID, provide catch-up after reconnect, and optionally compact old updates into
snapshots.

## Beneficial Use Cases

### Collaborative Room Board

Several clients can draw markers, place annotations, or maintain a lightweight
plan for a room. With normal latest-value storage, two users editing at the same
time can overwrite each other. With a CRDT, independent additions merge.

```ts
const board = await rallar.crdt.open<RoomBoard>('room-board', {
    scope: `room:${roomId}`,
    transport: 'rtc-or-ws',
});

await board.change((draft) => {
    draft.markers.add({
        markerId: crypto.randomUUID(),
        x: 0.42,
        y: 0.61,
        label: 'Inspect here',
        createdBy: rallar.clientId,
    });
});
```

Benefit: two users can add different markers while offline or on different RTC
paths, and both markers survive when updates are exchanged.

### Shared Checklist Or Task List

A room can maintain a checklist of actions such as "scan object", "confirm
route", or "review capture". One user can add an item while another marks a
different item done. The merged document preserves both changes.

```ts
const checklist = await rallar.crdt.open<SharedChecklist>('room-checklist', {
    scope: `room:${roomId}`,
});

await checklist.change((draft) => {
    draft.items.get(itemId).done = true;
});
```

Benefit: the UI can stay responsive offline and synchronize later without
forcing the application to reject one user's change.

### Offline Drafts With Field-Level Merging

A user may edit a structured report on a phone while another device updates a
different field. Latest-value writes would make this fragile because the whole
record is replaced. A CRDT map can merge independent field changes.

```ts
const report = await rallar.crdt.open<InspectionReport>('report', {
    scope: `principal:${principalId}`,
});

await report.change((draft) => {
    draft.fields.summary = 'Object looks intact';
});
```

Benefit: changes to `summary`, `status`, and `attachments` can be merged without
requiring a central lock. If two actors edit the same field, the application can
surface an explicit conflict or apply a known register policy for that field.

### Realtime Presence Annotations

Presence itself is usually ephemeral and server-owned, but user annotations on
presence can benefit from CRDT semantics. For example, room participants may add
temporary tags or notes to visible peers.

```ts
const annotations = await rallar.crdt.open<PresenceAnnotations>(
    'presence-annotations',
    { scope: `room:${roomId}` },
);

await annotations.change((draft) => {
    draft.peerNotes.set(peerId, {
        text: 'Handling camera feed',
        updatedBy: rallar.clientId,
    });
});
```

Benefit: low-latency peer updates can flow over RTC while the server still keeps
a catch-up log for users who join later.

### Shared Graph Editing

Rallar already has graph-oriented domain concepts. A CRDT layer could support
collaborative graph editing where clients add observations, edges, labels, or
layout hints independently.

```ts
const graphDoc = await rallar.crdt.open<SharedGraph>('room-graph', {
    scope: `room:${roomId}`,
});

await graphDoc.change((draft) => {
    draft.nodes.add({ id: nodeId, label: 'Entrance' });
    draft.edges.add({ from: nodeId, to: otherNodeId, kind: 'visible-from' });
});
```

Benefit: observations from several clients can converge into one graph without
serializing every edit through a single active writer.

## Cases That Should Stay Non-CRDT

Some data should remain authoritative and command-based:

- authentication state
- session ownership
- permissions
- billing or quota decisions
- security-sensitive group membership decisions
- server-owned presence expiry

These domains need explicit server validation and clear ordering. A CRDT can be
useful for user-authored annotations around those domains, but not for the
authoritative state transition itself.

## Implementation Notes

A first implementation should be narrow:

1. Add an explicit browser CRDT facade.
2. Support one document type or a small family of built-in merge types.
3. Persist local snapshots and pending updates through `rallar.data`.
4. Exchange live updates over the existing message layer.
5. Add server update-log and snapshot storage for reconnect and late join.
6. Keep authorization on the server.
7. Add compaction after the update log reaches a configured size or age.

This keeps the existing `rallar.data` contract stable while allowing Rallar to
support genuinely collaborative, offline-capable application data where it is
worth the extra model complexity.
