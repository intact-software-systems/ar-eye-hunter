import {
    newALBroadcastMessage,
    newALRoute,
    newALUnicastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    createRallarGameAuthorityEnvelope,
    createRallarGameAuthoritySequenceTracker,
    isRallarGameAuthorityEnvelope,
    resolveRallarGameAuthorityTypeIds,
    type RallarGameAuthorityCommandResult,
    type RallarGameAuthorityEnvelope,
    type RallarGameAuthorityRef,
    type RallarGameAuthoritySendResult,
    type RallarGameAuthorityTypeIds
} from '@shared/rallar-game/mod.ts';
import type {
    RallarServerWsFanout,
    RallarServerWsHandler,
    RallarServerWsMessage,
    RallarServerWsMessageContext,
    RallarServerWsPayload,
    RallarServerWsPublishResult,
    RallarServerWsSelector,
    RallarServerWsTopicDefinition
} from '../rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';

export interface RallarGameAuthorityServerWsFacade {
    defineTopic<T extends RallarServerWsPayload>(definition: RallarServerWsTopicDefinition<T>): void;
    on<T extends RallarServerWsPayload>(
        selector: RallarServerWsSelector,
        handler: RallarServerWsHandler<T>
    ): () => boolean;
    publish(
        message: ALMessage,
        fanout?: RallarServerWsFanout
    ): Promise<RallarServerWsPublishResult>;
}

export interface RallarGameAuthorityServerRallarFacade {
    readonly ws: RallarGameAuthorityServerWsFacade;
}

export interface RallarGameAuthorityServerCommandInput<TCommand> {
    readonly command: TCommand;
    readonly envelope: RallarGameAuthorityEnvelope<TCommand>;
    readonly roomId: string;
    readonly senderId: string;
    readonly raw: RallarServerWsMessage<RallarGameAuthorityEnvelope<TCommand>>;
    readonly context: RallarServerWsMessageContext;
}

export interface RallarGameAuthorityServerSyncInput {
    readonly payload: unknown;
    readonly envelope: RallarGameAuthorityEnvelope<unknown>;
    readonly roomId: string;
    readonly senderId: string;
    readonly raw: RallarServerWsMessage<RallarGameAuthorityEnvelope<unknown>>;
    readonly context: RallarServerWsMessageContext;
}

export interface RallarGameAuthorityServerCommandOutcome<TSnapshot, TEvent> {
    readonly status: 'accepted' | 'rejected';
    readonly reason?: string;
    readonly snapshot?: TSnapshot;
    readonly events?: readonly TEvent[];
}

export interface RallarGameAuthorityServerConfig<TCommand, TSnapshot, TEvent> {
    readonly rallar: RallarGameAuthorityServerRallarFacade;
    readonly protocol: string;
    readonly topicId: string;
    readonly authority?: Partial<RallarGameAuthorityRef>;
    readonly typeIds?: Partial<RallarGameAuthorityTypeIds>;
    readonly ttlMs?: number;
    readonly snapshotFanout?: RallarServerWsFanout;
    readonly eventFanout?: RallarServerWsFanout;
    readonly commandResultFanout?: RallarServerWsFanout;
    handleCommand(
        input: RallarGameAuthorityServerCommandInput<TCommand>
    ):
        | RallarGameAuthorityServerCommandOutcome<TSnapshot, TEvent>
        | Promise<RallarGameAuthorityServerCommandOutcome<TSnapshot, TEvent>>;
    readSnapshot?(
        input: RallarGameAuthorityServerSyncInput
    ): TSnapshot | undefined | Promise<TSnapshot | undefined>;
}

export interface RallarGameAuthorityServerStatus {
    readonly protocol: string;
    readonly topicId: string;
    readonly authority: RallarGameAuthorityRef;
    readonly stopped: boolean;
    readonly handledCommandCount: number;
    readonly rejectedCommandCount: number;
    readonly syncRequestCount: number;
    readonly publishedSnapshotCount: number;
    readonly publishedEventCount: number;
}

export interface RallarGameAuthorityServerHandle<TSnapshot, TEvent> {
    authority(): RallarGameAuthorityRef;
    status(): RallarGameAuthorityServerStatus;
    publishSnapshot(
        roomId: string,
        snapshot: TSnapshot,
        options?: { roomRef?: GroupRef; toPeerId?: string; }
    ): Promise<RallarGameAuthoritySendResult>;
    publishEvent(
        roomId: string,
        event: TEvent,
        options?: { roomRef?: GroupRef; toPeerId?: string; }
    ): Promise<RallarGameAuthoritySendResult>;
    stop(): void;
}

interface PublishRallarGameAuthorityCommandResultInput {
    readonly roomId: string;
    readonly toPeerId: string;
    readonly commandResult: RallarGameAuthorityCommandResult;
    readonly roomRef?: GroupRef;
}

const DEFAULT_RALLAR_GAME_AUTHORITY_SERVER_ID = 'rallar-game-authority-server';
const DEFAULT_RALLAR_GAME_AUTHORITY_SERVER_EPOCH = 1;
const DEFAULT_RALLAR_GAME_AUTHORITY_TTL_MS = 15_000;

export function installRallarGameAuthorityServer<TCommand, TSnapshot, TEvent>(
    config: RallarGameAuthorityServerConfig<TCommand, TSnapshot, TEvent>
): RallarGameAuthorityServerHandle<TSnapshot, TEvent> {
    const authority: RallarGameAuthorityRef = {
        kind: config.authority?.kind ?? 'server',
        id: config.authority?.id ?? DEFAULT_RALLAR_GAME_AUTHORITY_SERVER_ID,
        epoch: config.authority?.epoch ?? DEFAULT_RALLAR_GAME_AUTHORITY_SERVER_EPOCH
    };
    const typeIds = resolveRallarGameAuthorityTypeIds(
        config.topicId,
        config.typeIds
    );
    const sequenceTracker = createRallarGameAuthoritySequenceTracker();
    const unsubscribes: Array<() => boolean> = [];
    let stopped = false;
    let handledCommandCount = 0;
    let rejectedCommandCount = 0;
    let syncRequestCount = 0;
    let publishedSnapshotCount = 0;
    let publishedEventCount = 0;
    let nextSeq = 1;

    config.rallar.ws.defineTopic<RallarGameAuthorityEnvelope<TCommand>>({
        topicId: config.topicId,
        typeId: typeIds.command,
        scope: 'room',
        fanout: 'none',
        validate: (value, context) => isIncomingEnvelope(value, context, 'command')
    });
    config.rallar.ws.defineTopic<RallarGameAuthorityEnvelope<unknown>>({
        topicId: config.topicId,
        typeId: typeIds.syncRequest,
        scope: 'room',
        fanout: 'none',
        validate: (value, context) => isIncomingEnvelope(value, context, 'sync-request')
    });

    unsubscribes.push(
        config.rallar.ws.on<RallarGameAuthorityEnvelope<TCommand>>(
            { topicId: config.topicId, typeId: typeIds.command },
            handleCommandMessage
        )
    );
    unsubscribes.push(
        config.rallar.ws.on<RallarGameAuthorityEnvelope<unknown>>(
            { topicId: config.topicId, typeId: typeIds.syncRequest },
            handleSyncRequestMessage
        )
    );

    return {
        authority: () => authority,
        status,
        publishSnapshot,
        publishEvent,
        stop
    };

    function status(): RallarGameAuthorityServerStatus {
        return {
            protocol: config.protocol,
            topicId: config.topicId,
            authority,
            stopped,
            handledCommandCount,
            rejectedCommandCount,
            syncRequestCount,
            publishedSnapshotCount,
            publishedEventCount
        };
    }

    async function handleCommandMessage(
        message: RallarServerWsMessage<RallarGameAuthorityEnvelope<TCommand>>,
        context: RallarServerWsMessageContext
    ): Promise<void> {
        if (stopped || !acceptIncomingEnvelope(message.payload, 'command', context)) {
            return;
        }

        handledCommandCount += 1;
        const outcome = await config.handleCommand({
            command: message.payload.payload,
            envelope: message.payload,
            roomId: message.payload.roomId,
            senderId: context.senderId,
            raw: message,
            context
        });
        if (outcome.status === 'rejected') {
            rejectedCommandCount += 1;
        }

        await publishCommandResult({
            roomId: message.payload.roomId,
            toPeerId: context.senderId,
            commandResult: {
                commandSeq: message.payload.seq,
                status: outcome.status,
                reason: outcome.reason
            },
            roomRef: context.roomRef
        });

        if (outcome.status !== 'accepted') {
            return;
        }

        if (outcome.snapshot !== undefined) {
            await publishSnapshot(message.payload.roomId, outcome.snapshot, {
                roomRef: context.roomRef
            });
        }

        for (const event of outcome.events ?? []) {
            await publishEvent(message.payload.roomId, event, {
                roomRef: context.roomRef
            });
        }
    }

    async function handleSyncRequestMessage(
        message: RallarServerWsMessage<RallarGameAuthorityEnvelope<unknown>>,
        context: RallarServerWsMessageContext
    ): Promise<void> {
        if (
            stopped ||
            !acceptIncomingEnvelope(message.payload, 'sync-request', context)
        ) {
            return;
        }

        syncRequestCount += 1;
        const snapshot = await config.readSnapshot?.({
            payload: message.payload.payload,
            envelope: message.payload,
            roomId: message.payload.roomId,
            senderId: context.senderId,
            raw: message,
            context
        });
        if (snapshot === undefined) {
            return;
        }

        await publishSnapshot(message.payload.roomId, snapshot, {
            roomRef: context.roomRef,
            toPeerId: context.senderId
        });
    }

    async function publishCommandResult(
        input: PublishRallarGameAuthorityCommandResultInput
    ): Promise<RallarGameAuthoritySendResult> {
        return await publishEnvelope(
            input.roomId,
            'command-result',
            typeIds.commandResult,
            input.commandResult,
            {
                roomRef: input.roomRef,
                toPeerId: input.toPeerId,
                fanout: config.commandResultFanout ?? 'live-only'
            }
        );
    }

    async function publishSnapshot(
        roomId: string,
        snapshot: TSnapshot,
        options: { roomRef?: GroupRef; toPeerId?: string; } = {}
    ): Promise<RallarGameAuthoritySendResult> {
        const result = await publishEnvelope(
            roomId,
            'snapshot',
            typeIds.snapshot,
            snapshot,
            {
                ...options,
                fanout: config.snapshotFanout ?? 'live-only'
            }
        );
        if (result.status === 'sent') {
            publishedSnapshotCount += 1;
        }
        return result;
    }

    async function publishEvent(
        roomId: string,
        event: TEvent,
        options: { roomRef?: GroupRef; toPeerId?: string; } = {}
    ): Promise<RallarGameAuthoritySendResult> {
        const result = await publishEnvelope(
            roomId,
            'event',
            typeIds.event,
            event,
            {
                ...options,
                fanout: config.eventFanout ?? 'live-only'
            }
        );
        if (result.status === 'sent') {
            publishedEventCount += 1;
        }
        return result;
    }

    async function publishEnvelope<T>(
        roomId: string,
        kind: RallarGameAuthorityEnvelope<T>['kind'],
        typeId: string,
        payload: T,
        options: Readonly<{
            roomRef?: GroupRef;
            toPeerId?: string;
            fanout: RallarServerWsFanout;
        }>
    ): Promise<RallarGameAuthoritySendResult> {
        if (stopped) {
            return { status: 'stopped', transport: 'server' };
        }

        const envelope = createRallarGameAuthorityEnvelope({
            protocol: config.protocol,
            kind,
            roomId,
            senderId: authority.id,
            seq: nextSeq++,
            authority,
            payload
        });
        const route = newALRoute(
            config.topicId,
            roomId,
            `${roomId}:${kind}:${envelope.seq}`
        );
        const message = options.toPeerId
            ? newALUnicastMessage(
                authority.id,
                route,
                options.toPeerId,
                typeId,
                envelope
            )
            : newALBroadcastMessage(
                authority.id,
                route,
                'room',
                typeId,
                envelope,
                {
                    groupRef: options.roomRef,
                    reliability: 'at-least-once',
                    ttlMs: config.ttlMs ?? DEFAULT_RALLAR_GAME_AUTHORITY_TTL_MS
                }
            );
        const result = await config.rallar.ws.publish(message, options.fanout);

        return {
            status: isSuccessfulPublishStatus(result.status) ? 'sent' : 'failed',
            transport: 'server',
            seq: envelope.seq,
            raw: result,
            reason: isSuccessfulPublishStatus(result.status)
                ? undefined
                : result.reason
        };
    }

    function acceptIncomingEnvelope<T>(
        envelope: RallarGameAuthorityEnvelope<T>,
        kind: RallarGameAuthorityEnvelope<T>['kind'],
        context: RallarServerWsMessageContext
    ): boolean {
        if (
            !isRallarGameAuthorityEnvelope(envelope, config.protocol) ||
            context.roomId === undefined
        ) {
            return false;
        }

        return sequenceTracker.accept(envelope, {
            protocol: config.protocol,
            roomId: context.roomId,
            senderId: context.senderId,
            authorityKind: authority.kind,
            authorityId: authority.id,
            minAuthorityEpoch: authority.epoch,
            kinds: [kind]
        }).accepted;
    }

    function isIncomingEnvelope(
        value: unknown,
        context: Pick<RallarServerWsMessageContext, 'roomId' | 'senderId'>,
        kind: RallarGameAuthorityEnvelope<unknown>['kind']
    ): boolean {
        if (!isRallarGameAuthorityEnvelope(value, config.protocol)) {
            return false;
        }

        return value.kind === kind &&
            context.roomId !== undefined &&
            value.roomId === context.roomId &&
            value.senderId === context.senderId &&
            value.authority.kind === authority.kind &&
            value.authority.id === authority.id &&
            value.authority.epoch === authority.epoch;
    }

    function stop(): void {
        if (stopped) {
            return;
        }

        stopped = true;
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
    }
}

function isSuccessfulPublishStatus(
    status: RallarServerWsPublishResult['status']
): boolean {
    return status === 'sent-live' ||
        status === 'queued-outbox' ||
        status === 'skipped' ||
        status === 'duplicate' ||
        status === 'superseded';
}
