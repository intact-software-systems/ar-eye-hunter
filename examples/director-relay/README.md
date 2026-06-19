# Director Relay

Use director relay when a room has one elected browser director/host and other
peers need to send low-rate intents to it. The relay blocks stale appointments
and falls back through typed message paths when direct RTC delivery is not
available.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

type MoveIntent = {
    seq: number;
    direction: 'left' | 'right' | 'up' | 'down';
};

type DirectorOutput = {
    acceptedSeq: number;
    x: number;
    y: number;
};

if (shouldBecomeDirector()) {
    await rallar.director.appoint(currentRoom.group, {
        heartbeatTtlMs: 4_000,
    });
}

const relay = rallar.director.createRelay<MoveIntent, DirectorOutput>({
    roomRef: currentRoom.group,
    laneId: 'director',
    topicId: 'demo.director',
    intentTypeId: 'demo.intent',
    outputTypeId: 'demo.output',
    readSnapshot: () => readCurrentDirectorSnapshot(),
    onIntent: async (message) => {
        if (!rallar.director.status(currentRoom.group).isDirector) {
            return;
        }

        return simulateIntent(message.senderId, message.data);
    },
    onOutput: async (message) => {
        applyDirectorOutput(message.data);
    },
    onSnapshot: async (message) => {
        reconcileFromDirectorSnapshot(message.data);
    },
});

if (!relay.status().isDirector) {
    const sent = await relay.sendIntent({
        seq: nextInputSeq(),
        direction: 'left',
    });

    if (sent.status === 'stale-director' || sent.status === 'no-director') {
        showReconnectingDirectorState(sent.reason);
    }
}

relay.stop();
```

Director relay is for low-rate authority messages. Use
`rallar.realtime.room<T>(...)` for high-rate input/snapshot traffic.

`rallar.director.appoint(...)` uses the dedicated director appointment endpoint,
not generic room metadata updates. Owners/admins can appoint while online; by
default Rallar Game also allows an active member to appoint when no owner/admin
session and no active director session are present.
