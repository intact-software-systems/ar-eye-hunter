# Room Live Channel

Use `rallar.messages.room<T>({ purpose: 'live', publication })` for values that
replace each other: poses, cursors, and other state where only the newest value
of a stream matters. A live channel is best-effort, asks no receipt, is
volatile, and each value lives one second by default (override it per send
with `ttlMs`).

A live send is paced, not sent at once. The channel declares a
`publication` policy: `cadenceMs` is the interval between opportunities,
`retainNewest` is how many staged values each stream keeps, and
`drain: { messages, bytes }` bounds what one opportunity admits. All three
are required, so the policy states the traffic you accept. Every send names the
`resourceId` of the stream it publishes; values of one stream replace each
other, values of different streams never do.

`send(...)` returns a `RallarMessageHandle` whose first state is `staged`: the
value waits for the channel's next opportunity. `staged` is healthy, and
`isALDeliveryAdmitted(...)` is false for it by design. The handle then ends in
one of these states, and several are normal:

- `transport-accepted`: the value was admitted and handed to its carrier. With
  no receipt asked, this is terminal and the end of the lane's promise.
- `superseded`: a newer value of the same stream displaced it before an
  opportunity. This is the lane working, not a failure.
- `expired`: its deadline passed while staged, so it was never attempted.
- `rejected` or `failed`: the value was refused (for example `oversized`
  against `drain.bytes`), or the session ended while it was staged.

`rallar.messages.readUsage().publication` reads the session's staged values
and the pacing counters; read it once when you need to see how the lane is
behaving, not on every send.

```ts
import { rallar } from '@shared-web/browser/rallar.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

interface Pose {
    readonly x: number;
    readonly y: number;
    readonly headingRadians: number;
}

const room = await rallar.rooms.enter('arena');
const poseChannel = rallar.messages.room<Pose>({
    roomRef: room.roomRef,
    topicId: 'arena.pose',
    typeId: 'arena.pose.v1',
    purpose: 'live',
    publication: {
        cadenceMs: 50,
        retainNewest: 1,
        drain: { messages: 8, bytes: 65_536 }
    }
});

const unsubscribe = poseChannel.onRtc((pose, message) => {
    console.info('pose', message.senderId, message.resourceId, pose.x, pose.y);
});

const handle = await poseChannel.send(
    { x: 12.5, y: -3, headingRadians: 1.57 },
    { resourceId: 'player-1' }
);

const staged = await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES, timeoutMs: 1_000 });
if (staged.lifecycle.state !== 'staged') {
    console.warn('Pose was not staged', staged.lifecycle.state, staged.lifecycle.evidence.reason);
}

const settled = await handle.wait({ timeoutMs: 2_000 });
switch (settled.lifecycle.state) {
    case 'transport-accepted':
    case 'superseded':
    case 'expired':
        break;
    default:
        console.warn(
            'Pose was refused',
            settled.lifecycle.state,
            settled.lifecycle.evidence.reason
        );
}

console.info('publication', rallar.messages.readUsage().publication);

unsubscribe();
```

The first `wait(...)` resolves as soon as the handle leaves `submitted`, which
is `staged` for a live send, and the second resolves at the terminal state.
A value that ends `superseded` or `expired` needs no retry: a newer value of
its stream is the one in flight, or the next send replaces it.

The lane promises that each opportunity admits at most the drain budget, that a
stream never holds more than `retainNewest` values, and that a newer value
displaces an older one instead of queueing behind it. It does not promise
delivery of every value, an order across streams, or any history: two values
admitted at one opportunity may still be conflated on the way, and an idle
channel admits its first value at the session's next engine pass rather than
at a fixed boundary. Use `room.message<T>(...)` when every message must
arrive, and keep authoritative state out of live values.
