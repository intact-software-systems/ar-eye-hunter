import type { ApiV1Runtime } from '@api-v1/src/composition/api-v1-runtime.ts';
import {
    applyRelicCommand,
    isRelicCommand,
    RELIC_TOPICS,
    RELIC_TYPES,
    toPublicRelicSnapshot,
    type RelicCommand,
    type RelicGameState,
    type RelicPublicSnapshot,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import type { RallarServerApplication } from '@shared-server/rallar-facade/rallar-server-application.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import type { Hono } from 'hono';
import type { RelicInitialStateFactory, RelicInitialStateReason } from './relic-expedition-ai.ts';

export interface RelicHunterGameServiceOptions {
    readonly createInitialState: RelicInitialStateFactory;
}

export interface RelicHunterGameService {
    readSnapshot(gameId: string): Promise<RelicPublicSnapshot | undefined>;
    ensureSnapshot(gameId: string): Promise<RelicPublicSnapshot>;
    applyCommand(command: RelicCommand, senderId: string): Promise<RelicPublicSnapshot>;
    reset(gameId: string): Promise<RelicPublicSnapshot>;
}

export async function installRelicHunterGame(
    rallar: RallarServerApplication<ApiV1Runtime, Hono>,
    options: RelicHunterGameServiceOptions
): Promise<RelicHunterGameService> {
    const games = await rallar.data.open<RelicGameState>(
        'relic-hunter-games',
        {
            namespace: 'relic-hunter-v1',
            schemaVersion: 1
        }
    );

    // Serialize writes per game to prevent read-modify-write races when two
    // players submit actions simultaneously.
    const gameQueues = new Map<string, Promise<void>>();
    function enqueueForGame<T>(gameId: string, work: () => Promise<T>): Promise<T> {
        const previousCompletion = gameQueues.get(gameId) ?? Promise.resolve();
        const result = previousCompletion.then(work);
        gameQueues.set(gameId, result.then(() => undefined, () => undefined));
        return result;
    }

    async function createInitialState(
        gameId: string,
        reason: RelicInitialStateReason
    ): Promise<RelicGameState> {
        return await options.createInitialState(gameId, reason);
    }

    async function publishSnapshot(state: RelicGameState): Promise<void> {
        const snapshot = toPublicRelicSnapshot(state);
        const event: RelicServerEvent = {
            protocolVersion: snapshot.protocolVersion,
            gameId: snapshot.gameId,
            snapshot
        };

        await rallar.ws.publish(
            newALBroadcastMessage(
                'relic-hunter-server',
                newALRoute(
                    RELIC_TOPICS.snapshot,
                    state.roomId,
                    `${state.gameId}:${state.round}`
                ),
                'room',
                RELIC_TYPES.snapshot,
                event,
                {
                    reliability: 'at-least-once',
                    ttlMs: 15_000
                }
            ),
            'live-only'
        );
    }

    function applyCommand(
        command: RelicCommand,
        senderId: string
    ): Promise<RelicPublicSnapshot> {
        return enqueueForGame(command.gameId, async () => {
            const previous = await games.get(command.gameId) ??
                await createInitialState(command.gameId, 'command');
            const result = applyRelicCommand(previous, command, { senderId });
            await games.set(command.gameId, result.state);
            await publishSnapshot(result.state);
            return toPublicRelicSnapshot(result.state);
        });
    }

    // The browser sends commands over REST and consumes snapshots over WebSocket.
    // Other clients may send the same validated room command over WebSocket.
    rallar.ws.defineTopic<RelicCommand>({
        topicId: RELIC_TOPICS.command,
        typeId: RELIC_TYPES.command,
        scope: 'room',
        fanout: 'none',
        maxPayloadBytes: 16 * 1024,
        validate: (value, context) =>
            isRelicCommand(value) &&
            context.roomId !== undefined &&
            value.gameId === context.roomId
    });

    rallar.ws.on<RelicCommand>(
        {
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command
        },
        async (message, context) => {
            await applyCommand(message.payload, context.senderId);
        }
    );

    return {
        readSnapshot: async (gameId) => {
            const game = await games.get(gameId);
            return game ? toPublicRelicSnapshot(game) : undefined;
        },
        ensureSnapshot: (gameId) => {
            return enqueueForGame(gameId, async () => {
                const existing = await games.get(gameId);
                if (existing) {
                    return toPublicRelicSnapshot(existing);
                }
                const state = await createInitialState(gameId, 'ensure');
                await games.set(gameId, state);
                return toPublicRelicSnapshot(state);
            });
        },
        applyCommand,
        reset: (gameId) => {
            return enqueueForGame(gameId, async () => {
                const state = await createInitialState(gameId, 'reset');
                await games.set(gameId, state);
                await publishSnapshot(state);
                return toPublicRelicSnapshot(state);
            });
        }
    };
}
