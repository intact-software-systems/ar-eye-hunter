# Room Message Channel

Use `room.message<T>(...)` for typed room messages after entering a room. The
default `send(...)` strategy is `rtc-with-ws-fallback`; explicit `sendRtc(...)`
and `sendWs(...)` are still available. The handle scopes sends, but its receive
callbacks remain topic/type listeners, so validate each inbound target.

```ts
import {
    rallar,
    type RallarMessage,
    type RallarMessageSendResult
} from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

type ReadyMessage = {
    playerId: string;
    ready: boolean;
    changedAtEpochMs: number;
};

const acceptedMessageStatuses: ReadonlySet<RallarMessageSendResult['status']> = new Set([
    'enqueued',
    'sent-immediate',
    'duplicate',
    'superseded',
    'skipped'
]);

function isMessageForRoom<T>(
    message: RallarMessage<T>,
    roomRef: GroupRef
): boolean {
    const targets = message.raw.targets;
    const targetRoomRef = targets?.mode === 'multicast'
        ? targets.groupRef
        : targets?.mode === 'broadcast' && targets.scope === 'room'
        ? targets.groupRef
        : undefined;
    return targetRoomRef !== undefined && isSameGroupRef(targetRoomRef, roomRef);
}

const room = await rallar.rooms.enter('lobby');
const readyChannel = room.message<ReadyMessage>('ready');
const localPlayerId = 'player-1';

const unsubscribeWs = readyChannel.onWs((payload, message) => {
    if (isMessageForRoom(message, room.roomRef)) {
        console.info('ready', message.senderId, payload.ready);
    }
});

const unsubscribeRtc = readyChannel.onRtc((payload, message) => {
    if (isMessageForRoom(message, room.roomRef)) {
        console.info('ready', message.senderId, payload.ready);
    }
});

const sendResult = await readyChannel.send({
    playerId: localPlayerId,
    ready: true,
    changedAtEpochMs: Date.now()
});
if (!acceptedMessageStatuses.has(sendResult.status)) {
    console.warn('Ready delivery degraded', sendResult.status, sendResult.reason);
}

// For reliable server-routed coordination, force WS.
const reliableResult = await readyChannel.sendWs({
    playerId: localPlayerId,
    ready: true,
    changedAtEpochMs: Date.now()
});
if (!acceptedMessageStatuses.has(reliableResult.status)) {
    console.warn(
        'Reliable ready delivery degraded',
        reliableResult.status,
        reliableResult.reason
    );
}

unsubscribeRtc();
unsubscribeWs();
```

`room.message('ready')` derives `topicId: 'room.ready'` and
`typeId: 'room.ready.v1'`. Use `messages.channel<T>(...)` for non-room or
custom targeting flows.
