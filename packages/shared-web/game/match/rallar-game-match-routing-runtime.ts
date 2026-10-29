import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRealtimeMessage } from '@shared-web/browser/rallar.ts';
import { AsyncNotifications } from '@shared/cache/async-notifications.ts';
import type { RallarGameDirectorRelayRuntime } from '../director/rallar-game-director-relay-runtime.ts';
import {
    createRallarGameEnvelope,
    createRallarGameSequenceTracker,
    isRallarGameEnvelope,
    type RallarGameEnvelope,
    type RallarGameEnvelopeKind,
    type RallarGameSequenceTracker
} from '../envelopes.ts';
import type {
    RallarGameEnvelopeHandler,
    RallarGameMatchConfig,
    RallarGameRallarFacade
} from './rallar-game-match-contracts.ts';
import type { RallarGameMatchEgressRuntime } from './rallar-game-match-egress-runtime.ts';
import type { RallarGameMatchStatusRuntime } from './rallar-game-match-status-runtime.ts';
import { readRallarGameSessionGeneration, readRallarGameSessionRole } from './rallar-game-participation.ts';

export namespace RallarGameMatchRoutingRuntime {
    export interface Input<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        readonly config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>;
        readonly status: RallarGameMatchStatusRuntime;
        readRoomTarget(): RallarGameMatchStatusRuntime.RoomTarget;
        readLocalPeerId(): string | undefined;
    }
}

/** Owns game-envelope creation, sequence admission, and inbound match routing. */
export class RallarGameMatchRoutingRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    private readonly input: RallarGameMatchRoutingRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly sequenceTracker: RallarGameSequenceTracker = createRallarGameSequenceTracker();
    private readonly presenceNotifications = new AsyncNotifications<RallarGameEnvelope<TPresence>>();
    // The facade survives match-handle recreation. A reload gets a newly admitted presence
    // generation, while every handle in this browser shares one monotonic sender counter.
    private static readonly senderSequences = new WeakMap<RallarGameRallarFacade, number>();

    constructor(
        input: RallarGameMatchRoutingRuntime.Input<TInput, TIntent, TSnapshot, TEvent, TPresence>
    ) {
        this.input = input;
    }

    resetSequences(): void {
        this.sequenceTracker.reset();
    }

    createEnvelope<T>(
        kind: RallarGameEnvelopeKind,
        payload: T,
        options: RallarGameMatchEgressRuntime.EnvelopeOptions
    ): RallarGameEnvelope<T> {
        const room = this.input.readRoomTarget();
        const roomRef = room.roomRef;
        if (!roomRef || (options.roomId !== undefined && options.roomId !== roomRef.groupId)) {
            throw new Error('Cannot create Rallar Game envelope without the exact scoped room.');
        }
        const senderId = options.senderId ?? this.input.readLocalPeerId();
        if (!senderId) {
            throw new Error('Cannot create Rallar Game envelope without a local session.');
        }

        const senderGenerationId = readRallarGameSessionGeneration(
            this.input.config.rallar.rooms.state(),
            senderId,
            room
        );
        if (!senderGenerationId) {
            throw new Error('Cannot create Rallar Game envelope without admitted room presence.');
        }
        const seq = (RallarGameMatchRoutingRuntime.senderSequences.get(this.input.config.rallar) ?? 0) + 1;
        RallarGameMatchRoutingRuntime.senderSequences.set(this.input.config.rallar, seq);
        return createRallarGameEnvelope({
            protocol: this.input.config.protocol,
            kind,
            roomRef,
            matchId: this.input.config.matchId,
            senderId,
            senderGenerationId,
            seq,
            directorEpoch: options.directorEpoch,
            sentAtEpochMs: options.sentAtEpochMs,
            payload
        });
    }

    acceptEnvelope<T>(
        envelope: RallarGameEnvelope<T>,
        kind: RallarGameEnvelopeKind,
        options: Readonly<{
            senderId?: string;
            checkDirectorEpoch?: boolean;
            requireFreshDirectorSender?: boolean;
        }> = {}
    ): boolean {
        const role = readRallarGameSessionRole(
            this.input.config.rallar.rooms.state(),
            envelope.senderId,
            this.input.readRoomTarget()
        );
        if (role === undefined || (role === 'spectator' && kind !== 'sync-request')) {
            return false;
        }
        const generation = readRallarGameSessionGeneration(
            this.input.config.rallar.rooms.state(),
            envelope.senderId,
            this.input.readRoomTarget()
        );
        if (!generation || envelope.senderGenerationId !== generation) {
            return false;
        }
        const status = this.input.status.current;
        const senderId = options.requireFreshDirectorSender
            ? status.directorPeerId
            : options.senderId;
        return this.sequenceTracker.accept(envelope, {
            protocol: this.input.config.protocol,
            roomRef: this.input.readRoomTarget().roomRef,
            matchId: this.input.config.matchId,
            senderId,
            minDirectorEpoch: options.checkDirectorEpoch === false
                ? undefined
                : status.directorEpoch,
            kinds: [kind]
        }).accepted;
    }

    async routeEnvelope<T>(
        envelope: RallarGameEnvelope<T>,
        kind: RallarGameEnvelopeKind,
        handler: RallarGameEnvelopeHandler<T> | undefined
    ): Promise<void> {
        if (
            !this.input.status.isStopped &&
            this.acceptEnvelope(envelope, kind, { senderId: envelope.senderId })
        ) {
            await handler?.(envelope);
        }
    }

    async handleRealtimeInputOrPresence(
        message: RallarRealtimeMessage<RallarMessagePayload>
    ): Promise<void> {
        const envelope = message.data;
        if (!isRallarGameEnvelope(envelope, this.input.config.protocol)) {
            return;
        }

        if (envelope.kind === 'presence') {
            await this.handleRealtimePresence(
                message.peerId,
                envelope as RallarGameEnvelope<TPresence>
            );
            return;
        }

        if (this.input.status.isStopped || !this.input.status.current.directorIsFresh) {
            return;
        }

        const director = this.input.status.readFreshDirectorStatus();
        if (
            !director?.isDirector ||
            envelope.kind !== 'input' ||
            !this.acceptEnvelope(envelope, 'input', { senderId: message.peerId })
        ) {
            return;
        }

        await this.input.config.onInput?.(envelope as RallarGameEnvelope<TInput>);
    }

    async handleRealtimeSnapshot(
        message: RallarRealtimeMessage<RallarMessagePayload>
    ): Promise<void> {
        const status = this.input.status.current;
        if (this.input.status.isStopped || !status.directorIsFresh) {
            return;
        }

        const directorPeerId = status.directorPeerId;
        if (!directorPeerId || message.peerId !== directorPeerId) {
            return;
        }

        const envelope = message.data;
        if (
            !isRallarGameEnvelope(envelope, this.input.config.protocol) ||
            !this.acceptEnvelope(envelope, 'snapshot', {
                senderId: directorPeerId,
                requireFreshDirectorSender: true
            })
        ) {
            return;
        }

        this.input.status.recordSnapshot(envelope.sentAtEpochMs);
        await this.input.config.onSnapshot?.(envelope as RallarGameEnvelope<TSnapshot>);
    }

    async handleRelayEnvelope<T>(
        input: RallarGameDirectorRelayRuntime.EnvelopeInput<T>
    ): Promise<void> {
        if (
            this.input.status.isStopped ||
            !isRallarGameEnvelope(input.message.data, this.input.config.protocol) ||
            !this.acceptEnvelope(input.message.data, input.kind, {
                senderId: input.message.senderId,
                requireFreshDirectorSender: input.requireFreshDirectorSender
            })
        ) {
            return;
        }

        if (input.kind === 'snapshot') {
            this.input.status.recordSnapshot(input.message.data.sentAtEpochMs);
        }
        await input.handler?.(input.message.data);
    }

    onPresence(handler: RallarGameEnvelopeHandler<TPresence>): () => void {
        return this.presenceNotifications.subscribe(handler).unsubscribe;
    }

    private async handleRealtimePresence(
        peerId: string,
        envelope: RallarGameEnvelope<TPresence>
    ): Promise<void> {
        if (
            this.input.status.isStopped ||
            !this.acceptEnvelope(envelope, 'presence', {
                senderId: peerId,
                checkDirectorEpoch: false
            })
        ) {
            return;
        }

        await this.input.config.onPresence?.(envelope);
        await this.presenceNotifications.publishSequential(envelope);
    }
}
