# Browser Startup And Room

This example shows the normal browser boot path: set up Rallar, restore or log
in, create a room with a deterministic RallarAI-style display name, switch to
it, and subscribe to state.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';
import { createRallarAiFunnyRoomName, createRallarAiRoomNameSeed } from '@shared/rallar-ai/mod.ts';

const started = await rallar.setup({
    apiBaseUrl: 'http://localhost:8080',
    applicationId: 'demo-game',
    workspaceId: 'default',
    realtime: { laneId: 'realtime', openTimeoutMs: 1000 },
    rtc: { waitTimeoutMs: 1000, connectOnWait: true },
    start: {
        refreshPeople: true
    }
});

if (!started.session) {
    await rallar.auth.login({ username: 'alice', password: 'secret' });
    await rallar.start({ connect: true, refreshRooms: true, refreshPeople: true });
}

const existingNames = rallar.rooms
    .state()
    .rooms.map((room) => room.name)
    .filter((name): name is string => Boolean(name));

const displayName = createRallarAiFunnyRoomName({
    baseName: 'Demo Arena',
    theme: {
        id: 'demo-arena',
        defaultBaseName: 'Demo Arena',
        nouns: ['Beacon', 'Comet', 'Kite']
    },
    seed: createRallarAiRoomNameSeed('demo-arena'),
    existingNames
});

const created = await rallar.rooms.createAndSwitch({ displayName });
const room = rallar.rooms.session(created.group);

const subscriptions = rallar.subscriptions();
subscriptions.add(rallar.rooms.onChange((state) => renderRooms(state.rooms)));
subscriptions.add(rallar.people.onChange((state) => renderPeople(state.people)));
subscriptions.add(rallar.ws.onLifecycle((event) => renderWs(event.status)));

// Component cleanup.
subscriptions.unsubscribe();
```

`rooms.createAndSwitch(...)` leaves the previous current room after creating the
new one. `rooms.session(...)` returns a room-bound handle. Use that handle for
`room.message(...)` and `room.realtime(...)` so app code does not need to pass
`roomRef` on every send.

To enter an existing open room, expose a separate Quick Join action:

```ts
const result = await rallar.rooms.quickJoin({ kind: 'room', q: 'demo arena' });
if (result.status === 'joined') {
    const room = rallar.rooms.session(result.snapshot.group);
    renderCurrentRoom(room);
}
else {
    showMessage('No available room. Try again or create one.');
}
```

Quick Join excludes empty rooms by default; pass `includeEmpty: true` to include them.
The server ranks eligible rooms by distinct online members, then room ID, and applies
normal admission and capacity rules. It creates no room or pending approval request.
An unavailable result preserves the current room. A joined result connects presence,
switches the current room, and leaves the previous room unless `leaveCurrent: false`.
Room membership does not enlist a player in an application-owned match or expedition.

If admission succeeded but presence or adoption failed, `RallarQuickJoinPartialFailureError`
exposes `joinedRoom` and the original `cause`. A failure to leave the previous room uses
`RallarRoomSwitchPartialFailureError` with `operation: 'quick-join'`, and the new room
stays current. Recover that room explicitly instead of automatically selecting another.

For private links or a saved destination, capture entry before startup. This is an
alternative to unconditional room creation above; a pending invitation takes priority.

```ts
import {
    RallarRecentRooms,
    RallarRoomEntry,
    toRoomEntryUrl
} from '@shared-web/browser/rallar-room-entry.ts';

const scope = { applicationId: 'demo-game', workspaceId: 'default' };
rallar.configure({ apiBaseUrl: 'http://localhost:8080', ...scope });
const entry = RallarRoomEntry.createBrowser(rallar, { scope });
const recentRooms = RallarRecentRooms.createBrowser(rallar, entry, { scope });
const unsubscribe = entry.onChange(renderRoomEntry);
const unsubscribeHistory = recentRooms.onChange(renderRecentRooms);
entry.start();
await recentRooms.start();

// Keep the entry owner alive while the application displays its sign-in form.
// After restoring a session or completing sign-in:
await rallar.start({ connect: true, refreshRooms: entry.getState().status === 'idle' });
await entry.resume();

// Manual entry uses a complete scoped reference and the same lifecycle.
entry.enter({ roomRef: { ...scope, groupId: 'shared-room' }, joinCode: 'HOST-CODE' });
await entry.resume();

// A host shares the authoritative code and expiry returned by rotation.
const rotated = await rallar.rooms.rotateJoinCode({ ...scope, groupId: 'shared-room' });
const link = toRoomEntryUrl(window.location.href, {
    roomRef: rotated.snapshot.group,
    joinCode: rotated.joinCode
});
link.fold(showEntryError, (url) => renderShareLink(url, rotated.expiresAtEpochMs));

// Component cleanup.
unsubscribe();
unsubscribeHistory();
await recentRooms.stop();
entry.stop();
```

Render `entry.getState()` with correction, retry (`resume`), and cancel (`cancel`)
controls. A fresh link replaces the saved destination. Successful admission removes
the code from tab storage and binds the saved room to the principal. Authentication,
cancellation, and destination changes fence late completions. An invite-only link
uses `joinCode: null`; the host must first invite the guest's account reference.
Room entry does not enroll that account in application-owned gameplay.

History is optional navigation and never selects a room during hydration. Render its loading,
empty, and failed states; `recentRooms.retry()` retries local storage without repeating admission.
For a user-selected visit, pass its full `roomRef` and the displayed history's `principalId` to
`entry.returnTo(roomRef, principalId)`. Display the returned `left` failure, or call `entry.resume()`
after success when the connection is ready. The selection is bound to that account and rechecks
current server admission without a saved code. `recentRooms.forget(roomRef, principalId)` removes
only the shortcut. The ten newest distinct references and visit timestamps are stored through
Rallar Data per account and application/workspace; no credentials or availability claims are saved.

An unlisted open room uses the same entry owner and a link without a code:

```ts
const hidden = await rallar.rooms.createAndSwitch({
    displayName: 'Friends Arena',
    joinMode: 'open',
    directoryListing: 'unlisted'
});
toRoomEntryUrl(window.location.href, { roomRef: hidden.group, joinCode: null })
    .fold(showEntryError, renderShareLink);

// Only the listing intent changes; concurrent metadata remains server-owned.
await rallar.rooms.update({ roomRef: hidden.group, directoryListing: 'listed' });
await rallar.rooms.update({ roomRef: hidden.group, directoryListing: 'unlisted' });
```

Anyone with the link can request entry to an unlisted open room. Hiding removes it from the next
directory read and Quick Join selection, while existing members and application participants remain.
Use code-protected or invite-only admission when a link alone should not be sufficient.

To keep public discovery fresh without switching the current room, use the optional directory owner:

```ts
import { RallarRoomDirectory } from '@shared-web/browser/rallar-room-directory.ts';

const directory = RallarRoomDirectory.createBrowser(rallar, {
    scope: { applicationId: 'demo-game', workspaceId: 'default' },
    request: {
        kind: 'room',
        q: 'demo arena',
        limit: 50,
        includeEmpty: false,
        order: 'online-members'
    },
    refreshIntervalMs: 30_000,
    timeoutMs: 10_000,
    maxAttempts: 1
});
const unsubscribeDirectory = directory.onChange(renderPublicRooms);
await directory.start();

// An explicit Refresh action also resets the automatic interval.
await directory.refresh();

// Component cleanup.
unsubscribeDirectory();
directory.stop();
```

The owner reads all pages, deduplicates scoped references, and publishes complete results. Render
`loading`, `ready`, and `error` distinctly; an error retains the last complete entries. Automatic
reads pause when hidden or offline and resume immediately on return. Authentication and query
changes fence late results; use `changeRequest` to replace the complete query. Discovery never joins
or adopts a room. Scope, cadence, and per-request bounds are explicit application policy.
