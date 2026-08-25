import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarRealtimeMessage } from '@shared-web/browser/rallar.ts';
import type { RallarGameDirectorRelayRuntime } from '../director/rallar-game-director-relay-runtime.ts';
import {
    createRallarGameEnvelope,
    createRallarGameSequenceTracker,
    isRallarGameEnvelope,
    type RallarGameEnvelope,
    type RallarGameEnvelopeKind,
    type RallarGameSequenceTracker
} from '../envelopes.ts';
import type { RallarGameEnvelopeHandler, RallarGameMatchConfig } from './rallar-game-match-contracts.ts';
import type { RallarGameMatchEgressRuntime } from './rallar-game-match-egress-runtime.ts';
import type { RallarGameMatchStatusRuntime } from './rallar-game-match-status-runtime.ts';

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
    private readonly presenceHandlers = new Set<RallarGameEnvelopeHandler<TPresence>>();
    private nextSequence = 1;

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
        const roomId = options.roomId ?? room.roomId;
        const senderId = options.senderId ?? this.input.readLocalPeerId();
        if (!roomId) {
            throw new Error('Cannot create Rallar Game envelope without a room.');
        }
        if (!senderId) {
            throw new Error('Cannot create Rallar Game envelope without a local session.');
        }

        return createRallarGameEnvelope({
            protocol: this.input.config.protocol,
            kind,
            roomId,
            matchId: this.input.config.matchId,
            senderId,
            seq: this.nextSequence++,
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
        const status = this.input.status.current;
        const senderId = options.requireFreshDirectorSender
            ? status.directorPeerId
            : options.senderId;
        return this.sequenceTracker.accept(envelope, {
            protocol: this.input.config.protocol,
            roomId: this.input.readRoomTarget().roomId,
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
        this.presenceHandlers.add(handler);
        return () => this.presenceHandlers.delete(handler);
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
        for (const handler of this.presenceHandlers) {
            await handler(envelope);
        }
    }
}
