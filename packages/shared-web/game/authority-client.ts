import type {
    RallarFacade,
    RallarMessage,
    RallarRtcStatus,
    RallarSubscriptionScope,
    RallarUnsubscribe
} from '@shared-web/browser/rallar.ts';
import type { ALOutboundEnqueueStatus } from '@shared/alm/ALOutboundMessageRuntime.ts';
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
    type RallarGameAuthorityEnvelopeHandler,
    type RallarGameAuthorityRef,
    type RallarGameAuthoritySendResult,
    type RallarGameAuthorityStatusHandler,
    type RallarGameAuthorityTypeIds
} from '@shared/rallar-game/mod.ts';

export type RallarGameAuthorityClientRallarFacade = Pick<
    RallarFacade,
    'session' | 'subscriptions' | 'rooms' | 'messages' | 'rtc'
>;

export type RallarGameAuthorityPeerAssistOptions<TSnapshot> = Readonly<{
    enabled?: boolean;
    snapshotRepair?: boolean;
    acceptSnapshotRepair?: (
        envelope: RallarGameAuthorityEnvelope<TSnapshot>,
        message: RallarMessage<RallarGameAuthorityEnvelope<TSnapshot>>
    ) => boolean | Promise<boolean>;
}>;

export type RallarGameAuthorityClientConfig<TCommand, TSnapshot, TEvent, TPresence = unknown> = Readonly<{
    rallar: RallarGameAuthorityClientRallarFacade;
    protocol: string;
    topicId: string;
    authority: RallarGameAuthorityRef;
    roomId?: string;
    roomRef?: GroupRef;
    typeIds?: Partial<RallarGameAuthorityTypeIds>;
    authorityTtlMs?: number;
    peerAssist?: RallarGameAuthorityPeerAssistOptions<TSnapshot>;
    onCommandResult?: RallarGameAuthorityEnvelopeHandler<RallarGameAuthorityCommandResult>;
    onSnapshot?: RallarGameAuthorityEnvelopeHandler<TSnapshot>;
    onEvent?: RallarGameAuthorityEnvelopeHandler<TEvent>;
    onPresence?: RallarGameAuthorityEnvelopeHandler<TPresence>;
}>;

export type RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence = unknown> = Readonly<{
    start(): Promise<RallarGameAuthorityClientStatus>;
    stop(): void;
    status(): RallarGameAuthorityClientStatus;
    diagnostics(): RallarGameAuthorityDiagnostics;
    sendCommand(
        command: TCommand,
        options?: { key?: string; }
    ): Promise<RallarGameAuthoritySendResult>;
    requestSync(payload?: unknown): Promise<RallarGameAuthoritySendResult>;
    publishPresence(presence: TPresence): Promise<RallarGameAuthoritySendResult>;
    publishSnapshotRepair(snapshot: TSnapshot): Promise<RallarGameAuthoritySendResult>;
    onStatus(handler: RallarGameAuthorityStatusHandler): RallarUnsubscribe;
}>;

export function createRallarGameAuthorityClient<TCommand, TSnapshot, TEvent, TPresence = unknown>(
    config: RallarGameAuthorityClientConfig<TCommand, TSnapshot, TEvent, TPresence>
): RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence> {
    const typeIds = resolveRallarGameAuthorityTypeIds(
        config.topicId,
        config.typeIds
    );
    const sequenceTracker = createRallarGameAuthoritySequenceTracker();
    const statusHandlers = new Set<RallarGameAuthorityStatusHandler>();
    const pendingCommands = new Map<number, number>();

    let subscriptions: RallarSubscriptionScope | undefined;
    let started = false;
    let stopped = false;
    let nextSeq = 1;
    let lastRtcStatus: RallarRtcStatus | undefined;
    let lastPresenceAtEpochMs: number | undefined;
    let lastSnapshotRepairAtEpochMs: number | undefined;
    let lastAuthoritySeenAtEpochMs: number | undefined;
    let lastCommandResultAtEpochMs: number | undefined;
    let lastSnapshotAtEpochMs: number | undefined;
    let lastEventAtEpochMs: number | undefined;
    let currentStatus = createStatus('idle');

    const handle: RallarGameAuthorityClientHandle<TCommand, TSnapshot, TEvent, TPresence> = {
        start,
        stop,
        status: () => currentStatus,
        diagnostics: () =>
            deriveRallarGameAuthorityDiagnostics({
                status: currentStatus
            }),
        sendCommand,
        requestSync,
        publishPresence,
        publishSnapshotRepair,
        onStatus(handler): RallarUnsubscribe {
            statusHandlers.add(handler);
            void notifyStatusHandler(handler, currentStatus);
            return () => {
                statusHandlers.delete(handler);
            };
        }
    };

    return handle;

    async function start(): Promise<RallarGameAuthorityClientStatus> {
        if (started && !stopped) {
            return currentStatus;
        }

        started = true;
        stopped = false;
        sequenceTracker.reset();
        subscriptions = config.rallar.subscriptions();
        subscriptions
            .add(config.rallar.rooms.onChange(() => refreshStatus()))
            .add(config.rallar.rtc.onStatus((status) => {
                lastRtcStatus = status;
                refreshStatus();
            }))
            .add(config.rallar.messages.ws.onMessage<RallarGameAuthorityEnvelope<RallarGameAuthorityCommandResult>>(
                { topicId: config.topicId, typeId: typeIds.commandResult },
                handleCommandResultMessage
            ))
            .add(config.rallar.messages.ws.onMessage<RallarGameAuthorityEnvelope<TSnapshot>>(
                { topicId: config.topicId, typeId: typeIds.snapshot },
                handleWsSnapshotMessage
            ))
            .add(config.rallar.messages.ws.onMessage<RallarGameAuthorityEnvelope<TEvent>>(
                { topicId: config.topicId, typeId: typeIds.event },
                handleEventMessage
            ))
            .add(config.rallar.messages.rtc.onMessage<RallarGameAuthorityEnvelope<TSnapshot>>(
                { topicId: config.topicId, typeId: typeIds.snapshot },
                handleRtcSnapshotMessage
            ))
            .add(config.rallar.messages.rtc.onMessage<RallarGameAuthorityEnvelope<TPresence>>(
                { topicId: config.topicId, typeId: typeIds.presence },
                handlePresenceMessage
            ));

        refreshStatus();
        return currentStatus;
    }

    function stop(): void {
        if (stopped) {
            return;
        }

        stopped = true;
        started = false;
        pendingCommands.clear();
        subscriptions?.unsubscribe();
        subscriptions = undefined;
        setStatus('stopped');
    }

    async function sendCommand(
        command: TCommand,
        options: { key?: string; } = {}
    ): Promise<RallarGameAuthoritySendResult> {
        return await sendWsEnvelope('command', command, typeIds.command, {
            reliability: 'at-least-once',
            ack: 'receiver',
            key: options.key,
            trackPending: true
        });
    }

    async function requestSync(
        payload: unknown = {}
    ): Promise<RallarGameAuthoritySendResult> {
        return await sendWsEnvelope('sync-request', payload, typeIds.syncRequest, {
            reliability: 'at-least-once',
            ack: 'receiver'
        });
    }

    async function publishPresence(
        presence: TPresence
    ): Promise<RallarGameAuthoritySendResult> {
        if (!config.peerAssist?.enabled) {
            return {
                status: 'skipped',
                transport: 'rtc',
                reason: 'Peer assist is disabled.'
            };
        }

        return await sendRtcEnvelope('presence', presence, typeIds.presence);
    }

    async function publishSnapshotRepair(
        snapshot: TSnapshot
    ): Promise<RallarGameAuthoritySendResult> {
        if (!config.peerAssist?.snapshotRepair) {
            return {
                status: 'skipped',
                transport: 'rtc',
                reason: 'Peer snapshot repair is disabled.'
            };
        }

        return await sendRtcEnvelope('snapshot', snapshot, typeIds.snapshot);
    }

    async function sendWsEnvelope<T>(
        kind: RallarGameAuthorityEnvelope<T>['kind'],
        payload: T,
        typeId: string,
        options: Readonly<{
            reliability: 'best-effort' | 'at-least-once';
            ack: 'none' | 'receiver';
            key?: string;
            trackPending?: boolean;
        }>
    ): Promise<RallarGameAuthoritySendResult> {
        if (stopped) {
            return { status: 'stopped', transport: 'ws' };
        }

        const room = readRoomTarget();
        const senderId = readLocalPeerId();
        if (!room.roomId || !senderId) {
            refreshStatus();
            return {
                status: 'not-ready',
                transport: 'ws',
                reason: 'Cannot send without a room and local session.'
            };
        }

        const envelope = createEnvelope(kind, payload, {
            roomId: room.roomId,
            senderId
        });
        if (options.trackPending) {
            pendingCommands.set(envelope.seq, envelope.sentAtEpochMs);
        }

        const result = await config.rallar.messages
            .room<RallarGameAuthorityEnvelope<T>>({
                topicId: config.topicId,
                typeId,
                roomId: room.roomRef ? undefined : room.roomId,
                roomRef: room.roomRef
            })
            .sendWs(envelope, {
                resourceId: options.key,
                reliability: options.reliability,
                ack: options.ack
            });
        const sent = isSuccessfulMessageStatus(result.status);
        if (!sent && options.trackPending) {
            pendingCommands.delete(envelope.seq);
        }
        refreshStatus();

        return {
            status: sent ? 'sent' : 'failed',
            transport: 'ws',
            seq: envelope.seq,
            raw: result,
            reason: sent ? undefined : result.reason
        };
    }

    async function sendRtcEnvelope<T>(
        kind: RallarGameAuthorityEnvelope<T>['kind'],
        payload: T,
        typeId: string
    ): Promise<RallarGameAuthoritySendResult> {
        if (stopped) {
            return { status: 'stopped', transport: 'rtc' };
        }

        const room = readRoomTarget();
        const senderId = readLocalPeerId();
        if (!room.roomId || !senderId) {
            refreshStatus();
            return {
                status: 'not-ready',
                transport: 'rtc',
                reason: 'Cannot send without a room and local session.'
            };
        }

        const envelope = createEnvelope(kind, payload, {
            roomId: room.roomId,
            senderId
        });
        const result = await config.rallar.messages
            .room<RallarGameAuthorityEnvelope<T>>({
                topicId: config.topicId,
                typeId,
                roomId: room.roomRef ? undefined : room.roomId,
                roomRef: room.roomRef
            })
            .sendRtc(envelope, {
                reliability: 'best-effort',
                ack: 'none',
                ttlMs: 5_000
            });
        const sent = isSuccessfulMessageStatus(result.status);
        if (kind === 'presence' && sent) {
            lastPresenceAtEpochMs = envelope.sentAtEpochMs;
        }
        if (kind === 'snapshot' && sent) {
            lastSnapshotRepairAtEpochMs = envelope.sentAtEpochMs;
        }
        refreshStatus();

        return {
            status: sent ? 'sent' : 'failed',
            transport: 'rtc',
            seq: envelope.seq,
            raw: result,
            reason: sent ? undefined : result.reason
        };
    }

    async function handleCommandResultMessage(
        message: RallarMessage<RallarGameAuthorityEnvelope<RallarGameAuthorityCommandResult>>
    ): Promise<void> {
        if (
            !acceptEnvelope(message.payload, 'command-result', {
                senderId: config.authority.id
            })
        ) {
            return;
        }

        const commandResult = toCommandResult(message.payload.payload);
        if (commandResult) {
            pendingCommands.delete(commandResult.commandSeq);
        }
        lastAuthoritySeenAtEpochMs = message.payload.sentAtEpochMs;
        lastCommandResultAtEpochMs = message.payload.sentAtEpochMs;
        refreshStatus();
        await config.onCommandResult?.(message.payload);
    }

    async function handleWsSnapshotMessage(
        message: RallarMessage<RallarGameAuthorityEnvelope<TSnapshot>>
    ): Promise<void> {
        if (
            !acceptEnvelope(message.payload, 'snapshot', {
                senderId: config.authority.id
            })
        ) {
            return;
        }

        lastAuthoritySeenAtEpochMs = message.payload.sentAtEpochMs;
        lastSnapshotAtEpochMs = message.payload.sentAtEpochMs;
        refreshStatus();
        await config.onSnapshot?.(message.payload);
    }

    async function handleEventMessage(
        message: RallarMessage<RallarGameAuthorityEnvelope<TEvent>>
    ): Promise<void> {
        if (
            !acceptEnvelope(message.payload, 'event', {
                senderId: config.authority.id
            })
        ) {
            return;
        }

        lastAuthoritySeenAtEpochMs = message.payload.sentAtEpochMs;
        lastEventAtEpochMs = message.payload.sentAtEpochMs;
        refreshStatus();
        await config.onEvent?.(message.payload);
    }

    async function handleRtcSnapshotMessage(
        message: RallarMessage<RallarGameAuthorityEnvelope<TSnapshot>>
    ): Promise<void> {
        if (
            !config.peerAssist?.snapshotRepair ||
            !config.peerAssist.acceptSnapshotRepair
        ) {
            return;
        }

        if (!acceptEnvelope(message.payload, 'snapshot')) {
            return;
        }

        const accepted = await config.peerAssist.acceptSnapshotRepair(
            message.payload,
            message
        );
        if (!accepted) {
            return;
        }

        lastSnapshotRepairAtEpochMs = Date.now();
        lastSnapshotAtEpochMs = message.payload.sentAtEpochMs;
        refreshStatus();
        await config.onSnapshot?.(message.payload);
    }

    async function handlePresenceMessage(
        message: RallarMessage<RallarGameAuthorityEnvelope<TPresence>>
    ): Promise<void> {
        if (!config.peerAssist?.enabled) {
            return;
        }

        if (!acceptEnvelope(message.payload, 'presence', { senderId: message.senderId })) {
            return;
        }

        lastPresenceAtEpochMs = message.payload.sentAtEpochMs;
        refreshStatus();
        await config.onPresence?.(message.payload);
    }

    function acceptEnvelope(
        envelope: RallarGameAuthorityEnvelope<unknown>,
        kind: RallarGameAuthorityEnvelope<unknown>['kind'],
        options: Readonly<{ senderId?: string; }> = {}
    ): boolean {
        if (stopped || !isRallarGameAuthorityEnvelope(envelope, config.protocol)) {
            return false;
        }

        const room = readRoomTarget();
        return sequenceTracker.accept(envelope, {
            protocol: config.protocol,
            roomId: room.roomId,
            senderId: options.senderId,
            authorityKind: config.authority.kind,
            authorityId: config.authority.id,
            minAuthorityEpoch: config.authority.epoch,
            kinds: [kind]
        }).accepted;
    }

    function createEnvelope<T>(
        kind: RallarGameAuthorityEnvelope<T>['kind'],
        payload: T,
        options: Readonly<{
            roomId: string;
            senderId: string;
        }>
    ): RallarGameAuthorityEnvelope<T> {
        return createRallarGameAuthorityEnvelope({
            protocol: config.protocol,
            kind,
            roomId: options.roomId,
            senderId: options.senderId,
            seq: nextSeq++,
            authority: config.authority,
            payload
        });
    }

    function refreshStatus(): void {
        if (stopped) {
            return;
        }

        const room = readRoomTarget();
        const localPeerId = readLocalPeerId();
        setStatus(
            !started
                ? 'idle'
                : room.roomId && localPeerId
                ? 'ready'
                : 'degraded'
        );
    }

    function setStatus(
        phase: RallarGameAuthorityClientStatus['phase'],
        reason?: string
    ): void {
        currentStatus = createStatus(phase, reason);
        emitStatus(currentStatus);
    }

    function createStatus(
        phase: RallarGameAuthorityClientStatus['phase'],
        reason?: string
    ): RallarGameAuthorityClientStatus {
        const room = readRoomTarget();
        const readyPeerIds = uniqueSorted(lastRtcStatus?.readyPeerIds ?? []);
        const snapshotRepairEnabled = config.peerAssist?.snapshotRepair === true;
        const peerAssistEnabled = config.peerAssist?.enabled === true ||
            snapshotRepairEnabled;

        return {
            phase,
            protocol: config.protocol,
            topicId: config.topicId,
            roomId: room.roomId,
            roomRef: room.roomRef,
            localPeerId: readLocalPeerId(),
            authority: config.authority,
            started,
            stopped,
            pendingCommandCount: pendingCommands.size,
            peerAssist: {
                enabled: peerAssistEnabled,
                snapshotRepairEnabled,
                readyPeerIds,
                lastPresenceAtEpochMs,
                lastSnapshotRepairAtEpochMs
            },
            authorityTtlMs: config.authorityTtlMs,
            lastAuthoritySeenAtEpochMs,
            lastCommandResultAtEpochMs,
            lastSnapshotAtEpochMs,
            lastEventAtEpochMs,
            updatedAtEpochMs: Date.now(),
            reason
        };
    }

    function readRoomTarget(): Readonly<{
        roomId?: string;
        roomRef?: GroupRef;
    }> {
        const roomState = config.rallar.rooms.state();
        const roomRef = config.roomRef ?? roomState.currentRoomRef;
        const roomId = config.roomId ?? roomRef?.groupId ?? roomState.currentRoomId;
        return { roomId, roomRef };
    }

    function readLocalPeerId(): string | undefined {
        return config.rallar.session()?.sessionId;
    }

    function emitStatus(status: RallarGameAuthorityClientStatus): void {
        for (const handler of statusHandlers) {
            void notifyStatusHandler(handler, status);
        }
    }
}

function toCommandResult(
    value: unknown
): RallarGameAuthorityCommandResult | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return undefined;
    }

    const candidate = value as Partial<RallarGameAuthorityCommandResult>;
    if (
        typeof candidate.commandSeq !== 'number' ||
        !Number.isSafeInteger(candidate.commandSeq) ||
        candidate.commandSeq < 0 ||
        (candidate.status !== 'accepted' && candidate.status !== 'rejected')
    ) {
        return undefined;
    }

    return {
        commandSeq: candidate.commandSeq,
        status: candidate.status,
        reason: typeof candidate.reason === 'string' ? candidate.reason : undefined
    };
}

function isSuccessfulMessageStatus(status: ALOutboundEnqueueStatus): boolean {
    return status === 'enqueued' ||
        status === 'sent-immediate' ||
        status === 'skipped' ||
        status === 'duplicate';
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
