# Room Realtime Channel

Use `rallar.realtime.room<T>(...)` for room-scoped, low-latency RTC data. The
helper checks room transport status, waits for readiness by default, sends only
to ready room peers, and returns diagnostics.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

type PlayerInput = {
    seq: number;
    moveX: number;
    moveY: number;
    sprint: boolean;
};

const inputLane = rallar.realtime.room<PlayerInput>({
    roomRef: currentRoom.group,
    laneId: 'game-input',
    waitTimeoutMs: 500,
    maxAgeMs: 120,
    key: localPlayerId,
});

inputLane.on((message) => {
    if (isDirector()) {
        applyInput(message.peerId, message.data);
    }
});

const result = await inputLane.send({
    seq: nextInputSeq(),
    moveX: input.x,
    moveY: input.y,
    sprint: input.sprint,
});

if (result.status === 'sent' || result.status === 'partial') {
    recordRealtimeDelivery(result.peerIds);
} else {
    showDegradedNetworkState(result.reason ?? result.status);
}
```

Use lower-level `rtc.waitForRoomLane(...)`, `readyPeerIds(...)`, and
`realtime.sendJson(...)` only when the caller intentionally owns peer selection
or low-level readiness diagnostics.

