import {
    applyRelicCommand,
    isRelicCommand,
    RELIC_TOPICS,
    RELIC_TYPES,
    toPublicRelicSnapshot,
    type RelicCommand,
    type RelicGameState,
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import type { RallarServerAppDataStoreOptions } from '@shared-server/app-data/app-data-store-definition.ts';
import type { AppDataValueCodec } from '@shared-server/app-data/app-data-value-codec.ts';
import type { RallarServerAppDataStore } from '@shared-server/app-data/rallar-server-app-data-store.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsMessageContext,
    RallarServerWsPublishResult,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    applyRelicWsCommand,
    toRelicWsCommandWarning,
    type RelicCommandApplication
} from './apply-relic-ws-command.ts';
import { decodeRelicGameStateAppData } from './decode-relic-game-state-app-data.ts';
import { encodeRelicGameStateAppData } from './encode-relic-game-state-app-data.ts';
import type { RelicInitialStateFactory, RelicInitialStateReason } from './relic-expedition-ai.ts';
import { toRelicSnapshotMessage } from './to-relic-snapshot-message.ts';

export interface RelicHunterGameServiceOptions {
    readonly createInitialState: RelicInitialStateFactory;
    /**
     * The username of an issued session, read from the auth store: a WS command's own username is never trusted (Q6).
     * The store also returns expired and logged-out sessions; the sender's open WS connection is what authenticated it.
     */
    readonly readSessionUsername: (sessionId: string) => Promise<string | undefined>;
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
        /** The WS server's peer id: every snapshot's sender, so receivers' ACKs reach its receipt (D58). */
        serverPeerId: string;
        defineTopic(definition: RallarServerWsTopicDefinition<RelicCommand>): void;
        on(
            selector: RallarServerWsSelector,
            handler: (
                message: Readonly<{ payload: RelicCommand; }>,
                context: Pick<RallarServerWsMessageContext, 'senderId' | 'roomId' | 'roomRef'>
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
    encode: encodeRelicGameStateAppData,
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

    async function publishSnapshot(state: RelicGameState): Promise<void> {
        await rallar.ws.publish(toRelicSnapshotMessage(state, rallar.ws.serverPeerId), 'outbox');
    }

    function applyAndPublishCommand(
        command: RelicCommand,
        senderId: string
    ): Promise<RelicCommandApplication> {
        return enqueueForGame(command.gameId, async () => {
            const previous = await games.get(command.gameId) ??
                await options.createInitialState(command.gameId, 'command');
            const result = applyRelicCommand(previous, command, { senderId });
            await games.set(command.gameId, result.state);
            const snapshot = toPublicRelicSnapshot(result.state);
            try {
                await publishSnapshot(result.state);
                return { snapshot, publishFailure: undefined };
            }
            catch (error) {
                return { snapshot, publishFailure: toError(error) };
            }
        });
    }

    async function applyCommand(
        command: RelicCommand,
        senderId: string
    ): Promise<RelicPublicSnapshot> {
        const application = await applyAndPublishCommand(command, senderId);
        if (application.publishFailure !== undefined) {
            throw application.publishFailure;
        }
        return application.snapshot;
    }

    // Browsers send commands to the server itself on this topic (D57); REST carries them only before a browser learns the server id.
    rallar.ws.defineTopic({
        topicId: RELIC_TOPICS.command,
        typeId: RELIC_TYPES.command,
        scope: 'room',
        fanout: 'none',
        maxPayloadBytes: 16 * 1024,
        validate: (value, context) =>
            isRelicCommand(value) &&
            isDefaultRelicRoomContext(context, value.gameId)
    });

    rallar.ws.on(
        {
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command
        },
        async (message, context) => {
            if (!isDefaultRelicRoomContext(context, message.payload.gameId)) {
                return;
            }
            const outcome = await applyRelicWsCommand({
                command: message.payload,
                senderId: context.senderId,
                readSessionUsername: options.readSessionUsername,
                applyCommand: applyAndPublishCommand
            });
            const warning = toRelicWsCommandWarning(context.senderId, outcome);
            if (warning !== undefined) {
                console.warn(warning.message, ...(warning.error === undefined ? [] : [warning.error]));
            }
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
                const state = await options.createInitialState(gameId, 'ensure');
                await games.set(gameId, state);
                return toPublicRelicSnapshot(state);
            });
        },
        applyCommand,
        reset: (gameId) => {
            return enqueueForGame(gameId, async () => {
                const state = await options.createInitialState(gameId, 'reset');
                await games.set(gameId, state);
                await publishSnapshot(state);
                return toPublicRelicSnapshot(state);
            });
        }
    };
}

function isDefaultRelicRoomContext(
    context: Pick<RallarServerWsMessageContext, 'roomId' | 'roomRef'>,
    gameId: string
): boolean {
    const roomRef = context.roomRef;
    return context.roomId === gameId &&
        roomRef?.groupId === gameId &&
        roomRef.applicationId === DEFAULT_STATE_APPLICATION_ID &&
        roomRef.workspaceId === DEFAULT_STATE_WORKSPACE_ID;
}
