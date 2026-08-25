import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    createRallarGameAuthoritySequenceTracker,
    isRallarGameAuthorityEnvelope,
    resolveRallarGameAuthorityTypeIds,
    type RallarGameAuthorityCommandResult,
    type RallarGameAuthorityEnvelope,
    type RallarGameAuthorityRef,
    type RallarGameAuthoritySendResult,
    type RallarGameAuthorityTypeIds
} from '@shared/rallar-game/mod.ts';
import type { JsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';
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
import { toRallarGameAuthorityServerPublication } from './to-rallar-game-authority-server-publication.ts';

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
    readonly envelope: RallarGameAuthorityEnvelope<JsonWireValue>;
    readonly roomId: string;
    readonly senderId: string;
    readonly raw: RallarServerWsMessage<RallarGameAuthorityEnvelope<JsonWireValue>>;
    readonly context: RallarServerWsMessageContext;
}

export interface RallarGameAuthorityServerSyncInput {
    readonly payload: JsonWireValue;
    readonly envelope: RallarGameAuthorityEnvelope<JsonWireValue>;
    readonly roomId: string;
    readonly senderId: string;
    readonly raw: RallarServerWsMessage<RallarGameAuthorityEnvelope<JsonWireValue>>;
    readonly context: RallarServerWsMessageContext;
}

export type RallarGameAuthorityServerCommandOutcome<TSnapshot, TEvent> =
    | Readonly<{
        status: 'accepted';
        snapshot?: TSnapshot;
        events?: readonly TEvent[];
    }>
    | Readonly<{
        status: 'rejected';
        reason: string;
    }>;

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
    readonly decodeCommand: (value: JsonWireValue) => TCommand;
    readonly nowEpochMs: () => number;
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

export interface PublishRallarGameAuthoritySnapshotInput<TSnapshot> {
    readonly roomId: string;
    readonly snapshot: TSnapshot;
    readonly roomRef?: GroupRef;
    readonly toPeerId?: string;
}

export interface PublishRallarGameAuthorityEventInput<TEvent> {
    readonly roomId: string;
    readonly event: TEvent;
    readonly roomRef?: GroupRef;
    readonly toPeerId?: string;
}

export interface RallarGameAuthorityServerHandle<TSnapshot, TEvent> {
    authority(): RallarGameAuthorityRef;
    status(): RallarGameAuthorityServerStatus;
    publishSnapshot(
        input: PublishRallarGameAuthoritySnapshotInput<TSnapshot>
    ): Promise<RallarGameAuthoritySendResult>;
    publishEvent(
        input: PublishRallarGameAuthorityEventInput<TEvent>
    ): Promise<RallarGameAuthoritySendResult>;
    stop(): void;
}

interface PublishRallarGameAuthorityCommandResultInput {
    readonly roomId: string;
    readonly toPeerId: string;
    readonly commandResult: RallarGameAuthorityCommandResult;
    readonly roomRef?: GroupRef;
}

interface PublishRallarGameAuthorityEnvelopeInput<TPayload> {
    readonly roomId: string;
    readonly kind: RallarGameAuthorityEnvelope<TPayload>['kind'];
    readonly typeId: string;
    readonly payload: TPayload;
    readonly roomRef?: GroupRef;
    readonly toPeerId?: string;
    readonly fanout: RallarServerWsFanout;
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

    config.rallar.ws.defineTopic<RallarGameAuthorityEnvelope<JsonWireValue>>({
        topicId: config.topicId,
        typeId: typeIds.command,
        scope: 'room',
        fanout: 'none',
        validate: (value, context) => isIncomingEnvelope(value, context, 'command')
    });
    config.rallar.ws.defineTopic<RallarGameAuthorityEnvelope<JsonWireValue>>({
        topicId: config.topicId,
        typeId: typeIds.syncRequest,
        scope: 'room',
        fanout: 'none',
        validate: (value, context) => isIncomingEnvelope(value, context, 'sync-request')
    });

    unsubscribes.push(
        config.rallar.ws.on<RallarGameAuthorityEnvelope<JsonWireValue>>(
            { topicId: config.topicId, typeId: typeIds.command },
            handleCommandMessage
        )
    );
    unsubscribes.push(
        config.rallar.ws.on<RallarGameAuthorityEnvelope<JsonWireValue>>(
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
        message: RallarServerWsMessage<RallarGameAuthorityEnvelope<JsonWireValue>>,
        context: RallarServerWsMessageContext
    ): Promise<void> {
        if (stopped) {
            return;
        }

        const decodedCommand = decodeIncomingCommand(message.payload.payload);
        if (
            decodedCommand === undefined ||
            !acceptIncomingEnvelope(message.payload, 'command', context)
        ) {
            return;
        }

        handledCommandCount += 1;
        const outcome = await config.handleCommand({
            command: decodedCommand.command,
            envelope: message.payload,
            roomId: message.payload.roomId,
            senderId: context.senderId,
            raw: message,
            context
        });
        if (outcome.status === 'rejected') {
            rejectedCommandCount += 1;
            await publishCommandResult({
                roomId: message.payload.roomId,
                toPeerId: context.senderId,
                commandResult: {
                    commandSeq: message.payload.seq,
                    status: 'rejected',
                    reason: outcome.reason
                },
                roomRef: context.roomRef
            });
            return;
        }

        await publishCommandResult({
            roomId: message.payload.roomId,
            toPeerId: context.senderId,
            commandResult: {
                commandSeq: message.payload.seq,
                status: 'accepted'
            },
            roomRef: context.roomRef
        });

        if (outcome.snapshot !== undefined) {
            await publishSnapshot({
                roomId: message.payload.roomId,
                snapshot: outcome.snapshot,
                roomRef: context.roomRef
            });
        }

        for (const event of outcome.events ?? []) {
            await publishEvent({
                roomId: message.payload.roomId,
                event,
                roomRef: context.roomRef
            });
        }
    }

    async function handleSyncRequestMessage(
        message: RallarServerWsMessage<RallarGameAuthorityEnvelope<JsonWireValue>>,
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

        await publishSnapshot({
            roomId: message.payload.roomId,
            snapshot,
            roomRef: context.roomRef,
            toPeerId: context.senderId
        });
    }

    async function publishCommandResult(
        input: PublishRallarGameAuthorityCommandResultInput
    ): Promise<RallarGameAuthoritySendResult> {
        return await publishEnvelope({
            roomId: input.roomId,
            kind: 'command-result',
            typeId: typeIds.commandResult,
            payload: input.commandResult,
            roomRef: input.roomRef,
            toPeerId: input.toPeerId,
            fanout: config.commandResultFanout ?? 'live-only'
        });
    }

    async function publishSnapshot(
        input: PublishRallarGameAuthoritySnapshotInput<TSnapshot>
    ): Promise<RallarGameAuthoritySendResult> {
        const result = await publishEnvelope({
            roomId: input.roomId,
            kind: 'snapshot',
            typeId: typeIds.snapshot,
            payload: input.snapshot,
            roomRef: input.roomRef,
            toPeerId: input.toPeerId,
            fanout: config.snapshotFanout ?? 'live-only'
        });
        if (result.status === 'sent') {
            publishedSnapshotCount += 1;
        }
        return result;
    }

    async function publishEvent(
        input: PublishRallarGameAuthorityEventInput<TEvent>
    ): Promise<RallarGameAuthoritySendResult> {
        const result = await publishEnvelope({
            roomId: input.roomId,
            kind: 'event',
            typeId: typeIds.event,
            payload: input.event,
            roomRef: input.roomRef,
            toPeerId: input.toPeerId,
            fanout: config.eventFanout ?? 'live-only'
        });
        if (result.status === 'sent') {
            publishedEventCount += 1;
        }
        return result;
    }

    async function publishEnvelope<TPayload>(
        input: PublishRallarGameAuthorityEnvelopeInput<TPayload>
    ): Promise<RallarGameAuthoritySendResult> {
        if (stopped) {
            return { status: 'stopped', transport: 'server' };
        }

        const publication = toRallarGameAuthorityServerPublication({
            protocol: config.protocol,
            topicId: config.topicId,
            kind: input.kind,
            roomId: input.roomId,
            typeId: input.typeId,
            payload: input.payload,
            authority,
            sequence: nextSeq++,
            sentAtEpochMs: config.nowEpochMs(),
            ttlMs: config.ttlMs ?? DEFAULT_RALLAR_GAME_AUTHORITY_TTL_MS,
            roomRef: input.roomRef,
            toPeerId: input.toPeerId
        });
        const result = await config.rallar.ws.publish(
            publication.message,
            input.fanout
        );

        return {
            status: isSuccessfulPublishStatus(result.status) ? 'sent' : 'failed',
            transport: 'server',
            seq: publication.envelope.seq,
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
        value: JsonWireValue,
        context: Pick<RallarServerWsMessageContext, 'roomId' | 'senderId'>,
        kind: RallarGameAuthorityEnvelope<JsonWireValue>['kind']
    ): boolean {
        if (!isRallarGameAuthorityEnvelope(value, config.protocol)) {
            return false;
        }

        const envelope = value as RallarGameAuthorityEnvelope<JsonWireValue>;
        return envelope.kind === kind &&
            context.roomId !== undefined &&
            envelope.roomId === context.roomId &&
            envelope.senderId === context.senderId &&
            envelope.authority.kind === authority.kind &&
            envelope.authority.id === authority.id &&
            envelope.authority.epoch === authority.epoch;
    }

    function decodeIncomingCommand(
        value: JsonWireValue
    ): Readonly<{ command: TCommand; }> | undefined {
        try {
            return { command: config.decodeCommand(value) };
        }
        catch {
            return undefined;
        }
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
