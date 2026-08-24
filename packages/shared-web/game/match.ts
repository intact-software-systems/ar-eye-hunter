import type {
    RallarDirectorRelayMessage,
    RallarDirectorStatus,
    RallarMessage,
    RallarRealtimeMessage,
    RallarRealtimeSendResult,
    RallarRoomRealtimeSendResult,
    RallarRtcRoomLaneWaitResult,
    RallarRtcRoomLaneWaitStatus,
    RallarRtcStatus,
    RallarSubscriptionScope
} from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { deriveRallarGameDiagnostics } from './diagnostics.ts';
import {
    DEFAULT_RALLAR_GAME_CAPABILITY_TTL_MS,
    electRallarGameHost,
    scoreRallarGameHostCapability
} from './election.ts';
import { createRallarGameEnvelope, createRallarGameSequenceTracker, isRallarGameEnvelope } from './envelopes.ts';
import { resolveRallarGameLaneIds } from './lanes.ts';
import {
    decodeRallarGameHostCapability,
    publishRallarGameHostCapability,
    resolveDefaultRallarGamePeerIds
} from './match-capability.ts';
import { RallarGameDirectorAppointmentRuntime } from './rallar-game-director-appointment-runtime.ts';
import { RallarGameDirectorRelayRuntime } from './rallar-game-director-relay-runtime.ts';
import type { RallarGameFreshDirectorStatus } from './rallar-game-fresh-director-status.ts';
import { RallarGameMatchEgressRuntime, toRallarGameReliableEgressState } from './rallar-game-match-egress-runtime.ts';
import { RallarGamePresenceEgressRuntime } from './rallar-game-presence-egress-runtime.ts';
import type {
    RallarGameEgressState,
    RallarGameEnvelope,
    RallarGameEnvelopeHandler,
    RallarGameEnvelopeKind,
    RallarGameHostCapability,
    RallarGameHostElectionResult,
    RallarGameLaneIds,
    RallarGameLaneReadyOptions,
    RallarGameMatchConfig,
    RallarGameMatchHandle,
    RallarGameMatchPhase,
    RallarGameMatchStatus,
    RallarGamePeerReadiness,
    RallarGamePresenceSendOptions,
    RallarGameRecoveryState,
    RallarGameSendResult,
    RallarGameSequenceTracker,
    RallarGameStatusHandler,
    RallarGameTypeIds
} from './types.ts';

const DEFAULT_RALLAR_GAME_HEARTBEAT_TTL_MS = 10_000;

export function resolveRallarGameTypeIds(
    topicId: string,
    typeIds: Partial<RallarGameTypeIds> = {}
): RallarGameTypeIds {
    return {
        capability: `${topicId}.capability.v1`,
        intent: `${topicId}.intent.v1`,
        event: `${topicId}.event.v1`,
        snapshot: `${topicId}.snapshot.v1`,
        syncRequest: `${topicId}.sync-request.v1`,
        heartbeat: `${topicId}.heartbeat.v1`,
        ...typeIds
    };
}

export function createRallarGameMatch<TInput, TIntent, TSnapshot, TEvent, TPresence = TInput>(
    config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>
): RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    return new RallarGameMatchRuntime(config).handle;
}

interface RallarGameEnvelopeAcceptanceOptions {
    readonly senderId?: string;
    readonly checkDirectorEpoch?: boolean;
    readonly requireFreshDirectorSender?: boolean;
}

interface RallarGameMatchRoomTarget {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
}

class RallarGameMatchRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
    readonly handle: RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent, TPresence>;

    private readonly config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly laneIds: RallarGameLaneIds;
    private readonly typeIds: RallarGameTypeIds;
    private readonly capabilityTtlMs: number;
    private readonly heartbeatTtlMs: number;
    private readonly sequenceTracker: RallarGameSequenceTracker;
    private readonly capabilities = new Map<string, RallarGameHostCapability>();
    private readonly statusHandlers = new Set<RallarGameStatusHandler>();
    private readonly presenceHandlers = new Set<RallarGameEnvelopeHandler<TPresence>>();
    private readonly directorRelay: RallarGameDirectorRelayRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly egress: RallarGameMatchEgressRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly presenceEgress: RallarGamePresenceEgressRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;
    private readonly appointment: RallarGameDirectorAppointmentRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence>;

    private subscriptions: RallarSubscriptionScope | undefined;
    private started = false;
    private stopped = false;
    private nextSeq = 1;
    private reliableEgress: RallarGameEgressState = 'empty';
    private recovery: RallarGameRecoveryState = { status: 'idle' };
    private currentStatus: RallarGameMatchStatus;

    constructor(config: RallarGameMatchConfig<TInput, TIntent, TSnapshot, TEvent, TPresence>) {
        this.config = config;
        this.laneIds = resolveRallarGameLaneIds(config.laneIds);
        this.typeIds = resolveRallarGameTypeIds(config.topicId, config.typeIds);
        this.capabilityTtlMs = config.capabilityTtlMs ?? DEFAULT_RALLAR_GAME_CAPABILITY_TTL_MS;
        this.heartbeatTtlMs = config.heartbeatTtlMs ?? DEFAULT_RALLAR_GAME_HEARTBEAT_TTL_MS;
        this.sequenceTracker = createRallarGameSequenceTracker();
        this.directorRelay = this.createDirectorRelayRuntime();
        this.egress = this.createEgressRuntime();
        this.presenceEgress = this.createPresenceEgressRuntime();
        this.appointment = this.createAppointmentRuntime();
        this.currentStatus = this.createStatus('idle');
        this.handle = this.createHandle();
    }

    private createEgressRuntime(): RallarGameMatchEgressRuntime<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        return new RallarGameMatchEgressRuntime({
            config: this.config,
            laneIds: this.laneIds,
            isStopped: () => this.stopped,
            readRoomTarget: () => this.readRoomTarget(),
            readFreshDirectorStatus: () => this.readFreshDirectorStatus(),
            createEnvelope: (kind, payload, options) => this.createEnvelope(kind, payload, options),
            routeEnvelope: async (envelope, kind, handler) => await this.routeEnvelope(envelope, kind, handler),
            sendReliableSnapshot: async (envelope) => await this.directorRelay.sendSnapshot(envelope),
            refreshStatus: () => this.refreshStatus()
        });
    }

    private createDirectorRelayRuntime(): RallarGameDirectorRelayRuntime<
        TInput,
        TIntent,
        TSnapshot,
        TEvent,
        TPresence
    > {
        return new RallarGameDirectorRelayRuntime({
            config: this.config,
            laneIds: this.laneIds,
            typeIds: this.typeIds,
            heartbeatTtlMs: this.heartbeatTtlMs,
            isStopped: () => this.stopped,
            readFreshDirectorStatus: () => this.readFreshDirectorStatus(),
            createEnvelope: (kind, payload, options) => this.createEnvelope(kind, payload, options),
            routeEnvelope: async (envelope, kind, handler) => await this.routeEnvelope(envelope, kind, handler),
            handleEnvelope: async (input) => await this.handleRelayEnvelope(input),
            syncRequested: (atEpochMs) => this.recordSyncRequest(atEpochMs)
        });
    }

    private createPresenceEgressRuntime(): RallarGamePresenceEgressRuntime<
        TInput,
        TIntent,
        TSnapshot,
        TEvent,
        TPresence
    > {
        return new RallarGamePresenceEgressRuntime({
            config: this.config,
            laneIds: this.laneIds,
            isStopped: () => this.stopped,
            readStatus: () => this.currentStatus,
            readRoomTarget: () => this.readRoomTarget(),
            readLocalPeerId: () => this.readLocalPeerId(),
            readPeerReadiness: () => this.egress.peerReadiness,
            createEnvelope: (kind, payload, options) => this.createEnvelope(kind, payload, options)
        });
    }

    private createAppointmentRuntime(): RallarGameDirectorAppointmentRuntime<
        TInput,
        TIntent,
        TSnapshot,
        TEvent,
        TPresence
    > {
        return new RallarGameDirectorAppointmentRuntime({
            config: this.config,
            heartbeatTtlMs: this.heartbeatTtlMs,
            election: () => this.election(),
            readRoomTarget: () => this.readRoomTarget(),
            readDirectorStatus: () => this.readDirectorStatus(),
            refreshStatus: (status) => this.refreshStatus(status)
        });
    }

    private createHandle(): RallarGameMatchHandle<TInput, TIntent, TSnapshot, TEvent, TPresence> {
        return {
            start: async () => await this.start(),
            stop: () => this.stop(),
            status: () => this.currentStatus,
            diagnostics: () => this.diagnostics(),
            canAppointDirector: () => this.appointment.eligibility(),
            reportCapability: (capability) => this.reportCapability(capability),
            election: () => this.election(),
            appointIfElected: () => this.appointment.appointIfElected(),
            waitForReadyLanes: (options) => this.egress.waitForReadyLanes(options),
            sendPresence: (presence, options) => this.presenceEgress.send(presence, options),
            sendInput: (input) => this.egress.sendInput(input),
            sendIntent: (intent) => this.directorRelay.sendIntent(intent),
            publishSnapshot: (snapshot, options) => this.egress.publishSnapshot(snapshot, options),
            publishEvent: (event) => this.directorRelay.publishEvent(event),
            requestSync: (payload) => this.directorRelay.requestSync(payload),
            onPresence: (handler) => this.onPresence(handler),
            onStatus: (handler) => this.onStatus(handler)
        };
    }

    private diagnostics() {
        return deriveRallarGameDiagnostics({
            status: this.currentStatus,
            election: this.election(),
            appointment: this.appointment.eligibility(),
            lastAppointment: this.appointment.lastResult,
            peerReadiness: this.egress.peerReadiness,
            rtcStatus: this.safeReadRtcStatus(this.laneIds.input),
            wsStatus: this.safeReadWsStatus(),
            realtimeHealth: this.safeReadRealtimeHealth(this.laneIds),
            capabilities: [...this.capabilities.values()]
        });
    }

    private onPresence(handler: RallarGameEnvelopeHandler<TPresence>): () => void {
        this.presenceHandlers.add(handler);
        return () => this.presenceHandlers.delete(handler);
    }

    private onStatus(handler: RallarGameStatusHandler): () => void {
        this.statusHandlers.add(handler);
        void notifyRallarGameStatusHandler(handler, this.currentStatus);
        return () => this.statusHandlers.delete(handler);
    }

    private recordSyncRequest(atEpochMs: number): void {
        this.recovery = {
            ...this.recovery,
            lastSyncRequestedAtEpochMs: atEpochMs
        };
        this.refreshStatus();
    }

    private async start(): Promise<RallarGameMatchStatus> {
        if (this.started && !this.stopped) {
            return this.currentStatus;
        }

        this.started = true;
        this.stopped = false;
        this.sequenceTracker.reset();
        this.subscriptions = this.config.rallar.subscriptions();
        this.directorRelay.start();
        this.subscriptions
            .add(this.config.rallar.rooms.onChange(() => this.refreshStatus()))
            .add(this.config.rallar.people.onChange(() => this.refreshStatus()))
            .add(this.config.rallar.director.onStatus(() => this.refreshStatus()))
            .add(this.config.rallar.rtc.onStatus(() => this.refreshStatus()))
            .add(this.config.rallar.messages.ws.onMessage<RallarMessage['payload']>(
                { topicId: this.config.topicId, typeId: this.typeIds.capability },
                async (message) => await this.handleCapabilityMessage(message)
            ))
            .add(this.config.rallar.realtime.onJson<RallarMessage['payload']>(
                this.laneIds.input,
                async (message) => await this.handleRealtimeInputOrPresence(message)
            ))
            .add(this.config.rallar.realtime.onJson<RallarMessage['payload']>(
                this.laneIds.snapshot,
                async (message) => await this.handleRealtimeSnapshot(message)
            ))
            .add(() => this.directorRelay.stop());

        await this.refreshReliableEgress();
        this.refreshStatus();
        return this.currentStatus;
    }

    private stop(): void {
        if (this.stopped) {
            return;
        }

        this.stopped = true;
        this.started = false;
        this.subscriptions?.unsubscribe();
        this.subscriptions = undefined;
        this.directorRelay.stop();
        this.setStatus('stopped');
    }

    private stoppedResult(): RallarGameSendResult {
        return { status: 'stopped', reason: 'Rallar Game match is stopped.' };
    }

    private async reportCapability(
        capability: Partial<RallarGameHostCapability> = {}
    ): Promise<RallarGameSendResult> {
        if (this.stopped) {
            return this.stoppedResult();
        }

        const localPeerId = this.readLocalPeerId();
        if (!localPeerId) {
            return {
                status: 'failed',
                reason: 'Cannot report capability without a local session.'
            };
        }

        const room = this.readRoomTarget();
        if (!room.roomId) {
            return {
                status: 'failed',
                reason: 'Cannot report capability without a room.'
            };
        }

        const read = this.config.readCapability?.() ?? {};
        const appointmentEligibility = this.appointment.eligibility();
        const reportedAtEpochMs = Date.now();
        const report: RallarGameHostCapability = {
            ...read,
            ...capability,
            canHost: appointmentEligibility.allowed
                ? (capability.canHost ?? read.canHost)
                : false,
            peerId: localPeerId,
            reportedAtEpochMs
        };
        this.capabilities.set(localPeerId, report);

        const envelope = this.createEnvelope('capability', report, {
            directorEpoch: this.currentStatus.directorEpoch ?? 0,
            roomId: room.roomId,
            senderId: localPeerId,
            sentAtEpochMs: reportedAtEpochMs
        });
        const result = await publishRallarGameHostCapability({
            config: this.config,
            typeId: this.typeIds.capability,
            room: { roomId: room.roomId, roomRef: room.roomRef },
            envelope
        });
        this.refreshStatus();
        return result;
    }

    private election(): RallarGameHostElectionResult {
        const roomState = this.config.rallar.rooms.state();
        const peerIds = this.config.resolvePeerIds
            ? this.config.resolvePeerIds(roomState)
            : resolveDefaultRallarGamePeerIds(roomState, this.readLocalPeerId());
        const appointmentEligibility = this.appointment.eligibility();
        const capabilityValues = [...this.capabilities.values()];
        if (!appointmentEligibility.allowed && appointmentEligibility.localPeerId) {
            const previous = this.capabilities.get(appointmentEligibility.localPeerId);
            capabilityValues.push({
                ...previous,
                peerId: appointmentEligibility.localPeerId,
                reportedAtEpochMs: Date.now(),
                canHost: false
            });
        }

        return electRallarGameHost({
            peerIds,
            capabilities: capabilityValues,
            capabilityTtlMs: this.capabilityTtlMs,
            scoreHost: this.config.scoreHost ?? scoreRallarGameHostCapability
        });
    }

    private async handleCapabilityMessage(
        message: RallarMessage
    ): Promise<void> {
        if (this.stopped || !isRallarGameEnvelope(message.payload, this.config.protocol)) {
            return;
        }

        const accepted = this.acceptEnvelope(message.payload, 'capability', {
            senderId: message.senderId,
            checkDirectorEpoch: false
        });
        if (!accepted) {
            return;
        }

        const capability = decodeRallarGameHostCapability(message.payload);
        if (!capability) {
            return;
        }

        this.capabilities.set(capability.peerId, capability);
        this.refreshStatus();
    }

    private async handleRealtimeInputOrPresence(
        message: RallarRealtimeMessage<RallarMessage['payload']>
    ): Promise<void> {
        const envelope = message.data;
        if (!isRallarGameEnvelope(envelope, this.config.protocol)) {
            return;
        }

        if (envelope.kind === 'presence') {
            await this.handleRealtimePresence(
                message.peerId,
                envelope as RallarGameEnvelope<TPresence>
            );
            return;
        }

        if (this.stopped || !this.currentStatus.directorIsFresh) {
            return;
        }

        const director = this.readFreshDirectorStatus();
        if (!director?.isDirector) {
            return;
        }

        if (
            envelope.kind !== 'input' ||
            !this.acceptEnvelope(envelope, 'input', { senderId: message.peerId })
        ) {
            return;
        }

        await this.config.onInput?.(envelope as RallarGameEnvelope<TInput>);
    }

    private async handleRealtimePresence(
        peerId: string,
        envelope: RallarGameEnvelope<TPresence>
    ): Promise<void> {
        if (
            this.stopped ||
            !this.acceptEnvelope(envelope, 'presence', {
                senderId: peerId,
                checkDirectorEpoch: false
            })
        ) {
            return;
        }

        await this.config.onPresence?.(envelope);
        for (const handler of this.presenceHandlers) {
            await handler(envelope);
        }
    }

    private async handleRealtimeSnapshot(
        message: RallarRealtimeMessage<RallarMessage['payload']>
    ): Promise<void> {
        if (this.stopped || !this.currentStatus.directorIsFresh) {
            return;
        }

        const directorPeerId = this.currentStatus.directorPeerId;
        if (!directorPeerId || message.peerId !== directorPeerId) {
            return;
        }

        const envelope = message.data;
        if (
            !isRallarGameEnvelope(envelope, this.config.protocol) ||
            !this.acceptEnvelope(envelope, 'snapshot', {
                senderId: directorPeerId,
                requireFreshDirectorSender: true
            })
        ) {
            return;
        }

        this.recovery = {
            status: this.recovery.status === 'recovering' ? 'synced' : this.recovery.status,
            lastSnapshotAtEpochMs: envelope.sentAtEpochMs
        };
        this.refreshStatus();
        await this.config.onSnapshot?.(envelope as RallarGameEnvelope<TSnapshot>);
    }

    private async handleRelayEnvelope<T>(
        input: RallarGameDirectorRelayRuntime.EnvelopeInput<T>
    ): Promise<void> {
        if (this.stopped || !isRallarGameEnvelope(input.message.data, this.config.protocol)) {
            return;
        }

        if (
            !this.acceptEnvelope(input.message.data, input.kind, {
                senderId: input.message.senderId,
                requireFreshDirectorSender: input.requireFreshDirectorSender
            })
        ) {
            return;
        }

        if (input.kind === 'snapshot') {
            this.recovery = {
                status: this.recovery.status === 'recovering' ? 'synced' : this.recovery.status,
                lastSnapshotAtEpochMs: input.message.data.sentAtEpochMs
            };
            this.refreshStatus();
        }

        await input.handler?.(input.message.data);
    }

    private acceptEnvelope(
        envelope: RallarGameEnvelope<unknown>,
        kind: RallarGameEnvelopeKind,
        options: RallarGameEnvelopeAcceptanceOptions = {}
    ): boolean {
        const room = this.readRoomTarget();
        const directorEpoch = options.checkDirectorEpoch === false
            ? undefined
            : this.currentStatus.directorEpoch;
        const senderId = options.requireFreshDirectorSender
            ? this.currentStatus.directorPeerId
            : options.senderId;
        const accepted = this.sequenceTracker.accept(envelope, {
            protocol: this.config.protocol,
            roomId: room.roomId,
            matchId: this.config.matchId,
            senderId,
            minDirectorEpoch: directorEpoch,
            kinds: [kind]
        });

        return accepted.accepted;
    }

    private async routeEnvelope<T>(
        envelope: RallarGameEnvelope<T>,
        kind: RallarGameEnvelopeKind,
        handler: RallarGameEnvelopeHandler<T> | undefined
    ): Promise<void> {
        if (
            !this.stopped &&
            this.acceptEnvelope(envelope, kind, {
                senderId: envelope.senderId
            })
        ) {
            await handler?.(envelope);
        }
    }

    private refreshStatus(
        directorStatus: RallarDirectorStatus = this.readDirectorStatus()
    ): void {
        if (this.stopped) {
            return;
        }

        const nextPhase: RallarGameMatchPhase = !this.started
            ? 'idle'
            : directorStatus.isFresh
            ? 'active'
            : 'recovering';
        if (this.started && !directorStatus.isFresh) {
            this.recovery = {
                status: 'recovering',
                reason: 'No fresh director is available.',
                sinceEpochMs: this.recovery.status === 'recovering'
                    ? this.recovery.sinceEpochMs
                    : Date.now(),
                lastSyncRequestedAtEpochMs: this.recovery.lastSyncRequestedAtEpochMs,
                lastSnapshotAtEpochMs: this.recovery.lastSnapshotAtEpochMs
            };
        }
        else if (directorStatus.isFresh && this.recovery.status === 'recovering') {
            this.recovery = {
                status: 'idle',
                lastSnapshotAtEpochMs: this.recovery.lastSnapshotAtEpochMs
            };
        }

        this.setStatus(nextPhase, directorStatus);
    }

    private async refreshReliableEgress(): Promise<void> {
        const room = this.readRoomTarget();
        if (!room.roomId) {
            this.reliableEgress = 'empty';
            return;
        }

        try {
            const presence = await this.config.rallar.rooms.waitForPresence(
                room.roomRef ?? room.roomId,
                {
                    expect: { min: 1 },
                    timeoutMs: 0
                }
            );
            this.reliableEgress = toRallarGameReliableEgressState(presence.status);
        }
        catch {
            this.reliableEgress = 'failed';
        }
    }

    private setStatus(
        phase: RallarGameMatchPhase,
        directorStatus: RallarDirectorStatus = this.readDirectorStatus(),
        reason?: string
    ): void {
        this.currentStatus = this.createStatus(phase, directorStatus, reason);
        this.emitStatus(this.currentStatus);
    }

    private createStatus(
        phase: RallarGameMatchPhase,
        directorStatus: RallarDirectorStatus = this.readDirectorStatus(),
        reason?: string
    ): RallarGameMatchStatus {
        const room = this.readRoomTarget(directorStatus);
        return {
            phase,
            protocol: this.config.protocol,
            topicId: this.config.topicId,
            roomId: room.roomId,
            roomRef: room.roomRef,
            localPeerId: this.readLocalPeerId(),
            directorPeerId: directorStatus.appointment?.sessionId,
            directorEpoch: directorStatus.appointment?.epoch,
            directorIsFresh: directorStatus.isFresh,
            directorAuthority: this.toDirectorAuthority(directorStatus),
            egress: {
                reliable: this.reliableEgress,
                realtime: this.egress.realtimeState
            },
            recovery: this.recovery,
            started: this.started,
            stopped: this.stopped,
            updatedAtEpochMs: Date.now(),
            reason
        };
    }

    private toDirectorAuthority(
        directorStatus: RallarDirectorStatus
    ): RallarGameMatchStatus['directorAuthority'] {
        const localPeerId = this.readLocalPeerId();
        if (
            localPeerId &&
            directorStatus.appointment?.sessionId === localPeerId
        ) {
            return directorStatus.isFresh ? 'active' : 'stale';
        }

        if (!directorStatus.appointment && this.appointment.eligibility().allowed) {
            return 'candidate';
        }

        return 'none';
    }

    private readFreshDirectorStatus(): RallarGameFreshDirectorStatus | undefined {
        const status = this.readDirectorStatus();
        if (!status.isFresh || !status.appointment) {
            this.refreshStatus(status);
            return undefined;
        }
        this.refreshStatus(status);
        return status as RallarGameFreshDirectorStatus;
    }

    private readDirectorStatus(): RallarDirectorStatus {
        const room = this.readRoomTarget();
        return this.config.rallar.director.status(room.roomRef ?? room.roomId);
    }

    private readRoomTarget(
        directorStatus?: RallarDirectorStatus
    ): RallarGameMatchRoomTarget {
        const roomState = this.config.rallar.rooms.state();
        const roomRef = this.config.roomRef ??
            directorStatus?.roomRef ??
            roomState.currentRoomRef;
        const roomId = this.config.roomId ??
            roomRef?.groupId ??
            directorStatus?.roomId ??
            roomState.currentRoomId;
        return { roomId, roomRef };
    }

    private readLocalPeerId(): string | undefined {
        return this.config.rallar.session()?.sessionId;
    }

    private createEnvelope<T>(
        kind: RallarGameEnvelopeKind,
        payload: T,
        options: RallarGameMatchEgressRuntime.EnvelopeOptions
    ): RallarGameEnvelope<T> {
        const room = this.readRoomTarget();
        const roomId = options.roomId ?? room.roomId;
        const senderId = options.senderId ?? this.readLocalPeerId();
        if (!roomId) {
            throw new Error('Cannot create Rallar Game envelope without a room.');
        }
        if (!senderId) {
            throw new Error(
                'Cannot create Rallar Game envelope without a local session.'
            );
        }

        return createRallarGameEnvelope({
            protocol: this.config.protocol,
            kind,
            roomId,
            matchId: this.config.matchId,
            senderId,
            seq: this.nextSeq++,
            directorEpoch: options.directorEpoch,
            sentAtEpochMs: options.sentAtEpochMs,
            payload
        });
    }

    private safeReadRtcStatus(laneId: string): RallarRtcStatus | undefined {
        try {
            return this.config.rallar.rtc.status({ laneId });
        }
        catch {
            return undefined;
        }
    }

    private safeReadWsStatus() {
        try {
            return this.config.rallar.ws.status();
        }
        catch {
            return undefined;
        }
    }

    private safeReadRealtimeHealth(lanes: RallarGameLaneIds) {
        try {
            return this.config.rallar.realtime.health({
                laneIds: [
                    lanes.input,
                    lanes.intent,
                    lanes.snapshot,
                    lanes.metrics,
                    lanes.replication
                ]
            });
        }
        catch {
            return [];
        }
    }

    private emitStatus(status: RallarGameMatchStatus): void {
        for (const handler of this.statusHandlers) {
            void notifyRallarGameStatusHandler(handler, status);
        }
    }
}

async function notifyRallarGameStatusHandler(
    handler: RallarGameStatusHandler,
    status: RallarGameMatchStatus
): Promise<void> {
    try {
        await handler(status);
    }
    catch (error) {
        console.error('Error notifying Rallar Game status handler', error);
    }
}
