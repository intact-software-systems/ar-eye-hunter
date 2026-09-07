# Room Message Channel

Use `room.message<T>(...)` for typed room messages after entering a room. The
default `send(...)` strategy is `rtc-with-ws-fallback`; explicit `sendRtc(...)`
and `sendWs(...)` are still available. The handle scopes sends, but its receive
callbacks remain topic/type listeners, so validate each inbound target.

`accepted` and `enqueued` report admission into outbound processing. They do
not establish transport submission, receiver acknowledgement, or application
completion. Keep those stages separate when displaying delivery progress.

RTC/WS fallback captures one envelope and scoped room before the first
attempt. A second carrier preserves its ID, ordering, exclusions, and original
deadline, even if the current room changes. Typed sends default to a 30-second
deadline; override it with `ttlMs`. An elapsed deadline prevents further
carrier admission.

Current fallback reacts to no-route or open-circuit admission results. It does
not bypass validation, supersedence, or rate limiting. Both fallback orders
require a room audience; use WS explicitly for world/all scope. Receiver
receipt timeouts and shared RTC/WS receiver deduplication remain implementation
work, so one outgoing ID does not yet establish one logical receiver delivery.

```ts
import {
    rallar,
    type RallarMessage,
    type RallarMessageSendResult
} from '@shared-web/browser/rallar.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

interface ReadyMessage {
    readonly playerId: string;
    readonly ready: boolean;
    readonly changedAtEpochMs: number;
}

const acceptedMessageStatuses: ReadonlySet<RallarMessageSendResult['status']> = new Set([
    'enqueued',
    'accepted',
    'duplicate'
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
    console.warn('Ready message was not admitted', sendResult.status, sendResult.reason);
}

// For server-routed coordination, force WS.
const wsResult = await readyChannel.sendWs({
    playerId: localPlayerId,
    ready: true,
    changedAtEpochMs: Date.now()
});
if (!acceptedMessageStatuses.has(wsResult.status)) {
    console.warn(
        'WS ready message was not admitted',
        wsResult.status,
        wsResult.reason
    );
}

unsubscribeRtc();
unsubscribeWs();
```

`room.message('ready')` derives `topicId: 'room.ready'` and
`typeId: 'room.ready.v1'`. Use `messages.channel<T>(...)` for non-room or
custom targeting flows.
