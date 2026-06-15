# Media Calls

Use calls for targeted peer sessions with data lanes and optional media. Use the
media source helpers when microphone, camera, or screen streams should be
attached independently.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';

const unsubscribeInvites = rallar.calls.onInvite(async (invite) => {
    if (shouldAcceptCall(invite)) {
        const call = await invite.accept({
            data: { lanes: ['reliable'] },
            media: { audio: true, video: true },
        });
        attachCall(call);
    } else {
        await invite.decline('busy');
    }
});

const invite = await rallar.calls.invite({
    peerIds: ['peer-1'],
    data: { lanes: ['reliable'], openTimeoutMs: 1000 },
    media: { audio: true, video: true },
    message: 'Join the strategy call?',
});

const call = await rallar.calls.start({
    peerIds: invite.peerIds,
    data: { lanes: ['reliable'], openTimeoutMs: 1000 },
    media: { audio: true, video: true },
});

await call.wait({ timeoutMs: 1000 });

const microphone = await call.sources.microphone.start({
    audio: true,
});
const camera = await call.sources.camera.start({
    video: true,
});

const chat = call.channel<{ text: string }>({
    laneId: 'reliable',
});
await chat.send({ text: 'ready' });

await camera.setEnabled(false);
await microphone.stop();
await call.end({ stopLocalMedia: true });
unsubscribeInvites();
```

Use `rallar.media.*` for global local stream controls and `call.sources.*` when
the stream lifecycle belongs to a specific call.
