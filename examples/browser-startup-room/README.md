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
    RallarRoomEntry,
    toRoomEntryUrl
} from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import { RallarRecentRooms } from '@shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts';

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
import { RallarRoomDirectory } from '@shared-web/browser/rooms/directory/rallar-room-directory.ts';

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

## Display a live poll deadline

Read the closing instant from the poll's current room record, including after
rejoin. Each render can compare that same instant with the connected client's
current server-time estimate. Each comparison is local. On a healthy connection the SDK
reads server time once over HTTP during startup, then measures a round trip on the
existing WebSocket about every 20 seconds. It accounts for elapsed time, drift and
round-trip uncertainty between observations. A slow or missed reply can leave the
previous sample usable until its 30-second validity budget expires. When that
budget expires, deadline comparisons return `unavailable`. Presence and message
expiry use the same clock bounds.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

function pollStatus(poll: { closesAtEpochMs: number }): string {
    switch (rallar.compareDeadline(poll.closesAtEpochMs)) {
        case 'before': return 'Voting open';
        case 'overlaps': return 'Voting is closing';
        case 'at-or-after': return 'Voting closed';
        case 'unavailable': return 'Waiting for server time';
    }
}
```

At the exact cutoff, a window entirely at or beyond the closing instant is
closed. A window that includes time on both sides of the cutoff, or just
reaches it from below, displays “Voting is closing.” Compare again when the
view refreshes. The poll authority checks the closing instant when it receives
a vote and returns the result to the participant. A vote sent while the view
showed “Voting open” can still arrive late.

Run the [two-browser room poll](../shared-deadline-poll/README.md) to see an
in-time vote count and a delayed vote arrive after closure.

A room authority that grants a minimum grace period can call
`rallar.deadlineAfter(10_000)` once when the absence begins and save the
returned epoch in its checkpoint. An unavailable clock returns `undefined`.
A successor compares the stored deadline with `rallar.compareDeadline`.
Using the latest plausible server time at creation gives the participant the
full grace period even when the creation window has nonzero width.

## Check the clock difference between API nodes

When one node provides the time sample and another enforces the deadline, run
this probe from the repository root. Supply direct origins for the two known
nodes and their configured server peer IDs. A cluster can share a peer ID.
Distinct origins alone cannot establish that they route to different machines.

```sh
bun run examples/browser-startup-room/check-node-clock-offset.ts \
  https://api-a.example.org cluster-peer https://api-b.example.org cluster-peer 25
```

The last argument is the deployment's allowed absolute difference in
milliseconds. The example value of 25 is illustrative. The probe takes two
uncached samples and projects both to the same local monotonic instant.
Positive offsets mean the enforcement node is ahead. The reported minimum
and maximum include network travel and measurement uncertainty. The probe
assumes relative clock drift at most 1,000 ppm, local monotonic measurement
error at most 2 ms, round trips within 500 ms and samples at most 2 seconds old.

Exit 0 means the entire interval fits the budget. Exit 1 means the interval
is outside the budget or straddles its boundary (inconclusive). Exit 2 means
the input or measurement was unusable. Repeat measurements from representative
paths and under load. A passing sample describes that instant only.

If your deployment maintains an absolute offset bound between the sampled node
and the deadline authority throughout the operation, supply it to both SDK
calls. For example, with a maintained 25 ms bound:

```ts
const authority = { maxAuthorityOffsetMs: 25 };
const closesAt = rallar.deadlineAfter(10_000, authority);
if (closesAt !== undefined) {
    const phase = rallar.compareDeadline(closesAt, authority);
    // Reuse the stored closesAt when checking again or on another participant.
}
```

With a sampled window of [90, 100] ms and an offset bound of 5 ms, the
authority could be at [85, 105] ms. A cutoff of 105 overlaps that window,
and creating a ten-millisecond grace period yields 115. Omitting the bound
uses zero. If the deployment loses its offset guarantee, suspend cross-node
deadline decisions until the guarantee is restored. The probe supplies
measurement evidence at a point in time.


To collect deployment evidence, append a sample count and an interval in
milliseconds. For example, append `60 5000` to take 60 pairs with a five-second
pause after each completed pair. Run during a representative workload on the
two named nodes. Save stdout as JSON Lines. Each row records its UTC start
time, elapsed time and verdict. Successful observations also include both
round-trip times, sample ages and the signed offset interval and width.
Unavailable observations remain in the series. The exit code is 2 if any
observation was unavailable, otherwise 1 if any was outside or inconclusive,
otherwise 0. This measures the probe's requests; browser startup and refresh
traffic must be measured on the actual browser connection.

### Qualify a lobby seat deadline under load

Use the [seat deadline proof](../../packages/shared-test/black-box-runner/cluster-proofs/api-v1-seat-deadline-proof.mts)
on a disposable installation before making a cross-host fairness claim. The two
API processes share a migrated PostgreSQL database and use different
`RALLAR_SERVER_CLOCK_PEER_ID` values. Use direct HTTPS origins for remote APIs.
Loopback HTTP is supported for disposable local runs. Disable
`RALLAR_API_QUEUE_WORKERS` on the claim node and every other replica except the
expiry node. Enable the workers on that expiry node. Enable PostgreSQL pub/sub
for account-view invalidations. Record each node's VM or machine identity,
the worker configuration, the maintained offset budget and the workload the
deployment intends to support. Distinct URLs and peer IDs alone establish
which API answered. Physical host independence requires deployment evidence.

The fixture needs three distinct test accounts and a controller for the
disposable expiry process. Supply `SEAT_PROOF_OWNER_USERNAME` and
`SEAT_PROOF_OWNER_PASSWORD`, with corresponding `PLAYER` and `NEXT` pairs.
Set `SEAT_PROOF_WORKER_CONTROL` to an absolute executable path. It receives
one argument, either `stop` or `start`. Stop must return after the expiry
process stops responding. Start must return after its replacement serves the
same pinned clock identity. Start must also succeed when the worker is already running,
because cleanup runs after a partial or unacknowledged stop. The claim process and shared database stay
available through the interruption.

From the repository root, run the following command with your direct origins,
pinned clock identities and millisecond budget. Save stdout alongside the
topology record. Budget 25 below is illustrative.

```sh
bun run packages/shared-test/black-box-runner/cluster-proofs/api-v1-seat-deadline-proof.mts \
  --direct "$CLAIM_ORIGIN" "$CLAIM_CLOCK_ID" "$EXPIRY_ORIGIN" "$EXPIRY_CLOCK_ID" 25 \
  > seat-deadline.jsonl
```

Each case creates a fresh workspace and a one-place room, offers the place
to one queued player, and leaves another waiting. Authenticated sockets on
both nodes exchange clock frames with 50 ms between completed exchanges.
The restart case keeps the claim socket loaded across the expiry-node outage.
The load records give the actual exchanges and elapsed times. This models
connected timing traffic and a contested seat in one room. Compare those
conditions with the deployment's traffic before drawing conclusions.

The first two cases aim 750 ms before and 100 ms after the five-second offer
deadline. A claim-node time reading before dispatch and another after the
response bound the real presence mutation. Both nodes must return the same
private seats for both players after expiry. A third case holds the exact
offer's PostgreSQL deadline row across the cutoff. Supply
`SEAT_PROOF_DATABASE_URL` through the operator environment for a trusted
connection to the same disposable database with row-lock privileges on
`resource_inbox`. The claim API captures ingress and returns the AppInbox
result. The enabled worker executes the command while the independent expiry
wake is held. The proof checks the original stored offer and waiting successor
immediately before the late claim, then verifies refusal and releases the
row. A separate restart case takes the
worker down across the deadline, verifies that the original offer is still
committed, and observes promotion after restart before sending the late
claim. The observer reads on startup and on scoped account invalidations.
The qualification does not change the application's network cadence.

Each `offset` row records a point measurement with its interval and budget.
A straddling interval is inconclusive. Missing observations and intervals
outside budget also leave the clock unqualified. An interval is evidence
only for its sampled instant. The `claim`, `overdue-offer-refused`, `worker-recovery` and
`allocation` rows give the independent seat outcomes. A completed allocation
proof with an unqualified clock prints both results and exits nonzero.
An unexpected allocation, unusable identity or claim that missed its
target side of the deadline fails the run.

`npm run test:api-v1:black-box:postgres:seat-deadline` runs the same cases
in the release gate on disposable local API processes and a fresh database.
Its 100 ms budget and one-host results qualify the fixture only.
