import {
    RELIC_TOPICS,
    RELIC_TYPES,
    toRelicRoomGroupRef,
    type RelicCommand,
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import type { RelicGameInboxService } from '@relic-hunters/server/relic-game-inbox-service.ts';
import { isRelicGameMoveInput } from '@relic-hunters/server/relic-game-move.ts';
import {
    RelicGameMutationRefusedError,
    type RelicGameMutationService
} from '@relic-hunters/server/relic-game-mutation-service.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import type {
    RallarServerWsMessage,
    RallarServerWsMessageContext,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { RelicInitialStateFactory } from './relic-expedition-ai.ts';

export interface RelicHunterServer {
    readonly ws: Readonly<{
        serverPeerId: string;
        defineTopic(definition: RallarServerWsTopicDefinition<RelicCommand>): void;
        on(
            selector: RallarServerWsSelector,
            handler: (
                message: RallarServerWsMessage<RelicCommand>,
                context: Pick<RallarServerWsMessageContext, 'senderId' | 'roomId' | 'roomRef'>
            ) => void | Promise<void>
        ): (() => boolean) | void;
    }>;
}

// deno-lint-ignore no-namespace -- Type-only vocabulary owned by the service.
export namespace RelicHunterGameService {
    export type Session = Pick<IssuedAuthSession, 'sessionId' | 'clientId' | 'username' | 'issuedAtEpochMs'>;

    /** One REST request's identity: its session, its idempotent request ID and its `x-request-id` trace. */
    export interface RestRequest {
        readonly session: Session;
        readonly requestId: string;
        readonly traceId: string;
    }

    export interface Options {
        readonly mode: RelicGameMutationService.Command['authorization'];
        readonly inbox: Pick<RelicGameInboxService, 'execute' | 'enqueue'>;
        readonly mutations: Pick<RelicGameMutationService, 'readCurrentSnapshot'>;
        readonly createInitialState: RelicInitialStateFactory;
        readonly readSession: (sessionId: string) => Promise<Session | undefined>;
    }
}

/** REST waits for durable completion; WS hands its immutable message identity to the same AppInbox owner. */
export class RelicHunterGameService {
    private readonly rallar: RelicHunterServer;
    private readonly options: RelicHunterGameService.Options;

    constructor(rallar: RelicHunterServer, options: RelicHunterGameService.Options) {
        this.rallar = rallar;
        this.options = options;
    }

    async readSnapshot(
        gameId: string,
        request: RelicHunterGameService.RestRequest
    ): Promise<RelicPublicSnapshot | null> {
        return await this.options.mutations.readCurrentSnapshot({
            operation: 'ensure',
            gameId,
            move: null,
            requestId: request.requestId,
            traceId: request.traceId,
            actor: toActor(request.session),
            authorization: this.options.mode
        }, this.rallar.ws.serverPeerId);
    }

    async ensureSnapshot(gameId: string, request: RelicHunterGameService.RestRequest): Promise<RelicPublicSnapshot> {
        return await this.execute({
            operation: 'ensure',
            gameId,
            move: null,
            requestId: request.requestId,
            traceId: request.traceId,
            actor: toActor(request.session),
            authorization: this.options.mode
        });
    }

    async applyCommand(move: RelicCommand, request: RelicHunterGameService.RestRequest): Promise<RelicPublicSnapshot> {
        return await this.execute({
            operation: 'command',
            gameId: move.gameId,
            requestId: request.requestId,
            traceId: request.traceId,
            move: { ...move, username: request.session.username },
            actor: toActor(request.session),
            authorization: this.options.mode
        });
    }

    async reset(gameId: string, request: RelicHunterGameService.RestRequest): Promise<RelicPublicSnapshot> {
        return await this.execute({
            operation: 'reset',
            gameId,
            requestId: request.requestId,
            traceId: request.traceId,
            move: null,
            actor: toActor(request.session),
            authorization: this.options.mode
        });
    }

    installTopics(): void {
        this.rallar.ws.defineTopic({
            topicId: RELIC_TOPICS.command,
            typeId: RELIC_TYPES.command,
            scope: 'room',
            fanout: 'none',
            maxPayloadBytes: 16 * 1024,
            validate: (value, context) => isRelicGameMoveInput(value) && isRelicRoomContext(context, value.gameId)
        });
        this.rallar.ws.on({ topicId: RELIC_TOPICS.command, typeId: RELIC_TYPES.command }, async (message, context) => {
            if (!isRelicRoomContext(context, message.payload.gameId)) {
                return;
            }
            const session = await this.options.readSession(context.senderId);
            if (session === undefined) {
                return;
            }
            const command: RelicGameMutationService.CommandInput = {
                operation: 'command',
                gameId: message.payload.gameId,
                requestId: message.raw.id.msgId,
                traceId: message.raw.id.traceId,
                actor: toActor(session),
                authorization: 'group-policy',
                move: { ...message.payload, username: session.username }
            };
            // Complete WS handling only after durable admission. AppInbox owns execution and its refusal publication.
            await this.options.inbox.enqueue(
                command,
                () => this.options.createInitialState(command.gameId, command.operation)
            );
        });
    }

    private async execute(command: RelicGameMutationService.CommandInput): Promise<RelicPublicSnapshot> {
        const result = await this.options.inbox.execute(
            command,
            () => this.options.createInitialState(command.gameId, command.operation)
        );
        if (result.status === 'refused') {
            throw new RelicGameMutationRefusedError(result);
        }
        const current = await this.options.mutations.readCurrentSnapshot(command, this.rallar.ws.serverPeerId);
        if (current === null) {
            throw new RelicGameMutationRefusedError({
                status: 'refused',
                gameId: command.gameId,
                code: 'game-unavailable',
                message: 'The expedition is no longer available.',
                httpStatus: 404
            });
        }
        return current;
    }
}

export function installRelicHunterGame(
    rallar: RelicHunterServer,
    options: RelicHunterGameService.Options
): RelicHunterGameService {
    const service = new RelicHunterGameService(rallar, options);
    service.installTopics();
    return service;
}

function toActor(session: RelicHunterGameService.Session): RelicGameMutationService.Command['actor'] {
    return { clientId: session.clientId, sessionId: session.sessionId, issuedAtEpochMs: session.issuedAtEpochMs };
}

function isRelicRoomContext(
    context: Pick<RallarServerWsMessageContext, 'roomId' | 'roomRef'>,
    gameId: string
): boolean {
    return context.roomId === gameId && context.roomRef !== undefined &&
        isSameGroupRef(context.roomRef, toRelicRoomGroupRef(gameId));
}
