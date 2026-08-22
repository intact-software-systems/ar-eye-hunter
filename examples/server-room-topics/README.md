# Server Room Topics

Use custom Rallar Server WS topics when a server process needs to validate,
observe, transform, or suppress browser room traffic. Define explicit room
topics for app protocols; leave built-in Rallar topics to the middleware.

```ts
import type { RallarServerRuntime } from '@shared-server/rallar-facade/RallarServer.ts';
import type { RallarServerApplication } from '@shared-server/rallar-facade/RallarServerApplication.ts';

type Ping = {
    roomId: string;
    nonce: string;
};

type Pong = {
    roomId: string;
    nonce: string;
    serverAtEpochMs: number;
};

export function installRoomDiagnosticsTopic(
    rallar: RallarServerApplication<RallarServerRuntime, unknown>
) {
    rallar.ws.defineTopic<Ping>({
        topicId: 'room.demo.ping',
        typeId: 'room.demo.ping.v1',
        scope: 'room',
        fanout: 'none',
        maxPayloadBytes: 1024,
        validate: (value, context) =>
            isPing(value) &&
            context.roomId !== undefined &&
            value.roomId === context.roomId,
        authorize: (_message, context) =>
            context.roomId !== undefined &&
            context.senderId.length > 0
    });

    rallar.ws.proxy<Ping>({
        from: {
            topicId: 'room.demo.ping',
            typeId: 'room.demo.ping.v1'
        },
        suppressDefaultFanout: true,
        transform: (message) => ({
            ...message.raw,
            route: {
                ...message.raw.route,
                topicId: 'room.demo.pong'
            },
            payload: {
                ...message.raw.payload,
                typeId: 'room.demo.pong.v1',
                resource: JSON.stringify(
                    {
                        roomId: message.payload.roomId,
                        nonce: message.payload.nonce,
                        serverAtEpochMs: Date.now()
                    } satisfies Pong
                )
            }
        }),
        targets: (_message, context) => ({
            mode: 'unicast',
            toPeerId: context.senderId
        }),
        fanout: 'live-only'
    });

    rallar.ws.on<Ping>(
        {
            topicId: 'room.demo.ping',
            typeId: 'room.demo.ping.v1'
        },
        (message, context) => {
            recordRoomPing(context.roomId, context.senderId, message.payload.nonce);
        }
    );
}

function isPing(value: unknown): value is Ping {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<Ping>;
    return typeof candidate.roomId === 'string' &&
        typeof candidate.nonce === 'string';
}

function recordRoomPing(
    roomId: string | undefined,
    senderId: string,
    nonce: string
): void {
    console.debug('room ping', { roomId, senderId, nonce });
}
```

Room topics should use `scope: 'room'` and validate that payload room identity
matches `context.roomId`. When application/workspace scope matters, prefer
targets and resolvers that carry `GroupRef` instead of a bare room ID.

Use `fanout: 'none'` when the server fully handles the message, `live-only` for
ephemeral replies, and `outbox` for at-least-once WS delivery through QueueBox.
