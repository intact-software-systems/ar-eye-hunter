# Room Message Channel

Use `room.message<T>(...)` for typed room messages after entering a room. The
default `send(...)` strategy is `rtc-with-ws-fallback`; explicit `sendRtc(...)`
and `sendWs(...)` are still available.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

type ReadyMessage = {
    playerId: string;
    ready: boolean;
    changedAtEpochMs: number;
};

const room = await rallar.rooms.enter('lobby');
const readyChannel = room.message<ReadyMessage>('ready');

const unsubscribeWs = readyChannel.onWs((payload, message) => {
    updateReadyState(message.senderId, payload.ready);
});

const unsubscribeRtc = readyChannel.onRtc((payload, message) => {
    updateReadyState(message.senderId, payload.ready);
});

await readyChannel.send({
    playerId: localPlayerId,
    ready: true,
    changedAtEpochMs: Date.now(),
});

// For reliable server-routed coordination, force WS.
await readyChannel.sendWs({
    playerId: localPlayerId,
    ready: true,
    changedAtEpochMs: Date.now(),
});

unsubscribeRtc();
unsubscribeWs();
```

`room.message('ready')` derives `topicId: 'room.ready'` and
`typeId: 'room.ready.v1'`. Use `messages.channel<T>(...)` for non-room or
custom targeting flows.
