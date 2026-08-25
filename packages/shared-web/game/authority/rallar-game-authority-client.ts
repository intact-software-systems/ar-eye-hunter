import type {
    RallarMessage,
    RallarRtcStatus,
    RallarSubscriptionScope,
    RallarUnsubscribe
} from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    createRallarGameAuthorityEnvelope,
    createRallarGameAuthoritySequenceTracker,
    deriveRallarGameAuthorityDiagnostics,
    isRallarGameAuthorityEnvelope,
    resolveRallarGameAuthorityTypeIds,
    type RallarGameAuthorityClientStatus,
    type RallarGameAuthorityCommandResult,
    type RallarGameAuthorityDiagnostics,
    type RallarGameAuthorityEnvelope,
    type RallarGameAuthorityEnvelopeKind,
    type RallarGameAuthoritySendResult,
    type RallarGameAuthorityStatusHandler,
    type RallarGameAuthorityTypeIds
} from '@shared/rallar-game/mod.ts';
import type {
    RallarGameAuthorityClientConfig,
    RallarGameAuthorityClientHandle,
    RallarGameAuthorityCommandOptions
} from './rallar-game-authority-client-contracts.ts';
import {
    decodeAuthorityCommandResult,
    isSuccessfulAuthorityMessageStatus,
    notReadyAuthoritySendResult
} from './rallar-game-authority-message-results.ts';

interface RallarGameAuthorityRoomTarget {
    readonly roomId?: string;
    readonly roomRef?: GroupRef;
}

interface SendAuthorityWsEnvelopeOptions {
    readonly reliability: 'best-effort' | 'at-least-once';
    readonly ack: 'none' | 'receiver';
    readonly key?: string;
    readonly trackPending?: boolean;
}

interface SendAuthorityWsEnvelopeInput<T> {
    readonly kind: RallarGameAuthorityEnvelope<T>['kind'];
    readonly payload: T;
    readonly typeId: string;
    readonly options: SendAuthorityWsEnvelopeOptions;
}

interface AuthorityEnvelopeSender {
    readonly roomId: string;
    readonly senderId: string;
}

interface AuthorityEnvelopeAcceptanceOptions {
    readonly senderId?: string;
}

export class RallarGameAuthorityClient<TCommand, TSnapshot, TEvent, TPresence = never>
    implements RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence> {
    private readonly config: RallarGameAuthorityClientConfig<TCommand, TSnapshot, TEvent, TPresence>;
    private readonly typeIds: RallarGameAuthorityTypeIds;
    private readonly sequenceTracker = createRallarGameAuthoritySequenceTracker();
    private readonly statusHandlers = new Set<RallarGameAuthorityStatusHandler>();
    private readonly pendingCommands = new Map<number, number>();
    private subscriptions: RallarSubscriptionScope | undefined;
    private started = false;
    private stopped = false;
    private nextSeq = 1;
    private lastRtcStatus: RallarRtcStatus | undefined;
    private lastPresenceAtEpochMs: number | undefined;
    private lastSnapshotRepairAtEpochMs: number | undefined;
    private lastAuthoritySeenAtEpochMs: number | undefined;
    private lastCommandResultAtEpochMs: number | undefined;
    private lastSnapshotAtEpochMs: number | undefined;
    private lastEventAtEpochMs: number | undefined;
    private currentStatus: RallarGameAuthorityClientStatus;

    public constructor(
        config: RallarGameAuthorityClientConfig<TCommand, TSnapshot, TEvent, TPresence>
    ) {
        this.config = config;
        this.typeIds = resolveRallarGameAuthorityTypeIds(
            config.topicId,
            config.typeIds
        );
        this.currentStatus = this.createStatus('idle');
    }

    public async start(): Promise<RallarGameAuthorityClientStatus> {
        if (this.started && !this.stopped) {
            return this.currentStatus;
        }
        this.started = true;
        this.stopped = false;
        this.sequenceTracker.reset();
        this.subscriptions = this.config.rallar.subscriptions();
        this.subscribeToState();
        this.subscribeToAuthorityMessages();
        this.subscribeToPeerAssistMessages();
        this.refreshStatus();
        return this.currentStatus;
    }

    public stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.started = false;
        this.pendingCommands.clear();
        this.subscriptions?.unsubscribe();
        this.subscriptions = undefined;
        this.setStatus('stopped');
    }

    public status(): RallarGameAuthorityClientStatus {
        return this.currentStatus;
    }

    public diagnostics(): RallarGameAuthorityDiagnostics {
        return deriveRallarGameAuthorityDiagnostics({ status: this.currentStatus });
    }

    public async sendCommand(
        command: TCommand,
        options: RallarGameAuthorityCommandOptions = {}
    ): Promise<RallarGameAuthoritySendResult> {
        return await this.sendWsEnvelope({
            kind: 'command',
            payload: command,
            typeId: this.typeIds.command,
            options: {
                reliability: 'at-least-once',
                ack: 'receiver',
                key: options.key,
                trackPending: true
            }
        });
    }

    public async requestSync<TPayload>(payload?: TPayload): Promise<RallarGameAuthoritySendResult> {
        return await this.sendWsEnvelope({
            kind: 'sync-request',
            payload: payload ?? {},
            typeId: this.typeIds.syncRequest,
            options: { reliability: 'at-least-once', ack: 'receiver' }
        });
    }

    public async publishPresence(
        presence: TPresence
    ): Promise<RallarGameAuthoritySendResult> {
        if (!this.config.peerAssist?.enabled) {
            return {
                status: 'skipped',
                transport: 'rtc',
                reason: 'Peer assist is disabled.'
            };
        }
        return await this.sendRtcEnvelope('presence', presence, this.typeIds.presence);
    }

    public async publishSnapshotRepair(
        snapshot: TSnapshot
    ): Promise<RallarGameAuthoritySendResult> {
        if (!this.config.peerAssist?.snapshotRepair) {
            return {
                status: 'skipped',
                transport: 'rtc',
                reason: 'Peer snapshot repair is disabled.'
            };
        }
        return await this.sendRtcEnvelope('snapshot', snapshot, this.typeIds.snapshot);
    }

    public onStatus(handler: RallarGameAuthorityStatusHandler): RallarUnsubscribe {
        this.statusHandlers.add(handler);
        void notifyStatusHandler(handler, this.currentStatus);
        return () => {
            this.statusHandlers.delete(handler);
        };
    }

    private subscribeToState(): void {
        this.subscriptions
            ?.add(this.config.rallar.rooms.onChange(() => this.refreshStatus()))
            .add(this.config.rallar.rtc.onStatus((status) => {
                this.lastRtcStatus = status;
                this.refreshStatus();
            }));
    }

    private subscribeToAuthorityMessages(): void {
        this.subscriptions
            ?.add(
                this.config.rallar.messages.ws.onMessage<RallarGameAuthorityEnvelope<RallarGameAuthorityCommandResult>>(
                    { topicId: this.config.topicId, typeId: this.typeIds.commandResult },
                    async (message) => await this.handleCommandResultMessage(message)
                )
            )
            .add(this.config.rallar.messages.ws.onMessage<RallarGameAuthorityEnvelope<TSnapshot>>(
                { topicId: this.config.topicId, typeId: this.typeIds.snapshot },
                async (message) => await this.handleWsSnapshotMessage(message)
            ))
            .add(this.config.rallar.messages.ws.onMessage<RallarGameAuthorityEnvelope<TEvent>>(
                { topicId: this.config.topicId, typeId: this.typeIds.event },
                async (message) => await this.handleEventMessage(message)
            ));
    }

    private subscribeToPeerAssistMessages(): void {
        this.subscriptions
            ?.add(this.config.rallar.messages.rtc.onMessage<RallarGameAuthorityEnvelope<TSnapshot>>(
                { topicId: this.config.topicId, typeId: this.typeIds.snapshot },
                async (message) => await this.handleRtcSnapshotMessage(message)
            ))
            .add(this.config.rallar.messages.rtc.onMessage<RallarGameAuthorityEnvelope<TPresence>>(
                { topicId: this.config.topicId, typeId: this.typeIds.presence },
                async (message) => await this.handlePresenceMessage(message)
            ));
    }

    private async sendWsEnvelope<T>(
        input: SendAuthorityWsEnvelopeInput<T>
    ): Promise<RallarGameAuthoritySendResult> {
        if (this.stopped) {
            return { status: 'stopped', transport: 'ws' };
        }
        const room = this.readRoomTarget();
        const senderId = this.readLocalPeerId();
        if (!room.roomId || !senderId) {
            this.refreshStatus();
            return notReadyAuthoritySendResult('ws');
        }
        const envelope = this.createEnvelope(input.kind, input.payload, {
            roomId: room.roomId,
            senderId
        });
        if (input.options.trackPending) {
            this.pendingCommands.set(envelope.seq, envelope.sentAtEpochMs);
        }
        const result = await this.config.rallar.messages
            .room<RallarGameAuthorityEnvelope<T>>({
                topicId: this.config.topicId,
                typeId: input.typeId,
                roomId: room.roomRef ? undefined : room.roomId,
                roomRef: room.roomRef
            })
            .sendWs(envelope, {
                resourceId: input.options.key,
                reliability: input.options.reliability,
                ack: input.options.ack
            });
        const sent = isSuccessfulAuthorityMessageStatus(result.status);
        if (!sent && input.options.trackPending) {
            this.pendingCommands.delete(envelope.seq);
        }
        this.refreshStatus();
        return sent
            ? { status: 'sent', transport: 'ws', seq: envelope.seq, raw: result }
            : {
                status: 'failed',
                transport: 'ws',
                seq: envelope.seq,
                raw: result,
                reason: result.reason
            };
    }

    private async sendRtcEnvelope<T>(
        kind: RallarGameAuthorityEnvelope<T>['kind'],
        payload: T,
        typeId: string
    ): Promise<RallarGameAuthoritySendResult> {
        if (this.stopped) {
            return { status: 'stopped', transport: 'rtc' };
        }
        const room = this.readRoomTarget();
        const senderId = this.readLocalPeerId();
        if (!room.roomId || !senderId) {
            this.refreshStatus();
            return notReadyAuthoritySendResult('rtc');
        }
        const envelope = this.createEnvelope(kind, payload, {
            roomId: room.roomId,
            senderId
        });
        const result = await this.config.rallar.messages
            .room<RallarGameAuthorityEnvelope<T>>({
                topicId: this.config.topicId,
                typeId,
                roomId: room.roomRef ? undefined : room.roomId,
                roomRef: room.roomRef
            })
            .sendRtc(envelope, {
                reliability: 'best-effort',
                ack: 'none',
                ttlMs: 5_000
            });
        const sent = isSuccessfulAuthorityMessageStatus(result.status);
        this.recordPeerAssistSend(kind, sent, envelope.sentAtEpochMs);
        this.refreshStatus();
        return sent
            ? { status: 'sent', transport: 'rtc', seq: envelope.seq, raw: result }
            : {
                status: 'failed',
                transport: 'rtc',
                seq: envelope.seq,
                raw: result,
                reason: result.reason
            };
    }

    private recordPeerAssistSend(
        kind: RallarGameAuthorityEnvelopeKind,
        sent: boolean,
        sentAtEpochMs: number
    ): void {
        if (kind === 'presence' && sent) {
            this.lastPresenceAtEpochMs = sentAtEpochMs;
        }
        if (kind === 'snapshot' && sent) {
            this.lastSnapshotRepairAtEpochMs = sentAtEpochMs;
        }
    }

    private async handleCommandResultMessage(
        message: RallarMessage<RallarGameAuthorityEnvelope<RallarGameAuthorityCommandResult>>
    ): Promise<void> {
        if (
            !this.acceptEnvelope(message.payload, 'command-result', {
                senderId: this.config.authority.id
            })
        ) {
            return;
        }
        const commandResult = decodeAuthorityCommandResult(message.payload.payload);
        if (commandResult) {
            this.pendingCommands.delete(commandResult.commandSeq);
        }
        this.lastAuthoritySeenAtEpochMs = message.payload.sentAtEpochMs;
        this.lastCommandResultAtEpochMs = message.payload.sentAtEpochMs;
        this.refreshStatus();
        await this.config.onCommandResult?.(message.payload);
    }

    private async handleWsSnapshotMessage(
        message: RallarMessage<RallarGameAuthorityEnvelope<TSnapshot>>
    ): Promise<void> {
        if (
            !this.acceptEnvelope(message.payload, 'snapshot', {
                senderId: this.config.authority.id
            })
        ) {
            return;
        }
        this.lastAuthoritySeenAtEpochMs = message.payload.sentAtEpochMs;
        this.lastSnapshotAtEpochMs = message.payload.sentAtEpochMs;
        this.refreshStatus();
        await this.config.onSnapshot?.(message.payload);
    }

    private async handleEventMessage(
        message: RallarMessage<RallarGameAuthorityEnvelope<TEvent>>
    ): Promise<void> {
        if (
            !this.acceptEnvelope(message.payload, 'event', {
                senderId: this.config.authority.id
            })
        ) {
            return;
        }
        this.lastAuthoritySeenAtEpochMs = message.payload.sentAtEpochMs;
        this.lastEventAtEpochMs = message.payload.sentAtEpochMs;
        this.refreshStatus();
        await this.config.onEvent?.(message.payload);
    }

    private async handleRtcSnapshotMessage(
        message: RallarMessage<RallarGameAuthorityEnvelope<TSnapshot>>
    ): Promise<void> {
        const acceptRepair = this.config.peerAssist?.acceptSnapshotRepair;
        if (!this.config.peerAssist?.snapshotRepair || !acceptRepair) {
            return;
        }
        if (!this.acceptEnvelope(message.payload, 'snapshot')) {
            return;
        }
        if (!await acceptRepair(message.payload, message)) {
            return;
        }
        this.lastSnapshotRepairAtEpochMs = Date.now();
        this.lastSnapshotAtEpochMs = message.payload.sentAtEpochMs;
        this.refreshStatus();
        await this.config.onSnapshot?.(message.payload);
    }

    private async handlePresenceMessage(
        message: RallarMessage<RallarGameAuthorityEnvelope<TPresence>>
    ): Promise<void> {
        if (!this.config.peerAssist?.enabled) {
            return;
        }
        if (
            !this.acceptEnvelope(message.payload, 'presence', {
                senderId: message.senderId
            })
        ) {
            return;
        }
        this.lastPresenceAtEpochMs = message.payload.sentAtEpochMs;
        this.refreshStatus();
        await this.config.onPresence?.(message.payload);
    }

    private acceptEnvelope<T>(
        envelope: RallarGameAuthorityEnvelope<T>,
        kind: RallarGameAuthorityEnvelopeKind,
        options: AuthorityEnvelopeAcceptanceOptions = {}
    ): boolean {
        if (
            this.stopped || !isRallarGameAuthorityEnvelope(
                envelope,
                this.config.protocol
            )
        ) {
            return false;
        }
        const room = this.readRoomTarget();
        return this.sequenceTracker.accept(envelope, {
            protocol: this.config.protocol,
            roomId: room.roomId,
            senderId: options.senderId,
            authorityKind: this.config.authority.kind,
            authorityId: this.config.authority.id,
            minAuthorityEpoch: this.config.authority.epoch,
            kinds: [kind]
        }).accepted;
    }

    private createEnvelope<T>(
        kind: RallarGameAuthorityEnvelope<T>['kind'],
        payload: T,
        options: AuthorityEnvelopeSender
    ): RallarGameAuthorityEnvelope<T> {
        return createRallarGameAuthorityEnvelope({
            protocol: this.config.protocol,
            kind,
            roomId: options.roomId,
            senderId: options.senderId,
            seq: this.nextSeq++,
            authority: this.config.authority,
            payload
        });
    }

    private refreshStatus(): void {
        if (this.stopped) {
            return;
        }
        const room = this.readRoomTarget();
        const localPeerId = this.readLocalPeerId();
        this.setStatus(
            !this.started
                ? 'idle'
                : room.roomId && localPeerId
                ? 'ready'
                : 'degraded'
        );
    }

    private setStatus(
        phase: RallarGameAuthorityClientStatus['phase'],
        reason?: string
    ): void {
        this.currentStatus = this.createStatus(phase, reason);
        this.emitStatus(this.currentStatus);
    }

    private createStatus(
        phase: RallarGameAuthorityClientStatus['phase'],
        reason?: string
    ): RallarGameAuthorityClientStatus {
        const room = this.readRoomTarget();
        const readyPeerIds = uniqueSorted(this.lastRtcStatus?.readyPeerIds ?? []);
        const snapshotRepairEnabled = this.config.peerAssist?.snapshotRepair === true;
        const peerAssistEnabled = this.config.peerAssist?.enabled === true ||
            snapshotRepairEnabled;
        return {
            phase,
            protocol: this.config.protocol,
            topicId: this.config.topicId,
            roomId: room.roomId,
            roomRef: room.roomRef,
            localPeerId: this.readLocalPeerId(),
            authority: this.config.authority,
            started: this.started,
            stopped: this.stopped,
            pendingCommandCount: this.pendingCommands.size,
            peerAssist: {
                enabled: peerAssistEnabled,
                snapshotRepairEnabled,
                readyPeerIds,
                lastPresenceAtEpochMs: this.lastPresenceAtEpochMs,
                lastSnapshotRepairAtEpochMs: this.lastSnapshotRepairAtEpochMs
            },
            authorityTtlMs: this.config.authorityTtlMs,
            lastAuthoritySeenAtEpochMs: this.lastAuthoritySeenAtEpochMs,
            lastCommandResultAtEpochMs: this.lastCommandResultAtEpochMs,
            lastSnapshotAtEpochMs: this.lastSnapshotAtEpochMs,
            lastEventAtEpochMs: this.lastEventAtEpochMs,
            updatedAtEpochMs: Date.now(),
            reason
        };
    }

    private readRoomTarget(): RallarGameAuthorityRoomTarget {
        const roomState = this.config.rallar.rooms.state();
        const roomRef = this.config.roomRef ?? roomState.currentRoomRef;
        const roomId = this.config.roomId ?? roomRef?.groupId ??
            roomState.currentRoomId;
        return { roomId, roomRef };
    }

    private readLocalPeerId(): string | undefined {
        return this.config.rallar.session()?.sessionId;
    }

    private emitStatus(status: RallarGameAuthorityClientStatus): void {
        for (const handler of this.statusHandlers) {
            void notifyStatusHandler(handler, status);
        }
    }
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function notifyStatusHandler(
    handler: RallarGameAuthorityStatusHandler,
    status: RallarGameAuthorityClientStatus
): Promise<void> {
    try {
        await handler(status);
    }
    catch (error) {
        console.error('Error notifying Rallar Game Authority status handler', error);
    }
}
