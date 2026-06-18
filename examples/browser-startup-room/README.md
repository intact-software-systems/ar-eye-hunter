# Browser Startup And Room

This example shows the normal browser boot path: set up Rallar, restore or log
in, create a room with a deterministic RallarAI-style display name, switch to
it, and subscribe to state.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';
import {
    createRallarAiFunnyRoomName,
    createRallarAiRoomNameSeed,
} from '@shared/rallar-ai/mod.ts';

const started = await rallar.setup({
    apiBaseUrl: 'http://localhost:8080',
    applicationId: 'demo-game',
    workspaceId: 'default',
    realtime: { laneId: 'realtime', openTimeoutMs: 1000 },
    rtc: { waitTimeoutMs: 1000, connectOnWait: true },
    start: {
        refreshPeople: true,
    },
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
    theme: 'ar-eye-hunter',
    seed: createRallarAiRoomNameSeed('demo-arena'),
    existingNames,
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
