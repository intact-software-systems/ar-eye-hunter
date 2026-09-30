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
    RallarServerWsPublishInputDto,
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
        input: RallarServerWsPublishInputDto
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
    readonly roomRef: GroupRef;
    readonly toPeerId?: string;
}

export interface PublishRallarGameAuthorityEventInput<TEvent> {
    readonly roomId: string;
    readonly event: TEvent;
    readonly roomRef: GroupRef;
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
    readonly roomRef: GroupRef;
}

interface PublishRallarGameAuthorityEnvelopeInput<TPayload> {
    readonly roomId: string;
    readonly kind: RallarGameAuthorityEnvelope<TPayload>['kind'];
    readonly typeId: string;
    readonly payload: TPayload;
    readonly roomRef: GroupRef;
    readonly toPeerId?: string;
    readonly fanout: RallarServerWsFanout;
}

const DEFAULT_RALLAR_GAME_AUTHORITY_SERVER_ID = 'rallar-game-authority-server';
const DEFAULT_RALLAR_GAME_AUTHORITY_SERVER_EPOCH = 1;
const DEFAULT_RALLAR_GAME_AUTHORITY_TTL_MS = 15_000;
const GAME_PUBLICATION_STATUS = {
    'sent-live': 'sent',
    'cluster-published': 'sent',
    'queued-outbox': 'sent',
    none: 'skipped',
    'no-recipients': 'skipped',
    skipped: 'skipped',
    duplicate: 'skipped',
    superseded: 'skipped',
    expired: 'skipped',
    'partial-failure': 'partial',
    'no-route': 'failed',
    'rate-limited': 'failed',
    'circuit-open': 'failed',
    failed: 'failed'
} as const satisfies Record<RallarServerWsPublishResult['status'], RallarGameAuthoritySendResult['status']>;

export function installRallarGameAuthorityServer<TCommand, TSnapshot, TEvent>(
    config: RallarGameAuthorityServerConfig<TCommand, TSnapshot, TEvent>
): RallarGameAuthorityServerHandle<TSnapshot, TEvent> {
    return new RallarGameAuthorityServer(config).install();
}

class RallarGameAuthorityServer<TCommand, TSnapshot, TEvent>
    implements RallarGameAuthorityServerHandle<TSnapshot, TEvent> {
    private readonly config: RallarGameAuthorityServerConfig<TCommand, TSnapshot, TEvent>;
    private readonly authorityRef: RallarGameAuthorityRef;
    private readonly typeIds: RallarGameAuthorityTypeIds;
    private readonly sequenceTracker = createRallarGameAuthoritySequenceTracker();
    private readonly unsubscribes: Array<() => boolean> = [];
    private stopped = false;
    private handledCommandCount = 0;
    private rejectedCommandCount = 0;
    private syncRequestCount = 0;
    private publishedSnapshotCount = 0;
    private publishedEventCount = 0;
    private nextSeq = 1;

    constructor(config: RallarGameAuthorityServerConfig<TCommand, TSnapshot, TEvent>) {
        this.config = config;
        this.authorityRef = {
            kind: config.authority?.kind ?? 'server',
            id: config.authority?.id ?? DEFAULT_RALLAR_GAME_AUTHORITY_SERVER_ID,
            epoch: config.authority?.epoch ?? DEFAULT_RALLAR_GAME_AUTHORITY_SERVER_EPOCH
        };
        this.typeIds = resolveRallarGameAuthorityTypeIds(
            config.topicId,
            config.typeIds
        );
    }

    install(): this {
        this.config.rallar.ws.defineTopic<RallarGameAuthorityEnvelope<JsonWireValue>>({
            topicId: this.config.topicId,
            typeId: this.typeIds.command,
            scope: 'room',
            fanout: 'none',
            validate: (value, context) => this.isIncomingEnvelope(value, context, 'command')
        });
        this.config.rallar.ws.defineTopic<RallarGameAuthorityEnvelope<JsonWireValue>>({
            topicId: this.config.topicId,
            typeId: this.typeIds.syncRequest,
            scope: 'room',
            fanout: 'none',
            validate: (value, context) => this.isIncomingEnvelope(value, context, 'sync-request')
        });

        this.unsubscribes.push(
            this.config.rallar.ws.on<RallarGameAuthorityEnvelope<JsonWireValue>>(
                { topicId: this.config.topicId, typeId: this.typeIds.command },
                (message, context) => this.handleCommandMessage(message, context)
            )
        );
        this.unsubscribes.push(
            this.config.rallar.ws.on<RallarGameAuthorityEnvelope<JsonWireValue>>(
                { topicId: this.config.topicId, typeId: this.typeIds.syncRequest },
                (message, context) => this.handleSyncRequestMessage(message, context)
            )
        );

        return this;
    }

    authority(): RallarGameAuthorityRef {
        return this.authorityRef;
    }

    status(): RallarGameAuthorityServerStatus {
        return {
            protocol: this.config.protocol,
            topicId: this.config.topicId,
            authority: this.authorityRef,
            stopped: this.stopped,
            handledCommandCount: this.handledCommandCount,
            rejectedCommandCount: this.rejectedCommandCount,
            syncRequestCount: this.syncRequestCount,
            publishedSnapshotCount: this.publishedSnapshotCount,
            publishedEventCount: this.publishedEventCount
        };
    }

    private async handleCommandMessage(
        message: RallarServerWsMessage<RallarGameAuthorityEnvelope<JsonWireValue>>,
        context: RallarServerWsMessageContext
    ): Promise<void> {
        if (this.stopped || !hasAuthorizedRoomRef(context, message.payload.roomId)) {
            return;
        }

        const decodedCommand = this.decodeIncomingCommand(message.payload.payload);
        if (
            decodedCommand === undefined ||
            !this.acceptIncomingEnvelope(message.payload, 'command', context)
        ) {
            return;
        }

        this.handledCommandCount += 1;
        const outcome = await this.config.handleCommand({
            command: decodedCommand.command,
            envelope: message.payload,
            roomId: message.payload.roomId,
            senderId: context.senderId,
            raw: message,
            context
        });
        if (outcome.status === 'rejected') {
            this.rejectedCommandCount += 1;
        }
        await this.publishCommandResult({
            roomId: message.payload.roomId,
            toPeerId: context.senderId,
            commandResult: {
                commandSeq: message.payload.seq,
                status: outcome.status,
                ...(outcome.status === 'rejected' ? { reason: outcome.reason } : {})
            },
            roomRef: context.roomRef
        });
        if (outcome.status === 'rejected') {
            return;
        }
        if (outcome.snapshot !== undefined) {
            await this.publishSnapshot({
                roomId: message.payload.roomId,
                snapshot: outcome.snapshot,
                roomRef: context.roomRef
            });
        }

        for (const event of outcome.events ?? []) {
            await this.publishEvent({
                roomId: message.payload.roomId,
                event,
                roomRef: context.roomRef
            });
        }
    }

    private async handleSyncRequestMessage(
        message: RallarServerWsMessage<RallarGameAuthorityEnvelope<JsonWireValue>>,
        context: RallarServerWsMessageContext
    ): Promise<void> {
        if (
            this.stopped ||
            !hasAuthorizedRoomRef(context, message.payload.roomId) ||
            !this.acceptIncomingEnvelope(message.payload, 'sync-request', context)
        ) {
            return;
        }

        this.syncRequestCount += 1;
        const snapshot = await this.config.readSnapshot?.({
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

        await this.publishSnapshot({
            roomId: message.payload.roomId,
            snapshot,
            roomRef: context.roomRef,
            toPeerId: context.senderId
        });
    }

    private async publishCommandResult(
        input: PublishRallarGameAuthorityCommandResultInput
    ): Promise<RallarGameAuthoritySendResult> {
        return await this.publishEnvelope({
            roomId: input.roomId,
            kind: 'command-result',
            typeId: this.typeIds.commandResult,
            payload: input.commandResult,
            roomRef: input.roomRef,
            toPeerId: input.toPeerId,
            fanout: this.config.commandResultFanout ?? 'live-only'
        });
    }

    async publishSnapshot(
        input: PublishRallarGameAuthoritySnapshotInput<TSnapshot>
    ): Promise<RallarGameAuthoritySendResult> {
        const result = await this.publishEnvelope({
            roomId: input.roomId,
            kind: 'snapshot',
            typeId: this.typeIds.snapshot,
            payload: input.snapshot,
            roomRef: input.roomRef,
            toPeerId: input.toPeerId,
            fanout: this.config.snapshotFanout ?? 'live-only'
        });
        if (result.status === 'sent') {
            this.publishedSnapshotCount += 1;
        }
        return result;
    }

    async publishEvent(
        input: PublishRallarGameAuthorityEventInput<TEvent>
    ): Promise<RallarGameAuthoritySendResult> {
        const result = await this.publishEnvelope({
            roomId: input.roomId,
            kind: 'event',
            typeId: this.typeIds.event,
            payload: input.event,
            roomRef: input.roomRef,
            toPeerId: input.toPeerId,
            fanout: this.config.eventFanout ?? 'live-only'
        });
        if (result.status === 'sent') {
            this.publishedEventCount += 1;
        }
        return result;
    }

    private async publishEnvelope<TPayload>(
        input: PublishRallarGameAuthorityEnvelopeInput<TPayload>
    ): Promise<RallarGameAuthoritySendResult> {
        if (this.stopped) {
            return { status: 'stopped', transport: 'server' };
        }
        if (input.roomRef.groupId !== input.roomId) {
            return { status: 'failed', transport: 'server', reason: 'room-ref-mismatch' };
        }

        const publication = toRallarGameAuthorityServerPublication({
            protocol: this.config.protocol,
            topicId: this.config.topicId,
            kind: input.kind,
            roomId: input.roomId,
            typeId: input.typeId,
            payload: input.payload,
            authority: this.authorityRef,
            sequence: this.nextSeq++,
            sentAtEpochMs: this.config.nowEpochMs(),
            ttlMs: this.config.ttlMs ?? DEFAULT_RALLAR_GAME_AUTHORITY_TTL_MS,
            roomRef: input.roomRef,
            toPeerId: input.toPeerId
        });
        const result = await this.config.rallar.ws.publish({
            message: publication.message,
            ...(publication.message.targets?.mode === 'unicast'
                ? { scope: { applicationId: input.roomRef.applicationId, workspaceId: input.roomRef.workspaceId } }
                : {}),
            fanout: input.fanout
        });
        const status = GAME_PUBLICATION_STATUS[result.status];

        return {
            status,
            transport: 'server',
            seq: publication.envelope.seq,
            raw: result,
            reason: result.reason ?? (status === 'sent' ? undefined : result.status)
        };
    }

    private acceptIncomingEnvelope<T>(
        envelope: RallarGameAuthorityEnvelope<T>,
        kind: RallarGameAuthorityEnvelope<T>['kind'],
        context: RallarServerWsMessageContext & Readonly<{ roomId: string; roomRef: GroupRef; }>
    ): boolean {
        if (!isRallarGameAuthorityEnvelope(envelope, this.config.protocol)) {
            return false;
        }

        return this.sequenceTracker.accept(envelope, {
            protocol: this.config.protocol,
            roomId: context.roomId,
            senderId: context.senderId,
            authorityKind: this.authorityRef.kind,
            authorityId: this.authorityRef.id,
            minAuthorityEpoch: this.authorityRef.epoch,
            kinds: [kind]
        }).accepted;
    }

    private isIncomingEnvelope(
        value: JsonWireValue,
        context: RallarServerWsMessageContext,
        kind: RallarGameAuthorityEnvelope<JsonWireValue>['kind']
    ): boolean {
        if (!isRallarGameAuthorityEnvelope(value, this.config.protocol)) {
            return false;
        }

        const envelope = value as RallarGameAuthorityEnvelope<JsonWireValue>;
        return envelope.kind === kind &&
            hasAuthorizedRoomRef(context, envelope.roomId) &&
            envelope.senderId === context.senderId &&
            envelope.authority.kind === this.authorityRef.kind &&
            envelope.authority.id === this.authorityRef.id &&
            envelope.authority.epoch === this.authorityRef.epoch;
    }

    private decodeIncomingCommand(
        value: JsonWireValue
    ): Readonly<{ command: TCommand; }> | undefined {
        try {
            return { command: this.config.decodeCommand(value) };
        }
        catch {
            return undefined;
        }
    }

    stop(): void {
        if (this.stopped) {
            return;
        }

        this.stopped = true;
        for (const unsubscribe of this.unsubscribes) {
            unsubscribe();
        }
    }
}

function hasAuthorizedRoomRef(
    context: RallarServerWsMessageContext,
    roomId: string
): context is RallarServerWsMessageContext & Readonly<{ roomId: string; roomRef: GroupRef; }> {
    return context.roomId === roomId && context.roomRef?.groupId === roomId;
}
