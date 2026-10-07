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
    RallarServerWsMessageContext,
    RallarServerWsPublishInputDto,
    RallarServerWsPublishResult,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    applyRelicWsCommand,
    toRelicWsCommandWarning,
    type RelicCommandApplication
} from './apply-relic-ws-command.ts';
import { decodeRelicGameStateAppData } from './decode-relic-game-state-app-data.ts';
import { encodeRelicGameStateAppData } from './encode-relic-game-state-app-data.ts';
import type { RelicInitialStateFactory } from './relic-expedition-ai.ts';
import { toRelicRoundTransitionEvent, toRelicRoundTransitionMessage } from './to-relic-round-transition-message.ts';
import { toRelicSnapshotMessage } from './to-relic-snapshot-message.ts';

export interface RelicHunterGameServiceOptions {
    readonly createInitialState: RelicInitialStateFactory;
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
            input: RallarServerWsPublishInputDto
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

    const service = new RelicGameService({ games, rallar, options });
    service.installTopics();
    return service;
}

// deno-lint-ignore no-namespace -- Type-only vocabulary owned by the service.
namespace RelicGameService {
    export interface Dependencies {
        readonly games: Pick<RallarServerAppDataStore<RelicGameState>, 'get' | 'set' | 'setIfAbsent'>;
        readonly rallar: RelicHunterServer;
        readonly options: RelicHunterGameServiceOptions;
    }
}

class RelicGameService implements RelicHunterGameService {
    private readonly dependencies: RelicGameService.Dependencies;
    // Serialize writes per game to prevent read-modify-write races between simultaneous commands.
    private readonly gameQueues = new Map<string, Promise<void>>();

    constructor(dependencies: RelicGameService.Dependencies) {
        this.dependencies = dependencies;
    }

    private enqueueForGame<T>(gameId: string, work: () => Promise<T>): Promise<T> {
        const previousCompletion = this.gameQueues.get(gameId) ?? Promise.resolve();
        const result = previousCompletion.then(work);
        this.gameQueues.set(gameId, result.then(() => undefined, () => undefined));
        return result;
    }

    private async publishSnapshot(state: RelicGameState): Promise<void> {
        const { rallar } = this.dependencies;
        await rallar.ws.publish({
            message: toRelicSnapshotMessage(state, rallar.ws.serverPeerId),
            fanout: 'outbox'
        });
    }

    private async publishCommandResult(previous: RelicGameState, next: RelicGameState): Promise<void> {
        await this.publishSnapshot(next);
        const transition = toRelicRoundTransitionEvent(previous, next);
        if (transition === undefined) {
            return;
        }
        const { rallar } = this.dependencies;
        await rallar.ws.publish({
            message: toRelicRoundTransitionMessage(next, transition, rallar.ws.serverPeerId),
            fanout: 'outbox'
        });
    }

    private applyAndPublishCommand(
        command: RelicCommand,
        senderId: string
    ): Promise<RelicCommandApplication> {
        const { games, options } = this.dependencies;
        return this.enqueueForGame(command.gameId, async () => {
            const previous = await games.get(command.gameId) ??
                await options.createInitialState(command.gameId, 'command');
            const result = applyRelicCommand(previous, command, { senderId });
            await games.set(command.gameId, result.state);
            const snapshot = toPublicRelicSnapshot(result.state);
            try {
                await this.publishCommandResult(previous, result.state);
                return { snapshot, publishFailure: undefined };
            }
            catch (error) {
                return { snapshot, publishFailure: toError(error) };
            }
        });
    }

    async applyCommand(
        command: RelicCommand,
        senderId: string
    ): Promise<RelicPublicSnapshot> {
        const application = await this.applyAndPublishCommand(command, senderId);
        if (application.publishFailure !== undefined) {
            throw application.publishFailure;
        }
        return application.snapshot;
    }

    installTopics(): void {
        const { rallar } = this.dependencies;
        // The browser sends commands over WebSocket and falls back to REST only before it knows the server's peer id.
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
                    readSessionUsername: this.dependencies.options.readSessionUsername,
                    applyCommand: (command, senderId) => this.applyAndPublishCommand(command, senderId)
                });
                const warning = toRelicWsCommandWarning(context.senderId, outcome);
                if (warning !== undefined) {
                    console.warn(warning.message, ...(warning.error === undefined ? [] : [warning.error]));
                }
            }
        );
    }

    async readSnapshot(gameId: string): Promise<RelicPublicSnapshot | undefined> {
        const game = await this.dependencies.games.get(gameId);
        return game ? toPublicRelicSnapshot(game) : undefined;
    }

    ensureSnapshot(gameId: string): Promise<RelicPublicSnapshot> {
        const { games, options } = this.dependencies;
        return this.enqueueForGame(gameId, async () => {
            const existing = await games.get(gameId);
            if (existing) {
                return toPublicRelicSnapshot(existing);
            }
            const state = await options.createInitialState(gameId, 'ensure');
            await games.set(gameId, state);
            return toPublicRelicSnapshot(state);
        });
    }

    reset(gameId: string): Promise<RelicPublicSnapshot> {
        const { games, options } = this.dependencies;
        return this.enqueueForGame(gameId, async () => {
            const state = await options.createInitialState(gameId, 'reset');
            await games.set(gameId, state);
            await this.publishSnapshot(state);
            return toPublicRelicSnapshot(state);
        });
    }
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
