# Server Authoritative Game

Use Rallar Server when game truth should live on the server. Browser clients
send commands through REST or a validated WS topic; the server mutates durable
app data, then publishes a room snapshot to the players in that room.

```ts
import type { RallarServerApplication } from '@shared-server/rallar-facade/RallarServerApplication.ts';
import type { RallarServerRuntime } from '@shared-server/rallar-facade/RallarServer.ts';
import {
    newALBroadcastMessage,
    newALRoute,
} from '@shared/al-contracts/al-contract.ts';

type GameCommand = {
    gameId: string;
    seq: number;
    action: 'ready' | 'fire' | 'pickup';
};

type GameState = {
    gameId: string;
    roomId: string;
    revision: number;
    readyPeerIds: readonly string[];
    events: readonly string[];
};

type GameSnapshot = Pick<GameState, 'gameId' | 'revision' | 'readyPeerIds'>;

export async function installGameAuthority(
    rallar: RallarServerApplication<RallarServerRuntime, unknown>,
) {
    const games = await rallar.data.open<GameState>('demo-games', {
        namespace: 'demo-game',
        schemaVersion: 1,
        readConsistency: 'fresh',
        maxConflictRetries: 8,
    });

    async function publishSnapshot(state: GameState): Promise<void> {
        const snapshot: GameSnapshot = {
            gameId: state.gameId,
            revision: state.revision,
            readyPeerIds: state.readyPeerIds,
        };

        await rallar.ws.publish(
            newALBroadcastMessage(
                'demo-game-server',
                newALRoute(
                    'room.demo.snapshot',
                    state.roomId,
                    `${state.gameId}:${state.revision}`,
                ),
                'room',
                'room.demo.snapshot.v1',
                snapshot,
                {
                    reliability: 'at-least-once',
                    ttlMs: 15_000,
                },
            ),
            'live-only',
        );
    }

    async function applyCommand(
        command: GameCommand,
        senderId: string,
    ): Promise<GameSnapshot> {
        const state = await games.updateOrCreate(command.gameId, (current) => {
            const previous: GameState = current ?? {
                gameId: command.gameId,
                roomId: command.gameId,
                revision: 0,
                readyPeerIds: [],
                events: [],
            };

            if (
                command.action === 'ready' &&
                previous.readyPeerIds.includes(senderId)
            ) {
                return previous;
            }

            return {
                ...previous,
                revision: previous.revision + 1,
                readyPeerIds: command.action === 'ready'
                    ? [...previous.readyPeerIds, senderId]
                    : previous.readyPeerIds,
                events: [
                    ...previous.events,
                    `${senderId}:${command.seq}:${command.action}`,
                ],
            };
        });

        await publishSnapshot(state);
        return {
            gameId: state.gameId,
            revision: state.revision,
            readyPeerIds: state.readyPeerIds,
        };
    }

    rallar.ws.defineTopic<GameCommand>({
        topicId: 'room.demo.command',
        typeId: 'room.demo.command.v1',
        scope: 'room',
        fanout: 'none',
        maxPayloadBytes: 16 * 1024,
        validate: (value, context) =>
            isGameCommand(value) &&
            context.roomId !== undefined &&
            value.gameId === context.roomId,
    });

    rallar.ws.on<GameCommand>(
        {
            topicId: 'room.demo.command',
            typeId: 'room.demo.command.v1',
        },
        async (message, context) => {
            await applyCommand(message.payload, context.senderId);
        },
    );

    return {
        applyCommand,
        readSnapshot: async (gameId: string) => {
            const state = await games.get(gameId);
            return state
                ? {
                    gameId: state.gameId,
                    revision: state.revision,
                    readyPeerIds: state.readyPeerIds,
                }
                : undefined;
        },
    };
}

function isGameCommand(value: unknown): value is GameCommand {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<GameCommand>;
    return typeof candidate.gameId === 'string' &&
        typeof candidate.seq === 'number' &&
        (
            candidate.action === 'ready' ||
            candidate.action === 'fire' ||
            candidate.action === 'pickup'
        );
}
```

This pattern is useful for turn commands, match lifecycle, scores, loot, and
other state where browser peers should not be final authority. For high-rate
pose/input streams, keep using room RTC lanes and periodically reconcile from a
server snapshot.
