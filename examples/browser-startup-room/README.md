# Browser Startup And Room

This example shows the normal browser boot path: configure Rallar, restore or
log in, create a room with a deterministic RallarAI-style display name, join it,
and subscribe to state.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';
import {
    createRallarAiFunnyRoomName,
    createRallarAiRoomNameSeed,
} from '@shared/rallar-ai/mod.ts';

rallar.configure({ apiBaseUrl: 'http://localhost:8080' });
rallar.setDefaults({
    applicationId: 'demo-game',
    workspaceId: 'default',
    realtime: { laneId: 'realtime', openTimeoutMs: 1000 },
    rtc: { waitTimeoutMs: 1000, connectOnWait: true },
});

const started = await rallar.start({
    restoreSession: true,
    connect: true,
    refreshRooms: true,
    refreshPeople: true,
});

if (!started.session) {
    await rallar.auth.login({ username: 'alice', password: 'secret' });
    await rallar.start({ connect: true, refreshRooms: true, refreshPeople: true });
}

const existingNames = rallar.rooms
    .state()
    .rooms.map((room) => room.displayName)
    .filter((name): name is string => Boolean(name));

const displayName = createRallarAiFunnyRoomName({
    baseName: 'Demo Arena',
    theme: 'ar-eye-hunter',
    seed: createRallarAiRoomNameSeed('demo-arena'),
    existingNames,
});

const room = await rallar.rooms.create({ displayName });
await rallar.rooms.join(room.group);
rallar.setDefaults({ room: { roomRef: room.group } });

const subscriptions = rallar.subscriptions();
subscriptions.add(rallar.rooms.onChange((state) => renderRooms(state.rooms)));
subscriptions.add(rallar.people.onChange((state) => renderPeople(state.people)));
subscriptions.add(rallar.ws.onLifecycle((event) => renderWs(event.status)));

// Component cleanup.
subscriptions.unsubscribe();
```

Prefer `roomRef` after room creation when multiple applications or workspaces
can contain the same `groupId`.

