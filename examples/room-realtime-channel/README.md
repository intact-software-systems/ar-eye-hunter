# Room Realtime Channel

Use `room.realtime<T>(...)` for room-scoped, low-latency RTC data after
entering a room. The helper checks room transport status, waits for readiness by
default, sends only to ready room peers, and returns diagnostics. Its receive
callback remains a lane listener, so a shared lane payload must carry and
validate the full room identity.

```ts
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { rallar } from '@shared-web/browser/rallar.ts';

type PlayerInput = {
    roomRef: GroupRef;
    seq: number;
    moveX: number;
    moveY: number;
    sprint: boolean;
};

const room = await rallar.rooms.enter('lobby');
const localPlayerId = 'player-1';
const inputLane = room.realtime<PlayerInput>({
    laneId: 'game-input',
    waitTimeoutMs: 500,
    maxAgeMs: 120,
    key: localPlayerId,
});

inputLane.on((message) => {
    if (isSameGroupRef(message.data.roomRef, room.roomRef)) {
        console.info('player input', message.peerId, message.data);
    }
});

const sendResult = await inputLane.send({
    roomRef: room.roomRef,
    seq: 1,
    moveX: 0,
    moveY: 1,
    sprint: false,
});

if (sendResult.status !== 'sent') {
    console.warn(
        'Realtime input delivery degraded',
        sendResult.status,
        sendResult.reason,
    );
}
```

Use lower-level `rtc.waitForRoomLane(..., { expect })`, `readyPeerIds(...)`,
and `realtime.sendJson(...)` only when the caller intentionally owns peer
selection or low-level readiness diagnostics.
