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
import type { RallarServerAppDataStoreOptions } from '@shared-server/app-data/app-data-store-definition.ts';
import type { AppDataValueCodec } from '@shared-server/app-data/app-data-value-codec.ts';
import type { RallarServerAppDataStore } from '@shared-server/app-data/rallar-server-app-data-store.ts';
import { decodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsPublishResult,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeRelicGameStateAppData } from './decode-relic-game-state-app-data.ts';
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

export interface RelicHunterServer {
    readonly appData: Readonly<{
        open(
            name: string,
            options: RallarServerAppDataStoreOptions<RelicGameState>
        ): Promise<Pick<RallarServerAppDataStore<RelicGameState>, 'get' | 'set' | 'setIfAbsent'>>;
    }>;
    readonly ws: Readonly<{
        defineTopic(definition: RallarServerWsTopicDefinition<RelicCommand>): void;
        on(
            selector: RallarServerWsSelector,
            handler: (
                message: Readonly<{ payload: RelicCommand; }>,
                context: Readonly<{ senderId: string; }>
            ) => void | Promise<void>
        ): (() => boolean) | void;
        publish(
            message: ALMessage,
            fanout?: RallarServerWsFanout
        ): Promise<RallarServerWsPublishResult | void>;
    }>;
}

const RELIC_GAME_STATE_CODEC: AppDataValueCodec<RelicGameState> = {
    schemaVersion: 1,
    encode: (value) => decodeJsonWireValue(value, 'Relic game state'),
    decode: decodeRelicGameStateAppData
};

export async function installRelicHunterGame(
    rallar: RelicHunterServer,
    options: RelicHunterGameServiceOptions
): Promise<RelicHunterGameService> {
    const games = await rallar.appData.open(
        'relic-hunter-games',
        {
            namespace: 'relic-hunter-v1',
            codec: RELIC_GAME_STATE_CODEC
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
    rallar.ws.defineTopic({
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

    rallar.ws.on(
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
