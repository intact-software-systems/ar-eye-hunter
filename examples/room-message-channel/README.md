# Room Message Channel

Use `rallar.messages.room<T>(...)` for typed room messages. The default
`send(...)` strategy is `rtc-with-ws-fallback`; explicit `sendRtc(...)` and
`sendWs(...)` are still available.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

type ReadyMessage = {
    playerId: string;
    ready: boolean;
    changedAtEpochMs: number;
};

const readyChannel = rallar.messages.room<ReadyMessage>({
    topicId: 'lobby',
    typeId: 'ready',
    roomRef: currentRoom.group,
});

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

Use `messages.channel<T>(...)` for non-room or custom targeting flows. Use
`messages.room<T>(...)` when the message naturally belongs to the current room.

